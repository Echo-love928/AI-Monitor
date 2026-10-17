import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { z } from 'zod';
import { config,safeError } from '../server/config.js';
import { PublicHttp,checkHttp } from '../server/http.js';
import { graderAnchors,blindLabelSystem,GRADER_VERSION,applyGraderConstraints,graderFingerprint,calibrationResult } from '../eval/grading.js';
if(process.argv.includes('--recheck')){
 const file='reports/relevance-eval/grader-calibration.json';const report=JSON.parse(readFileSync(file,'utf8'));
 if(report.version!==GRADER_VERSION||report.promptHash!==graderFingerprint())throw Error('缓存校准契约过期');
 Object.assign(report,calibrationResult(report.results));writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exit(report.passed?0:1);
}
if(!process.argv.includes('--live')){console.log('Use --live to calibrate the independent grader against fixed anchors.');process.exit(0);}
const model=process.env.EVAL_JUDGE_MODEL||'qwen/qwen3-235b-a22b-2507';
const db=new DatabaseSync(`${config.dataDir}/signal.sqlite`,{timeout:5000});
const settings=JSON.parse(db.prepare('SELECT data FROM objects WHERE space=? AND id=?').get('state','settings')!.data as string);
const requestLimit=Number(process.env.EVAL_REQUEST_LIMIT||settings.aiDailyLimit);
if(!Number.isInteger(requestLimit)||requestLimit<settings.aiDailyLimit||requestLimit>settings.aiDailyLimit+90)throw Error('临时验收额度超出授权范围');
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
db.exec('BEGIN IMMEDIATE');try{const used=Number(db.prepare('SELECT used FROM usage WHERE day=? AND kind=?').get(day,'aiRequests')?.used||0);if(used>=requestLimit)throw Error('已达每日调用限额');db.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,kind) DO UPDATE SET used=excluded.used').run(day,'aiRequests',used+1);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
const entry=z.object({level:z.enum(['direct','weak','unrelated','insufficient']),reason:z.string()});
const schema=z.object({results:z.object(Object.fromEntries(graderAnchors.map(row=>[row.id,entry])))});const json=z.toJSONSchema(schema);delete (json as any).$schema;
const http=new PublicHttp();try{
  const doc=await http.request('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${config.aiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,provider:{require_parameters:true},...(model.includes('qwen3.5')?{reasoning:{enabled:false,exclude:true}}:{}),response_format:{type:'json_schema',json_schema:{name:'grader_calibration',strict:true,schema:json}},messages:[{role:'system',content:blindLabelSystem},{role:'user',content:JSON.stringify({responseSchema:json,cases:graderAnchors.map(({expected,...row})=>row)})}],max_tokens:5000}),timeoutMs:90000});if(doc.status>=400)throw Error(safeError('OpenRouter '+doc.status+': '+doc.text.slice(0,1600)));checkHttp(doc);const raw=JSON.parse(doc.text);if(raw.usage?.total_tokens)db.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,kind) DO UPDATE SET used=used+excluded.used').run(day,'aiTokens',raw.usage.total_tokens);
  const rawResults=Object.entries(schema.parse(JSON.parse(raw.choices[0].message.content)).results).map(([id,row])=>({id,...row}));
  const results=rawResults.map(row=>{const anchor=graderAnchors.find(item=>item.id===row.id)!;return applyGraderConstraints(anchor.query,anchor.text,row);});
  const report={model,version:GRADER_VERSION,promptHash:graderFingerprint(),...calibrationResult(results),rawResults,results,at:new Date().toISOString()};mkdirSync('reports/relevance-eval',{recursive:true});writeFileSync('reports/relevance-eval/grader-calibration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}finally{db.close();await http.close();}
