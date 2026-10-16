import { load } from 'cheerio';

// Parse literal JSON only; platform page scripts are never executed.
export function assignedJSON(html:string,marker:string):unknown {
  const offset=html.indexOf(marker);if(offset<0)return null;
  let start=offset+marker.length;while(/[\s=]/.test(html[start]||'') && start<html.length)start++;
  if(!['{','['].includes(html[start]))return null;
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<html.length;i++) {
    const c=html[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){depth--;if(!depth){try{return JSON.parse(html.slice(start,i+1));}catch{return null;}}}
  }
  return null;
}

export function publication(html:string,url:string) {
  const $=load(html);const host=new URL(url).hostname;
  const video=/(^|\.)bilibili\.com$/.test(host);const weibo=/(^|\.)(weibo\.com|weibo\.cn)$/.test(host);
  const nodes:Record<string,any>[]=[];
  $('script[type="application/ld+json"]').each((_,el)=>{try{const value=JSON.parse($(el).text());nodes.push(...(Array.isArray(value)?value:[value,...(value['@graph']||[])]));}catch{/* Ignore malformed metadata. */}});
  const structured=nodes.find(item=>/Article|BlogPosting|VideoObject|SocialMediaPosting/.test(String(item?.['@type'])))||{};
  let author=typeof structured.author==='string'?structured.author:structured.author?.name || structured.creator?.name || $('meta[name="author"]').attr('content') || $('[rel="author"]').first().text().trim();
  let date=$('meta[property="article:published_time"]').attr('content') || $('meta[itemprop="datePublished"]').attr('content') || $('meta[name="date"]').attr('content') || structured.datePublished || structured.uploadDate || $('time[datetime]:not([itemprop="dateModified"]):not(.updated)').first().attr('datetime');
  let text='';let authorId:string|undefined;let likes:number|undefined,views:number|undefined,reposts:number|undefined;
  if(video) {
    const initial=assignedJSON(html,'window.__INITIAL_STATE__') as any;const data=initial?.videoData;
    if(data?.bvid && new URL(url).pathname.includes(data.bvid)) {
      text=String(data.desc||'');author=data.owner?.name || author;authorId=data.owner?.mid?String(data.owner.mid):undefined;
      if(typeof data.pubdate==='number')date=new Date(data.pubdate*1000).toISOString();likes=data.stat?.like;views=data.stat?.view;reposts=data.stat?.share;
    }
    text=text || structured.description || $('meta[name="description"]').attr('content') || '';
  }
  if(weibo) {
    const render=assignedJSON(html,'$render_data') as any;const data=(Array.isArray(render)?render[0]:render)?.status;
    const body=$('.WB_text, .detail_wbtext, .weibo-text, .ctt').first();
    if(data?.text){text=load(String(data.text)).text();date=data.created_at || date;author=data.user?.screen_name || author;authorId=data.user?.idstr;likes=data.attitudes_count;reposts=data.reposts_count;}
    else if(body.length) {
      text=body.text();author=$('.nk, .WB_info a, .head_name').first().text().trim() || author;
      const stamp=$('.ct, .WB_from a[title]').first();const raw=stamp.attr('title') || stamp.text();
      const absolute=raw.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if(!date && absolute)date=`${absolute[1]}-${absolute[2].padStart(2,'0')}-${absolute[3].padStart(2,'0')}T${absolute[4].padStart(2,'0')}:${absolute[5]}:${absolute[6]||'00'}+08:00`;
    }
    else if(structured.articleBody)text=String(structured.articleBody);
  }
  const post=weibo && !!text;
  return {author:author?String(author).trim():undefined,date,text,authorId,likes,views,reposts,post,video,description:weibo&&!post?$('meta[name="description"]').attr('content')||'':''};
}
