import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Analyzer,reasoningEffortFor,REASONING_POLICY_VERSION, type AnalysisResult } from '../server/ai.js';
import { Store } from '../server/db.js';
import { PublicHttp, checkHttp, type HttpClient, type RequestOptions } from '../server/http.js';
import { config,safeError } from '../server/config.js';
import { evidenceExcerpt,ruleIntent,RELEVANCE_VERSION } from '../shared/relevance.js';
import type { RelevanceLevel,RuleAssessment,Settings } from '../shared/types.js';
import type { EvaluationCase } from '../eval/types.js';
import { metrics } from '../eval/metrics.js';
import { blindLabelSystem,explanationSystem,GRADER_VERSION,applyGraderConstraints,graderFingerprint } from '../eval/grading.js';
import {confirmedReference,type ConfirmedReference} from '../eval/confirmed-references.js';
import {retryableEvaluationFailure} from '../eval/retry.js';

const args=new Set(process.argv.slice(2));
const dataset=JSON.parse(readFileSync('eval/fixtures/relevance.json','utf8')) as {version:number;frozenAt:string;baselineIds?:string[];cases:EvaluationCase[]};
const confirmedReferences=(JSON.parse(readFileSync('eval/fixtures/confirmed-policies.json','utf8')) as {cases:ConfirmedReference[]}).cases;
const ids=process.argv.find(arg=>arg.startsWith('--ids='))?.slice(6).split(',');
const selected=dataset.cases.filter(row=>(!ids||ids.includes(row.id))&&(args.has('--dev')?row.split==='dev':args.has('--holdout')?row.split==='holdout':true));
if(!args.has('--live')) {console.log(JSON.stringify({mode:'inventory',cases:selected.length,origins:Object.fromEntries(['real','synthetic'].map(origin=>[origin,selected.filter(row=>row.origin===origin).length])),note:'Add --live to run paid model evaluation within the configured daily limit.'},null,2));process.exit(0);}
if(!config.aiKey)throw new Error('未配置 OpenRouter，无法运行真实模型评估');
const ledger=new DatabaseSync(`${config.dataDir}/signal.sqlite`,{timeout:5000});
const saved=ledger.prepare('SELECT data FROM objects WHERE space=? AND id=?').get('state','settings');
if(!saved)throw new Error('缺少已保存的模型配置');
const settings=JSON.parse(saved.data as string) as Settings;
const requestLimit=Number(process.env.EVAL_REQUEST_LIMIT||settings.aiDailyLimit);
if(!Number.isInteger(requestLimit)||requestLimit<settings.aiDailyLimit||requestLimit>settings.aiDailyLimit+90)throw Error('临时评估上限须在日常限额至额外 90 次之间，使用前需人工授权');
const http=new PublicHttp();let calls=0,tokens=0;const costs:number[]=[];const requestLog:unknown[]=[];
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function reserve(kind:string,amount:number,limit:number) {
  ledger.exec('BEGIN IMMEDIATE');try {const used=Number(ledger.prepare('SELECT used FROM usage WHERE day=? AND kind=?').get(day(),kind)?.used||0);if(used+amount>limit)throw Error('评估达到已配置的每日调用限额，尚未完成');ledger.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,kind) DO UPDATE SET used=excluded.used').run(day(),kind,used+amount);ledger.exec('COMMIT');}catch(error){ledger.exec('ROLLBACK');throw error;}
}
async function request(body:Record<string,unknown>) {
  reserve('aiRequests',1,requestLimit);calls++;
  const started=Date.now();
  const doc=await http.request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${config.aiKey}`,'Content-Type':'application/json','X-OpenRouter-Title':'FirstCue relevance evaluation'},body:JSON.stringify(body),timeoutMs:180000,maxBytes:2*1024*1024});
  if(doc.status>=400){let message='';try{message=JSON.parse(doc.text).error?.message||'';}catch{}throw Error(`OpenRouter ${doc.status}: ${message.slice(0,300)}`);}
  checkHttp(doc);const raw=JSON.parse(doc.text);if(raw.usage?.total_tokens){tokens+=raw.usage.total_tokens;reserve('aiTokens',raw.usage.total_tokens,Number.MAX_SAFE_INTEGER);}
  if(typeof raw.usage?.cost==='number')costs.push(raw.usage.cost);
  requestLog.push({model:body.model,elapsedMs:Date.now()-started,totalTokens:raw.usage?.total_tokens,reasoningTokens:raw.usage?.completion_tokens_details?.reasoning_tokens,costUSD:raw.usage?.cost??null,finishReason:raw.choices?.[0]?.finish_reason});
  if(raw.error)throw Error(String(raw.error.message||'供应商错误'));
  if(raw.choices?.[0]?.finish_reason==='length')throw Error('评估输出截断');
  return {doc,raw,json:JSON.parse(raw.choices[0].message.content)};
}
const baseline=JSON.parse(readFileSync('eval/fixtures/baseline-contract.json','utf8')) as {system:string;schema:unknown};
const directory='reports/relevance-eval';mkdirSync(directory,{recursive:true});
const contractHash=createHash('sha256').update(readFileSync('server/ai.ts','utf8').replace(/\r\n/g,'\n')).update(readFileSync('server/relevance.ts','utf8').replace(/\r\n/g,'\n')).update(readFileSync('shared/relevance.ts','utf8').replace(/\r\n/g,'\n')).update(readFileSync('server/quality.ts','utf8').replace(/\r\n/g,'\n')).update(JSON.stringify(dataset)).digest('hex');
type Row={id:string;expected:RelevanceLevel;predicted:RelevanceLevel;critical:boolean;origin:string;split:string;assessment?:RuleAssessment;decisionReason?:string;error?:string;displayed?:boolean;attempts?:number;previousErrors?:string[];};
const outputs:{baseline:Row[];current:Row[]}={baseline:[],current:[]};
function cacheFile(key:string){return `${directory}/${createHash('sha256').update(key).digest('hex')}.json`;}
const groups=new Map<string,EvaluationCase[]>();for(const row of selected){const key=row.rule.id+'|'+row.split;groups.set(key,[...(groups.get(key)||[]),row]);}
const batches=[...groups.values()].flatMap(rows=>Array.from({length:Math.ceil(rows.length/10)},(_,i)=>rows.slice(i*10,i*10+10)));
const pool=new Store(':memory:');pool.put('state','settings',{...settings,aiDailyLimit:100000});pool.put('state','modelChecked',{model:settings.model,at:Date.now(),reasoningEffort:'low'});
let modelCatalogue:{id:string;supported_parameters?:string[];reasoning?:{mandatory?:boolean;supported_efforts?:string[]|null};pricing?:{prompt?:string}}[]=[];
try {
  const catalog=await http.request('https://openrouter.ai/api/v1/models',{headers:{Authorization:`Bearer ${config.aiKey}`},maxBytes:8*1024*1024});checkHttp(catalog);modelCatalogue=JSON.parse(catalog.text).data;
  const primary=modelCatalogue.find(item=>item.id===settings.model);if(!primary?.supported_parameters?.includes('structured_outputs'))throw Error('生产模型未声明结构化输出能力');
  pool.put('state','modelChecked',{model:settings.model,at:Date.now(),reasoningEffort:reasoningEffortFor(primary),reasoningPolicyVersion:REASONING_POLICY_VERSION});
  const judgeModel=process.env.EVAL_JUDGE_MODEL||['qwen/qwen3-235b-a22b-2507'].find(id=>id!==settings.model&&modelCatalogue.some(item=>item.id===id&&item.supported_parameters?.includes('structured_outputs')));
  if(judgeModel===settings.model)throw Error('独立评估员必须使用不同模型');
  if(!judgeModel)throw Error('没有可用的独立结构化评估模型，可配置 EVAL_JUDGE_MODEL');
  const graderPromptHash=graderFingerprint();
  const calibrationFile=`${directory}/grader-calibration.json`;
  if(!existsSync(calibrationFile))throw Error('独立评估员尚未校准，请先运行 npm run eval:calibrate -- --live');
  const graderCalibration=JSON.parse(readFileSync(calibrationFile,'utf8'));
  if(!graderCalibration.passed||graderCalibration.model!==judgeModel||graderCalibration.version!==GRADER_VERSION||graderCalibration.promptHash!==graderPromptHash)throw Error('独立评估员校准缺失或过期，不能将本次评估判为通过');
  for(const mode of (args.has('--only-current')?['current']:['baseline','current']) as ('baseline'|'current')[]) {
    let modeBatches=batches;
    if(mode==='baseline'&&args.has('--baseline-dev-only')){const byRule=new Map<string,EvaluationCase[]>();for(const row of selected.filter(row=>dataset.baselineIds?.includes(row.id)??row.split==='dev'))byRule.set(row.rule.id,[...(byRule.get(row.rule.id)||[]),row]);modeBatches=[...byRule.values()].flatMap(rows=>Array.from({length:Math.ceil(rows.length/10)},(_,index)=>rows.slice(index*10,index*10+10)));}
    for(const split of ['dev','holdout']){const lane=modeBatches.filter(batch=>batch[0].split===split);
    for(let start=0;start<lane.length;start+=2) await Promise.all(lane.slice(start,start+2).map(async(batch,localIndex)=>{
      const index=start+localIndex;
      const key=JSON.stringify([mode,mode==='current'?contractHash:baseline,settings.model,batch.map(row=>row.id)]);const file=cacheFile(key);let records:Row[];
      const cached:Row[]|undefined=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;
      // Production keeps failed candidates for up to three attempts. Only execution/schema
      // failures can be retried here; a semantic disagreement never triggers another draw.
      const retryRows=mode==='current'&&args.has('--retry-errors')?cached?.filter(retryableEvaluationFailure)||[]:[];
      const retry=retryRows.length>0;
      if(cached&&!retry)records=cached;
      else {
        if(retry)writeFileSync(file.replace(/\.json$/,`.attempt-${Math.max(...retryRows.map(row=>row.attempts||1))}.json`),JSON.stringify(cached,null,2));
        const activeBatch=retry?batch.filter(row=>retryRows.some(item=>item.id===row.id)):batch;
        let response:any;let result:AnalysisResult|undefined;let error:string|undefined;
        try {
          const evidence=activeBatch.map(row=>row.evidence),rules=[batch[0].rule];
          if(mode==='baseline') {
            response=(await request({model:settings.model,provider:{require_parameters:true},reasoning:{effort:'low',exclude:true},response_format:{type:'json_schema',json_schema:{name:'baseline_verification',strict:true,schema:baseline.schema}},messages:[{role:'system',content:baseline.system.replace(/当前时间 [^。]+。/,'当前时间 '+dataset.frozenAt+'。')},{role:'user',content:JSON.stringify({rules,priorEvents:[],evidence:evidence.map(item=>({...item,text:item.text.slice(0,5000)}))})}],max_tokens:12000})).json;
          }else {
            const transport:HttpClient={request:async(_url:string,options?:RequestOptions)=>{const received=await request(JSON.parse(options!.body!));response=received.json;return received.doc;}};
            result=await new Analyzer(pool,transport,config.aiKey,()=>Date.parse(dataset.frozenAt)).analyze(evidence,rules,[]);
          }
        }catch(failure){error=safeError(failure);if(/402|401|限额/.test(error))throw failure;}
        const fresh=activeBatch.map(row=>{
          const events=response?.events?.filter((item:any)=>item.evidenceIds?.includes(row.evidence.id))||[];const event=events.find((item:any)=>(item.ruleIds||item.ruleAssessments?.filter((entry:any)=>entry.level==='direct').map((entry:any)=>entry.ruleId)||[]).includes(row.rule.id))||events[0];
          const related=result?.signals.filter(item=>item.evidence.some(ev=>ev.id===row.evidence.id))||[];const signal=related.find(item=>item.ruleIds.includes(row.rule.id))||related[0];
          const assessment=signal?.ruleAssessments?.find(item=>item.ruleId===row.rule.id);
          const exclusion=result?.exclusions?.find(item=>item.evidenceId===row.evidence.id);
          const predicted:RelevanceLevel=error?'insufficient':mode==='baseline'?(event?.ruleIds?.includes(row.rule.id)?'direct':'unrelated'):assessment?.level||exclusion?.category||'unrelated';
          const previous=cached?.find(item=>item.id===row.id);
          return {id:row.id,expected:row.expected,predicted,critical:row.critical,origin:row.origin,split:row.split,assessment,decisionReason:assessment?.validationReason||assessment?.reason||exclusion?.reason,error,displayed:!!signal&&!signal.auditOnly&&signal.status!=='rejected',attempts:(previous?.attempts||(previous?1:0))+1,previousErrors:previous?[...(previous.previousErrors||[]),...(previous.error?[previous.error]:previous.decisionReason?[`原文校验失败：${previous.decisionReason}`]:[])]:[]};
        });
        records=batch.map(row=>fresh.find(item=>item.id===row.id)||cached!.find(item=>item.id===row.id)!);
        writeFileSync(file,JSON.stringify(records,null,2));
      }
      // Cached model output is reusable; human-confirmed labels always come from the current fixture.
      records=records.map(record=>({...record,expected:batch.find(row=>row.id===record.id)!.expected}));
      outputs[mode].push(...records);writeFileSync(`${directory}/progress.json`,JSON.stringify({mode,batch:index+1,batches:batches.length,calls,tokens},null,2));
      console.log(`${mode} ${index+1}/${batches.length}: ${records.length} cases${records.find(row=>row.error)?.error?' ('+records.find(row=>row.error)!.error+')':''}`);
    }));
    if(mode==='current'&&split==='dev'&&modeBatches.some(batch=>batch[0].split==='holdout')){const development=outputs.current.filter(row=>row.split==='dev');if(!metrics(development).passed){writeFileSync(`${directory}/failed-dev.json`,JSON.stringify({metrics:metrics(development),outputs:development},null,2));throw Error('调试集未达标，尚未运行保留集');}}
    }
  }
  const levelSchema=z.enum(['direct','weak','unrelated','insufficient']);
  const labelEntry=z.object({level:levelSchema,reason:z.string()});
  type Judgement={id:string;level:RelevanceLevel;reason:string;grounded:boolean;explainsConnection:boolean;coversConstraints:boolean;noUnrelatedClaims:boolean;qualityReason?:string;rawLevel?:string;rawReason?:string;constraintOverride?:string};
  const judgements:Judgement[]=[];
  const original=(row:EvaluationCase)=>({id:row.id,query:row.rule.query,intent:ruleIntent(row.rule),author:row.evidence.author,title:row.evidence.title,url:row.evidence.finalUrl,text:evidenceExcerpt(row.evidence,[row.rule])});
  const labelCaseFile=(row:EvaluationCase)=>cacheFile(JSON.stringify(['blind-label-case-v1',graderPromptHash,judgeModel,original(row)]));
  const judgeBatches=['dev','holdout'].flatMap(split=>{const rows=selected.filter(row=>row.split===split);return Array.from({length:Math.ceil(rows.length/64)},(_,i)=>rows.slice(i*64,i*64+64));});
  for(const [judgeIndex,batch] of judgeBatches.entries()){
    const cases=batch.map(original);const file=cacheFile(JSON.stringify(['blind-label-v1',graderPromptHash,judgeModel,cases]));
    let judged:{id:string;level:RelevanceLevel;reason:string}[];
    if(batch.every(row=>existsSync(labelCaseFile(row))))judged=batch.map(row=>JSON.parse(readFileSync(labelCaseFile(row),'utf8')));
    else if(existsSync(file))judged=JSON.parse(readFileSync(file,'utf8'));
    else{
      const pending=batch.filter(row=>!existsSync(labelCaseFile(row)));
      const responseSchema=z.object({results:z.object(Object.fromEntries(pending.map(row=>[row.id,labelEntry])))});
      const schema=z.toJSONSchema(responseSchema);delete (schema as any).$schema;
      const reply=await request({model:judgeModel,provider:{require_parameters:true},response_format:{type:'json_schema',json_schema:{name:'blind_labels',strict:true,schema}},messages:[{role:'system',content:blindLabelSystem},{role:'user',content:JSON.stringify({responseSchema:schema,cases:pending.map(original)})}],max_tokens:18000});
      const fresh=Object.entries(responseSchema.parse(reply.json).results).map(([id,row])=>({id,...row}));
      judged=batch.map(row=>fresh.find(item=>item.id===row.id)||JSON.parse(readFileSync(labelCaseFile(row),'utf8')));writeFileSync(file,JSON.stringify(judged,null,2));
    }
    if(judged.length!==batch.length||new Set(judged.map(row=>row.id)).size!==batch.length||judged.some(row=>!batch.some(item=>item.id===row.id)))throw Error('独立盲审遗漏或虚构样本编号');
    for(const row of judged)if(!existsSync(labelCaseFile(batch.find(item=>item.id===row.id)!)))writeFileSync(labelCaseFile(batch.find(item=>item.id===row.id)!),JSON.stringify(row,null,2));
    judgements.push(...judged.map(item=>{const row=batch.find(row=>row.id===item.id)!;return {...applyGraderConstraints(row.rule.query,row.evidence.title+' '+row.evidence.text,item),grounded:false,explainsConnection:false,coversConstraints:false,noUnrelatedClaims:false};}));
    console.log(`blind labels ${judgeIndex+1}/${judgeBatches.length}`);
  }
  // One bounded second blind pass for disagreements, with the same rubric and no labels
  // or production answers in the request. Preserve both passes; never loop until agreement.
  const initialBlindDisagreements=judgements.filter(row=>(row.level==='direct')!==(selected.find(item=>item.id===row.id)!.expected==='direct')).map(row=>({...row}));
  const needsAdjudication=initialBlindDisagreements.filter(item=>!confirmedReference(selected.find(row=>row.id===item.id)!,confirmedReferences));
  const adjudicationAudit:{id:string;before:string;after:string;reason:string}[]=[];
  for(let start=0;start<needsAdjudication.length;start+=8){
    const batch=needsAdjudication.slice(start,start+8).map(item=>selected.find(row=>row.id===item.id)!);
    const cases=batch.map(original),file=cacheFile(JSON.stringify(['blind-adjudication-v1',graderPromptHash,judgeModel,cases]));
    let judged:{id:string;level:RelevanceLevel;reason:string}[];
    if(existsSync(file))judged=JSON.parse(readFileSync(file,'utf8'));
    else{
      const responseSchema=z.object({results:z.object(Object.fromEntries(batch.map(row=>[row.id,labelEntry])))});const schema=z.toJSONSchema(responseSchema);delete (schema as any).$schema;
      const reply=await request({model:judgeModel,provider:{require_parameters:true},response_format:{type:'json_schema',json_schema:{name:'blind_adjudication',strict:true,schema}},messages:[{role:'system',content:blindLabelSystem},{role:'user',content:JSON.stringify({responseSchema:schema,cases})}],max_tokens:9000});
      judged=Object.entries(responseSchema.parse(reply.json).results).map(([id,row])=>({id,...row}));writeFileSync(file,JSON.stringify(judged,null,2));
    }
    if(judged.length!==batch.length||new Set(judged.map(row=>row.id)).size!==batch.length||judged.some(row=>!batch.some(item=>item.id===row.id)))throw Error('独立复核遗漏或虚构样本编号');
    for(const raw of judged){const row=batch.find(item=>item.id===raw.id)!;const checked=applyGraderConstraints(row.rule.query,row.evidence.title+' '+row.evidence.text,raw);const target=judgements.find(item=>item.id===row.id)!;adjudicationAudit.push({id:row.id,before:target.level,after:checked.level,reason:checked.reason});Object.assign(target,checked);writeFileSync(labelCaseFile(row),JSON.stringify(raw,null,2));}
    console.log(`blind adjudication ${Math.floor(start/8)+1}/${Math.ceil(needsAdjudication.length/8)}`);
  }
  const qualityEntry=z.object({reason:z.string(),grounded:z.boolean(),explainsConnection:z.boolean(),coversConstraints:z.boolean(),noUnrelatedClaims:z.boolean()});
  const explanations=outputs.current.filter(row=>row.predicted==='direct').sort((a,b)=>a.id.localeCompare(b.id));
  for(let start=0;start<explanations.length;start+=64){
    const batch=explanations.slice(start,start+64);const cases=batch.map(row=>({...original(selected.find(item=>item.id===row.id)!),assessment:row.assessment,supportingEvidence:[...new Map((row.assessment?.citations||[]).flatMap(citation=>selected.filter(item=>item.evidence.id===citation.evidenceId).map(item=>[item.evidence.id,original(item)] as const))).values()]}));
    const file=cacheFile(JSON.stringify(['explanation-v1',graderPromptHash,judgeModel,cases]));
    let graded:{id:string;reason:string;grounded:boolean;explainsConnection:boolean;coversConstraints:boolean;noUnrelatedClaims:boolean}[];
    if(existsSync(file))graded=JSON.parse(readFileSync(file,'utf8'));
    else{
      const responseSchema=z.object({results:z.object(Object.fromEntries(batch.map(row=>[row.id,qualityEntry])))});const schema=z.toJSONSchema(responseSchema);delete (schema as any).$schema;
      const reply=await request({model:judgeModel,provider:{require_parameters:true},response_format:{type:'json_schema',json_schema:{name:'explanation_quality',strict:true,schema}},messages:[{role:'system',content:explanationSystem},{role:'user',content:JSON.stringify({responseSchema:schema,cases})}],max_tokens:16000});
      graded=Object.entries(responseSchema.parse(reply.json).results).map(([id,row])=>({id,...row}));writeFileSync(file,JSON.stringify(graded,null,2));
    }
    if(graded.length!==batch.length||new Set(graded.map(row=>row.id)).size!==batch.length||graded.some(row=>!batch.some(item=>item.id===row.id)))throw Error('解释质量盲审遗漏或虚构编号');
    for(const row of graded){const target=judgements.find(item=>item.id===row.id)!;Object.assign(target,{grounded:row.grounded,explainsConnection:row.explainsConnection,coversConstraints:row.coversConstraints,noUnrelatedClaims:row.noUnrelatedClaims,qualityReason:row.reason});}
    console.log(`explanation quality ${Math.floor(start/64)+1}/${Math.ceil(explanations.length/64)}`);
  }
  const rawDisagreements=judgements.filter(row=>(row.level==='direct')!==(selected.find(item=>item.id===row.id)!.expected==='direct'));
  const policyResolutions=rawDisagreements.flatMap(item=>{const reference=confirmedReference(selected.find(row=>row.id===item.id)!,confirmedReferences);return reference?[{id:item.id,modelLevel:item.level,referenceLevel:reference.level,reason:reference.reason,inputHash:reference.inputHash,authority:reference.authority}]:[];});
  const disagreements=rawDisagreements.filter(item=>!policyResolutions.some(reference=>reference.id===item.id));
  const kept=outputs.current.filter(row=>row.predicted==='direct');const quality=kept.map(row=>judgements.find(item=>item.id===row.id)!).filter(Boolean);const qualityPass=quality.filter(row=>row.grounded&&row.explainsConnection&&row.coversConstraints&&row.noUnrelatedClaims).length;
  const stability:{repeat:number;sonnetMatched:boolean;broadMatched:boolean}[]=[];
  if(!ids && !args.has('--dev'))for(let repeat=0;repeat<3;repeat++) {
    const sample=dataset.cases.find(row=>row.id==='synthetic-0')!;const broad=dataset.cases.find(row=>row.rule.query==='AI coding agents')!.rule;
    const evidence={...sample.evidence,text:'OpenClaw released a new coding agent scheduler with parallel repository tasks and detailed execution reports. No model provider or version is specified.'};
    const file=cacheFile(JSON.stringify(['stability-v1',contractHash,settings.model,repeat]));let record:typeof stability[number];
    if(existsSync(file))record=JSON.parse(readFileSync(file,'utf8'));
    else {const transport:HttpClient={request:async(_url,options)=>{const response=await request(JSON.parse(options!.body!));return response.doc;}};
      const result=await new Analyzer(pool,transport,config.aiKey,()=>Date.parse(dataset.frozenAt)).analyze([evidence],[sample.rule,broad],[]);
      record={repeat:repeat+1,sonnetMatched:result.signals.some(item=>item.ruleIds.includes(sample.rule.id)),broadMatched:result.signals.some(item=>item.ruleIds.includes(broad.id))};writeFileSync(file,JSON.stringify(record));}
    stability.push(record);console.log(`stability ${repeat+1}/3`);
  }
  const pairedIds=new Set(outputs.baseline.map(row=>row.id));
  const report={pairedComparison:{cases:pairedIds.size,baseline:metrics(outputs.baseline),current:metrics(outputs.current.filter(row=>pairedIds.has(row.id)))},at:new Date().toISOString(),contractHash,model:settings.model,judgeModel,graderCalibration,datasetVersion:dataset.version,cases:selected.length,callsThisRun:calls,tokensThisRun:tokens,costThisRunUSD:costs.length===calls?costs.reduce((sum,value)=>sum+value,0):null,requestLog,baseline:metrics(outputs.baseline),current:metrics(outputs.current),holdout:metrics(outputs.current.filter(row=>row.split==='holdout')),origins:Object.fromEntries(['real','synthetic'].map(origin=>[origin,metrics(outputs.current.filter(row=>row.origin===origin))])),quality:{evaluated:quality.length,passed:qualityPass,rate:quality.length?qualityPass/quality.length:null},calibration:{disagreements,fullyCalibrated:disagreements.length===0},stability,failures:outputs.current.filter(row=>row.error||((row.expected==='direct')!==(row.predicted==='direct'))),outputs,judgements,accepted:false};
  Object.assign(report,{retryAudit:outputs.current.filter(row=>row.previousErrors?.length).map(row=>({id:row.id,attempts:row.attempts,previousErrors:row.previousErrors,finalError:row.error||null})),blindAudit:{initialDisagreements:initialBlindDisagreements.map(({id,level,reason})=>({id,level,reason})),adjudicationAudit,unresolved:disagreements.length}});
  Object.assign(report.calibration,{fullyCalibrated:rawDisagreements.length===0,rawDisagreements,policyResolutions,unresolved:disagreements.length});
  Object.assign(report,{protocolHash:createHash('sha256').update(['scripts/evaluate-relevance.ts','eval/grading.ts','eval/metrics.ts','eval/confirmed-references.ts','eval/retry.ts','eval/fixtures/confirmed-policies.json'].map(file=>readFileSync(file,'utf8').replace(/\r\n/g,'\n')).join('')).digest('hex')});
  report.accepted=report.current.passed&&report.holdout.passed&&quality.length>=10&&qualityPass/quality.length>=0.95&&disagreements.length===0&&stability.length===3&&stability.every(row=>!row.sonnetMatched&&row.broadMatched);
  writeFileSync(`${directory}/${ids?'probe':args.has('--dev')?'dev':args.has('--holdout')?'holdout':'report'}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({accepted:report.accepted,baseline:report.baseline,current:report.current,quality:report.quality,calibrationDisagreements:disagreements.length,calls,tokens},null,2));
}catch(error){writeFileSync(`${directory}/incomplete.json`,JSON.stringify({at:new Date().toISOString(),error:safeError(error),calls,tokens,requestLog,completed:{baseline:outputs.baseline.length,current:outputs.current.length}},null,2));throw error;}
finally{pool.close();ledger.close();await http.close();}
