import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Analyzer, analysisSchema, analysisSchemaFor, parseAnalysisOutput, validateBatch,reasoningEffortFor } from '../server/ai.js';
import { makeEvidence } from '../server/parse.js';
import { applyQuality } from '../server/quality.js';
import { Store } from '../server/db.js';
import { dashboard } from '../server/app.js';
import { eligible } from '../server/mail.js';
import { currentSignal } from '../shared/freshness.js';
import { analysisFingerprint, evidenceExcerpt, includesTarget, matchesRule, needsAnalysis, queryVariants, ruleIntent } from '../shared/relevance.js';
import { xQueryFor, discoverySearches } from '../server/search.js';
import type { Candidate, Rule, Source } from '../shared/types.js';
import { evaluationWithoutFindings,withdrawExcludedMatches } from '../server/relevance.js';

const date=new Date(Date.now()-60000).toISOString();
const rule:Rule={id:'sonnet',name:'any label',query:'Claude Sonnet 4.6',kind:'keyword',enabled:true,notify:true,createdAt:date,baselineAt:new Date(Date.now()-3600000).toISOString(),nextRunAt:date,lastRunAt:null};
const broad:Rule={...rule,id:'broad',kind:'topic',query:'AI coding agents'};
const source:Source={id:'twitter',name:'X',kind:'x',url:'https://api.twitterapi.io',enabled:true,official:false};
test('评测任务数量和结果另行发布不替代已取得发现，数值结果、定性发现及能力变化保留',()=>{
  assert.equal(evaluationWithoutFindings('A benchmark measured coding agents on 100 repository bug-fixing tasks and published reproducible results.'),true);
  assert.equal(evaluationWithoutFindings('我们评测了 Sonnet 4.6，并报告工具调用准确率。'),true);
  assert.equal(evaluationWithoutFindings('We tested Sonnet 4.6 and published results: accuracy was 85%.'),false);
  assert.equal(evaluationWithoutFindings('We tested Sonnet 4.6 and published a report: it failed repository tasks.'),false);
  assert.equal(evaluationWithoutFindings('The new tool adds automatic test execution; its benchmark report is available.'),false);
});
function evidence(text='OpenClaw released support for Claude Sonnet 4.6 with parallel tool execution and substantially lower latency for coding tasks.') {
  return applyQuality(makeEvidence(source,{url:'https://x.com/fixture/status/123',title:'Agent integration update',text,publishedAt:date,original:true,postType:'original',likes:20,reposts:10,views:1000,authorFollowers:500}));
}
function request(text?:string) {
  const ev=evidence(text);
  const assessment={ruleId:rule.id,level:'direct',reason:'本次集成明确新增对目标版本的支持，并说明工具执行变化。',summary:'OpenClaw 新增 Sonnet 4.6 集成并说明并行工具执行变化，目前只有第三方帖子。',matchedEntity:'Sonnet',matchedVersion:'4.6',matchedAction:'integration',unmetConstraints:[],citations:[{evidenceId:ev.id,quote:ev.text.slice(0,300)}]};
  return {ev,data:analysisSchema.parse({events:[{title:'Agent integration update',summary:assessment.summary,entity:'OpenClaw',version:'1',eventType:'integration',occurredAt:date,isNewsworthy:true,isNewEvent:true,status:'pending',reason:'Third party source',attention:50,attentionReason:'Concrete feature',importance:'medium',importanceReason:'Integration',tags:[],evidenceIds:[ev.id],ruleIds:[rule.id],ruleAssessments:[assessment],existingEventId:null}],excludedEvidenceIds:[],exclusions:[]})};
}
test('无 Sonnet 4.6 的 OpenClaw 不能因模型填了编号就通过审核',()=>{
  const {ev,data}=request('OpenClaw released parallel scheduling and detailed task reporting for its coding agents.');
  const result=validateBatch(data,[ev],[rule],[]);assert.equal(currentSignal(result.signals[0]),false);assert.deepEqual(result.signals[0].ruleIds,[]);assert.equal(result.signals[0].ruleAssessments![0].level,'insufficient');assert.equal(result.issues!.length,1);
});
test('真实直接集成待核实可保留；弱相关即使含有准确型号也不保留',()=>{
  const {ev,data}=request();const kept=validateBatch(data,[ev],[rule],[]).signals[0];assert.equal(currentSignal(kept),true);assert.equal(kept.status,'pending');assert.equal(matchesRule(kept,rule),true);
  data.events[0].ruleAssessments[0].level='weak';data.events[0].ruleAssessments[0].summary='';data.events[0].ruleIds=[];
  assert.equal(currentSignal(validateBatch(data,[ev],[rule],[]).signals[0]),false);
});
test('引用虚构、其他事件证据和跨段拼接型号均不通过',()=>{
  for(const patch of ['fake','foreign','distant']) {
    const {ev,data}=request(patch==='distant'?'Claude Sonnet is available. '+ 'Unrelated context. '.repeat(45)+'Version 4.6 is the OpenClaw version.':undefined);
    if(patch==='fake')data.events[0].ruleAssessments[0].citations[0].quote='Sonnet 4.6 fabricated benchmark result';
    if(patch==='foreign')data.events[0].ruleAssessments[0].citations[0].evidenceId='foreign';
    const result=validateBatch(data,[ev],[rule],[]).signals[0];assert.equal(currentSignal(result),false);
  }
});
test('型号边界：4.60、4.6.1 和其他版本不当成4.6；真实版本对比可匹配',()=>{
  for(const version of ['4.60','4.6.1','4.5']) {const {ev,data}=request(`Claude Sonnet ${version} gained a new tool execution capability.`);assert.equal(currentSignal(validateBatch(data,[ev],[rule],[]).signals[0]),false);}
  const intent=ruleIntent(rule);assert.equal(includesTarget('Sonnet4.6 beat Sonnet 4.5 in this measured test.',intent),true);assert.equal(includesTarget('claude-sonnet-4-6',intent),false);
});
test('重新审核能撤销旧的精确匹配，同时保留另一个真正命中的规则',()=>{
  const {ev,data}=request();const first=validateBatch(data,[ev],[rule,broad],[]).signals[0];
  data.events[0].existingEventId=first.id;data.events[0].ruleIds=[broad.id];data.events[0].ruleAssessments=[{...data.events[0].ruleAssessments[0],level:'weak',summary:''},{...data.events[0].ruleAssessments[0],ruleId:broad.id,matchedVersion:'',level:'direct'}];
  const next=validateBatch(data,[ev],[rule,broad],[first]).signals[0];assert.deepEqual(next.ruleIds,[broad.id]);assert.equal(matchesRule(next,rule),false);assert.equal(matchesRule(next,broad),true);assert.equal(eligible({...next,status:'confirmed'},rule),false);
});
test('规则查询改变会使缓存失效、撤销列表和邮件匹配；仅改显示名称不影响',()=>{
  const {ev,data}=request();const first=validateBatch(data,[ev],[rule],[]).signals[0];
  const candidate:Candidate={...ev,attempts:1,processedHash:ev.contentHash,analysisFingerprint:analysisFingerprint([rule])};
  assert.equal(needsAnalysis(candidate,[rule]),false);assert.equal(needsAnalysis(candidate,[{...rule,name:'changed'}]),false);
  const changed={...rule,query:'Claude Sonnet 4.5'};assert.equal(needsAnalysis(candidate,[changed]),true);assert.equal(matchesRule(first,changed),false);
  const store=new Store(':memory:');try{store.put('rules',rule.id,changed);store.put('events',first.id,first);assert.equal(dashboard(store).events.length,0);}finally{store.close();}
});
test('纯产品查询不添加发布条件，发布意图保留；扩展不扩大实体版本并遵守预算',()=>{
  assert.equal(queryVariants(rule).length,3);for(const query of queryVariants(rule))assert.match(query,/sonnet\s*4\.6/i);
  assert.doesNotMatch(xQueryFor(rule),/release OR/);assert.match(xQueryFor({...rule,query:'Claude new model'}),/release OR update/);
  const jobs=discoverySearches([rule],[{...source,id:'bing',kind:'web',url:'https://www.bing.com/search'}],2,9);assert.ok(jobs.length<=2);assert.ok(jobs.every(job=>job.ruleId===rule.id&&/sonnet\s*4\.6/i.test(job.query)));
});
test('正文后部目标段落进入审核上下文，摘要截断不会静默丢失目标',()=>{
  const ev=evidence('Background. '.repeat(500)+'Claude Sonnet 4.6 added parallel tool execution in OpenClaw. '+ 'More background. '.repeat(100));
  const text=evidenceExcerpt(ev,[rule]);assert.ok(text.length<=5000);assert.match(text,/Sonnet 4\.6 added parallel/);
});
test('宽泛领域没有字面查询词时仍读取足额长文，保留开头之后的具体结果',()=>{
  const ev=evidence('Background. '.repeat(130)+'Codex fixed a repository bug and ran the test suite successfully. '+ 'More background. '.repeat(300));
  const text=evidenceExcerpt(ev,[broad]);assert.equal(text.length,5000);assert.match(text,/Codex fixed a repository bug/);
});
test('无理由排除不接受；insufficient 与 unrelated 独立记录',()=>{
  const {ev}=request();assert.throws(()=>validateBatch(analysisSchema.parse({events:[],excludedEvidenceIds:[ev.id]}),[ev],[rule],[]),/逐条提供原因/);
  const parsed=analysisSchema.parse({events:[],excludedEvidenceIds:[ev.id],exclusions:[{evidenceId:ev.id,category:'insufficient',reason:'Missing readable source'}]});assert.equal(validateBatch(parsed,[ev],[rule],[]).exclusions![0].category,'insufficient');
});
test('模型误把没有结果的评测介绍判为 direct，解析与最终校验都撤销该匹配',()=>{
  const {ev,data}=request('We tested Claude Sonnet 4.6 on a coding benchmark and published all prompts and results.');
  const parsed=parseAnalysisOutput({materials:{[ev.id]:{events:data.events,exclusion:null}}},[ev],[rule]);
  assert.equal(parsed.events.length,0);assert.equal(parsed.exclusions[0].category,'weak');
  const checked=validateBatch(data,[ev],[rule],[]).signals[0];assert.equal(checked.ruleIds.length,0);assert.equal(checked.auditOnly,true);
});
test('历史迁移留快照、不通知、不改暂停开关，并且幂等',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'relevance-'));const filename=path.join(directory,'test.sqlite');let store=new Store(filename);
  try {const {ev,data}=request();const old=validateBatch(data,[ev],[rule],[]).signals[0];store.put('events',old.id,old);store.put('rules',rule.id,{...rule,enabled:false});store.remove('state','relevanceVersion');store.close();store=new Store(filename);
    assert.equal(store.list('relevance-audit-v1').length,1);assert.equal(store.get<Rule>('rules',rule.id)!.enabled,false);const migrated=store.get<typeof old>('events',old.id)!;assert.equal(migrated.auditOnly,true);assert.equal(migrated.relevanceRechecked,true);assert.equal(eligible({...old,relevanceRechecked:true},rule),false);
    store.close();store=new Store(filename);assert.equal(store.list('relevance-audit-v1').length,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test('生产结构化契约直接限制证据和规则编号，实测回归线索不会被前置漏收',()=>{
  const {ev,data}=request();const schema=analysisSchemaFor([ev],[rule]);const output={materials:{[ev.id]:{events:data.events,exclusion:null}}};assert.equal(schema.safeParse(output).success,true);
  const fake=structuredClone(output);fake.materials[ev.id].events[0].ruleAssessments[0].citations[0].evidenceId='invented';assert.equal(schema.safeParse(fake).success,false);
  const uncited=structuredClone(output);uncited.materials[ev.id].events[0].ruleAssessments[0].citations=[];assert.equal(schema.safeParse(uncited).success,false);
  for(const body of ['A new controlled test found Sonnet 4.6 solved 82 tasks compared with 65 before.','We measured a regression in Claude Sonnet 4.6: 19 of 100 tool calls now fail.'])assert.equal(evidence(body).quality?.decision,'eligible');
});

test('正文指纹变化使旧匹配失效，互动数据变化不影响已审核引用',()=>{
  const {ev,data}=request();const saved=validateBatch(data,[ev],[rule],[]).signals[0];assert.equal(matchesRule(saved,rule),true);
  assert.equal(matchesRule({...saved,evidence:saved.evidence.map(item=>({...item,likes:999}))},rule),true);
  assert.equal(matchesRule({...saved,evidence:saved.evidence.map(item=>({...item,contentHash:'changed'}))},rule),false);
});
test('模型整条排除时也能撤销旧匹配，不要求模型额外返回被拒事件',()=>{
  const {ev,data}=request();const saved=validateBatch(data,[ev],[rule],[]).signals[0];
  const excluded=[{evidenceId:ev.id,category:'weak' as const,reason:'重新审核：只是配置清单提及，没有实质变化'}];
  const [withdrawn]=withdrawExcludedMatches([saved],excluded,[ev],[rule]);assert.deepEqual(withdrawn.ruleIds,[]);assert.equal(currentSignal(withdrawn),false);assert.equal(eligible({...withdrawn,status:'confirmed'},rule),false);
  assert.deepEqual(withdrawExcludedMatches([saved],excluded,[ev],[broad]),[]);
});
test('生成契约从当前材料自动派生证据编号与规则匹配，单一归属不再依赖事件编号',()=>{
  const {ev,data}=request();const raw=structuredClone(data);raw.events[0].ruleIds=[];
  const parsed=parseAnalysisOutput({materials:{[ev.id]:{events:raw.events,exclusion:null}}},[ev],[rule]);assert.deepEqual(parsed.events[0].ruleIds,[rule.id]);assert.deepEqual(parsed.events[0].evidenceIds,[ev.id]);
  const excluded=parseAnalysisOutput({materials:{[ev.id]:{events:[],exclusion:{reason:'No direct relation',category:'unrelated'}}}},[ev],[rule]);assert.deepEqual(excluded.excludedEvidenceIds,[ev.id]);
});

test('材料没有准确型号时直接拦截，不消耗模型请求也不臆造关键词关联',async()=>{
  const store=new Store(':memory:');try{const ev=evidence('OpenClaw released a new agent scheduler with parallel tasks and status reports.');let calls=0;
    const result=await new Analyzer(store,{request:async()=>{calls++;throw Error('must not call');}},'').analyze([ev],[rule],[]);
    assert.equal(calls,0);assert.deepEqual(result.signals,[]);assert.equal(result.exclusions![0].category,'unrelated');
  }finally{store.close();}
});

test('生成契约要求每条材料有结论，冲突只隔离对应材料',()=>{
  const {ev,data}=request();
  assert.throws(()=>parseAnalysisOutput({materials:{}},[ev],[rule]));
  const second={...ev,id:'second'};
  const output=parseAnalysisOutput({materials:{[ev.id]:{events:data.events,exclusion:null},second:{events:[],exclusion:null}}},[ev,second],[rule]);
  assert.equal(output.events.length,1);assert.deepEqual(output.events[0].evidenceIds,[ev.id]);
  assert.equal(output.exclusions[0].category,'insufficient');assert.equal(output.exclusions[0].evidenceId,'second');
  const conflicting=parseAnalysisOutput({materials:{[ev.id]:{events:data.events,exclusion:{category:'weak',reason:'Conflicting assignment'}}}},[ev],[rule]);
  assert.equal(conflicting.events.length,0);assert.equal(conflicting.exclusions[0].category,'insufficient');
});

test('同一事件在多条材料下返回时合并证据，不覆盖另一条真实来源',()=>{
  const {ev,data}=request();const second={...ev,id:'second'};
  const next=structuredClone(data.events);next[0].ruleAssessments[0].citations[0].evidenceId='second';
  const output=parseAnalysisOutput({materials:{[ev.id]:{events:data.events,exclusion:null},second:{events:next,exclusion:null}}},[ev,second],[rule]);
  assert.equal(output.events.length,1);assert.deepEqual(new Set(output.events[0].evidenceIds),new Set([ev.id,'second']));
});

test('逐材料审核不能借别条的型号引用保留本条无关内容',()=>{
  const {ev,data}=request();const other={...ev,id:'other'};
  const unrelated={...ev,text:'OpenClaw released a scheduler with parallel tasks, without naming a model.'};
  const foreign=structuredClone(data.events);foreign[0].ruleAssessments[0].citations[0].evidenceId=other.id;
  const output=parseAnalysisOutput({materials:{[ev.id]:{events:foreign,exclusion:null},other:{events:[],exclusion:{category:'weak',reason:'Background only'}}}},[unrelated,other],[rule]);
  assert.equal(output.events.length,0);assert.equal(output.exclusions.find(item=>item.evidenceId===ev.id)!.category,'insufficient');
});

test('同一作者同一天的不同视频不因事件字段相同而合并',()=>{
  const {ev,data}=request();const second={...ev,id:'second',finalUrl:'https://www.bilibili.com/video/BVtwo/'};
  ev.finalUrl='https://www.bilibili.com/video/BVone/';
  const next=structuredClone(data.events);next[0].ruleAssessments[0].citations[0].evidenceId='second';
  const output=parseAnalysisOutput({materials:{[ev.id]:{events:data.events,exclusion:null},second:{events:next,exclusion:null}}},[ev,second],[rule]);
  assert.equal(output.events.length,2);
});

test('真实性待核实不能伪装为目标约束不满足',()=>{
  const {data}=request();
  const invalid=structuredClone(data) as any;
  invalid.events[0].ruleAssessments[0].unmetConstraints=['missing official confirmation'];
  assert.equal(analysisSchema.safeParse(invalid).success,false);
});

test('仅使用模型明确支持的低推理档位，不向其他模型发送未声明参数',()=>{
  assert.equal(reasoningEffortFor({supported_parameters:['reasoning'],reasoning:{mandatory:false,supported_efforts:['none','low']}}),'low');
  assert.equal(reasoningEffortFor({supported_parameters:['reasoning'],reasoning:{mandatory:true,supported_efforts:['low']}}),'low');
  assert.equal(reasoningEffortFor({supported_parameters:['structured_outputs']}),null);
});

test('作者作品核对发布者，不能用正文中提及作者冒充本人作品',()=>{
  const {ev,data}=request('Another creator published a video about 程序员鱼皮 and his programming tools.');
  const video={...rule,query:'程序员鱼皮的视频'};
  Object.assign(ev,{sourceKind:'web',contentKind:'article',author:'另一位作者',authorName:'另一位作者',finalUrl:'https://www.bilibili.com/video/BVfixture/'});
  data.events[0].ruleAssessments[0].matchedVersion='';
  assert.equal(validateBatch(data,[ev],[video],[]).signals[0].ruleAssessments![0].level,'insufficient');
});

test('英文故障、测量和代码执行线索进入语义审核，不被前置词表漏收',()=>{
  for(const text of [
    'The new integration does not support Sonnet 4.6 streaming; requests fail with an unsupported-operation error.',
    'We migrated from Sonnet 4.6 after measuring latency at 8 seconds over 500 requests.',
    'Sonnet 4.6 fails more often on a new security test with full samples and error counts.',
    'The new agent builds 3D programs through executable code, then runs and verifies them automatically.',
  ])assert.equal(evidence(text).quality?.decision,'eligible');
});
