import type { Candidate, Evidence, Rule, RuleAssessment, Signal } from './types.js';

export const RELEVANCE_VERSION = 1;
export const relevanceLabels = { direct: '直接相关', weak: '弱相关', unrelated: '无关', insufficient: '关联待审核' };
export const constraintLabels:Record<string,string>={entity:'目标实体',version:'型号版本',author:'发布作者',action:'关注事件',topic:'领域范围'};
export const normalizeText = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function ruleFingerprint(rule: Pick<Rule, 'kind' | 'query'>): string { return JSON.stringify([rule.kind, normalizeText(rule.query)]); }
export function analysisFingerprint(rules: Rule[]): string { return JSON.stringify([RELEVANCE_VERSION, 2, rules.map(rule => [rule.id, ruleFingerprint(rule)]).sort((a,b) => a[0].localeCompare(b[0]))]); }
export function needsAnalysis(item: Candidate, rules: Rule[]): boolean {
  return item.processedHash !== item.contentHash || item.analysisFingerprint !== analysisFingerprint(rules);
}
export function directAssessments(signal: Signal, ruleId?: string): RuleAssessment[] {
  return (signal.ruleAssessments || []).filter(item => item.version === RELEVANCE_VERSION && item.validated && item.level === 'direct' && signal.ruleIds.includes(item.ruleId) && (!ruleId || item.ruleId === ruleId) && (!item.evidenceHashes || Object.entries(item.evidenceHashes).every(([id,hash])=>signal.evidence.some(evidence=>evidence.id===id&&evidence.contentHash===hash))));
}
export function matchesRule(signal: Signal, rule: Rule): boolean {
  return directAssessments(signal, rule.id).some(item => item.ruleFingerprint === ruleFingerprint(rule));
}
export interface RuleIntent { entity: string; version: string; aliases: string[]; action: 'new-model' | 'release' | 'update' | 'video' | 'video-or-content' | 'any'; author: string; }
export function ruleIntent(rule: Pick<Rule, 'query' | 'kind'>): RuleIntent {
  const query = normalizeText(rule.query);
  const model = query.match(/\b(?:(claude)\s*[- ]*)?(sonnet|opus|haiku)\s*[- ]*(\d+(?:\.\d+)+)\b/i);
  const versioned = model || query.match(/\b(gpt|gemini|qwen|deepseek|llama)[ -]*(\d+(?:\.\d+)+)(?:[ -]*(pro|flash|mini))?\b/i);
  let entity = '', version = '', aliases: string[] = [];
  if (model) { entity = model[2]; version = model[3]; aliases = [`Claude ${entity} ${version}`, `${entity} ${version}`, `Claude ${entity}${version}`]; }
  else if (versioned) { entity = versioned[1]; version = versioned[2]; const suffix = versioned[3] ? ` ${versioned[3]}` : ''; entity += suffix; aliases = [`${versioned[1]} ${version}${suffix}`, `${versioned[1]}-${version}${suffix}`]; }
  if(!entity && rule.kind==='keyword')entity=query.match(/\b(?:claude code|claude|openai|openclaw|codex|chatgpt|gemini|deepseek)\b/i)?.[0]||'';
  const action = /new\s+model|新模型|新大模型/.test(query) ? 'new-model' : /release|launch|正式发布|新版本/.test(query) ? 'release' : /update|更新/.test(query) ? 'update' : /视频.{0,8}(?:或者|或).{0,12}编程导航/.test(query) ? 'video-or-content' : /视频|\bvideos?\b/.test(query) ? 'video' : 'any';
  const author = action === 'video' || action === 'video-or-content' ? query.replace(/^(?:b站|bilibili)\s*(?:up主)?\s*/i, '').split(/的(?:最新|新)?视频|\s+videos?\b|或者/)[0].trim() : '';
  return { entity, version, aliases, action, author };
}
// All variants retain the same target. Unknown names never acquire invented synonyms.
export function queryVariants(rule: Rule): string[] {
  const intent = ruleIntent(rule);
  const base = rule.query.replace(/相关内容|相关信息|相关动态|最新消息|有关/g, ' ').replace(/\s+/g,' ').trim() || rule.query;
  if (intent.aliases.length) {
    const match = /(?:Claude\s*[- ]*)?(?:Sonnet|Opus|Haiku)\s*[- ]*\d+(?:\.\d+)+|(?:gpt|gemini|qwen|deepseek|llama)[ -]*\d+(?:\.\d+)+(?:[ -]*(?:pro|flash|mini))?/i;
    return [...new Set([base, ...intent.aliases.map(alias => base.replace(match, alias))])].slice(0,3);
  }
  const translated = base.replace(/人工智能/g,'AI').replace(/编程/g,'coding').replace(/智能体/g,'agents').replace(/千问|通义/g,'Qwen');
  return [...new Set([base, translated])].slice(0,3);
}
export function includesTarget(text: string, intent: RuleIntent): boolean {
  if (!intent.version) return true;
  const normalized = normalizeText(text);
  if (/sonnet|opus|haiku/i.test(intent.entity)) {
    const family = intent.entity.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const version = intent.version.replace(/\./g,'\\.');
    return new RegExp(`\\b${family}[\\s_-]*${version}(?![\\d.])`, 'i').test(normalized) || new RegExp(`\\b${version}[\\s_-]*${family}\\b`, 'i').test(normalized);
  }
  const family = intent.entity.split(' ')[0]; const suffix = intent.entity.split(' ').slice(1).join(' ');
  return new RegExp(`\\b${family}[\\s_-]*${intent.version.replace(/\./g,'\\.')}(?![\\d.])${suffix ? `[\\s_-]+${suffix}\\b` : ''}`, 'i').test(normalized);
}
export function evidenceExcerpt(item: Evidence, rules: Rule[], limit = 5000): string {
  if (item.text.length <= limit) return item.text;
  const anchors = rules.flatMap(rule => { const intent=ruleIntent(rule); return intent.aliases.length ? intent.aliases : [rule.query]; });
  const spans: [number,number][] = [[0,Math.min(1200,limit)]];
  for (const anchor of anchors) {
    const escaped = normalizeText(anchor).split(/\s+/).map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s_-]*');
    const index = item.text.toLowerCase().search(new RegExp(escaped,'i'));
    if (index>=0) spans.push([Math.max(0,index-400), Math.min(item.text.length,index+1100)]);
  }
  spans.sort((a,b)=>a[0]-b[0]); const merged: [number,number][]=[];
  for(const span of spans) { const previous=merged.at(-1); if(previous && span[0]<=previous[1])previous[1]=Math.max(previous[1],span[1]);else merged.push(span); }
  // A broad topic may have no literal query phrase. Keep the full available head
  // budget instead of silently reducing a long article to its first 1,200 chars.
  if(merged.length===1&&merged[0][0]===0)merged[0][1]=Math.max(merged[0][1],Math.min(item.text.length,limit));
  return merged.map(([start,end])=>item.text.slice(start,end)).join('\n[…]\n').slice(0,limit);
}
