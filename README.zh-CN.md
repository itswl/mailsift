# mailsift（中文说明）

mailsift 用于统一监控多个 IMAP 邮箱，包括垃圾箱。它结合本地规则和大模型判断邮件重要性，将需要处理的邮件推送到飞书或通用 Webhook，其余邮件汇总为每日简报。

> 这是辅助工具，不是邮件客户端。mailsift 只读，不会发送、回复、整理邮件，也不会将邮件标记为已读。分类结果可能有误，请继续以邮件客户端为准。

英文主文档见 [README.md](README.md)。

## 快速开始

```bash
git clone https://github.com/itswl/mailsift.git
cd mailsift
cp .env.example .env
vim .env
docker compose up -d
```

至少配置一个邮箱、一个输出出口（`FEISHU_WEBHOOK_URL` 或 `WEBHOOKWISE_URL`），以及可选的大模型 API Key。Node >= 22.5 的本地运行方式：

```bash
npm install
npm run check
npm run dev
```

## 基本配置

```bash
MAIL_ACCOUNT_1=qq|me@qq.com|授权码
MAIL_ACCOUNT_1_NAME=QQ主号
MAIL_ACCOUNT_1_FOLDERS=all

FEISHU_WEBHOOK_URL=
WEBHOOKWISE_URL=
WEBHOOKWISE_TOKEN=

LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
LLM_API_KEY=

PUSH_MIN_IMPORTANCE=warning
SPAM_RANK_BONUS=0
DIGEST_ENABLED=true
DIGEST_HOUR=9
```

完整配置见 [.env.example](.env.example)。`MAIL_ACCOUNT_N_FOLDERS` 可填 `all`、`INBOX,spam` 或具体文件夹名；`all` 会排除已发送、草稿、回收站和服务商的虚拟视图，`spam` 会自动识别垃圾箱。

`MAIL_CONTEXT`、`MAIL_ALWAYS_IMPORTANT`、`MAIL_NEVER_IMPORTANT` 和 `MAIL_KEYWORDS` 可用于定制分类规则。不要把 `MAIL_CONTEXT` 写成多行。发件人规则有三种写法：`@bank.com` 匹配发件地址的域名及其子域，`alerts@bank.com` 精确匹配该地址，其它写法按子串匹配地址和显示名。前两种不看显示名，避免仿冒域名或伪造显示名触发"始终重要"规则。

## Gmail / Outlook OAuth

Gmail 和 Outlook 通常需要 OAuth：

```bash
npm run oauth
```

无浏览器的服务器或 Docker：

```bash
docker compose run --rm mailsift node dist/scripts/oauth-setup.js --manual
```

长期凭据保存在 `data/tokens.json`，不要提交到仓库。个人 Gmail 可用 `gmail_pw` 加应用专用密码绕过 OAuth；Google Workspace 不支持此方式。

## 轮询和补账限制

首次扫描使用 `INITIAL_LOOKBACK_DAYS`（默认 3 天）。如果首次扫描或 UIDVALIDITY 变化后的单个文件夹回看超过 `MAX_MESSAGES_PER_LOOKBACK`（默认 500）封，mailsift 会先处理最旧的一批，后续轮询继续补账；不会为了避免重复补账而越过尚未处理的邮件。

单个文件夹每轮最多处理 `MAX_MESSAGES_PER_POLL`（默认 200）封。所有账号和文件夹合计受 `MAX_MESSAGES_PER_POLL_TOTAL`（默认 500）限制。普通全局上限触发时，尚未处理的文件夹保留游标，下一轮继续。UID 按从老到新处理，避免截断时跳过旧邮件。

超过 `MAX_MESSAGE_SOURCE_BYTES`（默认 5 MiB）的邮件不会下载给 MIME 解析器，而会记录为 dead letter，可通过 MCP 的 `list_dead_letters` 查询，不会静默消失。

MCP 恢复工具提供 `recovery_status` 和 `retry_dead_letter`。重试只会回退对应文件夹的本地游标，下一轮正常轮询会重新拉取邮件，不会修改邮箱内容。

MCP 还提供 `observability` 查看处理、投递、dead-letter 和反馈统计，以及 `record_feedback` 记录 `false_positive`、`missed`、`handled`、`correct`。反馈会保存下来，供后续规则和分类评估使用。

同一发件人累计两次 `missed` 反馈会推断为重要发件人，两次 `false_positive` 会推断为低优先级发件人；显式环境规则优先。可通过 MCP `feedback_rules` 查看推断规则。

状态保存在 SQLite 的 `data/mailsift.db` 中，Docker 使用 `mailsift-data` 命名卷持久化。

## IMAP IDLE 实时唤醒

`IMAP_IDLE_ENABLED=true` 会为每个账号的每个 IDLE 文件夹（`IMAP_IDLE_FOLDERS`，默认 `INBOX`）保持一条只读长连接。服务器通知有新邮件时，mailsift 立刻在同一条连接上抓取该文件夹，并走正常的去重、分诊、投递流水线，因此一次唤醒不产生额外登录。定时轮询继续作为对账机制运行，兜住通知漏掉的邮件；开启 IDLE 后通常可以把 `POLL_INTERVAL_SECONDS` 调到 900～1800。`npm run probe` 会显示服务器是否支持 IDLE，不支持的账号继续使用轮询。长连接断开后按退避重连，进程退出时会正常 LOGOUT，MCP `health` 会报告每个账号最近一次唤醒时间。

## OpenTelemetry 指标

指标使用 OpenTelemetry，默认关闭。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后即可把 OTLP 指标发送到 OpenTelemetry Collector，覆盖轮询耗时、账号结果、分类决策、通知、dead-letter 和 outbox。指标属性只使用 provider、结果、通道、重要性和决策来源等低基数值，不放邮箱地址、Message-ID 或主题。

`LLM_SKIP_SENSITIVE=true` 会让验证码、一次性密码和认证码邮件始终走本地规则/关键词路径，不发送给 LLM；它们仍可正常触发通知。

`LLM_REDACT_PII=true`（默认）会在发送给 LLM 前脱敏邮件地址、电话号码、银行卡号和身份证号；银行卡号和身份证号只在校验位成立时才脱敏，因此运单号、订单号、发票号通常会保留在摘要里。本地状态及通知保留原始值。只有在确认网关可信且确实需要更多上下文时，才考虑关闭它。

LLM 接口必须兼容 OpenAI 的 `/chat/completions`：请求使用 `model`、`messages`，并在启用时带上 `response_format: {"type":"json_object"}`；响应需要在 `choices[0].message.content` 中返回 JSON，并为每封输入邮件提供对应的 `index`。如果服务商不支持 `response_format`，可设置 `LLM_JSON_MODE=false`；服务商明确拒绝时 mailsift 也会自动重试一次。

`LLM_OUTPUT_LANGUAGE` 决定摘要、原因和分类的语言：`en`（默认）、`zh-CN`、`zh-TW`、`auto`（跟随每封邮件的语言）或任意语言名称。分类也使用同一语言，因此 `auto` 可能把日报的分类分组拆成多种语言。

如果 LLM 请求失败、返回无效 JSON/结构，或返回重复/越界的序号，该批邮件会整体使用本地 fallback，因为序号错位后整批结果都不可信。仅遗漏了个别序号时，只有被遗漏的那封邮件走 fallback。命中高风险关键词的邮件仍按 warning 处理并可能实时推送；未命中的邮件按 info 处理，进入日报/待复核队列。fallback 不会停止轮询。连续失败达到 `LLM_ALERT_AFTER_FAILURES` 后会发送故障告警，恢复后发送恢复通知；已经在 fallback 期间处理的邮件不会自动重新分诊，应检查对应时段的日报。

## 运行和恢复

```bash
docker compose up -d
docker compose logs -f
npm run check
npm run dev -- --once
npm run dev -- --once --dry-run
npm run probe
npm run probe -- --account me@example.com --no-counts
npm run oauth -- --account me@example.com --manual --force
npm run dev -- --digest-now
npm run dev -- --healthcheck
npm run dev -- --recover
```

`--once` 执行一次轮询；`--check` 校验配置和 OAuth 授权；`--dry-run` 只记录通知、不发送；`--digest-now` 立即发送当前日报；`--healthcheck` 只检查最近是否有轮询心跳；`--recover` 在中断后清理未完成记录并回退游标。`probe` 默认检查文件夹和近期数量，`--no-counts` 可省略数量查询，`--account` 可只检查一个账号。OAuth 支持 `--account`、`--manual` 和 `--force`。

Compose 默认使用已发布的 `1.0.0` 镜像。升级时在 `.env` 设置 `MAILSIFT_VERSION`，避免使用可变的 `latest` 标签。容器把 SQLite 状态和 OAuth refresh token 保存在 `mailsift-data` 命名卷中。宿主机直接执行 `npm run oauth` 写入的是 `./data/tokens.json`，不会自动进入 Docker 命名卷；给容器账号授权时应使用：

```bash
docker compose run --rm mailsift node dist/scripts/oauth-setup.js --manual
```

从当前源码构建而不是拉取镜像：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

systemd 模板见 [deploy/mailsift.service](deploy/mailsift.service)。先执行 `npm install` 和 `npm run build`，再把 `WorkingDirectory` 改为包含 `.env` 和 `data/` 的目录；如果 `which node` 不是 `/usr/bin/node`，还要修改 `ExecStart`。运行用户必须能写入 data 目录，建议使用低权限专用用户。处理过程中被中断时：

```bash
docker compose run --rm mailsift node dist/src/main.js --recover
```

## 通知重试

推送因网络错误、超时或 HTTP 408/429/5xx 失败时，会先按 `SINK_RETRY_ATTEMPTS`（默认 `3`，间隔数秒）立即重试，仍失败再进入持久化 outbox，由下一轮轮询继续投递。端点持续不可用时，每次推送只尝试一次，直到有一次投递成功，避免拖长轮询。

只有真正的投递失败会留在 outbox。出口按自身阈值（如 `FEISHU_MIN_IMPORTANCE`）主动拒绝的消息会当场了结并交给日报，因此 MCP `health` 里的待投递数量始终代表真实积压。`SPAM_RANK_BONUS` 对所有投递决策生效，包括飞书自身阈值，调高它确实会把更多垃圾箱邮件推送到通知渠道。

## MCP

内置 MCP 默认在主进程中开启。Docker 中，`MCP_BIND` 是容器内监听地址，`MCP_PUBLIC_HOST` 是宿主机发布地址；Compose 会让宿主机端口和容器端口都使用 `MCP_PORT`。默认只在宿主机回环地址提供服务：

```dotenv
MCP_ENABLED=true
MCP_PUBLIC_HOST=127.0.0.1
MCP_BIND=0.0.0.0
MCP_PORT=8410
MCP_TOKEN=<随机长 token>
```

需要公网访问时，必须显式设置 `MCP_PUBLIC_HOST` 并使用强 token。非回环 `MCP_BIND` 没有 `MCP_TOKEN` 时会拒绝启动；回环监听且 token 为空时是有意的不鉴权模式，因此不能把它暴露到主机之外。端点是 `/mcp`，使用无状态 Streamable HTTP，并默认按客户端每分钟 120 次请求限流，可通过 `MCP_RATE_LIMIT_PER_MINUTE` 调整。

请通过反向代理或隧道使用 HTTPS；MCP 会返回邮箱数据，不能让 bearer token 通过公网明文 HTTP 传输。它提供只读查询和本地恢复工具。`health` 只反映最近一次轮询心跳、账号失败、LLM 失败计数和待处理队列；Docker healthcheck 只检查轮询心跳，healthy 不代表所有账号、LLM 和通知出口都正常，应通过 MCP `health` 和 `recovery_status` 查看详细状态。

Signal Events 中的 MCP 引用只有设置 `MCP_TOKEN` 后才是 Bearer 鉴权引用；实时 IMAP 正文读取是有上限、只读、按需执行的，不会持久化原始正文。

## 开发

```bash
npm test
npm run typecheck
npm run build
```

## License

MIT
