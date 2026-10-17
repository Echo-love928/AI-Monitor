import type { Candidate, Evidence, Signal } from '../shared/types.js';
import type { Store } from './db.js';
import { applyQuality, evidenceKey } from './quality.js';
import { metadataFields } from '../shared/engagement.js';

export function twitterFields(item: Evidence): Partial<Evidence> {
  return { ...metadataFields(item),likes:item.likes,reposts:item.reposts,replies:item.replies,views:item.views,authorFollowers:item.authorFollowers,authorBlueVerified:item.authorBlueVerified,metricsCheckedAt:item.metricsCheckedAt,metricsAttemptedAt:item.metricsAttemptedAt,metricsUnavailable:item.metricsUnavailable,postType:item.postType,original:item.original };
}

// Metrics change independently of the text. Update embedded event evidence too.
export function syncTwitterEvents(store: Store): void {
  const candidates=new Map(store.list<Candidate>('candidates').filter(item=>item.sourceKind === 'x').map(item=>[item.externalId,item]));
  for(const event of store.list<Signal>('events')) {
    if(!event.evidence.some(item=>item.sourceKind === 'x')) continue;
    const evidence=event.evidence.map(item=>item.sourceKind === 'x' ? applyQuality({...item,...(candidates.has(item.externalId) ? twitterFields(candidates.get(item.externalId)!) : {})}) : item);
    if(JSON.stringify(evidence)!==JSON.stringify(event.evidence)) store.put('events',event.id,{...event,evidence});
  }
}

// Refresh all embedded evidence, including unchanged text and discovery aliases.
export function syncEvidenceMetadata(store: Store): void {
  syncTwitterEvents(store);
  const candidates = store.list<Candidate>('candidates').filter(item => item.sourceKind !== 'x' && item.original).sort((a,b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
  const byUrl = new Map<string, Candidate>();
  for (const item of candidates) {
    const key = evidenceKey(item); const previous = byUrl.get(key);
    byUrl.set(key, { ...item, ...metadataFields(previous || {}), ...metadataFields(item) });
  }
  for (const event of store.list<Signal>('events')) {
    const evidence = event.evidence.map(item => {
      const latest = byUrl.get(evidenceKey(item));
      return item.sourceKind !== 'x' && latest && Date.parse(latest.fetchedAt) >= Date.parse(item.fetchedAt) ? { ...item, ...metadataFields(latest) } : item;
    });
    if (JSON.stringify(evidence) !== JSON.stringify(event.evidence)) store.put('events',event.id,{...event,evidence});
  }
}
