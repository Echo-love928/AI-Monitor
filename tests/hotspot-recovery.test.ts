import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer,analysisSchema,creatorVideoFallback,validateBatch,type Analysis } from '../server/ai.js';
import { Store } from '../server/db.js';
import { Runner } from '../server/runner.js';
import { Collector,ingest } from '../server/sources.js';
import { makeEvidence } from '../server/parse.js';
import { applyQuality } from '../server/quality.js';
import { creatorVideoMatches,validateRelevance } from '../server/relevance.js';
import { currentSignal } from '../shared/freshness.js';
import { DEFAULT_TIME_RANGE,selectSignals } from '../shared/feed.js';
import { matchesRule } from '../shared/relevance.js';
import type { Evidence,Rule,Source } from '../shared/types.js';

const now=Date.now(),publishedAt=new Date(now-3*86400000).toISOString();
const creator:Rule={id:'creator',name:'作者作品',query:'程序员鱼皮的视频或者编程导航内容',kind:'keyword',enabled:true,notify:false,createdAt:publishedAt,baselineAt:null,nextRunAt:publishedAt,lastRunAt:null};
const kate:Rule={...creator,id:'kate',query:'B站up主 kate人不错的视频'};
const coding:Rule={...creator,id:'coding',query:'AI coding agents',kind:'topic'};
const source:Source={id:'bilibili',name:'B站',kind:'web',url:'https://www.bilibili.com/',enabled:true,official:false};
function video(id='BV1abc123',patch:Partial<Evidence>={}):Evidence {
  return applyQuality({...makeEvidence(source,{url:`https://www.bilibili.com/video/${id}/`,title:'创业三年半，我们要搬家了',text:'[B站公开视频简介，未读取视频或字幕] 鱼皮工作室这次介绍创业三年半后的搬家过程和工作室生活。这是作者近期发布的工作室 vlog。',author:'程序员鱼皮',original:true,publishedAt}),...patch},[],now);
}
function event(ev:Evidence,rule=creator):Analysis {
  return analysisSchema.parse({events:[{title:ev.title,summary:'作者发布近期作品，已取得公开视频简介，尚未读取完整视频。',entity:ev.author,version:'',eventType:'tutorial',occurredAt:publishedAt,isNewsworthy:false,isNewEvent:false,status:'rejected',reason:'普通教程或旧主题',attention:40,attentionReason:'作者作品',importance:'medium',importanceReason:'关注作者的新作品',tags:[],evidenceIds:[ev.id],ruleIds:[rule.id],existingEventId:null,ruleAssessments:[{ruleId:rule.id,level:'direct',reason:'发布作者和作品类型明确符合关注范围。',summary:'发布作者的新作品，具体内容以取得的视频简介为准。',matchedEntity:ev.author,matchedVersion:'',matchedAction:'新视频',unmetConstraints:[],citations:[{evidenceId:ev.id,quote:ev.text}]}]}],excludedEvidenceIds:[],exclusions:[]});
}

test('作者新视频按作品发布时间收录，不因旧主题或教程消失，且不误命中其他作者',()=>{
  const ev=video(),data=event(ev);data.events[0].occurredAt=new Date(now-20*86400000).toISOString();
  const kept=validateBatch(data,[ev],[creator,kate],[],now).signals[0];
  assert.equal(currentSignal(kept,now),true);assert.equal(kept.status,'pending');assert.equal(kept.occurredAt,publishedAt);
  assert.equal(matchesRule(kept,creator),true);assert.equal(matchesRule(kept,kate),false);
});

test('缺少作者、作者不符、非视频和超过五天的视频不走作者作品捷径',()=>{
  for(const ev of [video('BV1a',{author:''}),video('BV1b',{author:'其他作者'}),video('BV1c',{url:'https://example.com/article',finalUrl:'https://example.com/article',contentKind:'article'}),video('BV1d',{publishedAt:new Date(now-6*86400000).toISOString()})]) {
    assert.equal(creatorVideoMatches(ev,creator,now),false);
    assert.equal(creatorVideoFallback([ev],[creator],[],now),null);
  }
});

test('“作者视频或者编程导航内容”保留或关系，非视频须有编程导航原文',()=>{
  const ev=video('BV1nav',{author:'编程导航编辑',contentKind:'article',url:'https://example.com/nav-guide',finalUrl:'https://example.com/nav-guide',title:'编程导航项目教程更新',text:'编程导航发布新项目教程，介绍从接口设计到代码实现的完整流程，并给出示例代码与项目结构。'.repeat(3)});
  const raw=event(ev).events[0].ruleAssessments[0];assert.equal(validateRelevance(raw,creator,[ev],now).validated,true);
  const unrelated={...ev,title:'普通开发文章',text:'其他社区发布一篇常规开发文章，介绍接口设计和示例代码。'.repeat(4)};
  const checked=validateRelevance({...raw,citations:[{evidenceId:ev.id,quote:unrelated.text}]},creator,[unrelated],now);
  assert.equal(checked.level,'insufficient');
});

test('明确要求的具体教程可收录，通用领域监控仍按热点价值筛选',()=>{
  const tutorial:Rule={...coding,id:'tutorial',query:'AI Agent项目教程'};
  const ev=video('BV1tutorial',{title:'AI Agent 入门教程',text:'这份 AI Agent 项目教程讲解代码工具调用、测试执行和仓库开发，逐步搭建一个修复代码问题的智能体。'.repeat(3)});
  assert.equal(ev.quality?.decision,'eligible');
  const requested=validateBatch(event(ev,tutorial),[ev],[tutorial],[],now).signals[0];assert.equal(currentSignal(requested,now),true);
  const generic=validateBatch(event(ev,coding),[ev],[coding],[],now).signals[0];assert.equal(currentSignal(generic,now),false);
});

test('同一作者同日发布两部作品不会因相同元数据覆盖最终事件',()=>{
  const a=video('BV1first'),b=video('BV1second');const data=event(a);data.events.push(event(b).events[0]);
  const result=validateBatch(data,[a,b],[creator],[],now).signals;
  assert.equal(result.length,2);assert.equal(new Set(result.map(item=>item.id)).size,2);assert.equal(new Set(result.map(item=>item.eventKey)).size,2);
});

test('合并指针实体错误时另存有本条原文依据的事件，不继承错误来源和匹配',()=>{
  const ev=video(),oldEvidence=video('BV1foreign',{author:'kate人不错'});
  const old=validateBatch(event(oldEvidence,kate),[oldEvidence],[kate],[],now).signals[0];
  const data=event(ev);data.events[0].existingEventId=old.id;
  const kept=validateBatch(data,[ev],[creator],[old],now).signals[0];
  assert.equal(currentSignal(kept,now),true);assert.notEqual(kept.id,old.id);assert.deepEqual(kept.evidence.map(item=>item.id),[ev.id]);assert.deepEqual(kept.ruleIds,[creator.id]);
  assert.throws(()=>validateBatch(data,[ev],[creator],[old],now,true),/不同实体/);
});

test('相同实体与版本仅事件类型表述改变不丢失已经核验的作品',()=>{
  const ev=video(),data=event(ev);const old=validateBatch(data,[ev],[creator],[],now).signals[0];
  data.events[0].existingEventId=old.id;data.events[0].eventType='creator-upload';
  const kept=validateBatch(data,[ev],[creator],[old],now).signals[0];assert.equal(kept.id,old.id);assert.equal(currentSignal(kept,now),true);
});

test('新上传的旧模型介绍只命中作者作品，不把它刷新为模型新发布',()=>{
  const model:Rule={...creator,id:'model',query:'Claude new model'};
  const ev=video('BV1oldmodel',{text:'[B站公开视频简介] 本期回顾 Claude Opus 模型发布时的能力，介绍旧模型的功能和此前发布的接口。'.repeat(2)});
  const data=event(ev);data.events[0].ruleIds.push(model.id);data.events[0].ruleAssessments.push({...data.events[0].ruleAssessments[0],ruleId:model.id,matchedEntity:'Claude',matchedAction:'model launch'});
  const kept=validateBatch(data,[ev],[creator,model],[],now).signals[0];assert.equal(matchesRule(kept,creator),true);assert.equal(matchesRule(kept,model),false);
});

test('额度用尽仍可按已取得的作者元数据收录作品；其他语义匹配保留待审且不调用付费接口',async()=>{
  const store=new Store(':memory:');try{
    store.put('state','settings',{...store.settings(),model:'fixture',aiDailyLimit:1});store.reserve('aiRequests',1,1);
    const analyzer=new Analyzer(store,{request:async()=>{throw Error('不得产生网络调用');}},'fixture-key',()=>now);
    const ev=video();const result=await analyzer.analyze([ev],[creator,coding,kate],[]);
    assert.equal(currentSignal(result.signals[0],now),true);assert.deepEqual(result.signals[0].ruleIds,[creator.id]);assert.deepEqual(result.deferredEvidenceIds,[ev.id]);assert.equal(store.usage().aiRequests,1);
  }finally{store.close();}
});

test('作者作品即使未配置模型也可独立收录，泛领域语义审核仍要求模型',async()=>{
  const store=new Store(':memory:');try{
    store.put('state','settings',{...store.settings(),model:''});
    const analyzer=new Analyzer(store,{request:async()=>{throw Error('不得产生网络调用');}},'',()=>now);
    const result=await analyzer.analyze([video()],[creator],[]);assert.equal(currentSignal(result.signals[0],now),true);assert.deepEqual(result.deferredEvidenceIds,[]);
    await assert.rejects(analyzer.analyze([video()],[coding],[]),/尚未配置/);assert.equal(store.usage().aiRequests||0,0);
  }finally{store.close();}
});

for(const unavailable of ['quota','configuration'])test(`${unavailable}：前面的语义候选不能阻断后面的作者视频收录`,async()=>{
  const store=new Store(':memory:');try{
    for(const existing of store.list<Source>('sources'))store.remove('sources',existing.id);
    store.put('sources',source.id,source);store.put('rules',creator.id,creator);store.put('rules',coding.id,coding);
    store.put('state','settings',{...store.settings(),model:unavailable==='quota'?'fixture':'',aiDailyLimit:1});
    if(unavailable==='quota')store.reserve('aiRequests',1,1);
    const net={request:async()=>{throw Error('离线审核不得访问网络');}};
    const others=Array.from({length:8},(_,index)=>video(`BV1other${index}`,{author:'其他作者',publishedAt:new Date(now-1000).toISOString()})),work=video();
    for(const other of others)ingest(store,other);ingest(store,work);
    const runner=new Runner(store,new Collector(store,net,'',false),new Analyzer(store,net,unavailable==='quota'?'fixture-key':'',()=>now));
    const result=await runner.scan('重新核实');
    const visible=store.list<import('../shared/types.js').Signal>('events').filter(item=>currentSignal(item,now));
    assert.equal(visible.length,1);assert.equal(visible[0].evidence[0].id,work.id);assert.deepEqual(visible[0].ruleIds,[creator.id]);assert.equal(result?.newSignals,1);
    assert.equal(store.get<import('../shared/types.js').Candidate>('candidates',work.id)?.attempts,0);
    for(const other of others)assert.equal(store.get<import('../shared/types.js').Candidate>('candidates',other.id)?.attempts,0);
    assert.equal(store.usage().aiRequests||0,unavailable==='quota'?1:0);
  }finally{store.close();}
});

test('默认五天窗口显示三天前的作者新视频；用户选择24小时仍正确排除',()=>{
  const kept=creatorVideoFallback([video()],[creator],[],now)!.signals[0];
  const filters={source:'all',importance:'all' as const,keyword:'all',timeRange:DEFAULT_TIME_RANGE,status:'all' as const,search:'',sort:'heat' as const};
  assert.equal(selectSignals([kept],filters,now).length,1);assert.equal(selectSignals([kept],{...filters,timeRange:'24h'},now).length,0);
});
