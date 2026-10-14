# MCP 接口与实现方法核对记录

核对日期：2026-10-13（Asia/Shanghai）。对应需求/方案版本：0.2。

本记录用于开发前确认技术依据；没有初始化应用、安装项目依赖或执行真实付费 API/SMTP 联调。资料会变化，开发时按实际安装版本复核，不直接复制跨版本示例。

## 1. 使用的 MCP

| MCP | 实际使用工具 | 用途 |
| --- | --- | --- |
| Firecrawl | firecrawl_scrape，设置 maxAge: 0 | 实时读取 TwitterAPI.io 官方文档与 OpenAPI、OpenRouter、Node 版本文档、搜索页和公开 RSS |
| Context7 | resolve_library_id → query_docs | 查询 OpenRouter、Cheerio、Node、Vite、Express 和 Nodemailer 的官方实现资料 |

Firecrawl 和 Context7 是本次开发资料获取工具。产品运行时自行进行后端网页采集、X REST API、公开订阅和 OpenRouter 分析，不需要用户额外配置这两个 MCP 服务。

## 2. TwitterAPI.io：现行接入约定

资料来自用户指定服务的文档与当前 OpenAPI：

- [服务简介](https://docs.twitterapi.io/introduction)
- [最新推文搜索](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search)
- [账号时间线](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)
- [当前 OpenAPI JSON](https://docs.twitterapi.io/api-reference/openapi.json)

上述文档和规范均通过 Firecrawl MCP 读取成功；OpenAPI 的服务器地址为 `https://api.twitterapi.io`。这是第三方 X 数据服务，使用该服务的 Key，不要求接入 X 官方 OAuth 流程。

### 认证

请求头使用 `X-API-Key`。Key 只从服务端环境配置读取，不放在查询字符串、网页代码或日志里。拟定环境变量：`TWITTERAPI_IO_KEY`。

### 最新搜索

方法/路径：`GET /twitter/tweet/advanced_search`。

| 参数 | 当前文档约定 | 项目使用方式 |
| --- | --- | --- |
| query | 必填，字符串查询 | 关键词/领域查询叠加固定时间窗口 |
| queryType | 必填，Latest 或 Top | 自动监控使用 Latest |
| cursor | 可选，第一页为空字符串 | 后续使用服务返回游标 |

**本次发现的重要变化**：精确窗口应使用 `since_time:<Unix秒>` 和 `until_time:<Unix秒>`。现行文档明确提示，不再支持形如 `since:日期_时分秒_UTC` / `until:日期_时分秒_UTC` 的旧写法。应用构造秒级时间戳，不把 JavaScript 的毫秒数直接传入。此要求同时见当前 OpenAPI 的 query 描述。

本项目不会因查询结果按 Latest 排序就假定搜索完整；仍按时间窗口、分页和实际推文时间检查覆盖情况。

成功响应顶层字段为 `tweets`、`has_next_page`、`next_cursor`。每页最多约 20 条，可能少于 20 条；不能用条数小于 20 判断已经结束。

项目需要的推文字段包括：字符串 `id`、`url`、`text`、`createdAt`、`author.id`、`author.userName`、可用互动计数、`entities.urls`，以及引用/转发关联。字段通过运行时 Schema 校验，缺失的互动数据按缺失保存，不补零冒充真实统计。

### 账号时间线与身份

方法/路径：`GET /twitter/user/last_tweets`。

参数：`userId` 或 `userName`，以及可选 `cursor`、`includeReplies`。文档建议使用 userId；应用只发送一个账号标识，不依赖同时发送时的优先级。首次从用户名解析后保存稳定 ID。默认不包含回复，所需补充内容通过配置或引用证据另行取得。

成功响应顶层是 `tweets`、`has_next_page`、`next_cursor`、`status`、`message`，不是假定的 `data.tweets`。账号解析使用 `GET /twitter/user/info`；该接口顶层是 `data`、`status`、`msg`，不能复用错误的时间线响应模型。

X 蓝标、显示名称和关注者数量只是元数据。官方身份要与官网链接及稳定 ID 对照；转发别人的公告不直接等同于发布者确认。

### 增量分页与失败处理设计

1. 固定本轮 query、窗口起止和账号/规则身份，时间以 UTC 存储，以 Asia/Shanghai 显示。
2. 使用服务器返回的游标续查；持续校验响应，推文 ID 按字符串去重。
3. 以 `has_next_page` 为分页依据。空页但仍有下一页时，在预算内继续；重复游标或缺失下一页游标时记录异常，避免死循环。
4. 每查询每轮初始最多 3 页，X 请求并发 1，至少间隔 2 秒。限额是本项目起点，不是服务端 QPS 承诺。
5. 达到预算仍有下一页时保存窗口和游标，标明部分覆盖；下一次继续补查。若续查游标失效，重新查询原窗口并按 ID 去重；不静默跳过未完成窗口。只有本窗口完整采集并落库后才推进成功时间水位。
6. 采集成功、AI 失败时保留待分析候选。不能因为推进了采集水位而丢失未处理信息。
7. HTTP 错误、业务 status 错误、无效 JSON 和 Schema 不符各自记录；401/403 不循环重试，429 优先遵循 Retry-After，暂时错误有限退避。额度用尽显示来源受限。

自动轮询周期固定 30 分钟，首版不接入实时 WebSocket/webhook。现行 API 资料读取成功不代表真实账号查询已成功；需配置 Key 与可用额度后完成联调。

## 3. 无需 API 的搜索网页采集

### 已做的取样

| 来源 | MCP 取样结果 | 结论 |
| --- | --- | --- |
| [Bing 普通搜索页](https://www.bing.com/search?q=AI+model+release) | HTTP 200，HTML 中有 10 个自然搜索结果容器，存在标题链接；同时有搜索引擎生成的 AI 摘要 | 可作为首版优先适配入口；只提取自然结果并取原文，不把 AI 摘要当确认事实 |
| [DuckDuckGo 非 JavaScript 说明](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript) | 文档读取成功，说明 HTML/Lite 两种入口 | 已确认入口存在 |
| [DuckDuckGo HTML 搜索取样](https://html.duckduckgo.com/html/?q=AI+model+release) | Firecrawl 返回获取内容失败，未获得可验证结果 | 仍是待验证备选，不宣称可用，也不把失败解释为零结果 |

MCP 运行在独立网络环境，这些取样不能证明本地 Node 直接 HTTP 请求一定成功。应用开发时必须在本机真实请求入口、检查 HTML 和选择器，再记录实际可用状态。

### 解析技术

Context7 选用 `/websites/cheerio_js`，查询了 [加载 HTML](https://cheerio.js.org/docs/basics/loading) 与 [Cheerio 能力边界](https://cheerio.js.org/docs/intro)。当前支持 `load(html)`；Cheerio 不执行 JavaScript、不自动加载外部资源。

项目先用受控 HTTP 客户端取回 HTML，再调用 Cheerio 解析。虽然 Cheerio 也提供 fromURL，本项目不直接让解析库接管网络请求，以便统一限速、代理、响应大小、重定向与地址校验。

每个搜索引擎一个独立结果解析器，并配固定 HTML 测试样本；选择器取样只作为当前证据，不视为稳定契约。Bing 样本中自然结果可以从 `.b_algo` 中提取标题链接；开发时需确认原始直连 HTML 是否一致。正确展开跳转链接后仍要校验目标地址。

相同查询跨规则合并，30 分钟内复用；引擎并发 1、相邻请求至少 5 秒、每查询每轮 1 页/初始最多 10 条。403/验证码停止本轮来源，429 按服务指示退避；结构变化与真实无结果分别记录。首版不绕过验证码，不依赖搜索 API 或 OpenRouter 联网插件。

## 4. 已确认的公开订阅入口

Firecrawl MCP 以 rawHtml 读取以下入口，均返回 RSS XML：

| 来源 | 实际返回地址 | 结果 |
| --- | --- | --- |
| OpenAI News | [news/rss.xml](https://openai.com/news/rss.xml) | HTTP 200，XML RSS |
| Google AI Blog | [AI RSS](https://blog.google/innovation-and-ai/technology/ai/rss/) | 旧路径 `/technology/ai/rss/` 重定向到当前地址，HTTP 200，XML RSS |

初始订阅使用当前地址；本地实现仍需检查重定向、XML 大小、时间解析、GUID 去重与正文来源。后续官方发布记录和用户自定义 RSS/Atom 使用同一适配接口。

## 5. OpenRouter：证据分析与结构化结果

Firecrawl 实时读取 [HTTP 接入文档](https://openrouter.ai/docs/quickstart)；Context7 选用 `/openrouterteam/docs`，查询了 [结构化输出](https://openrouter.ai/docs/guides/features/structured-outputs) 与 [供应商路由](https://openrouter.ai/docs/guides/routing/provider-selection)。

项目接入约定：

- 服务端调用 `POST https://openrouter.ai/api/v1/chat/completions`，使用 Bearer Key 和 JSON 请求。
- 从当前模型目录选择支持结构化输出的模型，模型 slug 可配置；不把随时变化的 latest 别名或文档示例当作固定模型保证。
- HTTP 请求字段采用 `response_format`、`json_schema`、`strict` 与 `provider.require_parameters`；SDK 示例中的驼峰字段不能直接复制到 HTTP 请求体。
- 设置严格 JSON Schema，约束证据编号、可信状态、实体/版本、事件时间与命中规则。供应商端点也必须支持所需参数，不能只检查模型名称。
- 应用侧再次校验 Schema 与证据关联，禁止模型添加未经采集的“确认链接”。非法输出、不支持参数或来源不足时不触发邮件。
- 首版 AI 输入来自项目自己的多源采集与原文，默认不启用 web 插件。

开发联调已加载用户本地 Key。2026-10-13 通过 Firecrawl MCP 实时读取 `https://openrouter.ai/api/v1/models`，确认 `deepseek/deepseek-v4.1-flash`（DeepSeek V4.1 Flash）支持 `structured_outputs` / `response_format`；本机模型能力检查返回 200。初次推理返回 402，用户补充额度后真实结构化审核成功；目录能力检查与真实推理分别记录。

## 6. Node.js：必须按本机版本使用

本机实际运行版本为 **v24.16.0**。

Context7 使用 `/websites/nodejs_latest-v24_x_api` 查询 node:sqlite；另通过 Firecrawl 获取 [v24.16.0 专属 SQLite 文档](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html)，以该版本文档与运行时检查为准。

发现通用索引示例混入其他版本的方法，因此没有直接复制：

| 检查项 | 本机结果 | 开发约束 |
| --- | --- | --- |
| DatabaseSync | 存在 | 使用该版本构造器 |
| StatementSync.close | 不存在 | 不照搬含 statement.close() 的通用示例 |
| createTagStore | 存在 | 是否采用按具体存储需求决定 |
| SQLite 稳定性 | 版本文档为 Stability 1.2 / Release candidate | 记录版本，封装存储接口；不称为已经稳定的标准驱动 |

实现已采用短事务、参数化 SQL、busy timeout 和独立数据库连接，不在 SQLite 事务里等待外部网络；实际多进程同时初始化与重启持久化测试已通过。应用数据位于 `data/signal.sqlite`。

## 7. 前端、Express 与邮件

### Vite / React / TypeScript

Context7 使用 `/vitejs/vite`，查询 [当前 create-vite](https://github.com/vitejs/vite/tree/main/packages/create-vite) 与 [React TypeScript 模板](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts)。资料显示 Node 要求为 20.19+ 或 22.12+，本机 Node 24 满足基础要求。

已查询实际包版本并安装兼容依赖，保存 lockfile：React 19.3.0、Vite 8.3.4、@vitejs/plugin-react 6.1.2、TypeScript 7.0.2。构建和类型检查通过。

### Express 5

Context7 使用 `/websites/expressjs`，核对 [Express 5 迁移指南](https://expressjs.com/en/guide/migrating-5) 和 [路由](https://expressjs.com/en/guide/routing)。

SPA 回退路由需要有名称的通配符；覆盖根路径可用 `/{*splat}`，不能照搬 Express 4 的匿名 `*` 写法。API 404 和错误处理位于前端回退之前，避免失败接口被返回 HTML。Express 5 会把 async handler 返回的 rejected Promise 转交错误处理中间件，统一记录并脱敏。

### Nodemailer SMTP

Context7 使用 `/nodemailer/nodemailer-homepage`，查询 [SMTP 文档](https://nodemailer.com/smtp)。

465 端口使用隐式 TLS/secure=true；587 通常采用 secure=false 后 STARTTLS，并按实际邮箱配置要求 TLS。`verify()` 检查连接与认证，不证明发件人被接受或邮件送达。实际测试必须检查 sendMail 返回的接收状态，再由用户确认收件。

## 8. 尚需在开发与验收阶段完成

- 用户人工确认需求与方案后再初始化应用。
- 验证本地 Node 的实际出站网络与代理，而非依赖 MCP 所在环境的访问结果。
- 实现搜索解析并测试验证码、结构变更、限流、跳转与真实空结果；验证 DuckDuckGo 后再决定是否启用。
- 配置 TwitterAPI.io Key 并验证 Latest、时间窗口、账号 ID、游标及实际错误响应。
- 验证公开源本地解析与缓存，加入至少两个域名的原始来源。
- 配置 OpenRouter Key，验证所选模型/供应商的结构化输出及业务判断。
- 完成 30 分钟调度、重启恢复、部分窗口续查与限额测试。
- 配置 SMTP 并执行实际收件测试。
- 记录关键依赖安装版本、MCP 资料日期与真实测试结果；网页版验收后才开发 Agent Skills。

## 9. 开发期间补充核对

- Firecrawl MCP 实时读取 [Hugging Face Blog RSS](https://huggingface.co/blog/feed.xml)，返回 200 / RSS XML；本机 HTTP 请求连接超时，保留为有明确失败状态的可选来源。
- Firecrawl MCP 读取 Bing 带 `filters=ex1:"ez1"` 的最近一天搜索页，返回可解析 HTML。该筛选不保证结果条目都是当天发布，仍读取原文时间，缺失时间不得触发正式发布通知。
- Firecrawl MCP 当前 [OpenRouter 错误规范](https://openrouter.ai/docs/api_reference/errors-and-debugging) 与 [额度规范](https://openrouter.ai/docs/api_reference/limits)：402 区分账号/Key 额度与临时请求预算，临时情况可能有 Retry-After；HTTP 200 也可能返回供应商 error。应用已处理这两种路径，未把错误输出保存为热点。
- 只读 `GET /api/v1/key` 与最小结构化推理请求用于区分认证、额度和模型能力问题；402 错误按服务端说明处理，不自动更换用户指定模型。
- 实际安装：Express 5.3.0、Cheerio 1.2.0、fast-xml-parser 5.11.2、Undici 8.11.2、Zod 4.6.7、Nodemailer 10.1.0。fast-xml-parser 禁用实体处理并拒绝 DTD/ENTITY；Undici 使用 EnvHttpProxyAgent 处理服务端代理。
- Firecrawl MCP 获取 [Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) 与 [DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash)。实时目录的 `reasoning.supported_efforts` 为 `max/high/low`，默认开启且为 high；推理与可见输出共享 max_tokens，可能造成 length/空正文。实现按模型能力选择 low，不为不支持该参数的模型强行传入；每批 15 条，成功批次持久化，截断仍记录返回的 token 用量。

用户补充额度后的成功审核、官方 RSS 摘要核实、标题/摘要冲突保守处理以及浏览器关闭后的后台运行，均有本机真实记录；结果见 TEST-REPORT.md。Google 本机重试已经成功，Hugging Face 本机仍超时；不混同 MCP 和本机的网络可用性。

以上是当前真实核对结果；规划期“尚需”条目保留用于追踪，最终测试状态见 TEST-REPORT.md。
