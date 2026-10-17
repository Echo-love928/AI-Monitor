import type { Evidence, RelevanceLevel, Rule } from '../shared/types.js';
export interface EvaluationCase { id:string; group:string; split:'dev'|'holdout'; origin:'real'|'synthetic'; rule:Rule; evidence:Evidence; expected:RelevanceLevel; labelReason:string; critical:boolean; }
