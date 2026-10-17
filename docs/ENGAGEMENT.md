# 互动数据与作者资料

2026-10-17：保留原有标题、摘要、核实状态、重要性、时间、热度、来源标签、分享和视频入口，卡片新增原帖作者与互动明细；详情逐条展示证据各自的数据。

## 统一字段

采集层通过 `server/metadata.ts` 的 `sourceMetadata` 将各平台原始响应转换为 `EngagementMetrics` 和 `AuthorMetadata`，与原有 Evidence 顶层字段兼容，不更改既有 API 字段。`shared/engagement.ts` 提供计数清洗、展示和元数据合并工具。数据库仍保存 JSON 对象，首次启动执行幂等的 `engagementMetadataV1` 迁移。

| 来源 | 原始字段 | 统一字段 |
| --- | --- | --- |
| TwitterAPI.io | likeCount / retweetCount / replyCount / viewCount / bookmarkCount | likes / reposts / replies / views / bookmarks |
| B站视频页 | stat.like / share / reply / view / favorite / coin / danmaku | likes / reposts / replies / views / favorites / coins / danmaku |
| B站搜索 | like / share / reply / play / favorites / coin / danmaku 或 video_review | 对应上述字段；不将含义不明确的 review 当作评论 |
| 微博原帖 | attitudes_count / reposts_count / comments_count / reads_count | likes / reposts / replies / views；缺失浏览量保持缺失 |
| Hacker News 页面 / RSS | score、hn:score / descendants、hn:comments | points / replies；评分不转换成点赞 |
| 网页搜索、普通 RSS | 通常没有互动统计 | 保持缺失；搜索结果数量不转换成互动量 |

作者保留现有 `author`、`authorId`、`authorFollowers`，新增 `authorName`、`authorAvatarUrl`、`authorUrl`。Twitter 保留 @用户名，显示名独立存储；B站用 owner 或搜索结果中的作者资料；微博用 user；普通文章仅在结构化元数据提供时记录头像和作者主页。HN 的作者是投稿者。未提供头像时显示默认图标，图片加载失败自动回退。

计数接受非负安全整数、数字字符串、规范千位分隔以及 K/M/B/万/亿格式。真实的 0 被保留；null、空串、负数、NaN、无效文本等表示缺失，不产生 0。头像和主页仅保留 HTTP(S) 地址。

## 更新与展示

- 正文未变也更新候选的全部互动和作者资料，不重置首次发现时间或已完成的 AI 分析。
- 同一原帖经不同渠道发现时，正文保留较完整版本；已提供的元数据按观测时间更新。部分响应不会抹掉先前取得的字段，真实的 0 可以覆盖旧计数。
- 每轮采集和分析完成后同步事件内嵌证据。网页候选按规范原始 URL 匹配，Twitter 按推文 ID 匹配；搜索摘要不能覆盖原帖的作者和互动。
- B站搜索结果不保证包含转发、评论和头像。发现视频后读取公开详情接口 `/x/web-interface/view`，从 `stat.share`、`stat.reply`、`owner.face` 补齐；已完成 AI 分析的近 5 天视频也参与回查，不依赖重新分析。详情缓存和失败退避均为 30 分钟，每轮最多补查 3 条，计入现有公开搜索与补证请求预算。补取失败保留原简介和已有统计，并在运行记录标明失败。
- 卡片取互动热度最高的有效原帖，作者与全部计数都来自该原帖。不同平台或不同原帖的互动量不相加；详情可以查看每条证据。
- 基础展示为点赞、转发、评论、浏览量，B站标记为播放量，并在取得时增加收藏、投币、弹幕；Twitter 增加书签；HN 显示评分、评论。缺失指标显示“—”，全部缺失时说明来源未提供。
- 热度沿用点赞 + 转发 × 2 + 评论 + 浏览量 × 0.01，并纳入 HN 评分（HN 为评分 + 评论）。书签、投币、收藏、弹幕单独展示。缺失和 0 参与排序时仍有区别。
- 保留现有 Twitter 数值门槛和每 30 分钟回查、每日预算、5 天窗口及通知规则。新响应缺少门槛指标时依旧不能用旧值放行；作者头像与名称复用批量推文回查响应，不单独调用作者资料接口。一次性修复可显式指定已引用的旧记录，仍受现有每日预算限制。

Twitter 字段已对照 [TwitterAPI.io 响应文档](https://docs.twitterapi.io/api-reference/endpoint/get_user_timeline) 核对。各公开来源实际能提供的字段受接口与页面结构限制，未取得的信息不会补造；旧记录缺少的新增字段需要后续重新采集才能补齐。

验证：`npm test` 覆盖字段映射、字符串计数、0/缺失、页面提取、重复采集、跨渠道合并、事件同步、迁移、原帖选择和原有业务规则；`npm run build` 检查类型及前后端构建。界面使用隔离演示数据库验证，不写入实际数据。

后续缺陷修复：原先“已有合格视频简介就跳过 enrich”的路径导致详情接口没有执行，旧事件中的头像与缺失互动也未主动补齐。新增回归用例先复现零次详情请求，再验证详情补取、已处理候选回查、失败退避、错误 BV 隔离和现有预算限制；106 项测试通过。已对实际保存的 2 条 B站视频和 9 条 Twitter 记录回填作者头像，并在浏览器检查实际图片加载成功。两条 B站视频的转发/评论分别取得 9/4、7/9；统计为验证时快照，后续仍会变化。回填前的目标记录备份保存在本地 `reports/backups/`。
