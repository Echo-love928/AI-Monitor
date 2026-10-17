import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metrics } from '../eval/metrics.js';
import type { EvaluationCase } from '../eval/types.js';
import { applyQuality,discoveryCandidate } from '../server/quality.js';
import { applyGraderConstraints,calibrationResult,graderAnchors } from '../eval/grading.js';
import {confirmedReference,type ConfirmedReference} from '../eval/confirmed-references.js';
import {retryableEvaluationFailure} from '../eval/retry.js';

test('有限重试只恢复无效输出，不重抽语义过滤、缺失原文或已达上限的样本',()=>{
  assert.equal(retryableEvaluationFailure({predicted:'insufficient',decisionReason:'缺少面向该监控的事件摘要'}),true);
  assert.equal(retryableEvaluationFailure({predicted:'insufficient',decisionReason:'引用片段不在原文中',attempts:2}),true);
  assert.equal(retryableEvaluationFailure({predicted:'insufficient',error:'schema failure',attempts:3}),false);
  assert.equal(retryableEvaluationFailure({predicted:'weak',decisionReason:'没有具体结果'}),false);
  assert.equal(retryableEvaluationFailure({predicted:'insufficient',decisionReason:'没有可读取的原始正文'}),false);
});

test('人工口径只约束已确认且原始内容未变的样本，不覆盖新材料或相反标签',()=>{
  const data=JSON.parse(readFileSync('eval/fixtures/relevance.json','utf8')) as {cases:EvaluationCase[]};
  const references=(JSON.parse(readFileSync('eval/fixtures/confirmed-policies.json','utf8')) as {cases:ConfirmedReference[]}).cases;
  for(const reference of references){const row=data.cases.find(item=>item.id===reference.id)!;assert.equal(confirmedReference(row,references)?.level,reference.level);
    assert.equal(confirmedReference({...row,evidence:{...row.evidence,text:row.evidence.text+' New findings: accuracy improved.'}},references),undefined);
    assert.equal(confirmedReference({...row,expected:row.expected==='direct'?'weak':'direct'},references),undefined);
  }
});

test('独立校准按保留与过滤验收，四类标签分歧保留统计，漏项与误收不能通过',()=>{
  const rows=graderAnchors.map(row=>({id:row.id,level:row.expected==='direct'?'direct':'weak'}));
  assert.equal(calibrationResult(rows).passed,true);assert.ok(calibrationResult(rows).exactLabelMatches<graderAnchors.length);
  assert.equal(calibrationResult(rows.slice(1)).passed,false);
  rows[0].level='direct';assert.equal(calibrationResult(rows).passed,false);
});

test('独立评估以字符串核对版本，并保留模型原始分歧',()=>{
  const raw={level:'direct',reason:'model result'};
  const guarded=applyGraderConstraints('Claude Sonnet 3.7','Sonnet 3.70 launched',raw);
  assert.equal(guarded.level,'unrelated');assert.equal(guarded.rawLevel,'direct');
  assert.equal(applyGraderConstraints('Claude Sonnet 3.7','Sonnet 3.7 improved',raw).level,'direct');
  assert.equal(applyGraderConstraints('AI coding agents','a coding agent release',raw).level,'direct');
});
test('评估不以零保留、空样本或没有正例的准确率冒充通过',()=>{
  assert.equal(metrics([]).passed,false);assert.equal(metrics([]).precision,null);
  assert.equal(metrics(Array.from({length:100},(_,i)=>({id:String(i),expected:'unrelated' as const,predicted:'unrelated' as const,critical:true}))).passed,false);
  const rows=Array.from({length:100},(_,i)=>({id:String(i),expected:i<20?'direct' as const:'unrelated' as const,predicted:'unrelated' as const,critical:true}));
  assert.equal(metrics(rows).recall,0);assert.equal(metrics(rows).passed,false);
});
test('评估同时统计误收、漏收、关键反例及统计区间',()=>{
  const rows=Array.from({length:100},(_,i)=>({id:String(i),expected:i<40?'direct' as const:'unrelated' as const,predicted:i<40?'direct' as const:'unrelated' as const,critical:true}));
  assert.equal(metrics(rows).passed,true);rows[80].predicted='direct';assert.equal(metrics(rows).criticalErrors,1);assert.equal(metrics(rows).passed,false);assert.ok(metrics(rows).precision95CI![0]<metrics(rows).precision!);
});
test('160个冻结样本覆盖真实及合成材料，调试集与保留集按来源分组隔离',()=>{
  const data=JSON.parse(readFileSync('eval/fixtures/relevance.json','utf8')) as {cases:EvaluationCase[]};assert.ok(data.cases.length===160);
  assert.equal(data.cases.filter(item=>item.origin==='real').length,60);assert.equal(data.cases.filter(item=>item.origin==='synthetic').length,100);
  const groups=new Map<string,string>();for(const row of data.cases){if(groups.has(row.group))assert.equal(groups.get(row.group),row.split);groups.set(row.group,row.split);}
  assert.equal(new Set(data.cases.map(row=>row.id)).size,data.cases.length);
});

test('所有直接相关样本通过已有材料门槛，语义评估不被前置过滤伪装为无关',()=>{
  const data=JSON.parse(readFileSync('eval/fixtures/relevance.json','utf8')) as {frozenAt:string;cases:EvaluationCase[]};
  const now=Date.parse(data.frozenAt);
  const missed=data.cases.filter(row=>row.expected==='direct').flatMap(row=>{
    const item=applyQuality(row.evidence,[],now);
    return discoveryCandidate(item,now)?[]:[`${row.id}: ${item.quality?.reason}`];
  });
  assert.deepEqual(missed,[]);
});
