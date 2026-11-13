# MCP

mailsift includes an MCP server, so an AI assistant can see what needs you, list, search and read your triaged mail, preview the digest, look at attachments and at what your provider said about a sender, and check whether mailsift is healthy. With a second, write token it is given what the web view's owner has: it can mark mail done, file it, bin it, and send mail.

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
| `read_message` | One message as the web view shows it, read live: its text with the quoted history apart, who it is from and to, the provider's verdict on the sender, its flags and folder. |
| `prepare_reply` | What an answer to a message would start from: recipients, subject, thread references, the original quoted. Sends nothing. |
| `list_attachments` | A message's attachments, each with a resource URI to fetch the file. |
| `scan_attachment` | A bounded local check of one attachment. |
| `inspect_mail_safety` | Spam and safety clues for one message, with what the mailbox's provider reported about the sender. |
| `health` | Last poll, mailbox failures, LLM status and queues. Start here when a notification is missing. |
| `recovery_status` | Mailbox health timelines, folder UID progress, dead letters, and notifications queued for retry. |
| `list_dead_letters` | Messages skipped because they were oversized or could not be parsed. |
| `observability` | Totals for processing, delivery, dead letters, feedback and mailbox actions, plus access audit by tool. |
| `list_audit` | Recent tool and resource calls and audited mailbox actions. |
| `feedback_rules` | Sender rules inferred from feedback. |
| `manage_mail` | Write: mark read or unread, star or unstar, archive, bring back to the inbox, bin, move. |
| `mark_handled` | Write: say a message is dealt with, which takes it out of `needs_you`, or put it back. |
| `send_mail` | Write: answer a stored message, or send a new one, from a monitored mailbox. |
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
| `ACTION_REFUSED` | The mailbox or the mail server refused: a folder that does not exist, a recipient the server would not take, too many messages in a minute. |
| `WRITE_DISABLED` | No write credential is configured. |
| `SERVER_MISCONFIGURED` | mailsift cannot read its own settings. This needs a person, not another call. |
| `PROVIDER_ERROR` | Anything else. The underlying message is never passed through, because it can carry a credential. `send_mail` answers with this code and `send_timeout` in its message when the mail server did not confirm a message: it may have left, so look in Sent before sending again. |

A Message-ID that was never seen is not an error: `get_mail` answers `found: false`, because absence is a result.

## Write tools and the write token

`manage_mail`, `mark_handled`, `send_mail`, `record_feedback`, and `retry_dead_letter` are write tools, and they are not registered at all unless `MCP_WRITE_TOKEN` is set. The separate token keeps a leaked read credential from changing mailbox contents, sending mail or changing future triage policy.

**The write token is the owner's key.** A caller that presents it is given what a browser signed in with it has in the [web view](web-view.md#signing-in-and-what-a-session-may-do), and the tools run the page's own code, so the two cannot differ: the same checks, the same limits (ten messages a minute per client), the same audit. That includes the two things that act for you in the world, binning a message and sending one. An MCP client is a model, and the mail it reads is written by strangers who can address it directly, so give this token only to a client you would hand your mailbox to, and prefer one that asks before it sends. The server's instructions, each tool's description and the [skill](../.agents/skills/mailsift/SKILL.md) all tell a model to act only on your request and never on a message's; that is guidance, not a lock. `SMTP_ENABLED=false` switches sending off for the page and for MCP alike.

`manage_mail` supports `mark_read`, `mark_unread`, `star`, `unstar`, `archive`, `inbox`, `trash` and `move`. `archive` files a message in the mailbox's own archive folder (All Mail on Gmail; refused where there is none); `inbox` brings one back from spam, the archive or the bin; `trash` moves it to the mailbox's bin, which the provider empties on its own schedule; `move` takes a folder path from `list_folders`. Archiving and binning count the message as dealt with, and so does a `move` into the bin or a folder inside it. Every operation looks the message up again in the mailbox, starting where mailsift last saw it, and checks its Message-ID inside a writable IMAP lock before changing anything; then it records an audit row. After a move the stored record follows the message, so the web view and the next call look where it now is.

`mark_handled` is the ring in the web view: it takes a message out of the queue, or with `handled: false` puts it back. Marking one done also marks it read in its mailbox, in the background, and that is audited too; a mailbox that cannot be reached does not undo the mark.

`send_mail` is the composer. With `replyTo` (a stored Message-ID) the answer leaves from the mailbox that received the original and continues its thread. Where `to` is left out it goes to whoever the original asks answers to, or to its sender when the original asks for answers only at your own address; a message that names no sender and no reply address is refused until `to` is given, rather than answered to everyone it went to. Where `cc` is left out, `replyAll: true` puts the other recipients in copy (never your own addresses, and nobody twice). The subject is "Re:" the original's, and the original is quoted below the text unless `quote: false`. If the original can no longer be read from its mailbox, an answer still goes when `to` and `quote: false` are given. With `account` instead of `replyTo` it sends a new message from that mailbox. Text is plain text. Afterwards, as in the page, a copy is filed in Sent where the provider does not file one itself (`savedCopy` says whether one is there), the original is marked answered and counted as dealt with, and the audit has a row saying that a message left, from where and when, without its recipients or its text. A `note` in the result says something about where it went: an answer addressed for the caller to a Reply-To on another domain than the sender's, or with no sender address to compare it with (`prepare_reply` shows the same as `replyToElsewhere`, and where `to` came from as `addressedTo`), or an original that could not be quoted.

One letter is sent once. A letter's name is what the caller called it (`id`, optional) bound to what it says and who it goes to, as the page names its own, so the same request repeated within fifteen minutes is answered with `repeated: true`, a `notice`, and the same account of the first attempt (mailbox, recipients, any `note`) instead of a second copy; a name reused for a different letter does not answer for the first. When the mail server did not confirm a message, the answer is `PROVIDER_ERROR` with `send_timeout`: the message may have left, and the same request again gets the same answer without another attempt, until what became of the attempt is known. Then a repeat is answered with that: the letter left, or it failed before it was handed over and is sent. A different `id` sends it after all, once the owner has looked in Sent. That memory is the running process's: a restart forgets it. A call the client walks away from still runs to its end, and what it did is still recorded.

Set `MCP_WRITE_TOKEN` to a second secret that differs from `MCP_TOKEN`; reusing one value for both is refused at startup. Present it as the bearer token to get the full surface. `MCP_TOKEN` then stays a read-only credential, which is what any shared client should hold. Over stdio the caller can already read the env file, so setting `MCP_WRITE_TOKEN` alone enables the write tools there without a second presentation.

One message can be stored once per monitored mailbox (a forwarded copy, or a message sent to two of them). Every tool that acts on or reads a single message by its Message-ID (`manage_mail`, `mark_handled`, `read_message`, `prepare_reply`, and `send_mail` with `replyTo`) takes an optional `account`, and refuses an ambiguous id without one, naming the mailboxes, rather than acting on whichever copy was stored first.

What stays with the page: its own assistant (asking a question across your mail, drafting a reply), since an MCP client is itself the model that would do that, and notifications to installed copies of the page, which belong to a browser.

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
