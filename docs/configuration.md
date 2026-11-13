# Configuration

Every setting is an environment variable read from `.env`. [`.env.example`](../.env.example) lists all of them with their defaults and a line about each. This page covers the ones whose effect needs more than a line.

- [Mailboxes and folders](#mailboxes-and-folders)
- [Sending mail](#sending-mail)
- [Outputs](#outputs)
- [What gets pushed](#what-gets-pushed)
- [Your own rules](#your-own-rules)
- [Daily digest](#daily-digest)
- [Polling and limits](#polling-and-limits)
- [Real-time wake-ups with IMAP IDLE](#real-time-wake-ups-with-imap-idle)
- [Alerts](#alerts)

The LLM settings are described in [Triage](triage.md). The settings for MCP are in [MCP](mcp.md), and what the web view does with the ones below is in [Web view](web-view.md).

## Mailboxes and folders

`MAIL_ACCOUNT_N=provider|address|password[|host]` adds a mailbox; number them from 1 upwards. The password is usually an app password or the provider's authorization code. `.env.example` lists the provider presets, and `imap` with a host covers any other server. Gmail and Outlook usually need OAuth instead of a password; see [Deployment](deployment.md#gmail-and-outlook-oauth).

```bash
MAIL_ACCOUNT_1=qq|me@qq.com|app-password
MAIL_ACCOUNT_1_NAME=personal-qq
MAIL_ACCOUNT_1_FOLDERS=all

MAIL_ACCOUNT_2=imap|me@example.com|password|imap.example.com
```

`MAIL_ACCOUNT_N_NAME` is the name shown in notifications. `MAIL_ACCOUNT_N_FOLDERS` accepts `all`, `INBOX,spam` (the default), or explicit folder names. The `all` token excludes sent, drafts, trash, and provider-wide virtual views. The `spam` token detects the provider's spam folder. `npm run probe` lists the folders a server offers.

`SUPPRESS_SELF_FORWARDS=true` (the default) stops one message notifying twice when your mailboxes forward to each other. A forwarded copy is a new message with its own Message-ID, so deduplication cannot recognise it, but its sender is one of the configured accounts. Such a copy is recorded and stays searchable through `list_mail`, but it is neither pushed nor repeated in the daily digest, since the original was already triaged at its source. It costs no LLM call either. Mail you send to yourself inside a single mailbox is unaffected, and an explicit `MAIL_ALWAYS_IMPORTANT` sender still wins.

## Sending mail

Nothing in mailsift sends mail unless the [web view](web-view.md#writing) is on and a browser has signed in with `MCP_WRITE_TOKEN`. Then a reply or a new message leaves through the provider's own SMTP submission server, signed in with the credential that already reads the mailbox.

Every provider preset knows its server, so most mailboxes need no setting. The exceptions:

- **A custom host** (`imap|address|password|host`) has no known submission server. Set `MAIL_ACCOUNT_N_SMTP_HOST`, and `MAIL_ACCOUNT_N_SMTP_PORT` when it is not 465. Port 465 is TLS from the first byte; any other port must offer STARTTLS. There is no setting that sends a password unencrypted.
- **Outlook with OAuth** is authorized for reading only by default, because Microsoft consents to sending separately. Run `npm run oauth -- --account you@outlook.com --send --force` to add it. Gmail's OAuth scope already covers sending.

`MAIL_ACCOUNT_N_FROM_NAME` is the name mail is sent under; without it the bare address is used. The sender is always the mailbox's own address.

Gmail, Outlook and QQ file a copy of what was sent into Sent by themselves. For every other provider mailsift appends the copy over IMAP.

`SMTP_ENABLED=false` switches sending off for every mailbox, and so does `DRY_RUN=true`.

`MAIL_ACCOUNT_N_AUTHSERV_ID` is unrelated to sending but lives beside these: it names the server that receives this mailbox's mail, so the reader can tell a provider's verdict on a sender from one the sender wrote. See [Reading a message](web-view.md#reading-a-message).

## Outputs

Configure at least one; both can be on at once.

- **Feishu or Lark**: `FEISHU_WEBHOOK_URL` is a custom bot's webhook. `FEISHU_WEBHOOK_SECRET` is needed only when the bot verifies signatures. `FEISHU_MIN_IMPORTANCE` raises the bar for Feishu alone.
- **Webhook**: `WEBHOOK_URL` is the complete endpoint each push is posted to. `WEBHOOK_TOKEN`, when set, is sent as a `token` header.

A verification code appears in the Feishu card itself. The webhook payload only says that one arrived; see [Triage](triage.md#verification-codes-and-sign-in-links).

### Signal events

Webhook deliveries retain the existing `mail` / `triage` payload and add a small source-neutral `signal.v1` event. It carries the triage summary and an MCP lookup reference instead of copying the raw message body. The reference can fetch a bounded normalized body from IMAP on demand without persisting it; set `MCP_LIVE_BODY_CHARS` to tune the returned body cap. Live lookup is read-only and bounded by `MCP_LIVE_SOURCE_BYTES`, `MCP_LIVE_LOOKBACK_DAYS`, and `MCP_LIVE_SEARCH_MAX_MESSAGES`.

The reference is Bearer-authenticated only when `MCP_TOKEN` is configured. A loopback MCP listener with an empty token is intentionally unauthenticated, so do not expose it beyond the host. See [signal-event-v1.md](signal-event-v1.md) for the contract.

### Delivery retries

A push that fails with a network error, a timeout, or HTTP 408/429/5xx is retried up to `SINK_RETRY_ATTEMPTS` times (default `3`, seconds apart) and then waits in the durable outbox. Outbox retries use persisted exponential backoff: the first waits `OUTBOX_RETRY_BASE_SECONDS` (default `60`), and the wait doubles up to `OUTBOX_RETRY_MAX_SECONDS` (default `3600`), so a failed endpoint is not hammered on every poll. Once an endpoint has used up its retries, later pushes to it make a single attempt until one succeeds, so a dead endpoint does not stretch every poll. MCP `recovery_status` shows the next attempt time.

Only real failures wait in the outbox. An output that declines a message under its own threshold, such as `FEISHU_MIN_IMPORTANCE`, settles it immediately and the digest carries it, so a pending count in MCP `health` always means something is genuinely undelivered.

## What gets pushed

Triage rates every message `critical`, `warning` or `info`. `PUSH_MIN_IMPORTANCE` (default `warning`) is the lowest level pushed in real time. Everything below it waits for the daily digest.

`SPAM_RANK_BONUS` lifts spam-folder mail by whole importance levels, so with the default `PUSH_MIN_IMPORTANCE=warning` a bonus of `1` pushes every spam-folder message: warning and critical were already above the line and info now sits on it. Leave it at `0` unless `PUSH_MIN_IMPORTANCE` is `critical` and you want spam-folder warnings to break through anyway. Catching a message wrongly filed as spam does not need it, because triage assesses spam normally and rates a real bill or code warning or critical there. The bonus applies to every delivery decision, an output's own threshold such as `FEISHU_MIN_IMPORTANCE` included. `--check` warns about the combinations that deliver the whole spam folder.

## Your own rules

`MAIL_CONTEXT` is a sentence about you that the LLM reads with every message: who you are and what you want pushed. Keep it on one line in `.env`.

`MAIL_ALWAYS_IMPORTANT` and `MAIL_NEVER_IMPORTANT` are comma-separated sender rules: a match is marked critical or info without consulting the LLM. Sender rules take three forms: `@bank.com` matches the address domain or a subdomain of it, `alerts@bank.com` matches exactly that address, and anything else is a substring test on the address and display name. The first two ignore the display name so a look-alike domain or a crafted name cannot trigger an always-important rule.

`MAIL_KEYWORDS` are the keywords the local fallback looks for, on top of its built-in list, when no LLM is configured or it fails; see [Triage](triage.md#when-the-llm-fails).

Feedback becomes rules too. After two feedback records for the same sender, recorded through MCP `record_feedback` or by correcting a judgement in the web view, `missed` feedback infers an always-important rule and `false_positive` feedback infers a never-important rule. Explicit environment rules take precedence; inspect inferred rules with MCP `feedback_rules`.

## Daily digest

`DIGEST_ENABLED=true` collects the messages below the push threshold into one message a day. `--digest-now` sends the current digest at once, and MCP `list_digest` previews it.

`DIGEST_HOUR` is a whole hour from 0 to 23 on the server's own clock, so set `TZ` (the compose file defaults it to `Asia/Shanghai`); any other value falls back to 9, and `--check` says so. The digest goes out with the first poll after that hour, once per local calendar day.

Up to 0.1.97 the "already sent today" check used the UTC date, which got any hour earlier than the local time of UTC midnight wrong: before 08:00 in UTC+8, and in zones behind UTC most of the day, including the default 9 across the Americas. Those digests went out when the UTC date changed (08:00 in UTC+8, 19:00 or 20:00 in New York) instead of at the hour, and twice on a first day or after a day without polls. After upgrading, the first digest goes out when the old rule would have sent it, and every one after that at the hour.

## Polling and limits

`POLL_INTERVAL_SECONDS` (default `300`) is the time between polls. The first scan uses `INITIAL_LOOKBACK_DAYS` (default `3`). If a fresh folder or a folder whose UIDVALIDITY changed returns more than `MAX_MESSAGES_PER_LOOKBACK` messages (default `500`), mailsift processes the oldest bounded chunk and continues the backfill on later polls. It never advances past an unprocessed backlog just to avoid repeated work.

Each folder is limited to `MAX_MESSAGES_PER_POLL` (default `200`). All accounts and folders share `MAX_MESSAGES_PER_POLL_TOTAL` (default `500`). When the ordinary total cap is reached, unprocessed folders keep their cursors and continue on the next poll. Selected UIDs are processed oldest-first so a cap does not skip older mail.

Messages up to `MAX_MESSAGE_SOURCE_BYTES` (default `5 MiB`) use the normal MIME parser. For larger messages, mailsift reads only the selected `text/plain` body part, falling back to HTML, so a large attachment is not pulled into triage. If that text body alone exceeds the limit, the message is recorded as a dead letter and can be inspected through `list_dead_letters`; `list_attachments` can still look up its files by account and Message-ID.

## Real-time wake-ups with IMAP IDLE

`IMAP_IDLE_ENABLED=true` keeps one read-only connection per account and IDLE folder (`IMAP_IDLE_FOLDERS`, default `INBOX`) open. When the server reports new mail, mailsift fetches that folder at once on the same connection and runs the usual deduplicate, triage, and deliver pipeline, so a wake-up costs no extra login. Polling continues as the reconciliation pass and catches anything a notification missed; with IDLE on, `POLL_INTERVAL_SECONDS` can usually be raised to 900-1800. `npm run probe` shows whether a server advertises IDLE; accounts without it stay on polling. Listeners reconnect with backoff after a drop, log out cleanly on shutdown, and the MCP `health` tool reports the last wake-up per account.

Folders listed in `IMAP_IDLE_FOLDERS` must also be monitored, and `all` is not accepted there.

## Alerts

mailsift reports through the same outputs when it cannot do its job:

- A mailbox that fails `ACCOUNT_ALERT_AFTER_FAILURES` polls in a row (default `2`) raises an alert that names the kind of failure and what usually fixes it. While it keeps failing, the alert is not repeated within `ACCOUNT_ALERT_COOLDOWN_SECONDS` (default six hours), and a recovery notice follows once it works again.
- The LLM failing `LLM_ALERT_AFTER_FAILURES` times in a row (default `2`) raises an outage alert, and so does the decision stage of two-stage triage; see [Triage](triage.md#when-the-llm-fails).
- A stopped process or host cannot report itself. For that, see the heartbeat in [Deployment](deployment.md#monitoring).
