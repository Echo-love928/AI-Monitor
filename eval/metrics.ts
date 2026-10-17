import type { RelevanceLevel } from '../shared/types.js';
export interface EvaluationRow { id:string; expected:RelevanceLevel; predicted:RelevanceLevel; critical:boolean; error?:string; }
export function metrics(rows:EvaluationRow[]) {
  const kept=rows.filter(row=>row.predicted==='direct');const positives=rows.filter(row=>row.expected==='direct');
  const tp=kept.filter(row=>row.expected==='direct').length;const fp=kept.length-tp;const fn=positives.length-tp;
  const precision=kept.length?tp/kept.length:null, recall=positives.length?tp/positives.length:null;
  const interval=(success:number,n:number)=>{if(!n)return null;const z=1.96,den=1+z*z/n,center=(success/n+z*z/(2*n))/den,margin=z*Math.sqrt(success/n*(1-success/n)/n+z*z/(4*n*n))/den;return [Math.max(0,center-margin),Math.min(1,center+margin)];};
  const criticalErrors=rows.filter(row=>row.critical&&row.expected!=='direct'&&row.predicted==='direct').length;
  const failures=rows.filter(row=>row.error).length;
  return {total:rows.length,kept:kept.length,positives:positives.length,tp,fp,fn,precision,recall,precision95CI:interval(tp,kept.length),recall95CI:interval(tp,positives.length),criticalErrors,failures,insufficient:rows.filter(row=>row.predicted==='insufficient').length,passed:rows.length>=30&&kept.length>=10&&positives.length>=10&&precision!==null&&precision>=0.95&&recall!==null&&recall>=0.85&&criticalErrors===0&&failures===0};
}
