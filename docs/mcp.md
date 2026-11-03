# MCP

mailsift includes an MCP server, so an AI assistant can list, search and read your triaged mail, preview the digest, look at attachments, and check whether mailsift is healthy.

- [Connecting](#connecting)
- [Tools and resources](#tools-and-resources)
- [Write tools and the write token](#write-tools-and-the-write-token)
- [Attachments](#attachments)
- [Spam and safety clues](#spam-and-safety-clues)
- [Health and recovery](#health-and-recovery)
- [Audit](#audit)

## Connecting

The embedded MCP server is enabled by default in the main process. In Docker, `MCP_BIND` is the container listen address and `MCP_PUBLIC_HOST` is the host-side publish address. The Compose file uses `MCP_PORT` for both host and container ports; by default it is reachable only at `127.0.0.1:8410` on the host:

```dotenv
MCP_ENABLED=true
MCP_PUBLIC_HOST=127.0.0.1
MCP_BIND=0.0.0.0
MCP_PORT=8410
MCP_TOKEN=<random-long-token>
```

A non-loopback `MCP_BIND` refuses to start without `MCP_TOKEN`, and Compose binds to `0.0.0.0` inside the container, so a Docker deployment always needs a token. Loopback with an empty token is unauthenticated by design. For public HTTP access, use a strong token and set `MCP_PUBLIC_HOST` deliberately.

The endpoint is `/mcp`, uses stateless Streamable HTTP with `Authorization: Bearer <MCP_TOKEN>`, and applies `MCP_RATE_LIMIT_PER_MINUTE` (default `120`) per client. Use HTTPS through a reverse proxy or tunnel because MCP carries mailbox data and bearer tokens must not cross the public internet over plain HTTP. Behind a proxy, set `TRUSTED_PROXY=true` (see [Web view](web-view.md#behind-a-reverse-proxy)).

For local stdio clients, point the command at `dist/src/mcp.js` (or `npm run mcp` in a checkout).

## Tools and resources

| Tool | What it does |
| --- | --- |
| `list_mail` | Recently processed mail (24 hours by default), filtered by level, exact category, mailbox, spam only or pushed only. |
| `list_threads` | Recent conversations, grouped by their References/In-Reply-To root. |
| `search_mail` | Keyword search over subject, sender, category, summary, reason, the stored body preview and attachment metadata. |
| `get_mail` | The stored triage record for one Message-ID, with a bounded body preview. |
| `mail_summary` | Processed and pushed totals for a time window, spam and spam rescues included. |
| `list_digest` | The messages waiting for the next daily digest. |
| `list_accounts` | The monitored mailboxes, their providers and the folders being watched. |
| `list_folders` | One mailbox's IMAP folders. |
| `list_attachments` | A message's attachments, each with a resource URI to fetch the file. |
| `scan_attachment` | A bounded local check of one attachment. |
| `inspect_mail_safety` | Spam and safety clues for one message. |
| `health` | Last poll, mailbox failures, LLM status and queues. Start here when a notification is missing. |
| `recovery_status` | Mailbox health timelines, folder UID progress, dead letters, and notifications queued for retry. |
| `list_dead_letters` | Messages skipped because they were oversized or could not be parsed. |
| `observability` | Totals for processing, delivery, dead letters, feedback and mailbox actions, plus access audit by tool. |
| `list_audit` | Recent tool and resource calls and audited mailbox actions. |
| `feedback_rules` | Sender rules inferred from feedback. |
| `manage_mail` | Write: mark read or unread, star or unstar, move. |
| `record_feedback` | Write: label a message `false_positive`, `missed`, `handled` or `correct`. |
| `retry_dead_letter` | Write: rewind one folder cursor so the next poll retries a dead letter. |

Resources: `mailsift://mail/{messageId}` reads a stored triage record, `mailsift://imap/{account}/{messageId}` fetches a bounded normalized body from IMAP on demand, and `mailsift://imap/{account}/{messageId}/attachment/{partId}` fetches one attachment. Nothing fetched live is persisted. The webhook's [signal event](signal-event-v1.md) carries the second form as its reference.

`list_folders` takes the exact account address returned by `list_accounts` and lists its decoded IMAP folder paths, hierarchy delimiter, flags, special-use marker, and selectability. It uses IMAP LIST without opening folders or changing mail.

## Write tools and the write token

`manage_mail`, `record_feedback`, and `retry_dead_letter` are write tools, and they are not registered at all unless `MCP_WRITE_TOKEN` is set. `manage_mail` supports `mark_read`, `mark_unread`, `star`, `unstar`, and `move`; it refuses delete/trash destinations and never sends mail. Every operation resolves the Message-ID again inside a writable IMAP lock and records an audit row. The separate token keeps a leaked read credential from changing either mailbox contents or future triage policy.

Set `MCP_WRITE_TOKEN` to a second secret that differs from `MCP_TOKEN`; reusing one value for both is refused at startup. Present it as the bearer token to get the full surface. `MCP_TOKEN` then stays a read-only credential, which is what the browser view and any shared client should hold. Over stdio the caller can already read the env file, so setting `MCP_WRITE_TOKEN` alone enables the write tools there without a second presentation.

`record_feedback` records `false_positive`, `missed`, `handled`, and `correct` labels for later rule and triage evaluation. Two `missed` or two `false_positive` records for one sender become a rule; see [Configuration](configuration.md#your-own-rules).

## Attachments

`list_attachments` takes a configured account and Message-ID, and returns MIME metadata plus a `mailsift://imap/.../attachment/{partId}` resource URI for each file. Read the resource to fetch that one file from IMAP. The web view also lists and downloads attachments from a message's detail panel. Reads use a read-only mailbox lock; attachment bytes are never stored. New triage records keep only a bounded manifest of names, MIME types, part IDs, and reported sizes.

`MCP_ATTACHMENT_MAX_BYTES` limits the decoded size of each on-demand file and defaults to 10 MiB (configuration is capped at 100 MiB). This limit is separate from `MCP_LIVE_SOURCE_BYTES`, so attachment reads fetch the selected MIME part without downloading the entire message source. Filenames are treated as untrusted data and files are delivered as downloads. mailsift returns image and PDF files as-is; it does not recognize images or extract PDF text.

`scan_attachment` and the web view's **Scan attachment** button read only a bounded decoded prefix, controlled by `MCP_ATTACHMENT_SCAN_BYTES` (default 1 MiB, hard cap 4 MiB). The local check looks for suspicious filename/MIME combinations and common executable, script, active-content, and container signatures. It does not unpack, execute, upload, persist, or claim to replace antivirus software.

## Spam and safety clues

The `inspect_mail_safety` tool checks a message's configured folder, mailing-list or bulk-mail headers, a From/Reply-To domain mismatch, attachment filename/MIME types, and links parsed from a bounded text body prefix. The web detail view offers the same check, and attachment lists show file-type cautions and a bounded scan button. Mailbox reads use a read-only lock; only the selected text body prefix is read for link parsing, and no link is opened.

Link parsing reads at most `MCP_SAFETY_BODY_BYTES` (default 256 KiB, hard cap 1 MiB) from a selected text body part. It reports scheme, IP-host, punycode, userinfo, and common shortener clues while omitting URL paths and query values.

These are clues, not a spam or malware verdict. Mailing-list headers do not prove spam; sender fields can be forged. mailsift does not verify SPF, DKIM or DMARC, resolve or reputation-check links, unpack attachments, or provide an antivirus verdict. It does not move, delete, flag, or otherwise change messages as part of these checks.

## Health and recovery

`health` reports the last poll heartbeat, account failures (with each failing account's last good check), LLM and decision-stage failure counts, and pending queues; `healthy` is false while a mailbox is at the alert threshold. Its `delivery` block reports the push and digest thresholds, the spam bonus, and whether self-forwards are suppressed. The Docker healthcheck checks only the poll heartbeat; a healthy container does not prove that every account, LLM call, or notification sink is healthy. Use MCP `health` and `recovery_status` for those details.

The MCP recovery tools expose `recovery_status` always, and `retry_dead_letter` only when the write credential is configured. Retrying rewinds one folder cursor so the next normal poll can fetch the message again; it does not modify the mailbox.

## Audit

Every tool and live resource call is audited by name, outcome, caller fingerprint, and (where useful) a bounded account/message/part target; rejected authentication attempts are included. `list_audit` returns recent rows and mailbox-action audit, and `observability` groups the access audit by tool. Credentials, message bodies, and URL query strings are never stored in the audit.
