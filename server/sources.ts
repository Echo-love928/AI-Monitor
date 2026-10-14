import { z } from 'zod';
import type { Account, Candidate, Evidence, Source, SourceResult } from '../shared/types.js';
import { Store } from './db.js';
import { config, safeError } from './config.js';
import { checkHttp, type HttpClient } from './http.js';
import { article, hash, isoDate, makeEvidence, parseFeed, parseSearch } from './parse.js';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class Throttle { private last = new Map<string, number>(); async wait(key: string, ms: number): Promise<void> { const delay = Math.max(0, (this.last.get(key) || 0) + ms - Date.now()); if (delay) await sleep(delay); this.last.set(key, Date.now()); } }
const tweetSchema = z.object({ id: z.string(), url: z.string(), text: z.string(), createdAt: z.string(), author: z.object({ id: z.string(), userName: z.string() }), likeCount: z.number().optional(), replyCount: z.number().optional(), retweetCount: z.number().optional(), viewCount: z.number().optional() }).passthrough();
const pageSchema = z.object({ tweets: z.array(tweetSchema), has_next_page: z.boolean(), next_cursor: z.string(), status: z.string().optional(), message: z.string().optional() });
export interface Checkpoint { since: number; until?: number; cursor?: string; }
export interface Collected { items: Evidence[]; result: SourceResult; }
export function ingest(store: Store, item: Evidence): void {
  const old = store.get<Candidate>('candidates', item.id);
  if (old && old.collectedHash === item.contentHash) { store.put('candidates', item.id, { ...old, fetchedAt: item.fetchedAt, likes: item.likes, replies: item.replies, reposts: item.reposts, views: item.views }); return; }
  store.put('candidates', item.id, { ...item, collectedHash: item.contentHash, processedHash: old?.processedHash || null, attempts: 0 });
}
export class Collector {
  throttle = new Throttle();
  constructor(public store: Store, public http: HttpClient, public xKey = config.xKey, public timing = true) {}
  async web(source: Source, query: string): Promise<Collected> {
    const cacheId = hash(`${source.id}:${query}`); const cache = this.store.get<{ expires: number; items: Evidence[] }>('cache', cacheId);
    if (cache && cache.expires > Date.now()) return this.result(source, cache.items, 'cached', '复用 30 分钟内结果');
    if (this.timing) await this.throttle.wait(source.id, 5000 + Math.floor(Math.random() * 500));
    const url = new URL(source.url); url.searchParams.set('q', query);
    if (source.id === 'bing') { url.searchParams.set('filters', 'ex1:"ez1"'); url.searchParams.set('setlang', 'en'); }
    const doc = await this.http.request(url.href); checkHttp(doc);
    const items = parseSearch(doc.text, source, doc.url); this.store.put('cache', cacheId, { expires: Date.now() + 30 * 60000, items });
    return this.result(source, items);
  }
  async rss(source: Source, since: number): Promise<Collected> {
    const old = this.store.get<{ etag?: string; modified?: string; items: Evidence[] }>('feeds', source.id);
    const headers: Record<string, string> = {}; if (old?.etag) headers['If-None-Match'] = old.etag; if (old?.modified) headers['If-Modified-Since'] = old.modified;
    const doc = await this.http.request(source.url, { headers, maxBytes: 3 * 1024 * 1024 });
    if (doc.status === 304 && old) return this.result(source, old.items.filter(item => !item.publishedAt || Date.parse(item.publishedAt) >= since), 'cached', '订阅未变化');
    checkHttp(doc); const items = parseFeed(doc.text, source); this.store.put('feeds', source.id, { etag: doc.headers.etag, modified: doc.headers['last-modified'], items: items.slice(0, 100) });
    return this.result(source, items.filter(item => !item.publishedAt || Date.parse(item.publishedAt) >= since));
  }
  async x(source: Source, query: string, fallbackSince: number, account?: Account): Promise<Collected> {
    if (!this.xKey) return this.result(source, [], 'unconfigured', '填写 TWITTERAPI_IO_KEY 后启用 X 采集');
    const settings = this.store.settings(); const key = hash(`x:${account?.id || query}`); const saved = this.store.get<Checkpoint>('checkpoints', key);
    const checkpoint: Checkpoint = saved?.until ? saved : { since: Math.max(0, (saved?.since || fallbackSince) - 10 * 60000), until: Date.now(), cursor: '' };
    this.store.put('checkpoints', key, checkpoint);
    let cursor = checkpoint.cursor || ''; let complete = false; const items: Evidence[] = []; const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      if (!this.store.reserve('xRequests', 1, settings.xDailyLimit)) return this.result(source, items, 'limited', 'X 每日请求上限已到；窗口保留等待续查');
      if ((this.store.usage().xResults || 0) + 20 > settings.xResultDailyLimit) return this.result(source, items, 'limited', 'X 每日结果预算不足以读取下一页');
      if (this.timing) await this.throttle.wait('twitter', 2000);
      const url = new URL(account ? 'https://api.twitterapi.io/twitter/user/last_tweets' : 'https://api.twitterapi.io/twitter/tweet/advanced_search');
      if (account) { url.searchParams.set(account.userId ? 'userId' : 'userName', account.userId || account.userName); url.searchParams.set('includeReplies', 'false'); }
      else { url.searchParams.set('query', `(${query}) since_time:${Math.floor(checkpoint.since / 1000)} until_time:${Math.floor(checkpoint.until! / 1000)}`); url.searchParams.set('queryType', 'Latest'); }
      url.searchParams.set('cursor', cursor);
      const doc = await this.http.request(url.href, { headers: { 'X-API-Key': this.xKey } });
      if (doc.status === 400 && cursor) { this.store.put('checkpoints', key, { ...checkpoint, cursor: '' }); throw new Error('X 续查游标失效，已保留窗口，将重新查询去重'); }
      checkHttp(doc); const data = pageSchema.parse(JSON.parse(doc.text));
      if (data.status && data.status !== 'success') throw new Error(`X 业务请求失败：${data.message || data.status}`);
      this.store.reserve('xResults', data.tweets.length, Number.MAX_SAFE_INTEGER);
      for (const tweet of data.tweets) {
        const publishedAt = isoDate(tweet.createdAt); if (publishedAt && Date.parse(publishedAt) < checkpoint.since) continue;
        const official = config.trustedXIds.includes(tweet.author.id);
        const value = makeEvidence(source, { url: tweet.url, title: tweet.text.slice(0, 100), text: tweet.text, externalId: tweet.id, publishedAt, author: `@${tweet.author.userName}`, authorId: tweet.author.id, official, original: true, likes: tweet.likeCount, replies: tweet.replyCount, reposts: tweet.retweetCount, views: tweet.viewCount });
        if (!items.some(item => item.id === value.id)) items.push(value);
      }
      const reachedOld = account && data.tweets.some(tweet => (isoDate(tweet.createdAt) ? Date.parse(tweet.createdAt) : Infinity) < checkpoint.since);
      this.store.transaction(() => { for (const item of items) ingest(this.store, item); });
      if (!data.has_next_page || reachedOld) { complete = true; break; }
      if (!data.next_cursor || data.next_cursor === cursor || seen.has(data.next_cursor)) throw new Error('X 分页游标重复或缺失，窗口未标为完成');
      seen.add(data.next_cursor); cursor = data.next_cursor;
      this.store.put('checkpoints', key, { ...checkpoint, cursor });
    }
    this.store.put('checkpoints', key, complete ? { since: checkpoint.until } : { ...checkpoint, cursor });
    return this.result(source, items, complete ? (items.length ? 'success' : 'empty') : 'partial', complete ? '增量窗口采集完成' : '已到单轮分页上限，保留窗口继续补查');
  }
  async resolveAccount(account: Account): Promise<Account> {
    if (account.userId || !this.xKey) return account;
    if (!this.store.reserve('xRequests', 1, this.store.settings().xDailyLimit)) throw new Error('X 每日请求上限已到');
    if (this.timing) await this.throttle.wait('twitter', 2000);
    const url = new URL('https://api.twitterapi.io/twitter/user/info'); url.searchParams.set('userName', account.userName);
    const doc = await this.http.request(url.href, { headers: { 'X-API-Key': this.xKey } }); checkHttp(doc);
    const data = z.object({ status: z.literal('success'), data: z.object({ id: z.string() }) }).parse(JSON.parse(doc.text));
    const resolved = { ...account, userId: data.data.id }; this.store.put('accounts', account.id, resolved); return resolved;
  }
  async enrich(item: Evidence): Promise<Evidence> {
    if (item.sourceKind === 'x' || item.original && item.text.length > 600) return item;
    const cache = this.store.get<{ at: number; value: Evidence }>('articles', item.url);
    if (cache && Date.now() - cache.at < 30 * 60000) return { ...cache.value, id: item.id, sourceId: item.sourceId, sourceKind: item.sourceKind };
    try {
      const doc = await this.http.request(item.url); checkHttp(doc); const body = article(doc.text, doc.url);
      const officialHosts = ['openai.com', 'www.anthropic.com', 'anthropic.com', 'blog.google', 'deepmind.google', 'huggingface.co'];
      const finalHost = new URL(doc.url).hostname;
      const value = { ...item, contentKind: 'article' as const, finalUrl: doc.url, text: body.text, title: body.title || item.title, publishedAt: body.publishedAt || item.publishedAt, original: true, official: officialHosts.includes(finalHost), contentHash: hash(body.text) };
      this.store.put('articles', item.url, { at: Date.now(), value }); return value;
    } catch (error) {
      const feed = item.sourceKind === 'rss' ? this.store.get<{ items: Evidence[] }>('feeds', item.sourceId)?.items.find(value => value.id === item.id) : undefined;
      const obtained = item.sourceKind === 'rss' && (feed?.original ? feed : item.original ? item : undefined);
      if (obtained) return { ...item, contentKind: 'feed', original: true, official: obtained.official, title: obtained.title, publishedAt: obtained.publishedAt, text: `${obtained.text}\n[仅有发布源摘要；文章全文未读取：${safeError(error)}]`, contentHash: obtained.contentHash };
      return { ...item, original: false, text: `${item.text}\n[原文未读取：${safeError(error)}]` };
    }
  }
  result(source: Source, items: Evidence[], status?: SourceResult['status'], message = ''): Collected { return { items, result: { sourceId: source.id, name: source.name, kind: source.kind, status: status || (items.length ? 'success' : 'empty'), count: items.length, message } }; }
}
