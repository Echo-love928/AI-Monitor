# DEBUG REPORT：热点准确度与旧闻

- **Symptom**：扩展来源后，首页出现旧文章与普通客户案例，Twitter 有用线索反而变少。
- **Root cause**：泛搜索结果缺日期仍占分析额度；X 每轮十条且普通原创必须外链；默认仅已核实但不检查事件年龄；官方材料身份与选题价值混在一起；单条错误合并中断整批。读库样本包括 115 条网页候选中 103 条无发布时间、132 条 X 因无外链被过滤、旧版首页 5 条已核实均为客户案例。
- **Fix**：Twitter 优先；网页定向补证；共享滚动 120 小时判断；官方内容仍需新颖性和选题价值审核；事件错误隔离。用户已确认开发及过期保留审计语义。实现见 `shared/freshness.ts`、`server/quality.ts`、`server/retention.ts`、`server/runner.ts`、`server/ai.ts`、`web/src/App.tsx`。
- **Evidence**：52 项测试通过、生产构建通过。真实 15 条 X 候选复核保留 2 个 pending；2016 年旧闻、抱怨和推广退出热点，全部原始与审计保留。实际报告 `reports/twitter-priority-integration.json`。
- **Regression test**：`tests/freshness.test.ts`，以及更新后的 quality/core/API 用例。
- **Related**：前一轮信息源可靠性改造见 `docs/SOURCE-QUALITY.md`；本轮覆盖此前默认仅已核实、X 十条及 24 小时设置。公开来源仍可能超时或要求访问校验；pending 不是事实确认。
- **Status**：DONE。当前策略与验证细节见 `docs/TWITTER-PRIORITY.md`。

补充实际运行：已启用的两个关键词触发定时检查，分析 29 条材料、新增 7 个 pending，合计 9 个近期 pending。多引擎补证成功且访问校验单独降级，记录见 reports/twitter-priority-live-run.json。最终 52 项测试通过，本地生产构建与 API/worker 验收完成。
