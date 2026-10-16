import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../server/db.js';
import { PublicHttp } from '../server/http.js';
import { Collector } from '../server/sources.js';
import { safeError } from '../server/config.js';
import { FRESHNESS_MS } from '../shared/freshness.js';
import type { Source } from '../shared/types.js';
const store = new Store(':memory:'); const http = new PublicHttp(); const collector = new Collector(store, http);
const results: unknown[] = [];
try {
  for (const source of store.list<Source>('sources').filter(item => item.enabled && item.kind !== 'x')) {
    try { const result = source.kind === 'web' ? await collector.web(source, ['baidu','sogou'].includes(source.id) ? 'AI 编程 模型 最新 发布' : 'AI coding model release') : source.format === 'page' ? await collector.page(source, Date.now() - FRESHNESS_MS) : await collector.rss(source, Date.now() - FRESHNESS_MS);
      const value = { name: source.name, status: result.result.status, count: result.items.length, sample: result.items.slice(0, 2).map(item => ({ title: item.title, url: item.url, publishedAt: item.publishedAt })), message: result.result.message }; results.push(value); console.log(JSON.stringify(value));
    } catch (error) { const value = { name: source.name, status: 'failed', error: safeError(error) }; results.push(value); console.log(JSON.stringify(value)); }
  }
  mkdirSync('reports', { recursive: true }); writeFileSync('reports/live-sources.json', JSON.stringify({ checkedAt: new Date().toISOString(), environment: 'local Node.js HTTP client', results }, null, 2));
} finally { store.close(); await http.close(); }
