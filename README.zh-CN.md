# mailsift（中文说明）

mailsift 用于统一监控多个 IMAP 邮箱，包括垃圾箱。它结合本地规则和大模型判断邮件重要性，将需要处理的邮件推送到飞书或 WebhookWise，其余邮件汇总为每日简报。

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
LLM_MODEL=deepseek-chat
LLM_API_KEY=

PUSH_MIN_IMPORTANCE=warning
SPAM_RANK_BONUS=0
DIGEST_ENABLED=true
DIGEST_HOUR=9
```

完整配置见 [.env.example](.env.example)。`MAIL_ACCOUNT_N_FOLDERS` 可填 `all`、`INBOX,spam` 或具体文件夹名；`all` 会排除已发送、草稿、回收站和服务商的虚拟视图，`spam` 会自动识别垃圾箱。

`MAIL_CONTEXT`、`MAIL_ALWAYS_IMPORTANT`、`MAIL_NEVER_IMPORTANT` 和 `MAIL_KEYWORDS` 可用于定制分类规则。不要把 `MAIL_CONTEXT` 写成多行。

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

## OpenTelemetry 指标

指标使用 OpenTelemetry，默认关闭。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后即可把 OTLP 指标发送到 OpenTelemetry Collector，覆盖轮询耗时、账号结果、分类决策、通知、dead-letter 和 outbox。指标属性只使用 provider、结果、通道、重要性和决策来源等低基数值，不放邮箱地址、Message-ID 或主题。

`LLM_SKIP_SENSITIVE=true` 会让验证码、一次性密码和认证码邮件始终走本地规则/关键词路径，不发送给 LLM；它们仍可正常触发通知。

## 运行和恢复

```bash
docker compose up -d
docker compose logs -f
npm run check
npm run dev -- --once
npm run dev -- --once --dry-run
npm run probe
```

systemd 模板见 [deploy/mailsift.service](deploy/mailsift.service)。处理过程中被中断时：

```bash
docker compose run --rm mailsift node dist/src/main.js --recover
```

Compose 默认使用已发布的 `1.0.0` 镜像。升级时在 `.env` 设置 `MAILSIFT_VERSION`，避免使用可变的 `latest` 标签。

## MCP

内置 MCP 默认在主容器中开启，并绑定回环地址：

```bash
MCP_ENABLED=true MCP_TOKEN=<随机长 token> docker compose up -d
```

需要公网访问时，设置强 token、显式绑定 `MCP_BIND`，并发布或反代 `MCP_PORT`：

默认 compose 只映射到本机回环地址。若确实需要公网访问，请设置强 token 并显式绑定主机端口：

```dotenv
MCP_ENABLED=true
MCP_BIND=0.0.0.0
MCP_PORT=8410
MCP_TOKEN=<随机长 token>
```

请通过反向代理或隧道使用 HTTPS；MCP 会返回邮箱数据，不能让 bearer token 通过公网明文 HTTP 传输。非回环模式没有 `MCP_TOKEN` 时会拒绝启动。MCP 与主进程合并运行，提供查询和本地恢复工具。

## 开发

```bash
npm test
npm run typecheck
npm run build
```

## License

MIT
