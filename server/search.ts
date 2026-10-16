import type { Rule, Source } from '../shared/types.js';

export interface DiscoverySearch { platform:'bilibili'|'weibo'|'web'; source:Source; query:string; }

export function discoverySearches(rules:Rule[],sources:Source[],limit:number,rotation=0,now=Date.now()):DiscoverySearch[] {
  if(!rules.length || limit<1)return [];
  const platforms=['bilibili','weibo','web'] as const;
  const queues=platforms.map(platform=>rules.slice().sort((a,b)=>Number(new RegExp(platform==='bilibili'?'视频|B站|bilibili':platform==='weibo'?'微博|weibo':'$^','i').test(b.query))-Number(new RegExp(platform==='bilibili'?'视频|B站|bilibili':platform==='weibo'?'微博|weibo':'$^','i').test(a.query))));
  const jobs:DiscoverySearch[]=[];const engines=sources.filter(source=>source.enabled&&source.kind==='web'&&!source.format).sort((a,b)=>a.id.localeCompare(b.id));
  for(let i=0;i<rules.length*3 && jobs.length<limit;i++) {
    const pi=(i+rotation)%3,platform=platforms[pi];const rule=queues[pi][(Math.floor(i/3)+Math.floor(rotation/3))%rules.length];
    const special=sources.find(source=>source.id===platform);if(special && !special.enabled)continue;
    const source=platform==='web'?engines[(i+rotation)%engines.length]:special;
    if(!source)continue;
    const base=rule.query.replace(/相关内容|相关信息|相关动态|最新消息|的视频或者|的视频|或者|有关/g,' ').replace(/\s+/g,' ').trim();
    const month=new Date(now).toISOString().slice(0,7);
    const videoBase=/的视频/.test(rule.query)?rule.query.split(/的视频/)[0].trim():base;
    const query=platform==='bilibili'?videoBase:platform==='weibo'?`(site:weibo.com OR site:weibo.cn) ${base} ${month}`:`${base} ${month} ${/[\u4e00-\u9fff]/.test(base)?'发布 更新':'release update'}`;
    jobs.push({platform,source,query});
  }
  return jobs;
}

export function xQueryFor(rule:Rule):string {
  const base=queriesFor(rule)[0].replace(/ release update$/,'');
  return rule.kind === 'keyword' ? `(${base}) (release OR update OR launch OR 发布 OR 更新)` : base;
}
function queriesFor(rule: Rule): string[] {
  const base = rule.query.replace(/相关内容|相关信息|相关动态|最新消息|有关|正式发布|新版本/g, ' ').replace(/\s+/g, ' ').trim() || rule.query;
  const english = base.replace(/人工智能/g, 'AI').replace(/编程/g, 'coding').replace(/智能体/g, 'agents').replace(/大模型|模型/g, 'model').replace(/千问|通义/g, 'Qwen').replace(/最新|发布|更新/g, ' ').replace(/\s+/g, ' ').trim();
  return [...new Set([`${english} release update`, `${base} 发布 更新`, `site:bilibili.com/video ${base}`, `(site:weibo.com OR site:weibo.cn) ${base}`])];
}
