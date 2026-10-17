// Offline repair for the 2026-10-17 visibility regression. No network or model calls.
// Dry-run by default. --apply creates a full backup and archives every changed row.
import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { analysisSchema,creatorVideoFallback,validateBatch,type AnalysisResult } from '../server/ai.js';
import { applyQuality } from '../server/quality.js';
import { currentSignal } from '../shared/freshness.js';
import { platformOf } from '../shared/discovery.js';
import { matchesRule,ruleFingerprint } from '../shared/relevance.js';
import type { Candidate,Rule,Signal } from '../shared/types.js';

const applying=process.argv.includes('--apply'),now=Date.now();
const db=new DatabaseSync(`${config.dataDir}/signal.sqlite`,{timeout:5000,readOnly:!applying});
const read=<T>(space:string)=>db.prepare('SELECT data FROM objects WHERE space=? ORDER BY id').all(space).map(row=>JSON.parse(row.data as string) as T);
const rules=read<Rule>('rules'),prior=read<Signal>('events'),candidates=read<Candidate>('candidates');
const protectedState=()=>JSON.stringify({rules:read('rules'),sources:read('sources'),accounts:read('accounts'),mail:read('mail'),settings:db.prepare('SELECT data FROM objects WHERE space=? AND id=?').get('state','settings'),usage:db.prepare('SELECT * FROM usage ORDER BY day,kind').all()});
const before=protectedState();
const sources=new Map(candidates.map(item=>[item.id,item]));
const changes=new Map<string,Signal>();
const audit:{id:string;method:string;sourceIds:string[];replaces?:string}[]=[];
const cached=JSON.parse(readFileSync('reports/relevance-history-pre-excerpt.json','utf8')) as {results:{originalId:string;result?:AnalysisResult}[]};
const latest=JSON.parse(readFileSync('reports/relevance-history-review.json','utf8')) as typeof cached;
const recoverable=['285705bf529be78954d11cae','54152cab03f112ea2e301a2b','65ab210802075cd614bda968','77c2e6e097ea639c38475919'];
for(const id of recoverable){
  const old=prior.find(item=>item.id===id);
  if(!old||currentSignal(old,now)||!old.auditReason?.startsWith('关联待审核'))continue;
  const signal=cached.results.find(row=>row.originalId===id)?.result?.signals.find(item=>item.id===id);
  if(!signal)throw Error(`缺少有效的历史逐监控审核 ${id}`);
  const evidence=signal.evidence.map(item=>{
    const current=sources.get(item.id);
    if(!current||current.contentHash!==item.contentHash||current.text!==item.text)throw Error(`原文已变化，必须重新语义审核 ${item.id}`);
    return applyQuality(current,[],now);
  });
  const latestResult=latest.results.find(row=>row.originalId===id)?.result;
  if(latestResult?.exclusions?.some(item=>evidence.some(ev=>ev.id===item.evidenceId)&&['weak','unrelated'].includes(item.category)))throw Error(`后续审核已有明确排除结论，禁止回退旧结果 ${id}`);
  const assessments=(signal.ruleAssessments||[]).filter(item=>item.validated&&item.level==='direct'&&rules.some(rule=>rule.id===item.ruleId&&ruleFingerprint(rule)===item.ruleFingerprint));
  if(!assessments.length)throw Error(`规则已改变或没有有效引用 ${id}`);
  const data=analysisSchema.parse({events:[{...signal,evidenceIds:evidence.map(item=>item.id),ruleIds:assessments.map(item=>item.ruleId),ruleAssessments:assessments,existingEventId:null}],excludedEvidenceIds:[],exclusions:[]});
  // Validate from this material alone: no inherited evidence, matches or merge dates.
  const result=validateBatch(data,evidence,rules,[],now).signals[0];
  if(!currentSignal(result,now)||!assessments.every(item=>result.ruleIds.includes(item.ruleId)))throw Error(`恢复内容未通过当前原文校验 ${id}`);
  changes.set(id,{...result,id,eventKey:old.eventKey,firstSeenAt:old.firstSeenAt,relevanceRechecked:true});
  audit.push({id,method:'cached-assessment-revalidated-against-unchanged-source',sourceIds:evidence.map(item=>item.id)});
}

// Creator uploads are exact author + actual video + publication date matches.
const videos=candidates.filter(item=>platformOf(item)==='bilibili');
const creatorSignals:Signal[]=[];
for(let index=0;index<videos.length;index+=8)creatorSignals.push(...(creatorVideoFallback(videos.slice(index,index+8),rules,prior,now)?.signals||[]));
for(const signal of creatorSignals){
  if(!currentSignal(signal,now))throw Error(`作者作品验证未通过 ${signal.id}`);
  changes.set(signal.id,{...signal,relevanceRechecked:true});
  audit.push({id:signal.id,method:'creator-video-metadata',sourceIds:signal.evidence.map(item=>item.id)});
  for(const old of prior.filter(item=>item.id!==signal.id&&item.evidence.some(ev=>signal.evidence.some(source=>source.finalUrl===ev.finalUrl)))){
    changes.set(old.id,{...old,auditOnly:true,auditReason:`已由逐作者作品审核恢复为 ${signal.id}`,relevanceRechecked:true});
    audit.push({id:old.id,method:'superseded-duplicate-video',sourceIds:old.evidence.map(item=>item.id),replaces:signal.id});
  }
}

// One saved digest was blocked by an output-format error. Restore only its
// explicit OpenAI item; do not carry over the other companies' digest headlines.
const digest=sources.get('4d68100005673d9f7a1ba88f'),openai=rules.find(rule=>rule.query.toLowerCase()==='openai相关内容');
const digestOld=prior.find(item=>item.id==='724a9c42cf3c98e98c9ab2e7');
if(digest&&openai&&digestOld?.auditReason?.startsWith('关联待审核')){
  const quote='2. OpenAI 泄露 Astra 私有版本，20 分钟后即被下线';
  if(!digest.text.includes(quote))throw Error('日报原文已变化，停止离线恢复');
  const summary='B站「一只AI风向标」视频简介声称 OpenAI 的 Astra 私有版本曾泄露并在 20 分钟后下线。仅取得视频简介，未核实该传闻，也未读取视频或字幕。';
  const data=analysisSchema.parse({events:[{title:'B站视频简介称 OpenAI Astra 私有版本短暂泄露（待核实）',summary,entity:'OpenAI',version:'Astra',eventType:'model-rumor',occurredAt:digest.publishedAt,isNewsworthy:true,isNewEvent:true,status:'pending',reason:'原文明确报道 OpenAI 模型动向，仅读取到 B站视频简介，传闻未经官方核实。',attention:40,attentionReason:'与关注目标直接相关的视频线索',importance:'medium',importanceReason:'涉及模型动向，但仍只有第三方简介。',tags:['OpenAI','B站','待核实'],evidenceIds:[digest.id],ruleIds:[openai.id],existingEventId:null,ruleAssessments:[{ruleId:openai.id,level:'direct',reason:'简介明确声称 OpenAI 模型短暂泄露并下线，是关于该公司的具体动向，事实真实性仍待核实。',summary,matchedEntity:'OpenAI',matchedVersion:'',matchedAction:'模型泄露传闻',unmetConstraints:[],citations:[{evidenceId:digest.id,quote}]}]}],excludedEvidenceIds:[],exclusions:[]});
  const result=validateBatch(data,[digest],rules,[],now).signals[0];
  if(!currentSignal(result,now)||!matchesRule(result,openai))throw Error('日报 OpenAI 条目未通过当前校验');
  changes.set(digestOld.id,{...result,id:digestOld.id,eventKey:digestOld.eventKey,firstSeenAt:digestOld.firstSeenAt,relevanceRechecked:true});
  audit.push({id:digestOld.id,method:'offline-source-review-openai-item-only',sourceIds:[digest.id]});
}

const afterEvents=[...new Map([...prior,...changes.values()].map(item=>[item.id,item])).values()];
const visible=afterEvents.filter(item=>currentSignal(item,now)&&rules.some(rule=>matchesRule(item,rule)));
const report={at:new Date(now).toISOString(),applied:applying,beforeVisible:prior.filter(item=>currentSignal(item,now)).length,visible:visible.length,bilibili:visible.filter(item=>item.evidence.some(ev=>platformOf(ev)==='bilibili')).length,rules:rules.length,enabled:rules.filter(rule=>rule.enabled).length,paidCalls:0,audit,events:visible.map(item=>({id:item.id,title:item.title,status:item.status,ruleIds:item.ruleIds,sources:item.evidence.map(ev=>({id:ev.id,url:ev.finalUrl,author:ev.author,publishedAt:ev.publishedAt}))})),backup:''};
mkdirSync('reports/backups',{recursive:true});
if(applying){
  if(rules.some(rule=>rule.enabled))throw Error('修复时有监控正在启用，请先确保不会并发写入');
  report.backup=`reports/backups/pre-hotspot-recovery-${new Date(now).toISOString().replace(/[:.]/g,'-')}.sqlite`;
  await backup(db,report.backup);
  db.exec('BEGIN IMMEDIATE');
  try{
    if(before!==protectedState())throw Error('修复期间用户设置、配额或规则变化，停止写入');
    const put=db.prepare('INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(space,id) DO UPDATE SET data=excluded.data,updated=excluded.updated');
    for(const [id,signal] of changes){
      const old=prior.find(item=>item.id===id);
      if(old&&!db.prepare('SELECT 1 FROM objects WHERE space=? AND id=?').get('hotspot-recovery-audit-20261017',id))put.run('hotspot-recovery-audit-20261017',id,JSON.stringify(old),now);
      put.run('events',id,JSON.stringify(signal),now);
    }
    put.run('state','hotspotVisibilityRepair20261017',JSON.stringify(report),now);
    if(before!==protectedState())throw Error('恢复意外改变受保护的用户状态');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
writeFileSync(`reports/hotspot-recovery-${applying?'applied':'preview'}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({applied:applying,beforeVisible:report.beforeVisible,visible:report.visible,bilibili:report.bilibili,changes:changes.size,paidCalls:0,backup:report.backup,restored:report.events.filter(item=>changes.has(item.id)).map(item=>({title:item.title,status:item.status,ruleIds:item.ruleIds}))},null,2));
db.close();
