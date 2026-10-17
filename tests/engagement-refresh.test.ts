import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate, Evidence, Signal, Source } from '../shared/types.js';
import { makeEvidence } from '../server/parse.js';
import { Store } from '../server/db.js';
import { Collector, ingest } from '../server/sources.js';
import { syncEvidenceMetadata } from '../server/twitter-policy.js';
import { applyQuality } from '../server/quality.js';
import { Runner } from '../server/runner.js';

const now=Date.now();const date=new Date(now-60000).toISOString();
const source:Source={id:'bilibili',name:'B站',kind:'web',format:'bilibili',url:'https://api.bilibili.com/x/web-interface/search/type',enabled:true,official:false};
const post=()=>applyQuality(makeEvidence(source,{url:'https://www.bilibili.com/video/BVabc123/',externalId:'BVabc123',title:'New coding model',text:'The project released a new coding model with concrete improvements and downloadable weights. '.repeat(2),author:'作者',publishedAt:date,contentKind:'description',original:true,likes:22,views:1095}));
const detail={code:0,data:{bvid:'BVabc123',title:'New coding model',desc:'The project released a new coding model with concrete improvements and downloadable weights.',pubdate:Math.floor(Date.parse(date)/1000),owner:{mid:123,name:'作者',face:'https://i2.hdslb.com/bfs/face/author.jpg'},stat:{view:2834,like:45,share:9,reply:4,coin:2,favorite:12,danmaku:1}}};

test('已有合格 B站简介仍读取详情，补齐头像、转发和评论；30分钟缓存不重复请求',async()=>{
  const store=new Store(':memory:');try{
    let calls=0;
    const collector=new Collector(store,{request:async url=>{calls++;assert.equal(new URL(url).pathname,'/x/web-interface/view');assert.equal(new URL(url).searchParams.get('bvid'),'BVabc123');return {status:200,url,headers:{},text:JSON.stringify(detail)};}},'',false);
    const original=post();const value=await collector.enrich(original);
    assert.equal(calls,1);assert.equal(value.authorAvatarUrl,detail.data.owner.face);assert.equal(value.reposts,9);assert.equal(value.replies,4);assert.equal(value.coins,2);
    assert.equal(value.text,original.text);assert.equal(value.contentHash,original.contentHash);assert.equal(value.publishedAt,original.publishedAt);assert.equal(value.firstDiscoveredAt,original.fetchedAt);
    const cached=await collector.enrich(original);assert.equal(calls,1);assert.equal(cached.replies,4);
  }finally{store.close();}
});

test('已完成 AI 分析的视频也回查详情，同步已有事件，不重置正文与分析状态',async()=>{
  const store=new Store(':memory:');try{
    const original=post();ingest(store,original);
    const saved=store.get<Candidate>('candidates',original.id)!;store.put('candidates',saved.id,{...saved,attempts:2,processedHash:saved.contentHash});
    const event:Signal={id:'event',eventKey:'event',title:'Model release',summary:'A new coding model',entity:'model',version:'1',eventType:'release',occurredAt:date,status:'pending',reason:'Pending proof',attention:50,attentionReason:'Release',tags:[],evidence:[original],ruleIds:['rule'],firstSeenAt:date,updatedAt:date,isNewsworthy:true,isNewEvent:true,screeningVersion:2,twitterFilterVersion:1};store.put('events',event.id,event);
    let calls=0;const collector=new Collector(store,{request:async url=>{calls++;return {status:200,url,headers:{},text:JSON.stringify(detail)};}},'',false);
    const result=await collector.refreshVideoMetrics(source,1);syncEvidenceMetadata(store);
    assert.equal(result.items.length,1);assert.equal(calls,1);
    const updated=store.get<Signal>('events',event.id)!;assert.equal(updated.evidence[0].authorAvatarUrl,detail.data.owner.face);assert.equal(updated.evidence[0].reposts,9);assert.equal(updated.evidence[0].replies,4);assert.equal(updated.updatedAt,date);
    const candidate=store.get<Candidate>('candidates',original.id)!;assert.equal(candidate.processedHash,original.contentHash);assert.equal(candidate.attempts,2);
    assert.equal((await collector.refreshVideoMetrics(source,1)).items.length,0);assert.equal(calls,1);
  }finally{store.close();}
});

test('B站详情失败和错误 BV 号不覆盖已有互动，也不立即反复请求',async()=>{
  for(const response of [{code:-412,message:'访问校验',data:null},{code:0,data:{...detail.data,bvid:'BVother123'}}]){
    const store=new Store(':memory:');try{
      const original=post();ingest(store,original);let calls=0;
      const collector=new Collector(store,{request:async url=>{calls++;return {status:200,url,headers:{},text:JSON.stringify(response)};}},'',false);
      assert.equal((await collector.refreshVideoMetrics(source,1)).result.status,'failed');
      const saved=store.get<Candidate>('candidates',original.id)!;assert.equal(saved.likes,22);assert.equal(saved.original,true);assert.equal(saved.replies,undefined);assert.ok(saved.metricsAttemptedAt);
      await collector.refreshVideoMetrics(source,1);await collector.enrich(original);assert.equal(calls,1);
    }finally{store.close();}
  }
});

test('定时检查为已处理视频补齐详情，重新核实不联网',async()=>{
  const store=new Store(':memory:');try{
    for(const saved of store.list<Source>('sources'))store.remove('sources',saved.id);store.put('sources',source.id,source);
    store.put('rules','rule',{id:'rule',name:'AI',query:'coding model',kind:'topic',enabled:true,notify:false,createdAt:date,baselineAt:date,nextRunAt:date,lastRunAt:null});
    const original=post();ingest(store,original);store.put('candidates',original.id,{...store.get<Candidate>('candidates',original.id),processedHash:original.contentHash});
    let calls=0;const collector=new Collector(store,{request:async url=>{calls++;return {status:200,url,headers:{},text:JSON.stringify(detail)};}},'',false);
    collector.videoSearch=async item=>collector.result(item,[],'empty');
    const runner=new Runner(store,collector,{analyze:async()=>{throw new Error('Processed evidence must not be analyzed again');}});
    await runner.scan('定时检查');assert.equal(calls,1);assert.equal(store.get<Candidate>('candidates',original.id)?.reposts,9);
    await runner.scan('重新核实');assert.equal(calls,1);
  }finally{store.close();}
});

test('仅显式指定的旧推文可补取作者资料，定时回查限制和现有预算继续生效',async()=>{
  const store=new Store(':memory:');try{
    const x:Source={...source,id:'twitter',kind:'x',url:'https://api.twitterapi.io'};
    const old=makeEvidence(x,{url:'https://x.com/author/status/1',externalId:'1',title:'Release',text:'The project released a new coding model with downloadable weights.',author:'@author',publishedAt:date,postType:'unknown',original:false});ingest(store,old);
    let calls=0;const collector=new Collector(store,{request:async url=>{calls++;assert.equal(new URL(url).searchParams.get('tweet_ids'),'1');return{status:200,url,headers:{},text:JSON.stringify({tweets:[{id:'1',url:old.url,text:old.text,createdAt:date,isReply:false,author:{id:'author',userName:'author',name:'Author',profilePicture:'https://pbs.twimg.com/author.jpg',followers:100},likeCount:10,retweetCount:5,viewCount:500}],status:'success'})};}},'test-key',false);
    assert.equal((await collector.refreshMetrics(x,now)).items.length,0);assert.equal(calls,0);
    const repaired=await collector.refreshMetrics(x,now,new Set(['1']));assert.equal(repaired.items[0].authorAvatarUrl,'https://pbs.twimg.com/author.jpg');assert.equal(calls,1);assert.equal(store.usage().xRequests,1);assert.equal(store.usage().xResults,1);
    store.put('state','settings',{...store.settings(),xDailyLimit:1});
    assert.equal((await collector.refreshMetrics(x,now,new Set(['1']))).result.status,'limited');assert.equal(calls,1);
  }finally{store.close();}
});
