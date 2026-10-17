export interface RetryRow {predicted:string;decisionReason?:string;error?:string;attempts?:number;}
// Match production's bounded retries of invalid outputs. A valid filtering decision
// or genuinely missing source is never resampled to improve benchmark scores.
export function retryableEvaluationFailure(row:RetryRow):boolean {
  if((row.attempts||1)>=3)return false;
  return !!row.error||row.predicted==='insufficient'&&['缺少面向该监控的事件摘要','引用片段不在原文中'].some(reason=>row.decisionReason===reason);
}
