# Troubleshooting

- **The container keeps restarting and the log says "MCP startup failed":** Compose binds MCP to `0.0.0.0` inside the container, and a non-loopback bind refuses to start without `MCP_TOKEN`. Set `MCP_TOKEN` to a long random string, or `MCP_ENABLED=false` if you want neither MCP nor the web view.
- **`docker compose up` cannot pull the image:** `MAILSIFT_VERSION` must name a published release, written without the leading `v` (`0.1.99`, not `v0.1.99`); the Releases page lists them. Leave it unset to run `latest`.
- **Nothing was notified:** call MCP `health` first. Its `delivery` block reports the push and digest thresholds, the spam bonus, and whether self-forwards are suppressed, which usually explains the decision without further digging. `recovery_status` then shows folder UID progress and any notification still queued for retry.
- **A mailbox stopped being checked:** the web view names it under the status line, and tapping the line shows the kind of failure and what usually fixes it; see [Web view](web-view.md#mailboxes-that-cannot-be-read).
- **Repeated notifications:** messages are deduplicated by account plus Message-ID. Mailboxes that forward to each other are covered by `SUPPRESS_SELF_FORWARDS` ([Configuration](configuration.md#mailboxes-and-folders)). `--recover` is for interrupted, undecided records.
- **Delivery failures:** a push that fails with a network error, a timeout, or HTTP 408/429/5xx is retried and then waits in the durable outbox with exponential backoff; `recovery_status` shows the next attempt time. See [Configuration](configuration.md#delivery-retries).
- **Outbox backlog:** only real failures wait there. An output that declines a message under its own threshold, such as `FEISHU_MIN_IMPORTANCE`, settles it immediately and the digest carries it, so a pending count in MCP `health` always means something is genuinely undelivered.
- **The digest arrives at the wrong hour:** `DIGEST_HOUR` is read on the server's clock, so check `TZ`; see [Configuration](configuration.md#daily-digest).
- **QQ scans many messages:** some QQ IMAP endpoints ignore `SINCE`; the local UID cursor still preserves correctness.
- **Messages marked read:** mailsift uses read-only mailbox locks and `BODY.PEEK[]`.
- **LLM privacy:** `LLM_SKIP_SENSITIVE=true` keeps verification-code messages local, and `LLM_REDACT_PII=true` redacts common direct identifiers before sending fields to the LLM. Omit `LLM_API_KEY` for local keyword fallback or use a self-hosted endpoint. See [Triage](triage.md).
- **OAuth expiry:** access tokens refresh automatically. Re-authorize with `npm run oauth -- --account user@example.com --force` (or the Docker form in [Deployment](deployment.md#gmail-and-outlook-oauth)) after revocation or credential changes.
