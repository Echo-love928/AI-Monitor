import type { Evidence, Rule } from '../shared/types.js';
import type { Analysis } from '../server/ai.js';
// Explicit model output for business-rule tests. Semantic evaluation lives in eval/.
export function fixtureAssessment(ev: Evidence, rule: Rule): Analysis['events'][number]['ruleAssessments'][number] {
  return {ruleId:rule.id,level:'direct',reason:'本测试材料描述了监控范围内的具体更新。',summary:'本测试材料描述了一项具体更新，详细真实性由业务核验判断。',matchedEntity:'test',matchedVersion:'',matchedAction:'release',unmetConstraints:[],citations:[{evidenceId:ev.id,quote:ev.text.slice(0,350)}]};
}
