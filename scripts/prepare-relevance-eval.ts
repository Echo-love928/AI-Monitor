import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { freshHoldout } from '../eval/fresh-holdout.js';
import { synthetic } from '../eval/synthetic.js';
import type { EvaluationCase } from '../eval/types.js';
import type { Evidence, Rule } from '../shared/types.js';

if(existsSync('eval/fixtures/relevance.json')&&!process.argv.includes('--replace')){console.log('固定评估集已存在；重新生成需显式传入 --replace，并重新独立校准。');process.exit(0);}
const freeze='2026-10-17T04:20:00.000Z';
const rules=new Map<string,Rule>();
function rule(query:string):Rule {if(!rules.has(query))rules.set(query,{id:createHash('sha256').update(query).digest('hex').slice(0,12),name:query,query,kind:query==='AI coding agents'?'topic':'keyword',enabled:true,notify:false,createdAt:freeze,baselineAt:null,nextRunAt:freeze,lastRunAt:null});return rules.get(query)!;}
const rows=JSON.parse(readFileSync('reports/relevance-real-snapshot.json','utf8')) as Evidence[];
const selected=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19];
const realTopic:EvaluationCase['expected'][]=['direct','direct','direct','direct','weak','weak','weak','unrelated','weak','direct','weak','weak','weak','unrelated','weak','unrelated','weak','unrelated','weak','direct'];
const cases:EvaluationCase[]=[];
for(const [position,index] of selected.entries()) {
  const evidence=rows[index];
  for(const [offset,query] of ['Claude Sonnet 4.6','Claude new model','AI coding agents'].entries()) {
    const expected=offset===2?realTopic[position]:'unrelated';
    const cluster=[2,9].includes(index)?'codex-history':[6,18].includes(index)?'voice-live':[15,17].includes(index)?'basket-promo':`source-${evidence.id}`;
    const split=cluster==='codex-history'||cluster==='voice-live'?'dev':position%2?'holdout':'dev';
    cases.push({id:`real-${index}-${offset}`,group:cluster,split,origin:'real',rule:rule(query),evidence,expected,labelReason:offset<2?'材料没有关于指定型号或新的 Claude 模型的实质信息。':expected==='direct'?'材料包含与编程智能体直接相关的具体能力、研究或事件。':'材料仅为背景、推广或非编程智能体主题，没有该范围的实质新增信息。',critical:offset===0});
  }
}
for(const [index,[query,text,expected]] of synthetic.entries()) {
  const id=`synthetic-${index}`;const video=query==='程序员鱼皮的视频';
  const evidence:Evidence={id,sourceId:video?'bilibili':'twitter',sourceKind:video?'web':'x',contentKind:video?'description':'post',externalId:id,url:video?`https://www.bilibili.com/video/BVfixture${index}/`:`https://x.com/fixture/status/${index+100}`,finalUrl:video?`https://www.bilibili.com/video/BVfixture${index}/`:`https://x.com/fixture/status/${index+100}`,title:`评估材料 ${index+1}`,text,publishedAt:freeze,fetchedAt:freeze,author:video?(text.includes('发布作者：另一位作者')?'另一位作者':text.includes('发布作者：程序员鱼皮')?'程序员鱼皮':'未知'):'fixture',official:false,original:!text.includes('正文')&&!text.includes('original page could not be read'),postType:'original',likes:20,reposts:10,views:1000,authorFollowers:500,contentHash:createHash('sha256').update(text).digest('hex'),quality:{version:2,decision:'eligible',reason:'Frozen evaluation material'}};
  if(video&&text.includes('文字动态'))Object.assign(evidence,{sourceId:'weibo',contentKind:'article',url:'https://weibo.com/fixture/'+id,finalUrl:'https://weibo.com/fixture/'+id});
  // Identity/version transformations stay in one group and split.
  const group=`synthetic-scenario-${Math.floor(index/2)}`;
  const split:EvaluationCase['split']=Math.floor(index/2)%2?'holdout':'dev';
  cases.push({id,group,split,origin:'synthetic',rule:rule(query),evidence,expected,labelReason:`按固定判据：${expected}；不以观点、热度或生态关联替代目标实质关联。`,critical:expected==='unrelated'||expected==='insufficient'});
}
// The original holdout has been inspected: it is now regression data, never called unseen.
const baselineIds=cases.filter(row=>row.split==='dev'&&row.id!=='synthetic-45').map(row=>row.id);
for(const row of cases)row.split='dev';
for(const [index,[query,text,expected]] of freshHoldout.entries()){
 const id=`fresh-${index}`,video=query==='程序员鱼皮的视频';
 const author=video?(text.includes('发布作者：其他创作者')?'其他创作者':text.includes('发布作者：程序员鱼皮')?'程序员鱼皮':'未知'):'fixture';
 const url=video?`https://www.bilibili.com/video/BVfresh${index}/`:`https://x.com/fixture/status/${1000+index}`;
 const evidence:Evidence={id,sourceId:video?'bilibili':'twitter',sourceKind:video?'web':'x',contentKind:video?'description':'post',externalId:id,url,finalUrl:url,title:`新保留材料 ${index+1}`,text,publishedAt:freeze,fetchedAt:freeze,author,official:false,original:!text.includes('无法读取')&&!text.includes('cannot be read'),postType:'original',likes:20,reposts:10,views:1000,authorFollowers:500,contentHash:createHash('sha256').update(text).digest('hex'),quality:{version:2,decision:'eligible',reason:'Frozen evaluation material'}};
 if(video&&text.includes('文字博客'))Object.assign(evidence,{sourceId:'weibo',contentKind:'article',url:'https://weibo.com/fixture/'+id,finalUrl:'https://weibo.com/fixture/'+id});
 cases.push({id,group:`fresh-scenario-${Math.floor(index/2)}`,split:'holdout',origin:'synthetic',rule:rule(query),evidence,expected,labelReason:`新冻结保留集；按已确认口径：${expected}`,critical:expected==='unrelated'||expected==='insufficient'});
}
mkdirSync('eval/fixtures',{recursive:true});
writeFileSync('eval/fixtures/relevance.json',JSON.stringify({version:4,frozenAt:freeze,baselineIds,labelStatus:'AI-authored; confirmed no-results and programming-context policies; user confirmed coding Skill relevance independent of newsworthiness. Original 120 are regression data after failed holdout audit; 40 fresh unseen holdout cases frozen before rerun.',cases},null,2)+'\n');
writeFileSync('eval/fixtures/baseline-contract.json',readFileSync('reports/relevance-baseline-contract.json','utf8'));
console.log(JSON.stringify({cases:cases.length,real:cases.filter(item=>item.origin==='real').length,synthetic:cases.filter(item=>item.origin==='synthetic').length,groups:new Set(cases.map(item=>item.group)).size}));
