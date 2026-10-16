import type { Candidate, Signal } from '../shared/types.js';
import { expiredEvidence, FRESHNESS_MS, signalTime } from '../shared/freshness.js';
import type { Store } from './db.js';
import { QUALITY_VERSION } from './quality.js';

// Expiration only updates eligibility; raw contents and previous snapshots remain.
export function expireContent(store: Store, now = Date.now()): { candidates: number; events: number } {
  const counts = { candidates: 0, events: 0 };
  store.transaction(() => {
    for (const item of store.list<Candidate>('candidates')) {
      if (!expiredEvidence(item, now) || item.quality?.reason === '超过 5 天，自动排除并停止重试') continue;
      store.put('candidates', item.id, { ...item, quality: { version: QUALITY_VERSION, decision: 'filtered', reason: '超过 5 天，自动排除并停止重试' }, processedHash: item.contentHash }); counts.candidates++;
    }
    for (const signal of store.list<Signal>('events')) {
      const time = signalTime(signal, now);
      if (time === null || time >= now - FRESHNESS_MS || signal.auditReason === '超过 5 天，自动退出热点列表') continue;
      store.put('events', signal.id, { ...signal, auditOnly: true, auditReason: '超过 5 天，自动退出热点列表' }); counts.events++;
    }
  });
  return counts;
}
