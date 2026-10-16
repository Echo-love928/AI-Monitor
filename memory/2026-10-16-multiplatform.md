# DEBUG REPORT · 多平台独立热点发现

- **Symptom:** 用户发现热点几乎全部来自 Twitter；要求 Twitter 占多数，同时让百度、微博、B站等渠道独立提供热点。批准 70% / 30%、5 天窗口、其他平台公开原文准入，允许 B站简介独立待核实并附视频链接。
- **Root cause:** `quality.ts` 硬编码网页只能补证，`runner.ts` 没有独立搜索阶段，`defaultSignal` 只显示 Twitter 待核实；B站/微博不能形成可识别的独立发布源，原文解析缺作者和平台发布时间。实跑还发现原生请求计数与引擎数形成固定轮转，Twitter 补证抢材料额度，同作者无关视频被 AI 拼入事件，以及只向 AI 传本轮到期规则导致其他范围事件误排除。
- **Fix:** `shared/discovery.ts` 统一平台与准入；`server/publication.ts` 安全读取字面 JSON/元数据；`sources.ts` 增加公开 B站搜索和微博定向发现；`runner.ts` 轮转独立查询、共用请求预算、预留其他平台材料额度，并按全部启用规则审核；`quality.ts` 去重与 70/30 选择、视频链接关联；`ai.ts` 支持独立 pending 并保留核验限制；`db.ts` 保存迁移审计；`App.tsx` 平台筛选及视频入口。
- **Evidence:** 80 项测试、生产构建、diff 空白检查通过。公开 B站 API 成功读取近期真实视频；真实 AI 复核得到独立 pending；浏览器显示 B站筛选与正确链接，未横向溢出。`reports/multiplatform-video-final.json` 为最终单视频复核，无新 X 请求、无邮件。运行扫描由用户当前启用状态决定，未擅自改动开关。
- **Regression test:** `tests/multiplatform.test.ts` 16 项测试；原有质量与时效测试改为新的真实行为预期，Twitter 硬门槛回归保持。
- **Related:** Twitter 四门槛、纯原创、蓝 V +10%、30 分钟指标回查和 120 小时过期规则保持。B站 `search/type` 出现 412，默认使用成功的公开 `search/all/v2`；不依赖搜索排序推断时间。微博正文需要公开原帖，当前本机取样登录跳转，百度/搜狗会出现校验，不能以摘要凑配额。已有 AI 合并冲突继续隔离并保留重试，未放宽版本校验。
- **Status:** DONE_WITH_CONCERNS — 多平台流程与 B站真实端到端验证完成；微博公开原文受当前网络/平台访问限制，未声称取得真实合格微博热点。
