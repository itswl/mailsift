# mailsift

Unified IMAP monitoring for important email. mailsift scans every configured mailbox—including spam folders—uses an LLM plus local rules to classify messages, and sends important results to Feishu or WebhookWise.

> mailsift is an assistant, not a mail client. It is read-only: it does not send, reply to, organize, or mark messages as read. Classification can be wrong, so keep using your mail client as the source of truth.

Chinese documentation: [README.zh-CN.md](README.zh-CN.md).

## Features

- Any IMAP provider, with multiple accounts.
- Spam-folder monitoring with provider-specific folder-name detection.
- Personal rules plus LLM classification; keyword fallback when no LLM is configured.
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
LLM_MODEL=deepseek-chat
LLM_API_KEY=

PUSH_MIN_IMPORTANCE=warning
SPAM_RANK_BONUS=0
DIGEST_ENABLED=true
DIGEST_HOUR=9
```

`MAIL_ACCOUNT_N_FOLDERS` accepts `all`, `INBOX,spam`, or explicit folder names. The `all` token excludes sent, drafts, trash, and provider-wide virtual views. The `spam` token detects the provider's spam folder.

`MAIL_CONTEXT`, `MAIL_ALWAYS_IMPORTANT`, `MAIL_NEVER_IMPORTANT`, and `MAIL_KEYWORDS` customize classification. Keep `MAIL_CONTEXT` on one line in `.env`.

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

The first scan uses `INITIAL_LOOKBACK_DAYS` (default `3`). If a fresh folder or a folder whose UIDVALIDITY changed returns more than `MAX_MESSAGES_PER_LOOKBACK` messages (default `500`), the entire lookback batch is skipped and the cursor advances to the highest returned UID. This prevents repeated historical backfills.

Each folder is limited to `MAX_MESSAGES_PER_POLL` (default `200`). All accounts and folders share `MAX_MESSAGES_PER_POLL_TOTAL` (default `500`). When the ordinary total cap is reached, unprocessed folders keep their cursors and continue on the next poll. Selected UIDs are processed oldest-first so a cap does not skip older mail.

State is stored in SQLite (`data/mailsift.db`). Docker persists it in the `mailsift-data` named volume.

### Signal events

WebhookWise deliveries retain the existing `mail` / `triage` payload and add a
small source-neutral `signal.v1` event. It carries the triage summary and an
authenticated MCP lookup reference instead of copying the raw message body.
See [docs/signal-event-v1.md](docs/signal-event-v1.md) for the contract.

## Running

```bash
docker compose up -d
docker compose logs -f
docker compose pull && docker compose up -d

npm run check
npm run dev -- --once
npm run dev -- --once --dry-run
npm run probe
```

Compose uses the released image version `1.0.0` by default. Set `MAILSIFT_VERSION` in `.env` when upgrading; this keeps deployments away from the mutable `latest` tag.

For systemd, use [deploy/mailsift.service](deploy/mailsift.service). Recovery after an interrupted dispatch:

```bash
docker compose run --rm mailsift node dist/src/main.js --recover
```

## MCP

The MCP server is disabled by default. Enable the Docker profile:

```bash
docker compose --profile mcp up -d
```

The default compose mapping is loopback-only. For public HTTP access, set a strong token and bind the host port explicitly:

```dotenv
MCP_PUBLIC_HOST=0.0.0.0
MCP_PORT=8410
MCP_TOKEN=<random-long-token>
# Public HTTP MCP is read-only by default; only disable this on a trusted network.
MCP_READ_ONLY=true
```

Use HTTPS through a reverse proxy or tunnel; the MCP endpoint carries mailbox data and bearer tokens must not cross the public internet over plain HTTP. Public HTTP mode refuses to start without `MCP_TOKEN` and exposes only read-only query tools unless `MCP_READ_ONLY=false` is explicitly set. For local stdio clients, point the command at `dist/src/mcp.js`. The server provides tools for listing, searching, inspecting, and summarizing mail, listing accounts, and checking health; trusted read-write mode also provides immediate polling and digest sending.

## Troubleshooting

- **Repeated notifications:** messages are deduplicated by account plus Message-ID. `--recover` is for interrupted, undecided records.
- **QQ scans many messages:** some QQ IMAP endpoints ignore `SINCE`; the local UID cursor still preserves correctness.
- **Messages marked read:** mailsift uses read-only mailbox locks and `BODY.PEEK[]`.
- **LLM privacy:** by default the sender, subject, and the first `LLM_BODY_CHARS` characters are sent to the configured LLM. Omit `LLM_API_KEY` for local keyword fallback or use a self-hosted endpoint.
- **OAuth expiry:** access tokens refresh automatically. Re-authorize with `npm run oauth -- --account user@example.com --force` after revocation or credential changes.

## Development

```bash
npm test
npm run typecheck
npm run build
```

## License

MIT
