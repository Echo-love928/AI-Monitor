import type { Candidate, Evidence, Signal } from '../shared/types.js';
import type { Store } from './db.js';
import { applyQuality } from './quality.js';

export function twitterFields(item: Evidence): Partial<Evidence> {
  return { likes:item.likes,reposts:item.reposts,replies:item.replies,views:item.views,authorFollowers:item.authorFollowers,authorBlueVerified:item.authorBlueVerified,metricsCheckedAt:item.metricsCheckedAt,metricsAttemptedAt:item.metricsAttemptedAt,metricsUnavailable:item.metricsUnavailable,postType:item.postType,original:item.original };
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
