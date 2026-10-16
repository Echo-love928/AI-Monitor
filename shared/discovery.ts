import type { Evidence } from './types.js';
import { withinWindow } from './freshness.js';

export type Platform = 'x' | 'bilibili' | 'weibo' | 'web' | 'rss';
export const platformNames: Record<Platform,string> = { x:'X / Twitter',bilibili:'B站',weibo:'微博',web:'网页与媒体',rss:'官方发布与订阅' };

export function platformOf(item: Evidence): Platform {
  const host=new URL(item.finalUrl).hostname;
  if(item.sourceKind === 'x' || /(^|\.)(x\.com|twitter\.com)$/.test(host)) return 'x';
  if(/(^|\.)bilibili\.com$/.test(host)) return 'bilibili';
  if(/(^|\.)(weibo\.com|weibo\.cn)$/.test(host)) return 'weibo';
  return item.sourceKind === 'rss' ? 'rss' : 'web';
}

export function nonTwitterDiscovery(item: Evidence,now=Date.now()): boolean {
  if(item.sourceKind === 'x' || platformOf(item) === 'x' || item.quality?.decision !== 'eligible' || !item.original || !withinWindow(item.publishedAt,now)) return false;
  const url=new URL(item.finalUrl);
  if(/(^|\.)(bing|sogou|baidu|duckduckgo|brave)\.com$/.test(url.hostname) || /^\/(search|tag|category)(\/|$)/i.test(url.pathname)) return false;
  if(platformOf(item) === 'bilibili') return /^\/video\/BV[a-zA-Z0-9]+\/?$/.test(url.pathname) && item.contentKind === 'description' && item.text.length>=40 && !!item.author && !/bilibili\.com$/i.test(item.author);
  if(platformOf(item) === 'weibo') return /^\/(?:\d+\/[A-Za-z0-9]+|status\/[A-Za-z0-9]+|detail\/\d+|comment\/[A-Za-z0-9]+)\/?$/.test(url.pathname) && item.contentKind === 'post' && item.text.length>=40 && !!item.author && !/weibo\.(com|cn)$/i.test(item.author);
  return (item.contentKind === 'article' || item.contentKind === 'feed' && item.official) && item.text.length>=80 && !!item.author && url.pathname!=='/';
}
