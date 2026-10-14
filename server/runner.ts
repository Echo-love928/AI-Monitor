import { randomUUID } from 'node:crypto';
import type { Account, Candidate, Evidence, Rule, Run, Signal, Source } from '../shared/types.js';
import { Store } from './db.js';
import { INTERVAL_MS, safeError } from './config.js';
import { Collector, ingest } from './sources.js';
import { Analyzer, type AnalysisResult } from './ai.js';
import { queueNotifications } from './mail.js';
export interface AnalysisService { analyze(evidence: Evidence[], rules: Rule[], prior: Signal[]): Promise<AnalysisResult>; }
export class Runner {
  constructor(public store: Store, public collector: Collector, public analyzer: AnalysisService) {}
  async scan(trigger = '定时检查'): Promise<Run | null> {
    const owner = randomUUID(); if (!this.store.lease('scan', owner, 120000)) return null;
    const renewal = setInterval(() => this.store.lease('scan', owner, 120000), 30000); renewal.unref();
    const started = Date.now(); let rules = this.store.list<Rule>('rules').filter(rule => rule.enabled && (trigger !== '定时检查' || Date.parse(rule.nextRunAt) <= started));
    if (!rules.length) { clearInterval(renewal); this.store.release('scan', owner); return null; }
    const run: Run = { id: randomUUID(), startedAt: new Date(started).toISOString(), finishedAt: null, status: 'running', trigger, ruleIds: rules.map(rule => rule.id), sources: [], analyzed: 0, newSignals: 0, message: '' };
    this.store.put('runs', run.id, run); this.store.put('state', 'lastScanStarted', started);
    for (const old of this.store.list<Run>('runs').filter(item => item.status === 'running' && item.id !== run.id)) this.store.put('runs', old.id, { ...old, status: 'failed', finishedAt: run.startedAt, message: '服务重启或租约失效后恢复；候选和检查点仍保留' });
    const sources = this.store.list<Source>('sources'); const since = started - this.store.settings().lookbackHours * 3600000;
    const gathered: Evidence[] = [];
    const collect = async (source: Source, task: () => ReturnType<Collector['rss']>) => { let succeeded = true; try { const value = await task(); gathered.push(...value.items); run.sources.push(value.result); } catch (error) { succeeded = false; run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: 'failed', count: 0, message: safeError(error) }); } this.store.put('runs', run.id, run); return succeeded; };
    try {
      const queries = [...new Set(rules.map(rule => rule.query))]; let webRequests = 0;
      if (trigger === '重新核实') {
        const cached = this.store.list<Candidate>('candidates');
        for (const source of sources) run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: source.enabled ? 'cached' : 'disabled', count: source.enabled ? cached.filter(item => item.sourceId === source.id).length : 0, message: source.enabled ? '复用持久化候选，本次不重新请求采集来源' : '已暂停' });
      } else await Promise.all(sources.map(async source => {
        if (!source.enabled) { run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: 'disabled', count: 0, message: '已暂停' }); return; }
        if (source.kind === 'rss') await collect(source, () => this.collector.rss(source, since));
        if (source.kind === 'web') for (const query of queries) { if (webRequests++ >= this.store.settings().searchPerRunLimit) { run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: 'limited', count: 0, message: '本轮搜索请求上限已到' }); break; } if (!await collect(source, () => this.collector.web(source, query))) break; }
        if (source.kind === 'x') {
          for (const query of queries) if (!await collect(source, () => this.collector.x(source, query, since))) return;
          for (const account of this.store.list<Account>('accounts').filter(item => item.enabled).slice(0, 10)) if (!await collect(source, async () => this.collector.x(source, '', since, await this.collector.resolveAccount(account)))) break;
        }
      }));
      this.store.put('runs', run.id, run);
      const unique = [...new Map(gathered.map(item => [item.id, item])).values()];
      for (const item of unique) ingest(this.store, item);
      const pending = this.store.list<Candidate>('candidates').filter(item => item.processedHash !== item.contentHash && item.attempts < 3 && (!item.publishedAt || Date.parse(item.publishedAt) >= since));
      const buckets = new Map<string, Candidate[]>(); for (const item of pending) { const bucket = buckets.get(item.sourceId) || []; bucket.push(item); buckets.set(item.sourceId, bucket); }
      for (const bucket of buckets.values()) bucket.sort((a, b) => (b.publishedAt || b.fetchedAt).localeCompare(a.publishedAt || a.fetchedAt));
      const selected: Candidate[] = []; while (selected.length < this.store.settings().candidatePerRunLimit && [...buckets.values()].some(bucket => bucket.length)) for (const bucket of buckets.values()) { if (selected.length >= this.store.settings().candidatePerRunLimit) break; const value = bucket.shift(); if (value) selected.push(value); }
      if (selected.length && this.analyzer instanceof Analyzer && (!this.analyzer.apiKey || !this.store.settings().model)) run.message = 'AI 尚未配置：已保存候选内容，配置 Key 与模型后点击重新核实';
      else if (selected.length) {
        const evidence: Evidence[] = [];
        for (const item of selected) { const value = await this.collector.enrich(item); evidence.push(value); this.store.put('candidates', item.id, { ...value, processedHash: item.processedHash, attempts: item.attempts }); }
        for (let offset = 0; offset < evidence.length; offset += 15) {
          const batch = evidence.slice(offset, offset + 15);
          try {
            const prior = this.store.list<Signal>('events'); const { signals, excludedEvidenceIds } = await this.analyzer.analyze(batch, rules, prior);
            this.store.transaction(() => {
              for (const signal of signals) { if (!this.store.get('events', signal.id)) run.newSignals++; this.store.put('events', signal.id, signal); }
              for (const item of batch) { const related = signals.filter(signal => signal.evidence.some(ev => ev.id === item.id)); const old = this.store.get<Candidate>('candidates', item.id)!; this.store.put('candidates', item.id, { ...old, processedHash: excludedEvidenceIds.includes(item.id) || related.length && related.every(signal => signal.status !== 'pending') ? item.contentHash : null, attempts: old.attempts + 1 }); }
            });
            run.analyzed += batch.length; this.store.put('runs', run.id, run);
          } catch (error) {
            run.message = safeError(error);
            for (const item of batch) { const old = this.store.get<Candidate>('candidates', item.id)!; this.store.put('candidates', item.id, { ...old, attempts: old.attempts + 1 }); }
            break;
          }
        }
      }
      queueNotifications(this.store, this.store.list<Signal>('events'), rules);
      for (const rule of rules) { const current = this.store.get<Rule>('rules', rule.id); if (!current) continue; this.store.put('rules', rule.id, { ...current, baselineAt: current.baselineAt || run.startedAt, lastRunAt: run.startedAt, nextRunAt: new Date(started + INTERVAL_MS).toISOString() }); }
      const active = run.sources.filter(item => item.status !== 'disabled'); const succeeded = active.filter(item => ['success', 'empty', 'cached', 'partial'].includes(item.status));
      run.status = !succeeded.length ? 'failed' : active.some(item => ['failed', 'unconfigured', 'partial', 'limited'].includes(item.status)) || !!run.message ? 'partial' : 'success';
      if (!run.message) run.message = run.status === 'failed' ? '所有启用来源均未成功，请查看来源记录' : trigger === '重新核实' ? `复用候选，分析 ${run.analyzed} 条，新增 ${run.newSignals} 个事件` : `采集 ${unique.length} 条候选，分析 ${run.analyzed} 条，新增 ${run.newSignals} 个事件`;
    } catch (error) { run.status = 'failed'; run.message = safeError(error); }
    finally { run.finishedAt = new Date().toISOString(); this.store.put('runs', run.id, run); clearInterval(renewal); this.store.release('scan', owner); }
    return run;
  }
}
