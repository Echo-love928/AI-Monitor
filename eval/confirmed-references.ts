import {createHash} from 'node:crypto';
import type {EvaluationCase} from './types.js';
import type {RelevanceLevel} from '../shared/types.js';

export interface ConfirmedReference {id:string;level:RelevanceLevel;inputHash:string;authority:string;reason:string;}
export function referenceInputHash(row:EvaluationCase):string {
  return createHash('sha256').update(JSON.stringify([row.rule.kind,row.rule.query,row.evidence.author,row.evidence.title,row.evidence.finalUrl,row.evidence.text])).digest('hex');
}
// Human decisions outrank a fallible model grader, but never transfer to changed material.
export function confirmedReference(row:EvaluationCase,references:ConfirmedReference[]):ConfirmedReference|undefined {
  return references.find(item=>item.id===row.id&&item.authority==='user-confirmed-policy'&&item.level===row.expected&&item.inputHash===referenceInputHash(row));
}
