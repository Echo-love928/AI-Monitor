import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Candidate, Evidence, Signal, Source } from '../shared/types.js';
import { count, formatCount, interactionScore, metricRows, normalizeMetadata } from '../shared/engagement.js';
import { heatScore, primaryEvidence } from '../shared/feed.js';
import { sourceMetadata } from '../server/metadata.js';
import { article, makeEvidence, parseFeed } from '../server/parse.js';
import { Store } from '../server/db.js';
import { Collector, ingest } from '../server/sources.js';
import { syncEvidenceMetadata } from '../server/twitter-policy.js';
import { dashboard } from '../server/app.js';
import { mergeEvidence } from '../server/quality.js';

const now=Date.now();
const date=new Date(now-60000).toISOString();
const body='A new coding model has been released with concrete improvements for developers. '.repeat(3);
const source:Source={id:'bilibili',name:'B站',kind:'web',url:'https://api.bilibili.com/x/web-interface/search/type',format:'bilibili',enabled:true,official:false};
const evidence=(patch:Partial<Evidence>={})=>makeEvidence(source,{url:'https://www.bilibili.com/video/BVabc123/',title:'New coding model release',text:body,author:'作者',publishedAt:date,contentKind:'description',original:true,quality:{version:2,decision:'eligible',reason:'Readable original'},...patch});
const signal=(items:Evidence[]):Signal=>({id:'event',eventKey:'event',title:'Release',summary:'New coding model',entity:'model',version:'1',eventType:'release',occurredAt:date,status:'pending',reason:'Pending proof',attention:50,attentionReason:'New feature',tags:[],evidence:items,ruleIds:['rule'],firstSeenAt:date,updatedAt:date,isNewsworthy:true,isNewEvent:true,screeningVersion:2,twitterFilterVersion:1});

test('统一计数保留零并处理字符串与紧凑单位，非法值保持缺失',()=>{
  for(const [raw,expected] of [[0,0],['0',0],['1,234',1234],['1.2万',12000],['2.3K',2300],['1.5M',1500000],['1.1亿',110000000]] as const) assert.equal(count(raw),expected);
  for(const raw of [undefined,null,'',' ','—','隐藏',true,-1,'-1',1.5,'1.5','12,34','1e4',Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) assert.equal(count(raw),undefined,String(raw));
  assert.equal(formatCount(0),'0');assert.equal(formatCount(undefined),'—');assert.equal(formatCount(12000),'1.2万');
});

test('四个平台映射统一字段，评分/弹幕/投币/收藏不冒充点赞评论',()=>{
  const x=sourceMetadata('x',{likeCount:'12',retweetCount:5,replyCount:'0',viewCount:'1.2K',bookmarkCount:8,author:{name:'Alice',userName:'alice',profilePicture:'https://img.example/a.jpg',followers:'1,000'}});
  assert.equal(x.likes,12);assert.equal(x.replies,0);assert.equal(x.views,1200);assert.equal(x.bookmarks,8);assert.equal(x.authorFollowers,1000);assert.equal(x.authorName,'Alice');
  const bili=sourceMetadata('bilibili',{play:'2.3万',video_review:30,review:99,favorites:12,upic:'//img.example/b.jpg',mid:123,author:'作者'});
  assert.equal(bili.views,23000);assert.equal(bili.danmaku,30);assert.equal(bili.replies,undefined);assert.equal(bili.likes,undefined);assert.equal(bili.favorites,12);assert.equal(bili.authorAvatarUrl,'https://img.example/b.jpg');assert.equal(bili.authorFollowers,undefined);
  const weibo=sourceMetadata('weibo',{attitudes_count:'2万',reposts_count:4,comments_count:6,user:{idstr:'123',screen_name:'作者',followers_count:0,avatar_hd:'https://img.example/c.jpg'}});
  assert.equal(weibo.likes,20000);assert.equal(weibo.replies,6);assert.equal(weibo.views,undefined);assert.equal(weibo.authorFollowers,0);
  const hn=sourceMetadata('hackernews',{score:55,descendants:3,by:'alice'});
  assert.equal(hn.points,55);assert.equal(hn.likes,undefined);assert.equal(hn.replies,3);assert.equal(hn.views,undefined);
  assert.equal(normalizeMetadata({authorAvatarUrl:'javascript:alert(1)',authorUrl:'data:text/html,test'}).authorAvatarUrl,undefined);
});

test('B站搜索保留字符串指标和作者头像，不把弹幕或 review 当作评论',async()=>{
  const store=new Store(':memory:');try{
    const collector=new Collector(store,{request:async url=>({status:200,url,headers:{},text:JSON.stringify({code:0,data:{result:[{bvid:'BVabc123',title:'Release',description:body,pubdate:Math.floor(now/1000),author:'作者',mid:123,upic:'//img.example/avatar.jpg',play:'1.2万',like:'20',share:0,favorites:5,video_review:8,review:100}]}})})},'',false);
    const item=(await collector.videoSearch(source,'model')).items[0];
    assert.equal(item.views,12000);assert.equal(item.reposts,0);assert.equal(item.danmaku,8);assert.equal(item.replies,undefined);assert.equal(item.authorAvatarUrl,'https://img.example/avatar.jpg');assert.equal(item.favorites,5);
  }finally{store.close();}
});

test('Twitter 采集保留显示名头像书签，字符串指标仍执行原有门槛',async()=>{
  const store=new Store(':memory:');try{
    const collector=new Collector(store,{request:async url=>({status:200,url,headers:{},text:JSON.stringify({tweets:[{id:'1',url:'https://x.com/alice/status/1',text:body,createdAt:date,isReply:false,author:{id:'a',userName:'alice',name:'Alice',followers:'100',profilePicture:'https://img.example/a.jpg'},likeCount:'10',retweetCount:'5',replyCount:'0',viewCount:'500',bookmarkCount:'6'}],has_next_page:false})})},'test-key',false);
    const item=(await collector.x({...source,id:'twitter',kind:'x'},'release',now-3600000)).items[0];
    assert.equal(item.quality?.decision,'eligible');assert.equal(item.author,'@alice');assert.equal(item.authorName,'Alice');assert.equal(item.authorAvatarUrl,'https://img.example/a.jpg');assert.equal(item.bookmarks,6);assert.equal(item.replies,0);
  }finally{store.close();}
});

test('B站和微博页面完整互动数据贯穿 publication → article → enrich',async()=>{
  const bili={videoData:{bvid:'BVabc123',desc:body,pubdate:Math.floor(now/1000),owner:{name:'作者',mid:123,face:'//img.example/a.jpg'},stat:{view:1200,like:20,share:4,reply:6,coin:7,favorite:8,danmaku:9}}};
  const html='<title>Release</title><script>window.__INITIAL_STATE__='+JSON.stringify(bili)+'</script>';
  const parsed=article(html,'https://www.bilibili.com/video/BVabc123/');
  assert.equal(parsed.replies,6);assert.equal(parsed.coins,7);assert.equal(parsed.favorites,8);assert.equal(parsed.danmaku,9);assert.equal(parsed.authorAvatarUrl,'https://img.example/a.jpg');
  const weibo={status:{text:body,created_at:date,attitudes_count:10,reposts_count:0,comments_count:'12',user:{idstr:'123',screen_name:'微博作者',followers_count:'1.2万',profile_image_url:'https://img.example/b.jpg'}}};
  const postHtml='<title>Release</title><script>$render_data='+JSON.stringify([weibo])+'</script>';
  const store=new Store(':memory:');try{
    const collector=new Collector(store,{request:async url=>({status:200,url,headers:{},text:postHtml})},'',false);
    const item=await collector.enrich(evidence({url:'https://weibo.com/123/abc',finalUrl:'https://weibo.com/123/abc',original:false}));
    assert.equal(item.replies,12);assert.equal(item.authorFollowers,12000);assert.equal(item.authorName,'微博作者');assert.equal(item.reposts,0);assert.equal(item.views,undefined);
  }finally{store.close();}
});

test('Hacker News RSS 与页面保留评分和评论，普通搜索摘要不生成互动数据',()=>{
  const rss='<rss><channel><item><title>Release</title><link>https://example.com/release</link><description>'+body+'</description><pubDate>'+date+'</pubDate><dc:creator>alice</dc:creator><hn:score>42</hn:score><hn:comments>0</hn:comments></item></channel></rss>';
  const item=parseFeed(rss,{...source,id:'hackernews',kind:'rss',url:'https://hnrss.org/newest'})[0];
  assert.equal(item.points,42);assert.equal(item.replies,0);assert.equal(item.likes,undefined);assert.equal(item.authorName,'alice');
  const html='<table><tr class="athing"><td>New release</td></tr><tr><td class="subtext"><span class="score">42 points</span><a class="hnuser">alice</a><span class="age" title="'+date+'"></span><a>12 comments</a></td></tr></table><div>'+body+'</div>';
  const parsed=article(html,'https://news.ycombinator.com/item?id=1');assert.equal(parsed.points,42);assert.equal(parsed.replies,12);assert.equal(parsed.likes,undefined);
  assert.equal(interactionScore(evidence({likes:undefined})),null);
});

test('正文不变也更新作者和全部互动，部分响应保留已有字段，真实零可覆盖',()=>{
  const store=new Store(':memory:');try{
    const old=evidence({likes:9,replies:4,coins:5,authorFollowers:100,authorAvatarUrl:'https://img.example/old.jpg',fetchedAt:date});ingest(store,old);
    store.put('candidates',old.id,{...store.get<Candidate>('candidates',old.id),attempts:2,processedHash:old.contentHash});store.put('events','event',signal([old]));
    const fresh=evidence({likes:20,replies:0,authorName:'新作者名',authorFollowers:0,authorAvatarUrl:'https://img.example/new.jpg'});ingest(store,fresh);syncEvidenceMetadata(store);
    const candidate=store.get<Candidate>('candidates',old.id)!;assert.equal(candidate.attempts,2);assert.equal(candidate.processedHash,old.contentHash);assert.equal(candidate.coins,5);assert.equal(candidate.replies,0);
    const updated=dashboard(store).events[0];assert.equal(updated.evidence[0].likes,20);assert.equal(updated.evidence[0].replies,0);assert.equal(updated.evidence[0].coins,5);assert.equal(updated.evidence[0].authorFollowers,0);assert.equal(updated.evidence[0].authorName,'新作者名');assert.equal(updated.firstSeenAt,date);
    assert.equal(updated.updatedAt,date);assert.equal(candidate.firstDiscoveredAt,date);
  }finally{store.close();}
});

test('迁移旧记录后不改正文和首次发现，重启幂等且可同步跨渠道同一原帖',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'engagement-migration-'));const file=path.join(directory,'test.sqlite');let store=new Store(file);
  try{
    const old=evidence({likes:1,fetchedAt:date});const fresh=evidence({id:'alias',sourceId:'bing',likes:30,authorName:'作者新名',fetchedAt:new Date(now).toISOString()});
    store.put('events','event',signal([old]));store.put('candidates',fresh.id,{...fresh,attempts:2,processedHash:fresh.contentHash});store.remove('state','engagementMetadataV1');store.close();store=new Store(file);
    const updated=store.get<Signal>('events','event')!;assert.equal(updated.evidence[0].likes,30);assert.equal(updated.evidence[0].authorName,'作者新名');assert.equal(updated.evidence[0].text,old.text);assert.equal(updated.firstSeenAt,date);
    store.close();store=new Store(file);assert.equal(store.get<Candidate>('candidates',fresh.id)?.attempts,2);assert.deepEqual(store.get<Signal>('events','event'),updated);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('卡片作者与互动来自同一原帖，重复来源不累加，平台标签保留语义',()=>{
  const a=evidence({likes:10,replies:2,reposts:5,views:1000});const b=evidence({id:'b',author:'另一作者',likes:50});
  const event=signal([a,b,{...a,id:'support',supportingOnly:true,likes:9999}]);assert.equal(primaryEvidence(event)?.id,'b');assert.equal(heatScore(event),50);
  assert.equal(heatScore(signal([a,{...a,id:'alias'}])),32);
  assert.equal(metricRows(a).find(row=>row.key==='views')?.label,'播放');
  const hn=evidence({finalUrl:'https://news.ycombinator.com/item?id=1',points:42,replies:0});assert.deepEqual(metricRows(hn).map(row=>row.label),['评分','评论']);
  assert.equal(heatScore(signal([hn])),42);assert.equal(heatScore(signal([evidence({likes:0})])),0);assert.equal(heatScore(signal([evidence({metricsUnavailable:true,likes:99})])),null);
});

test('跨渠道合并保留完整正文并采用较新指标，搜索摘要不能覆盖作者或互动',()=>{
  const old=evidence({likes:20,coins:5,authorName:'真实作者',text:body.repeat(2),fetchedAt:date});
  const fresh=evidence({id:'alias',sourceId:'bing',likes:0,replies:2,authorName:'真实作者新名称',fetchedAt:new Date(now).toISOString()});
  const merged=mergeEvidence([old,fresh])[0];
  assert.equal(merged.text,old.text);assert.equal(merged.likes,0);assert.equal(merged.coins,5);assert.equal(merged.authorName,'真实作者新名称');
  const snippet=evidence({id:'snippet',sourceId:'sogou',original:false,author:'www.bilibili.com',likes:99999,fetchedAt:new Date(now+1).toISOString()});
  const store=new Store(':memory:');try{
    store.put('events','event',signal([old]));
    for(const item of [old,fresh,snippet])store.put('candidates',item.id,{...item,attempts:0,processedHash:null});
    syncEvidenceMetadata(store);
    const ev=store.get<Signal>('events','event')!.evidence[0];
    assert.equal(ev.authorName,'真实作者新名称');assert.equal(ev.likes,0);assert.equal(ev.coins,5);assert.equal(ev.text,old.text);
    assert.equal(mergeEvidence([old,snippet])[0].likes,20);
  }finally{store.close();}
});
