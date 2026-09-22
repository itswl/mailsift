# mailsift

Unified IMAP monitoring for important email. mailsift scans every configured mailbox—including spam folders—uses an LLM plus local rules to classify messages, and sends important results to Feishu or a generic webhook.

> mailsift is an assistant, not a mail client. It is read-only: it does not send, reply to, organize, or mark messages as read. Classification can be wrong, so keep using your mail client as the source of truth.

中文文档：[README.zh-CN.md](README.zh-CN.md)。

## Features

- Any IMAP provider, with multiple accounts.
- Spam-folder monitoring with provider-specific folder-name detection.
- Personal rules plus LLM classification; keyword fallback when the LLM is not configured or fails.
- Real-time push notifications and a daily digest.
- Crash-safe cursor handling and recovery for interrupted processing.
- Optional MCP server for querying local triage results.

## Quick start

```bash
git clone https://github.com/itswl/mailsift.git
cd mailsift
cp .env.example .env
vim .env
docker compose up -d
```

At minimum, configure one mailbox, one output (`FEISHU_WEBHOOK_URL` or `WEBHOOKWISE_URL`), and optionally an LLM API key. For local development with Node >= 22.5:

```bash
npm install
npm run check
npm run dev
```

## Configuration

All settings are environment variables. See [.env.example](.env.example) for the complete template.

```bash
MAIL_ACCOUNT_1=qq|me@qq.com|app-password
MAIL_ACCOUNT_1_NAME=personal-qq
MAIL_ACCOUNT_1_FOLDERS=all

MAIL_ACCOUNT_2=imap|me@example.com|password|imap.example.com

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

`MAIL_ACCOUNT_N_FOLDERS` accepts `all`, `INBOX,spam`, or explicit folder names. The `all` token excludes sent, drafts, trash, and provider-wide virtual views. The `spam` token detects the provider's spam folder.

`MAIL_CONTEXT`, `MAIL_ALWAYS_IMPORTANT`, `MAIL_NEVER_IMPORTANT`, and `MAIL_KEYWORDS` customize classification. Keep `MAIL_CONTEXT` on one line in `.env`. Sender rules take three forms: `@bank.com` matches the address domain or a subdomain of it, `alerts@bank.com` matches exactly that address, and anything else is a substring test on the address and display name. The first two ignore the display name so a look-alike domain or a crafted name cannot trigger an always-important rule.

### Gmail and Outlook OAuth

Gmail and Outlook require OAuth for most accounts:

```bash
npm run oauth
```

For a headless server or Docker:

```bash
docker compose run --rm mailsift node dist/scripts/oauth-setup.js --manual
```

The refresh-token store is `data/tokens.json`. Treat it as a long-lived mailbox credential, keep it out of version control, and preserve its file ownership in Docker (`uid 10001`). Personal Gmail can use `gmail_pw` with an app password instead of OAuth; Google Workspace cannot.

### Polling and backfill limits

The first scan uses `INITIAL_LOOKBACK_DAYS` (default `3`). If a fresh folder or a folder whose UIDVALIDITY changed returns more than `MAX_MESSAGES_PER_LOOKBACK` messages (default `500`), mailsift processes the oldest bounded chunk and continues the backfill on later polls. It never advances past an unprocessed backlog just to avoid repeated work.

Each folder is limited to `MAX_MESSAGES_PER_POLL` (default `200`). All accounts and folders share `MAX_MESSAGES_PER_POLL_TOTAL` (default `500`). When the ordinary total cap is reached, unprocessed folders keep their cursors and continue on the next poll. Selected UIDs are processed oldest-first so a cap does not skip older mail.

Messages larger than `MAX_MESSAGE_SOURCE_BYTES` (default `5 MiB`) are not downloaded into the MIME parser. They are recorded as dead letters and can be inspected through the MCP `list_dead_letters` tool.

The MCP recovery tools expose `recovery_status` and `retry_dead_letter`. Retrying rewinds one folder cursor so the next normal poll can fetch the message again; it does not modify the mailbox.

MCP also provides `observability` for processing, delivery, dead-letter, and feedback totals, plus `record_feedback` with `false_positive`, `missed`, `handled`, and `correct` labels. Feedback is stored for later rule and triage evaluation.

After two feedback records for the same sender, `missed` feedback infers an always-important rule and `false_positive` feedback infers a never-important rule. Explicit environment rules take precedence; inspect inferred rules with MCP `feedback_rules`.

State is stored in SQLite (`data/mailsift.db`). Docker persists it in the `mailsift-data` named volume.

## OpenTelemetry metrics

Metrics are instrumented with OpenTelemetry and disabled by default. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send OTLP metrics to an OpenTelemetry Collector. The instruments cover poll duration, account outcomes, triage decisions, notifications, dead letters, and the outbox. Attributes intentionally use only low-cardinality values such as provider, outcome, channel, importance, and decision source.

`LLM_SKIP_SENSITIVE=true` keeps verification codes, one-time passwords, and auth-code messages in the local keyword/rule path. They remain eligible for normal notifications, but their content is never sent to the configured LLM.

`LLM_REDACT_PII=true` (the default) redacts email addresses, phone numbers, payment card numbers, and resident ID numbers from fields sent to the LLM. Card and ID numbers are only redacted when their checksum holds, so waybill, order, and invoice numbers stay readable in summaries. Local state and notifications keep the original values. Set it to `false` only when the configured endpoint is trusted and the additional context is necessary.

The LLM integration is OpenAI-compatible: mailsift posts to `${LLM_BASE_URL}/chat/completions` with `model`, `messages`, and (when enabled) `response_format: {"type":"json_object"}`. The response must provide JSON in `choices[0].message.content` with one result per input index. Set `LLM_JSON_MODE=false` for providers that reject `response_format`; mailsift also retries once without it when the rejection is explicit.

`LLM_OUTPUT_LANGUAGE` sets the language of summaries, reasons, and categories: `en` (default), `zh-CN`, `zh-TW`, `auto` to follow each message, or any language name. Categories use the same language, so `auto` can split the digest's category groups.

If an LLM request fails, returns invalid JSON/schema, or omits an input index, the affected batch uses the local fallback. Keyword matches remain warning-level and can be pushed; messages without a high-risk keyword become info and are queued for digest/review. Fallback does not stop polling. After `LLM_ALERT_AFTER_FAILURES` consecutive failures, mailsift sends an outage alert; when calls recover it sends a recovery notice. Messages already processed during fallback are not automatically re-triaged, so review that period's digest.

### Signal events

Webhook deliveries retain the existing `mail` / `triage` payload and add a
small source-neutral `signal.v1` event. It carries the triage summary and an MCP
lookup reference instead of copying the raw message body. The reference can fetch
a bounded normalized body from IMAP on demand without persisting it; set
`MCP_LIVE_BODY_CHARS` to tune the returned body cap. Live lookup is read-only and
bounded by `MCP_LIVE_SOURCE_BYTES`, `MCP_LIVE_LOOKBACK_DAYS`, and
`MCP_LIVE_SEARCH_MAX_MESSAGES`.

The reference is Bearer-authenticated only when `MCP_TOKEN` is configured. A
loopback MCP listener with an empty token is intentionally unauthenticated, so
do not expose it beyond the host. See [docs/signal-event-v1.md](docs/signal-event-v1.md)
for the contract.

## Running

```bash
docker compose up -d
docker compose logs -f
docker compose pull && docker compose up -d

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

`--once` polls once and exits with status `2` if an account fetch fails. `--check`
validates configuration and OAuth authorization; `--dry-run` logs notifications
without sending them; `--digest-now` sends the current digest; `--healthcheck`
checks only whether a recent poll heartbeat exists; and `--recover` drops
undispatched records and rewinds cursors after an interrupted run.

`probe` checks folders and recent counts by default. Use `--no-counts` for a
lighter connectivity/folder check, or `--account` to select one account. OAuth
supports `--account`, `--manual`, and `--force`.

Compose uses the released image version `1.0.0` by default. Set `MAILSIFT_VERSION`
in `.env` when upgrading; this keeps deployments away from the mutable `latest`
tag. The container stores SQLite state and OAuth refresh tokens in the
`mailsift-data` named volume. A host-side `npm run oauth` writes to
`./data/tokens.json`, which is not the Docker volume; run the OAuth command
through `docker compose run --rm mailsift ...` when authorizing the container's
accounts.

To build from the checked-out source instead of pulling the image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

For systemd, first run `npm install` and `npm run build`, then use
[deploy/mailsift.service](deploy/mailsift.service). Change `WorkingDirectory` to
the directory containing `.env` and `data/`, and change `ExecStart` if `which node`
is not `/usr/bin/node`. The service user must own or be able to write the data
directory; a dedicated low-privilege user is recommended. Recovery after an
interrupted dispatch:

```bash
docker compose run --rm mailsift node dist/src/main.js --recover
```

## MCP

The embedded MCP server is enabled by default in the main process. In Docker,
`MCP_BIND` is the container listen address and `MCP_PUBLIC_HOST` is the host-side
publish address. The Compose file uses `MCP_PORT` for both host and container
ports; by default it is reachable only at `127.0.0.1:8410` on the host:

```dotenv
MCP_ENABLED=true
MCP_PUBLIC_HOST=127.0.0.1
MCP_BIND=0.0.0.0
MCP_PORT=8410
MCP_TOKEN=<random-long-token>
```

For public HTTP access, use a strong token and set `MCP_PUBLIC_HOST` deliberately.
A non-loopback `MCP_BIND` refuses to start without `MCP_TOKEN`; loopback with an
empty token is unauthenticated by design. The endpoint is `/mcp`, uses stateless
Streamable HTTP, and applies `MCP_RATE_LIMIT_PER_MINUTE` (default `120`). Use
HTTPS through a reverse proxy or tunnel because MCP carries mailbox data and
bearer tokens must not cross the public internet over plain HTTP. It exposes
read-only query/recovery tools; for local stdio clients, point the command at
`dist/src/mcp.js`.

`health` reports the last poll heartbeat, account failures, LLM failure count,
and pending queues. The Docker healthcheck checks only the poll heartbeat; a
healthy container does not prove that every account, LLM call, or notification
sink is healthy. Use MCP `health` and `recovery_status` for those details.

## Troubleshooting

- **Repeated notifications:** messages are deduplicated by account plus Message-ID. `--recover` is for interrupted, undecided records.
- **QQ scans many messages:** some QQ IMAP endpoints ignore `SINCE`; the local UID cursor still preserves correctness.
- **Messages marked read:** mailsift uses read-only mailbox locks and `BODY.PEEK[]`.
- **LLM privacy:** `LLM_SKIP_SENSITIVE=true` keeps verification-code messages local, and `LLM_REDACT_PII=true` redacts common direct identifiers before sending fields to the LLM. Omit `LLM_API_KEY` for local keyword fallback or use a self-hosted endpoint.
- **OAuth expiry:** access tokens refresh automatically. Re-authorize with `npm run oauth -- --account user@example.com --force` after revocation or credential changes.

## Development

```bash
npm test
npm run typecheck
npm run build
```

## License

MIT
