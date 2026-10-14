import { load } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import type { Evidence, Source } from '../shared/types.js';
import { publicUrl } from './http.js';
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const isoDate = (value: unknown): string | null => { if (typeof value !== 'string' || !value.trim()) return null; const d = new Date(value); return Number.isFinite(d.getTime()) && d.getTime() <= Date.now() + 300000 ? d.toISOString() : null; };
export function canonical(raw: string): string { const url = publicUrl(raw); url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key); return url.href; }
export function makeEvidence(source: Source, raw: Partial<Evidence> & { url: string; title: string; text: string }): Evidence {
  const url = canonical(raw.url); const text = raw.text.replace(/\s+/g, ' ').trim().slice(0, 9000);
  return { id: hash(`${source.id}:${raw.externalId || url}`), sourceId: source.id, sourceKind: source.kind, contentKind: source.kind === 'rss' ? 'feed' : source.kind === 'x' ? 'post' : 'snippet', externalId: raw.externalId || url, finalUrl: url, publishedAt: null, fetchedAt: new Date().toISOString(), author: new URL(url).hostname, official: false, original: false, ...raw, url, title: raw.title.slice(0, 240), text, contentHash: hash(`${raw.title}|${text}`) };
}
export function searchLink(raw: string, base: string): string {
  const url = new URL(raw, base);
  if (url.hostname.endsWith('bing.com') && url.pathname === '/ck/a') { const u = url.searchParams.get('u'); if (u?.startsWith('a1')) return canonical(Buffer.from(u.slice(2), 'base64url').toString('utf8')); }
  if (url.hostname.endsWith('duckduckgo.com') && url.searchParams.has('uddg')) return canonical(url.searchParams.get('uddg')!);
  return canonical(url.href);
}
export function parseSearch(html: string, source: Source, base: string): Evidence[] {
  const $ = load(html); const pageText = $('body').text();
  if (/verify (?:you are|you're) human|unusual traffic|captcha|anomaly\.js|b_captcha|验证您是|异常流量/i.test(pageText + html.slice(0, 10000))) throw new Error('搜索页出现验证码或访问校验，本轮停止该来源');
  const entries = source.id === 'duckduckgo' ? $('.result, tr:has(.result-link)') : $('.b_algo');
  const result: Evidence[] = [];
  entries.each((_, el) => { const node = $(el); const link = source.id === 'duckduckgo' ? node.find('.result__a, .result-link').first() : node.find('h2 a').first(); const title = link.text().trim(); const href = link.attr('href'); if (!title || !href) return; try { const url = searchLink(href, base); if (/\.(bing|duckduckgo)\.com$/.test(new URL(url).hostname)) return; result.push(makeEvidence(source, { url, title, text: node.find('.b_caption p, .result__snippet, .result-snippet').text() || title })); } catch { /* Invalid/private targets are excluded. */ } });
  if (!result.length && !/no results|did not match|没有找到|找不到.*结果/i.test(pageText)) throw new Error('无法识别搜索结果结构，未将此响应视为零结果');
  return result.slice(0, 10);
}
export function article(html: string, url: string): { title: string; text: string; publishedAt: string | null } {
  const $ = load(html); let date = $('meta[property="article:published_time"]').attr('content') || $('meta[name="date"]').attr('content') || $('time[datetime]').first().attr('datetime');
  if (!date) $('script[type="application/ld+json"]').each((_, el) => { try { const data = JSON.parse($(el).text()); const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])]; for (const node of nodes) if (node.datePublished) { date = node.datePublished; break; } } catch { /* Ignore malformed metadata. */ } });
  const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text();
  $('script,style,nav,footer,header,aside,form,noscript').remove();
  const main = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  const text = main.text().replace(/\s+/g, ' ').trim().slice(0, 9000);
  if (text.length < 80 || /checking your browser|verify you are human|just a moment|enable javascript and cookies/i.test(text.slice(0, 800))) throw new Error(`原文不可读取：${new URL(url).hostname}`);
  return { title: title.trim().slice(0, 240), text, publishedAt: isoDate(date) };
}
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const str = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' ? str((value as Record<string, unknown>)['#text']) : '';
export function parseFeed(xml: string, source: Source): Evidence[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('订阅包含不支持的外部实体声明');
  if (XMLValidator.validate(xml) !== true) throw new Error('订阅不是有效 XML');
  const data = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(xml);
  const atom = !!data.feed; const items = atom ? list<Record<string, unknown>>(data.feed.entry) : list<Record<string, unknown>>(data.rss?.channel?.item);
  if (!data.feed && !data.rss?.channel) throw new Error('响应不是 RSS 或 Atom 订阅');
  return items.flatMap(item => { try {
    const link = atom ? list<Record<string, string>>(item.link as Record<string, string>[]).find(v => !v['@_rel'] || v['@_rel'] === 'alternate')?.['@_href'] || '' : str(item.link);
    const rawBody = str(item['content:encoded']) || str(item.content) || str(item.description) || str(item.summary); const body = load(rawBody).text();
    const publishedAt = isoDate(str(item.pubDate) || str(item.published) || str(item['dc:date']));
    const url = canonical(link); const official = source.official && new URL(url).hostname === new URL(source.url).hostname;
    return [makeEvidence(source, { url, title: str(item.title), text: body || str(item.title), externalId: str(item.guid) || str(item.id) || url, publishedAt, official, original: body.length >= 80, author: str(item['dc:creator']) || str(item.author) || new URL(url).hostname })];
  } catch { return []; } }).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}
