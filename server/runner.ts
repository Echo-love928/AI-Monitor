import { randomUUID } from 'node:crypto';
import type { Account, Candidate, Evidence, Rule, Run, Signal, Source } from '../shared/types.js';
import { Store } from './db.js';
import { INTERVAL_MS, safeError } from './config.js';
import { Collector, ingest } from './sources.js';
import { Analyzer, type AnalysisResult } from './ai.js';
import { queueNotifications } from './mail.js';
import { applyQuality, discoveryCandidate, evidenceKey, linkedUrls, mergeEvidence, selectCandidates } from './quality.js';
import { nonTwitterDiscovery, platformOf } from '../shared/discovery.js';
import { discoverySearches, xQueryFor } from './search.js';
import { currentSignal, expiredEvidence, FRESHNESS_MS } from '../shared/freshness.js';
import { expireContent } from './retention.js';
import { syncTwitterEvents } from './twitter-policy.js';

export interface AnalysisService { analyze(evidence: Evidence[], rules: Rule[], prior: Signal[]): Promise<AnalysisResult>; }
export class Runner {
  constructor(public store: Store, public collector: Collector, public analyzer: AnalysisService) {}
  async scan(trigger = '定时检查'): Promise<Run | null> {
    const owner = randomUUID(); if (!this.store.lease('scan', owner, 120000)) return null;
    const renewal = setInterval(() => this.store.lease('scan', owner, 120000), 30000); renewal.unref();
    const started = Date.now();
    expireContent(this.store,started);
    const rules = this.store.list<Rule>('rules').filter(rule => rule.enabled && (trigger !== '定时检查' || Date.parse(rule.nextRunAt) <= started));
    if (!rules.length) { clearInterval(renewal); this.store.release('scan', owner); return null; }
    const run: Run = { id: randomUUID(), startedAt: new Date(started).toISOString(), finishedAt: null, status: 'running', trigger, ruleIds: rules.map(rule => rule.id), sources: [], analyzed: 0, newSignals: 0, message: '' };
    this.store.put('runs', run.id, run); this.store.put('state', 'lastScanStarted', started);
    for (const old of this.store.list<Run>('runs').filter(item => item.status === 'running' && item.id !== run.id)) this.store.put('runs', old.id, { ...old, status: 'failed', finishedAt: run.startedAt, message: '服务重启或租约失效后恢复；候选和检查点仍保留' });
    const settings = this.store.settings();
    const discoveryBudget=Math.max(1,Math.ceil(settings.searchPerRunLimit*0.6));
    const sources = this.store.list<Source>('sources'); const since = started - FRESHNESS_MS;
    const gathered: Evidence[] = []; let webRequests = 0;
    const failedEngines = new Set<string>();
    const collect = async (source: Source, task: () => ReturnType<Collector['rss']>, purpose: 'discovery' | 'verification' | 'metrics' = 'discovery', query?: string) => {
      run.sources=run.sources.filter(row=>!(row.sourceId===source.id && row.status==='standby'));
      try {
        const value = await task(); gathered.push(...value.items); run.sources.push({ ...value.result, purpose, query: query || value.result.query });
        return value.items;
      } catch (error) {
        run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: 'failed', count: 0, message: safeError(error), purpose, query });
        if (source.kind === 'web') failedEngines.add(source.id);
        return [];
      } finally { this.store.put('runs', run.id, run); }
    };
    const save = (item: Evidence) => {
      const old = this.store.get<Candidate>('candidates', item.id);
      this.store.put('candidates', item.id, { ...old, ...item, processedHash: item.quality?.decision === 'filtered' ? item.contentHash : old?.processedHash || null, attempts: old?.attempts || 0 });
    };
    try {
      const recheck = trigger === '重新核实';
      if (recheck) {
        const cached = this.store.list<Candidate>('candidates');
        for (const source of sources) run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: source.enabled ? 'cached' : 'disabled', count: source.enabled ? cached.filter(item => item.sourceId === source.id).length : 0, message: source.enabled ? '复用持久化候选，本次不重新请求采集来源' : '已暂停' });
      } else {
        await Promise.all(sources.map(async source => {
          if (!source.enabled) { run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: 'disabled', count: 0, message: '已暂停' }); return; }
          if (source.kind === 'web') { run.sources.push({sourceId:source.id,name:source.name,kind:source.kind,status:'standby',count:0,message:'等待本轮独立发现或定向补证查询',purpose:'discovery'}); return; }
          if (source.kind === 'rss') {
            const first=gathered.length;
            await collect(source, () => source.format === 'page' ? this.collector.page(source, since) : this.collector.rss(source, since));
            for(const item of gathered.slice(first).filter(item=>item.sourceId === source.id && source.official && !item.publishedAt).slice(0,3)) {
              const enriched=await this.collector.enrich(item);const index=gathered.findIndex(value=>value.id===item.id);if(index>=0)gathered[index]=enriched;
            }
          }
          if (source.kind === 'x') {
            for (const account of this.store.list<Account>('accounts').filter(item => item.enabled).slice(0, 10)) await collect(source, async () => this.collector.x(source, '', since, await this.collector.resolveAccount(account)));
            for (const query of [...new Set(rules.map(xQueryFor))]) {
              const before=run.sources.filter(row=>row.sourceId===source.id && row.status==='failed').length;
              await collect(source, () => this.collector.x(source, query, since));
              if(run.sources.filter(row=>row.sourceId===source.id && row.status==='failed').length>before)break;
            }
          }
        }));
        const rotation=this.store.get<number>('state','discoveryRotation')||0;
        const jobs=discoverySearches(rules,sources,discoveryBudget,rotation,started);
        this.store.put('state','discoveryRotation',rotation+1);
        let discoveryEngine=rotation;
        const blockedPlatforms=new Set<string>();
        for(const job of jobs) {
          if(webRequests>=discoveryBudget)break;
          const engines=sources.filter(item=>item.enabled && item.kind==='web' && !item.format && !failedEngines.has(item.id)).sort((a,b)=>a.id.localeCompare(b.id));
          const engine=engines[discoveryEngine%engines.length];let found:Evidence[]=[];
          if(job.source.format==='bilibili' && !blockedPlatforms.has(job.source.id)) {
            webRequests++;found=await collect(job.source,()=>this.collector.videoSearch(job.source,job.query),'discovery',job.query);
            if(run.sources.at(-1)?.status==='failed')blockedPlatforms.add(job.source.id);
          } else if(engine) {
            webRequests++;discoveryEngine++;
            const query=job.source.format==='bilibili'?'site:bilibili.com/video '+job.query+' '+new Date(started).toISOString().slice(0,7):job.query;
            found=await collect(job.source.format?job.source:engine,()=>job.source.format?this.collector.platformSearch(job.source,engine,query):this.collector.web(engine,query),'discovery',query);
            if(run.sources.at(-1)?.status==='failed')failedEngines.add(engine.id);
          } else {run.sources.push({sourceId:job.source.id,name:job.source.name,kind:job.source.kind,status:'failed',count:0,message:'没有可用的公开搜索引擎，保留后续检查',purpose:'discovery',query:job.query});}
          for(const item of mergeEvidence(found).filter(item=>item.quality?.decision!=='filtered').slice(0,3)) {
            const value=applyQuality(nonTwitterDiscovery(item,started)?item:await this.collector.enrich(item));
            const index=gathered.findIndex(ev=>ev.id===value.id);if(index>=0)gathered[index]=value;else gathered.push(value);
          }
        }
        for(const source of sources.filter(item=>item.enabled && item.kind === 'x')) await collect(source,()=>this.collector.refreshMetrics(source),'metrics');
      }

      const unique = [...new Map(gathered.map(item => [item.id, item])).values()];
      for (const item of unique) ingest(this.store, item);
      const all = this.store.list<Candidate>('candidates');
      const classified = all.map(item => ({ ...item, ...applyQuality(item, all) }));
      for (const item of classified) this.store.put('candidates', item.id, { ...item, processedHash: item.quality?.decision === 'filtered' ? item.contentHash : item.processedHash });
      syncTwitterEvents(this.store);
      const enabledSources = new Set(sources.filter(source => source.enabled).map(source => source.id));
      const disabledPlatforms=new Set(sources.filter(source=>!source.enabled && ['bilibili','weibo'].includes(source.format||'')).map(source=>source.id));
      const pending = classified.filter(item => !disabledPlatforms.has(platformOf(item)) && enabledSources.has(item.sourceId) && discoveryCandidate(item,started) && item.processedHash !== item.contentHash && item.attempts < 3);
      const selected = selectCandidates(pending, settings.candidatePerRunLimit);

      if (selected.length && this.analyzer instanceof Analyzer && (!this.analyzer.apiKey || !settings.model)) run.message = 'AI 尚未配置：已保存候选内容，配置 Key 与模型后点击重新核实';
      else if (selected.length) {
        const prepared: Evidence[][] = []; let evidenceCount = 0;
        const reservedOther=selected.filter(item=>item.sourceKind!=='x').length;
        const materialLimits={x:settings.candidatePerRunLimit-reservedOther,other:selected.some(item=>item.sourceKind==='x')?reservedOther:settings.candidatePerRunLimit};
        const materialCounts={x:0,other:0};
        for (const item of selected) {
          if (evidenceCount >= settings.candidatePerRunLimit) break;
          const lane=item.sourceKind==='x'?'x':'other';
          if(materialCounts[lane]>=materialLimits[lane])continue;
          const value = applyQuality(recheck ? item : await this.collector.enrich(item), classified); save(value);
          if(value.quality?.decision === 'filtered') continue;
          if(value.publishedAt && Date.parse(value.publishedAt)<since) {
            save({...value,quality:{version:value.quality!.version,decision:'filtered',reason:'原文发布时间超出本轮监控窗口，不作为新事件'}}); continue;
          }
          let group: Evidence[] = [value];
          if (item.sourceKind === 'x') {
            const linked = recheck ? all.filter(ev => ev.sourceKind !== 'x' && linkedUrls(item).includes(ev.url)) : await this.collector.linked(item);
            // Old linked originals remain context so a fresh tweet cannot conceal the original date.
            const usable = linked.filter(link => link.original);
            for (const link of linked) { ingest(this.store, link); save(link); }
            group.push(...usable);
          }
          if (!recheck && (!group.some(ev => ev.official && ev.original) || !value.publishedAt) && webRequests < settings.searchPerRunLimit) {
            const engines = sources.filter(source => source.enabled && source.kind === 'web' && !source.format && !failedEngines.has(source.id)).sort((a,b)=>a.id.localeCompare(b.id));
            const engine = engines[webRequests % engines.length];
            if (engine) {
              const query = value.title.slice(0,100) + ' official announcement'; webRequests++;
              const found = await collect(engine, () => this.collector.web(engine, query), 'verification', query);
              for (const link of found.filter(item=>item.quality?.decision !== 'filtered').slice(0,2)) { const ev = applyQuality(await this.collector.enrich(link)); ingest(this.store, ev); save(ev); if(ev.quality?.decision === 'eligible' || ev.original && expiredEvidence(ev)) group.push(ev); }
            }
          }
          group.push(...classified.filter(ev => ev.quality?.decision === 'context' && (ev.inReplyToId === value.externalId || ev.conversationId === value.externalId)));
          group = mergeEvidence(group).slice(0,15);
          group=group.slice(0,Math.min(settings.candidatePerRunLimit-evidenceCount,materialLimits[lane]-materialCounts[lane]));
          evidenceCount += group.length;materialCounts[lane]+=group.length; prepared.push(group);
        }
        // Keep each tweet with its linked originals in the same AI batch.
        const batches: Evidence[][] = [];
        for (const group of prepared) { const last = batches.at(-1); if (!last || mergeEvidence([...last, ...group]).length > 15) batches.push(group); else batches[batches.length - 1] = mergeEvidence([...last,...group]); }
        for (const batch of batches) {
          try {
            const prior = this.store.list<Signal>('events');
            const analysisRules=this.store.list<Rule>('rules').filter(rule=>rule.enabled);
            const { signals, excludedEvidenceIds,issues=[] } = await this.analyzer.analyze(batch, analysisRules, prior);
            const unresolved=new Set(issues.flatMap(issue=>issue.evidenceIds));
            if(issues.length)run.message=[run.message,...new Set(issues.map(issue=>issue.message))].filter(Boolean).join('；');
            const aliases=new Map<string,Candidate[]>();
            for(const item of this.store.list<Candidate>('candidates')) {const key=evidenceKey(item);const bucket=aliases.get(key)||[];bucket.push(item);aliases.set(key,bucket);}
            this.store.transaction(() => {
              for (const signal of signals) { if (!this.store.get('events', signal.id) && currentSignal(signal)) run.newSignals++; this.store.put('events', signal.id, signal); }
              for (const item of batch) {
                const related = signals.filter(signal => signal.evidence.some(ev => ev.id === item.id));
                const done = expiredEvidence(item) || !unresolved.has(item.id) && (excludedEvidenceIds.includes(item.id) || !!related.length && related.every(signal => signal.status !== 'pending' || signal.auditOnly));
                const old = this.store.get<Candidate>('candidates', item.id); if (!old) continue;
                this.store.put('candidates', item.id, { ...old, processedHash: done ? item.contentHash : null, attempts: old.attempts + 1 });
                for (const alias of (aliases.get(evidenceKey(item)) || []).filter(ev => ev.id !== item.id && ev.contentHash === item.contentHash)) this.store.put('candidates', alias.id, { ...alias, processedHash: done ? alias.contentHash : null, attempts: old.attempts + 1 });
              }
            });
            run.analyzed += batch.filter(item=>!unresolved.has(item.id)).length; this.store.put('runs', run.id, run);
          } catch (error) {
            run.message = safeError(error);
            for (const item of batch) { const old = this.store.get<Candidate>('candidates', item.id); if (old) this.store.put('candidates', item.id, { ...old, attempts: old.attempts + 1 }); }
            break;
          }
        }
      }
      const current = this.store.list<Candidate>('candidates');
      const provenance=new Map(mergeEvidence(current).map(item=>[evidenceKey(item),item.discoveredBy || [item.sourceId]]));
      for(const item of current) { item.discoveredBy=provenance.get(evidenceKey(item)); this.store.put('candidates',item.id,item); }
      for (const source of sources) {
        const result = run.sources.find(value => value.sourceId === source.id); if (!result) continue;
        const values = current.filter(item => item.sourceId === source.id && Date.parse(item.fetchedAt) >= started);
        result.originalCount = values.filter(item => item.original).length;
        result.uniqueCount = mergeEvidence(values).filter(item => (item.discoveredBy || [item.sourceId]).length === 1).length;
        result.filtered = values.filter(item => item.quality?.decision === 'filtered').length; result.filterReasons = {};
        for (const item of values.filter(item => item.quality?.decision === 'filtered')) result.filterReasons[item.quality!.reason] = (result.filterReasons[item.quality!.reason] || 0) + 1;
      }
      queueNotifications(this.store, this.store.list<Signal>('events'), rules);
      for (const rule of rules) { const currentRule = this.store.get<Rule>('rules', rule.id); if (currentRule) this.store.put('rules', rule.id, { ...currentRule, baselineAt: currentRule.baselineAt || run.startedAt, lastRunAt: run.startedAt, nextRunAt: new Date(started + INTERVAL_MS).toISOString() }); }
      const active = run.sources.filter(item => item.status !== 'disabled' && item.status !== 'standby'); const succeeded = active.filter(item => ['success', 'empty', 'cached', 'partial'].includes(item.status));
      run.status = !succeeded.length ? 'failed' : active.some(item => ['failed', 'unconfigured', 'partial', 'limited'].includes(item.status)) || !!run.message ? 'partial' : 'success';
      if (!run.message) run.message = run.status === 'failed' ? '所有启用来源均未成功，请查看来源记录' : '采集 ' + unique.length + ' 条候选，分析 ' + run.analyzed + ' 条，新增 ' + run.newSignals + ' 个事件；过滤 ' + current.filter(item=>item.quality?.decision === 'filtered' && Date.parse(item.fetchedAt)>=started).length + ' 条';
    } catch (error) { run.status = 'failed'; run.message = safeError(error); }
    finally { run.finishedAt = new Date().toISOString(); this.store.put('runs', run.id, run); clearInterval(renewal); this.store.release('scan', owner); }
    return run;
  }
}
