# FirstCue · AI 热点情报台

为 AI 编程博主收集网页搜索、X 和官方订阅中的新信息，使用 OpenRouter 核实事件、合并转载和生成中文摘要。关键词与领域范围统一每 30 分钟检查；只有基线之后新增且核实的关键词命中进入邮件队列。

## 本地运行

需要 Node.js **24.16.0–24.x**。项目使用该版本的 `node:sqlite`，不兼容旧版 Node。

```powershell
npm ci
# 首次使用时复制示例；已有 .env 时不要覆盖。
Copy-Item .env.example .env
npm run dev
```

开发页面：<http://127.0.0.1:5173/>。API：<http://127.0.0.1:3030/>。

构建后可直接运行，不需要 Vite：

```powershell
npm run build
npm start
```

正式本地页面：<http://127.0.0.1:3030/>。两种启动方式都包含 API 与独立后台 worker；使用一种即可。在终端按 Ctrl+C 停止。关闭网页不会停止后台，关闭进程或电脑休眠会暂停监控。

## 配置

密钥只保存在本地 `.env`；修改后重启。页面不收集或返回密钥。

| 环境变量 | 用途 |
| --- | --- |
| OPENROUTER_API_KEY | OpenRouter Key，需要可用额度 |
| OPENROUTER_MODEL | 默认 `deepseek/deepseek-v4.1-flash`，已核对支持结构化输出 |
| TWITTERAPI_IO_KEY | TwitterAPI.io Key 与可用额度 |
| SMTP_HOST / SMTP_PORT | 邮件服务器与端口 |
| SMTP_SECURE | 465 通常为 true；587 通常为 false，仍要求 STARTTLS |
| SMTP_USER / SMTP_PASS | SMTP 账号与授权码 |
| SMTP_FROM | 发件人地址 |
| NOTIFY_EMAIL | 初始接收邮箱，也可在页面设置 |
| HTTPS_PROXY / HTTP_PROXY | 可选出站 HTTP 代理；不得放入浏览器配置 |
| TRUSTED_X_IDS | 已核验官方身份的稳定 X 用户 ID，逗号分隔；蓝标和用户名不自动成为官方依据 |

模型、接收邮箱和调用限额保存到 SQLite 后，页面设置优先于初始环境默认值。当前服务仅接受本地回环访问；部署前需另行设计访问认证与网络配置。

## 使用流程

1. 在“我的监控”添加关键词目标或范围。搜索查询可包含英文产品名，例如 `Claude new model release` 或 `AI coding agents`；AI 按完整目标判断，不把简单关键词命中视为真实发布。
2. 在“信息来源”查看或暂停来源、添加 RSS/Atom、添加 X 账号时间线。Bing 不需 API；DuckDuckGo 是默认暂停的备选。各来源状态分别记录。
3. 首次检查建立历史基线；之后每 30 分钟执行，也可点击“立即检查”。网页搜索有缓存和限速，X 使用增量窗口与游标续查。
4. 在“最新信号”按范围、渠道、可信状态和关注度筛选，打开事件查看证据与核实理由。官方发布摘要与完整原文分别标识；发生时间与发现时间分别标识。待核实或已排除内容不会发送正式发布通知。
5. AI 请求失败时保留候选；解决服务问题后点击“重新核实”，只复用已保存内容，不重复请求采集来源。连续未解决的候选不会无限重试。
6. 需要邮件时再填写 SMTP 与接收邮箱，先检查连接、发送测试邮件并确认收件，再验收自动通知。

Google / Hugging Face 等域名是否可访问取决于本机网络；失败有运行记录，不会被伪装为没有热点。Bing 搜索页可能出现校验或结构变化，此时停止该来源本轮请求。OpenRouter 返回 402 时先处理账号/Key 额度；“检查模型能力”只确认目录声明，不能代替真实推理。

## 数据、限额与验证

- 数据在 `data/signal.sqlite`，包括规则、候选、事件、检查点、通知和用量。备份时先停止进程，再复制整个 `data` 目录，保留 SQLite 的 WAL 文件。
- 默认每轮最多 10 次搜索、30 条分析候选；X 每查询最多 3 页，未完成窗口继续保留。每日默认 AI 100 次、X 200 次请求 / 2000 条结果，可在设置调整。
- AI 每批 15 条，30 条候选最多调用两次；成功批次单独提交，后续失败保留剩余内容。模型支持时使用低推理强度，避免推理占满输出预算。无关内容必须显式排除，防止反复审核。
- `npm test`：核心业务、API 与多进程存储测试，网络服务使用隔离替身，不使用真实 Key。
- `npm run build`：类型检查与前后端构建。
- `npm run smoke`：真实读取公共搜索/订阅源，并写入 `reports/live-sources.json`；不调用付费 X 或 AI，不发送邮件。

目录：`web` 页面、`server` API/worker/适配器、`shared` 类型、`tests` 测试、`docs` 需求/方案/研究/验收记录。

[需求](docs/REQUIREMENTS.md) · [方案](docs/PLAN.md) · [MCP 接口研究](docs/API-RESEARCH.md) · [测试与验收](docs/TEST-REPORT.md)

Agent Skills 按用户要求在网页版可用并验收后开发，当前不包含技能包。
