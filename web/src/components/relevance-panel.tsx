import type { Signal } from '../../../shared/types.js';
import { constraintLabels, directAssessments, relevanceLabels } from '../../../shared/relevance.js';

export function targetSummary(signal: Signal, ruleId: string): string {
  const matches=directAssessments(signal,ruleId==='all'?undefined:ruleId);
  return [...new Set(matches.slice(0,2).map(match=>match.summary.trim()).filter(Boolean))].join(' ') || signal.summary;
}
export function RelevanceSummary({signal,ruleId}:{signal:Signal;ruleId:string}) {
  const matches=directAssessments(signal,ruleId==='all'?undefined:ruleId);
  return <div className="relevance-summary">{matches.slice(0,2).map(match=><div key={match.ruleId}><span className="relevance-label">直接相关 · {match.ruleQuery}</span><span>{match.reason}</span></div>)}{matches.length>2 && <span className="small">另有 {matches.length-2} 个直接相关监控，详见证据</span>}{!matches.length && <span>关联待审核：历史内容尚未提供逐监控依据</span>}</div>;
}
export function RelevanceDetails({signal,ruleId}:{signal:Signal;ruleId:string}) {
  const assessments=(signal.ruleAssessments||[]).filter(item=>ruleId==='all'||item.ruleId===ruleId);
  return <section className="relevance-details" aria-label="监控匹配依据"><h3>为什么与你的监控相关</h3>{assessments.length?assessments.map(match=><article key={match.ruleId} className="relevance-assessment"><strong>{relevanceLabels[match.level]} · {match.ruleQuery}</strong><p>{match.reason}</p>{match.validationReason && <p>{match.validationReason}</p>}{match.unmetConstraints.length>0 && <p>未满足：{match.unmetConstraints.map(key=>constraintLabels[key]||key).join('、')}</p>}{match.citations.map((citation,index)=>{const source=signal.evidence.find(item=>item.id===citation.evidenceId);return source?<blockquote key={`${citation.evidenceId}-${index}`}><p>{citation.quote}</p><a href={source.finalUrl} target="_blank" rel="noopener noreferrer">查看原文：{source.title}</a></blockquote>:null;})}<small>按当时的监控目标审核 · {new Date(match.reviewedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</small></article>):<p>关联待审核：该历史内容尚未提供逐监控依据。</p>}</section>;
}
