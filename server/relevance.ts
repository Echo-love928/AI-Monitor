import { z } from 'zod';
import type { Evidence, RelevanceExclusion, Rule, RuleAssessment, Signal } from '../shared/types.js';
import { includesTarget, normalizeText, RELEVANCE_VERSION, ruleFingerprint, ruleIntent } from '../shared/relevance.js';
import {nonTwitterDiscovery,platformOf} from '../shared/discovery.js';

export const relevanceSchema = z.object({
  ruleId: z.string(), level: z.enum(['direct','weak','unrelated','insufficient']),
  reason: z.string().min(1).max(600), summary: z.string().max(700),
  matchedEntity: z.string().max(150), matchedVersion: z.string().max(80), matchedAction: z.string().max(200),
  unmetConstraints: z.array(z.enum(['entity','version','author','action','topic'])).max(5),
  citations: z.array(z.object({ evidenceId:z.string(), quote:z.string().min(1).max(900) })).max(4),
});
export const exclusionSchema = z.object({ evidenceId:z.string(), reason:z.string().min(1).max(600), category:z.enum(['weak','unrelated','insufficient']) });
export const relevanceInstructions = `相关性是独立准入条件，不能由热度、官方身份、同公司、同作者或同一生态代替。对每个事件逐一评估所有输入 rules，在 ruleAssessments 中每个编号恰好出现一次。
level=direct：原文明确指向该目标或有依据的等价名称，且该事件提供关于目标的实质新增信息，并满足规则显式的型号、版本、作者、动作约束。
level=weak：只是背景、对比时顺带列名、支持列表或配置工具清单、同公司或同生态，没有对该目标的实质信息。level=unrelated：无关联或目标/版本不符。level=insufficient：材料不完整或指代不明，无法证明关联；不能混为事实待核实。
人工确认口径：仅声称做过评测、但已取得材料没有给出结果或具体发现，按 weak 过滤。实质比较须包含可归因的结果或发现，而不是只宣布存在一份评测。
人工确认口径：AI coding agents 范围要求明确的编程、代码或开发任务关联。通用 Agent 的插件、桌面控制、办公连接器、CLI、代码库提交数量或模型支持清单不能自动证明编程用途；材料没有说明编程关联时按 weak 过滤。
人工确认口径：明确说明 Claude Code/Codex 等编程工具的具体开发用途或开源 Skill 能力，可判 direct；是否属于普通教程、是否有新发布和热点价值另由 isNewsworthy/isNewEvent 判断，不把相关性与热点价值混为一谈。
例如 Claude Sonnet 4.6：仅介绍 OpenClaw 更新不匹配；只列出使用了 Sonnet 4.6 也不够；明确新增该版本支持并描述使用变化、实质测评、价格、故障、能力变化可以 direct。其他版本单独发布不匹配；真正对比目标版本并提供结果可以匹配。批评、否定和故障不因负面观点排除。
自然语言意图以 query 为准，name 仅是标签。Claude new model 要求新的 Claude 模型信息，办公室、公司融资、Claude Code 界面变化均不符合；作者视频规则须核对发布作者和作品类型，不要求视频是模型发布。topic 允许语义相关，但必须解释具体领域联系和新增事实。
ruleIds 必须且仅填写本事件 direct 的规则编号。每个 direct 结论必须有同一事件对应的 citations，引用 evidence 标题或正文中连续的原文，不翻译、不省略、不拼接，不引用自己生成的摘要。精确型号与版本须出现在引用中或同条证据紧邻上下文；不能拼接不同段落的实体和数字。matchedEntity/matchedVersion/matchedAction 写证据支持的匹配要素，未满足的约束放 unmetConstraints。引用其他事件不能挽救无关主事件。
reason 用简短中文说明“为什么与这个监控直接相关/为什么过滤”，不要只复述文章。direct 的 summary 用中文仅概述本事件与这个目标相关的新增事实和证据限制；其他等级 summary 为空。事件总 summary 也只写同一实际事件，不能混入日报其他条目。
unmetConstraints 只允许 entity/version/author/action/topic，表示监控的匹配条件；尚无官方确认、时间不明、只有第三方来源等事实核实限制不属于这些条件，写入事件的 status/reason，不能据此降低相关性。
事实可信状态与相关等级分别判断；明确关于目标的第三方爆料可 direct 但事实 pending。相关性 insufficient 不进入主列表。所有事件都没有 direct 的材料放入 excludedEvidenceIds，并在 exclusions 为每条提供原因及 weak/unrelated/insufficient 类别，证据不足不得编造成无关。
检索来源或查询词、URL 中的跟踪参数、作者同属一家公司都不算目标证据。遵守材料的实际读取范围，不凭知识或推测补出缺失的目标关联。`;

// Reporting that results exist elsewhere is a process description, not an acquired finding.
// Counts of test tasks and model version numbers do not count as outcome measurements.
export function evaluationWithoutFindings(text:string):boolean {
  const process=/\b(?:benchmarks?|benchmarked|benchmarking|evaluated|evaluation|tested|measured)\b|评测|基准测试|测量/i.test(text);
  const report=/\b(?:publish\w*|report\w*|reproducible results|results? (?:are |is )?available)\b|公布|发布.{0,15}(?:结果|报告)|报告.{0,15}(?:准确率|结果)|结果.{0,15}(?:公布|发布|另见|详见)/i.test(text);
  const outcome=/(?:\d+(?:\.\d+)?\s*(?:%|ms\b|seconds?\b|tokens?\s*\/\s*s\b|倍))|(?:accuracy|latency|score|pass rate|准确率|延迟|得分|通过率)\s*(?:(?:was|is|of|为|达到|降至|升至|:)\s*)?\d|\d+\s*(?:vs\.?|versus|比|对)\s*\d+|\b(?:found|observed|showed|revealed|outperform\w*|underperform\w*|faster|slower|lower|higher|better|worse|improv\w*|regress\w*|failed|failure|cannot|unable|unsupported|vulnerab\w*|inaccur\w*|hallucinat\w*)\b|更快|更慢|提升|下降|失败|漏洞|不支持|发现|结果显示|观察到|无法/i.test(text);
  const capability=/\b(?:adds?|added|supports?|introduced)\b|新增|修复|新增支持/i.test(text);
  return process&&report&&!outcome&&!capability;
}

export function creatorVideoRule(rule:Rule):boolean {
  const intent=ruleIntent(rule);
  return !!intent.author&&!intent.entity&&!intent.version&&['video','video-or-content'].includes(intent.action);
}
export function creatorVideoMatches(item:Evidence,rule:Rule,now=Date.now()):boolean {
  const intent=ruleIntent(rule);
  return creatorVideoRule(rule)&&platformOf(item)==='bilibili'&&nonTwitterDiscovery(item,now)&&[item.author,item.authorName||''].some(author=>normalizeText(author).replace(/^@/,'')===intent.author.replace(/^@/,''));
}
export function requestedTutorial(rule:Rule):boolean {return /教程|教学|课程|tutorial|walkthrough|how[ -]?to/i.test(rule.query);}

export function validateRelevance(raw: z.infer<typeof relevanceSchema>, rule: Rule, sources: Evidence[], now: number): RuleAssessment {
  const intent = ruleIntent(rule); const byId = new Map(sources.map(item=>[item.id,item]));
  const problems: string[]=[]; const contexts: string[]=[]; const cited: Evidence[]=[];
  if(raw.level!=='direct'&&raw.summary.trim())problems.push('相关等级与目标摘要不一致');
  if(/^(placeholder|unknown|n\/a)$/i.test(raw.reason.trim()))problems.push('缺少实际相关性判定依据');
  for(const citation of raw.citations) {
    const evidence = byId.get(citation.evidenceId); const quote=normalizeText(citation.quote);
    if(!evidence) {problems.push('引用不属于当前事件证据');continue;}
    const body=normalizeText(evidence.text);const title=normalizeText(evidence.title);
    const index=body.indexOf(quote);const inTitle=title.includes(quote);
    if(index<0 && !inTitle) {problems.push('引用片段不在原文中');continue;}
    // Use local context, never distant occurrences of the entity and version.
    contexts.push(index>=0 ? body.slice(Math.max(0,index-180),index+quote.length+180) : title);
    cited.push(evidence);
  }
  if(raw.level==='direct') {
    if(!raw.citations.length || !cited.some(item=>item.original && !item.supportingOnly && item.contentKind!=='snippet'))problems.push('缺少可读取的主证据引用');
    if(raw.unmetConstraints.length)problems.push('监控的必要约束未满足');
    if(!raw.summary.trim())problems.push('缺少面向该监控的事件摘要');
    if(intent.version && (!contexts.some(text=>includesTarget(text,intent)) || normalizeText(raw.matchedVersion)!==intent.version))problems.push('原文引用未支持准确型号和版本');
    if(!intent.version && intent.entity && !contexts.some(text=>intent.entity==='claude'?/\bclaude\b|\bsonnet\b|\bopus\b|\bhaiku\b/i.test(text):text.includes(intent.entity)))problems.push('引用未明确指向监控目标');
    const navigationArm=intent.action==='video-or-content'&&cited.some(item=>/编程导航/.test(item.title+' '+item.text));
    if(intent.author && !navigationArm && !cited.some(item=>[item.author,item.authorName||''].some(text=>normalizeText(text).replace(/^@/,'')===intent.author.replace(/^@/,''))))problems.push('发布作者与监控不符');
    if(intent.action==='video' && !cited.some(item=>/bilibili\.com\/video\//i.test(item.finalUrl)))problems.push('缺少所关注的视频作品');
    if(intent.action==='video-or-content'&&!navigationArm&&!cited.some(item=>/bilibili\.com\/video\//i.test(item.finalUrl)))problems.push('未满足作者视频或编程导航内容任一分支');
    if(intent.action==='new-model' && !contexts.some(text=>/(?:new|introduc|launch|releas|新|发布|推出).{0,100}(?:model|模型|sonnet|opus|haiku)|(?:model|模型|sonnet|opus|haiku).{0,100}(?:new|launch|releas|新|发布|推出)/i.test(text)))problems.push('缺少新模型事件的原文依据');
  }
  const processOnly=raw.level==='direct'&&!problems.length&&cited.length>0&&!cited.some(item=>creatorVideoMatches(item,rule,now))&&cited.every(item=>evaluationWithoutFindings(item.text));
  return {...raw,...(processOnly?{level:'weak' as const,summary:'',reason:'已取得原文只描述评测过程或声称结果另行发布，没有具体结果或发现。'}:{}),evidenceHashes:Object.fromEntries(cited.map(item=>[item.id,item.contentHash])), ruleQuery:rule.query,ruleKind:rule.kind,ruleFingerprint:ruleFingerprint(rule),version:RELEVANCE_VERSION,reviewedAt:new Date(now).toISOString(),validated:!problems.length, ...(problems.length?{level:'insufficient',validationReason:[...new Set(problems)].join('；')}: {})};
}

// A model may exclude the entire material instead of returning a revised event.
// Withdraw only conclusions whose complete cited support was actually reviewed.
export function withdrawExcludedMatches(prior:Signal[],exclusions:RelevanceExclusion[],evidence:Evidence[],rules:Rule[],now=Date.now()):Signal[] {
  const enabled=new Set(rules.map(rule=>rule.id));const byId=new Map(exclusions.map(item=>[item.evidenceId,item]));
  const reviewed=new Map(evidence.filter(item=>byId.has(item.id)).map(item=>[item.finalUrl,byId.get(item.id)!]));
  const changed:Signal[]=[];
  for(const signal of prior) {
    let touched=false;
    const ruleAssessments=(signal.ruleAssessments||[]).map(assessment=>{
      if(!enabled.has(assessment.ruleId)||assessment.level!=='direct'||!assessment.citations.length)return assessment;
      const decisions=assessment.citations.map(citation=>byId.get(citation.evidenceId)||reviewed.get(signal.evidence.find(item=>item.id===citation.evidenceId)?.finalUrl||''));
      if(decisions.some(item=>!item))return assessment;
      touched=true;const level=decisions.some(item=>item!.category==='insufficient')?'insufficient':decisions[0]!.category;
      return {...assessment,level,validated:false,summary:'',reason:decisions.map(item=>item!.reason).join('；'),reviewedAt:new Date(now).toISOString()};
    });
    if(!touched)continue;
    const ruleIds=ruleAssessments.filter(item=>item.validated&&item.level==='direct').map(item=>item.ruleId);
    changed.push({...signal,ruleAssessments,ruleIds,updatedAt:new Date(now).toISOString(),...(!ruleIds.length?{auditOnly:true,auditReason:ruleAssessments.some(item=>item.level==='insufficient')?'关联待审核：重新审核的材料证据不足':'重新审核确认与监控目标没有直接关联'}:{})});
  }
  return changed;
}
