import type { Candidate, Signal } from '../shared/types.js';
import { RELEVANCE_VERSION } from '../shared/relevance.js';
import type { Store } from './db.js';

// Archive before changing eligibility; no network and no notification is generated.
export function migrateRelevance(store: Store): void {
  if(store.get<number>('state','relevanceVersion')===RELEVANCE_VERSION)return;
  for(const signal of store.list<Signal>('events')) {
    if(!store.get('relevance-audit-v1',signal.id))store.put('relevance-audit-v1',signal.id,signal);
    store.put('events',signal.id,{...signal,relevanceVersion:RELEVANCE_VERSION,ruleAssessments:[],relevanceRechecked:true,auditOnly:true,auditReason:signal.auditOnly?signal.auditReason:'关联待审核：历史内容尚未通过逐监控审核'});
  }
  for(const item of store.list<Candidate>('candidates')) {
    store.put('candidates',item.id,{...item,analysisFingerprint:undefined,attempts:0});
  }
  store.put('state','relevanceVersion',RELEVANCE_VERSION);
}
