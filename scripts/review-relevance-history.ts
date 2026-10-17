import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { config,safeError } from '../server/config.js';
import { Store } from '../server/db.js';
import { Analyzer,type AnalysisResult } from '../server/ai.js';
import { PublicHttp,checkHttp,type HttpClient } from '../server/http.js';
import { currentSignal } from '../shared/freshness.js';
import type { Rule,Settings,Signal } from '../shared/types.js';

const args=new Set(process.argv.slice(2));const db=new DatabaseSync(`${config.dataDir}/signal.sqlite`,{timeout:5000});
const read=<T>(space:string)=>db.prepare('SELECT data FROM objects WHERE space=?').all(space).map(row=>JSON.parse(row.data as string) as T);
const rules=read<Rule>('rules'),events=read<Signal>('events');const settings=JSON.parse(db.prepare('SELECT data FROM objects WHERE space=? AND id=?').get('state','settings')!.data as string) as Settings;
const eligible=events.filter(item=>currentSignal(item)&&item.relevanceVersion===undefined);
const requestLimit=Number(process.env.EVAL_REQUEST_LIMIT||settings.aiDailyLimit);
if(!Number.isInteger(requestLimit)||requestLimit<settings.aiDailyLimit||requestLimit>settings.aiDailyLimit+90)throw Error('临时评估上限超出授权范围');
const contractHash=createHash('sha256').update(['server/ai.ts','server/relevance.ts','shared/relevance.ts','server/quality.ts'].map(file=>readFileSync(file,'utf8').replace(/\r\n/g,'\n')).join('')).digest('hex');
const sourceHash=createHash('sha256').update(JSON.stringify(eligible.map(item=>[item.id,item.evidence.map(ev=>[ev.id,ev.contentHash])]).sort())).update(JSON.stringify(rules.map(rule=>[rule.id,rule.kind,rule.query]).sort())).digest('hex');
const file='reports/relevance-history-review.json';
type Review={sourceHash:string;contractHash?:string;model?:string;at:string;originalIds:string[];results:{originalId:string;result?:AnalysisResult;error?:string}[]};
let review:Review=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{sourceHash,at:new Date().toISOString(),originalIds:eligible.map(item=>item.id),results:[]};
if(review.sourceHash!==sourceHash||review.model&&review.model!==settings.model||review.contractHash!==contractHash)review={sourceHash,contractHash,model:settings.model,at:new Date().toISOString(),originalIds:eligible.map(item=>item.id),results:[]};
review.model=settings.model;
if(!args.has('--live')&&!args.has('--apply')){console.log(JSON.stringify({eligible:eligible.length,pausedRules:rules.filter(rule=>!rule.enabled).length,note:'--live prepares a cached review; --apply requires an accepted evaluation and creates a SQLite backup.'}));db.close();process.exit(0);}
if(args.has('--live')) {
  const http=new PublicHttp();const pool=new Store(':memory:');pool.put('state','settings',settings);
  const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const reserve=(kind:string,amount:number,limit:number)=>{db.exec('BEGIN IMMEDIATE');try{const used=Number(db.prepare('SELECT used FROM usage WHERE day=? AND kind=?').get(day(),kind)?.used||0);if(used+amount>limit)throw Error('每日 AI 调用限额已到');db.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,kind) DO UPDATE SET used=excluded.used').run(day(),kind,used+amount);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}};
  const transport:HttpClient={request:async(url,options)=>{if(options?.method==='POST')reserve('aiRequests',1,requestLimit);const doc=await http.request(url,options);if(options?.method==='POST'){try{const usage=JSON.parse(doc.text).usage;if(usage?.total_tokens)reserve('aiTokens',usage.total_tokens,Number.MAX_SAFE_INTEGER);}catch{}}return doc;}};
  const analyzer=new Analyzer(pool,transport);
  const groups:Signal[][]=[];for(const event of eligible.filter(event=>!review.results.some(item=>item.originalId===event.id&&item.result))){const last=groups.at(-1);if(!last||new Set([...last.flatMap(item=>item.evidence),...event.evidence].map(item=>item.id)).size>8)groups.push([event]);else last.push(event);}
  try{for(const group of groups){const ids=new Set(group.flatMap(event=>event.ruleIds));const matching=rules.filter(rule=>ids.has(rule.id));if(!matching.length)continue;const evidence=[...new Map(group.flatMap(event=>event.evidence).map(item=>[item.id,item])).values()];
      try{const result=await analyzer.analyze(evidence,matching,group);for(const event of group){review.results=review.results.filter(item=>item.originalId!==event.id);review.results.push({originalId:event.id,result});}}
      catch(error){for(const event of group)review.results.push({originalId:event.id,error:safeError(error)});writeFileSync(file,JSON.stringify(review,null,2));throw error;}
      writeFileSync(file,JSON.stringify(review,null,2));console.log(`历史审核 ${review.results.length}/${eligible.length}`);
    }}finally{pool.close();await http.close();}
}
if(args.has('--apply')) {
  const evaluation=JSON.parse(readFileSync('reports/relevance-eval/report.json','utf8'));if(!evaluation.accepted||evaluation.model!==settings.model)throw Error('当前模型的完整语义评估尚未通过，暂不迁移生产匹配');
  const protocolHash=createHash('sha256').update(['scripts/evaluate-relevance.ts','eval/grading.ts','eval/metrics.ts','eval/confirmed-references.ts','eval/retry.ts','eval/fixtures/confirmed-policies.json'].map(file=>readFileSync(file,'utf8').replace(/\r\n/g,'\n')).join('')).digest('hex');
  if(evaluation.protocolHash!==protocolHash)throw Error('评估判据或人工确认记录在验收后变化，暂不应用历史结果');
  const contractHash=createHash('sha256').update(readFileSync('server/ai.ts','utf8').replace(/\r\n/g,'\n')).update(readFileSync('server/relevance.ts','utf8').replace(/\r\n/g,'\n')).update(readFileSync('shared/relevance.ts','utf8').replace(/\r\n/g,'\n')).update(readFileSync('server/quality.ts','utf8').replace(/\r\n/g,'\n')).update(JSON.stringify(JSON.parse(readFileSync('eval/fixtures/relevance.json','utf8')))).digest('hex');
  if(evaluation.contractHash!==contractHash)throw Error('审核契约在评估后变化，暂不应用历史结果');
  if(review.results.length<eligible.length||review.results.some(item=>item.error&&!item.result))throw Error('历史隔离审核尚未完成，暂不迁移');
  mkdirSync('reports/backups',{recursive:true});const target=`reports/backups/pre-relevance-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`;await backup(db,target);db.close();
  const store=new Store();try{store.transaction(()=>{for(const row of review.results){const old=store.get<Signal>('events',row.originalId);if(!old||!row.result)continue;
      for(const signal of row.result.signals)store.put('events',signal.id,{...signal,relevanceRechecked:true});
      if(!row.result.signals.some(item=>item.id===old.id)){
        const exclusions=row.result.exclusions?.filter(item=>old.evidence.some(evidence=>evidence.id===item.evidenceId));
        const unresolved=row.result.issues?.some(issue=>issue.evidenceIds.some(id=>old.evidence.some(item=>item.id===id)))||exclusions?.some(item=>item.category==='insufficient');
        const reasons=exclusions?.map(item=>item.reason);
        store.put('events',old.id,{...old,auditOnly:true,auditReason:unresolved?'关联待审核：重新核验未完成':reasons?.join('；').slice(0,600)||'与监控目标没有直接关联'});
      }
    }});console.log(JSON.stringify({backup:target,reviewed:review.results.length,visible:store.list<Signal>('events').filter(item=>currentSignal(item)).length}));}finally{store.close();}
}else db.close();
