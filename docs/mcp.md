# MCP

mailsift includes an MCP server, so an AI assistant can see what needs you, list, search and read your triaged mail, preview the digest, look at attachments and at what your provider said about a sender, and check whether mailsift is healthy. With a second, write token it can also mark mail done and file it. It can never send mail or delete it.

An agent that supports skills can load [`.agents/skills/mailsift/SKILL.md`](../.agents/skills/mailsift/SKILL.md), which says how these tools are meant to be used and where the limits are.

- [Connecting](#connecting)
- [Tools and resources](#tools-and-resources)
- [Prompts](#prompts)
- [Errors](#errors)
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

While no token is set, the server answers only to requests addressed to `localhost`, `127.0.0.1` or `[::1]` and refuses any other `Host` with 421. A browser can be made to reach a loopback port through a host name some other site controls; the name it sends is how that is told apart from you. A proxy on the same machine that forwards a different name needs it listed in `MCP_ALLOWED_HOSTS`.

The endpoint is `/mcp`, uses stateless Streamable HTTP with `Authorization: Bearer <MCP_TOKEN>`, and applies `MCP_RATE_LIMIT_PER_MINUTE` (default `120`) per client. Use HTTPS through a reverse proxy or tunnel because MCP carries mailbox data and bearer tokens must not cross the public internet over plain HTTP. Behind a proxy, set `TRUSTED_PROXY=true` (see [Web view](web-view.md#behind-a-reverse-proxy)).

For local stdio clients, point the command at `dist/src/mcp.js` (or `npm run mcp` in a checkout).

## Tools and resources

| Tool | What it does |
| --- | --- |
| `needs_you` | The queue the web view opens on: mail judged to matter that nobody has dealt with yet. Optionally also what was dealt with in the last seven days. Start here for "what needs me". |
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
| `inspect_mail_safety` | Spam and safety clues for one message, with what the mailbox's provider reported about the sender. |
| `health` | Last poll, mailbox failures, LLM status and queues. Start here when a notification is missing. |
| `recovery_status` | Mailbox health timelines, folder UID progress, dead letters, and notifications queued for retry. |
| `list_dead_letters` | Messages skipped because they were oversized or could not be parsed. |
| `observability` | Totals for processing, delivery, dead letters, feedback and mailbox actions, plus access audit by tool. |
| `list_audit` | Recent tool and resource calls and audited mailbox actions. |
| `feedback_rules` | Sender rules inferred from feedback. |
| `manage_mail` | Write: mark read or unread, star or unstar, archive, bring back to the inbox, move. |
| `mark_handled` | Write: say a message is dealt with, which takes it out of `needs_you`, or put it back. |
| `record_feedback` | Write: label a message `false_positive`, `missed`, `handled` or `correct`. |
| `retry_dead_letter` | Write: rewind one folder cursor so the next poll retries a dead letter. |

### Resources

| Resource | What it reads |
| --- | --- |
| `mailsift://search-syntax` | Every filter the tools accept, the category and importance vocabularies, and what the store does not hold. Rendered from the constants the triage code uses, so it cannot describe a vocabulary that no longer exists. |
| `mailsift://mail/{messageId}` | One stored judgement as a markdown page: headers, how it was judged and why, the bounded body preview, the attachment list. |
| `mailsift://thread/{threadKey}` | A whole conversation as one markdown page, oldest first. Thread keys come from `list_threads`. |
| `mailsift://imap/{account}/{messageId}` | A bounded normalized body, fetched from the mailbox on demand. |
| `mailsift://imap/{account}/{messageId}/attachment/{partId}` | One attachment, fetched on demand. |

The first three are markdown because a model reads them: the headings say what each field means, which a JSON object has to be told. The same records are still JSON from `get_mail` and `list_threads`, which is what an application should parse. Nothing fetched live is persisted. The webhook's [signal event](signal-event-v1.md) carries the `mailsift://imap/...` form as its reference.

`list_folders` takes the exact account address returned by `list_accounts` and lists its decoded IMAP folder paths, hierarchy delimiter, flags, special-use marker, and selectability. It uses IMAP LIST without opening folders or changing mail.

## Prompts

Prompts are workflows, not questions. Each one fixes an order of tool calls that works and says when to stop, because a model asked something broad usually starts with a search, and a search cannot answer a question about mail that was never delivered.

| Prompt | Arguments | What it does |
| --- | --- | --- |
| `catch_up` | `hours`, optional `focus` | Reports what arrived and what needs action, starting from `needs_you` and reading `mail_summary`, `list_mail` and the pending digest rather than searching. It changes nothing. |
| `why_not_notified` | `about` | Diagnoses a missing notification in order: was the mailbox read, was it judged above the threshold, was it delivered. Starts at `health`, which answers most cases on its own. |
| `review_triage` | `hours` | Goes through recent judgements and records feedback on the wrong ones. Asks before recording anything, because two records for one sender become a standing rule. Registered only where `MCP_WRITE_TOKEN` is configured. |

## Errors

Every failure carries a `code` a caller can branch on, a message, and a `hint` naming the next move. Tools answer with `isError` and the body as JSON; resource reads carry the same body in the JSON-RPC error's `data`.

| Code | Means |
| --- | --- |
| `NOT_FOUND` | The id is unknown to mailsift. |
| `ACCOUNT_UNKNOWN` | That address is not one of the monitored mailboxes. |
| `INVALID_ARGUMENT` | An argument does not match the schema, or a resource URI is malformed. |
| `MAILBOX_UNAVAILABLE` | The mailbox itself could not be read just now. Stored records stay available. |
| `ATTACHMENT_UNSUPPORTED` | Skipped by the size or type limit. |
| `ACTION_REFUSED` | `manage_mail` was asked for an action or destination that is not allowed. |
| `WRITE_DISABLED` | No write credential is configured. |
| `SERVER_MISCONFIGURED` | mailsift cannot read its own settings. This needs a person, not another call. |
| `PROVIDER_ERROR` | Anything else. The underlying message is never passed through, because it can carry a credential. |

A Message-ID that was never seen is not an error: `get_mail` answers `found: false`, because absence is a result.

## Write tools and the write token

`manage_mail`, `mark_handled`, `record_feedback`, and `retry_dead_letter` are write tools, and they are not registered at all unless `MCP_WRITE_TOKEN` is set. The separate token keeps a leaked read credential from changing either mailbox contents or future triage policy.

`manage_mail` supports `mark_read`, `mark_unread`, `star`, `unstar`, `archive`, `inbox` and `move`. `archive` files a message in the mailbox's own archive folder (All Mail on Gmail; refused where there is none) and counts it as dealt with; `inbox` brings one back from spam or from the archive; `move` takes a folder path from `list_folders`. It never sends mail, and it refuses a move to a bin whatever the folder is called: by the usual names and by the server's own `\Trash` flag. Every operation looks the message up again in the mailbox, starting where mailsift last saw it, and checks its Message-ID inside a writable IMAP lock before changing anything; then it records an audit row. After a move the stored record follows the message, so the web view and the next call look where it now is.

`mark_handled` is the ring in the web view: it takes a message out of the queue, or with `handled: false` puts it back. Marking one done also marks it read in its mailbox, and the answer's `markedRead` says whether the mailbox could be told; a mailbox that cannot be reached does not undo the mark.

Set `MCP_WRITE_TOKEN` to a second secret that differs from `MCP_TOKEN`; reusing one value for both is refused at startup. Present it as the bearer token to get the full surface. `MCP_TOKEN` then stays a read-only credential, which is what any shared client should hold. Over stdio the caller can already read the env file, so setting `MCP_WRITE_TOKEN` alone enables the write tools there without a second presentation.

The [web view](web-view.md#signing-in-and-what-a-session-may-do) makes the same split: a browser that signs in with `MCP_WRITE_TOKEN` can act on mail, and one that signs in with `MCP_TOKEN` reads. The page can do two things the MCP tools deliberately cannot, move a message to the bin and send a reply, because there a person presses the button. An MCP client is a model following instructions that may have come from the mail it is reading, so what it is given is what can be undone from the same place: flags flip back, and a message that was archived or moved can be brought back. Both write to the same audit tables.

`record_feedback` records `false_positive`, `missed`, `handled`, and `correct` labels for later rule and triage evaluation. Two `missed` or two `false_positive` records for one sender become a rule; see [Configuration](configuration.md#your-own-rules). The `handled` label also takes the message out of the queue, but it cannot put one back: `mark_handled` is the tool for the queue.

## Attachments

`list_attachments` takes a configured account and Message-ID, and returns MIME metadata plus a `mailsift://imap/.../attachment/{partId}` resource URI for each file. Read the resource to fetch that one file from IMAP. The web view also lists and downloads attachments from a message's detail panel. Reads use a read-only mailbox lock; attachment bytes are never stored. New triage records keep only a bounded manifest of names, MIME types, part IDs, and reported sizes.

`MCP_ATTACHMENT_MAX_BYTES` limits the decoded size of each on-demand file and defaults to 10 MiB (configuration is capped at 100 MiB). This limit is separate from `MCP_LIVE_SOURCE_BYTES`, so attachment reads fetch the selected MIME part without downloading the entire message source. Filenames are treated as untrusted data and files are delivered as downloads. mailsift returns image and PDF files as-is; it does not recognize images or extract PDF text.

`scan_attachment` and the web view's **Scan attachment** button read only a bounded decoded prefix, controlled by `MCP_ATTACHMENT_SCAN_BYTES` (default 1 MiB, hard cap 4 MiB). The local check looks for suspicious filename/MIME combinations and common executable, script, active-content, and container signatures. It does not unpack, execute, upload, persist, or claim to replace antivirus software.

## Spam and safety clues

The `inspect_mail_safety` tool checks a message's configured folder, mailing-list or bulk-mail headers, a From/Reply-To domain mismatch, attachment filename/MIME types, and links parsed from a bounded text body prefix. Under `senderSignals.authentication` it also repeats what the mailbox's own provider reported about SPF, DKIM and DMARC, by the same rules as the reader (`pass`, `fail`, or `none` when the provider said nothing or is not one whose header can be recognised). The web detail view offers the same check, and attachment lists show file-type cautions and a bounded scan button. Mailbox reads use a read-only lock; only the selected text body prefix is read for link parsing, and no link is opened.

Link parsing reads at most `MCP_SAFETY_BODY_BYTES` (default 256 KiB, hard cap 1 MiB) from a selected text body part. It reports scheme, IP-host, punycode, userinfo, and common shortener clues while omitting URL paths and query values.

These are clues, not a spam or malware verdict. Mailing-list headers do not prove spam; sender fields can be forged. mailsift does not verify SPF, DKIM or DMARC itself (it repeats what the mailbox's own provider reported, see [Reading a message](web-view.md#reading-a-message), and a pass proves the domain, not the intent), resolve or reputation-check links, unpack attachments, or provide an antivirus verdict. It does not move, delete, flag, or otherwise change messages as part of these checks.

## Health and recovery

`health` reports the last poll heartbeat, account failures (with each failing account's last good check), LLM and decision-stage failure counts, and pending queues; `healthy` is false while a mailbox is at the alert threshold. Its `delivery` block reports the push and digest thresholds, the spam bonus, and whether self-forwards are suppressed. The Docker healthcheck checks only the poll heartbeat; a healthy container does not prove that every account, LLM call, or notification sink is healthy. Use MCP `health` and `recovery_status` for those details.

The MCP recovery tools expose `recovery_status` always, and `retry_dead_letter` only when the write credential is configured. Retrying rewinds one folder cursor so the next normal poll can fetch the message again; it does not modify the mailbox.

## Audit

Every tool and live resource call is audited by name, outcome, caller fingerprint, and (where useful) a bounded account/message/part target; rejected authentication attempts are included. What the web view does is recorded the same way: its mailbox actions and each message it sends (as `send`, without recipients or text) in the mailbox-action audit, and marking done, feedback, questions, drafts and notification subscriptions as `web:*` rows in the access audit. `list_audit` returns recent rows and mailbox-action audit, and `observability` groups the access audit by tool. Credentials, message bodies, and URL query strings are never stored in the audit.
