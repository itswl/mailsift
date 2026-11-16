# MCP

mailsift includes an MCP server, so an AI assistant can see what needs you, list, search and read your triaged mail, reach the rest of the mailbox live, preview the digest, look at attachments and at what your provider said about a sender, and check whether mailsift is healthy. With a second, write token it is given what the web view's owner has: it can mark mail done, file it, bin it, and send mail.

An agent that supports skills can load [`.agents/skills/mailsift/SKILL.md`](../.agents/skills/mailsift/SKILL.md), which says how these tools are meant to be used and where the limits are.

- [Connecting](#connecting)
- [Tools and resources](#tools-and-resources)
- [The rest of the mailbox, live](#the-rest-of-the-mailbox-live)
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
| `needs_you` | The queue the web view opens on: mail judged to matter that nobody has dealt with yet. A row with `withheld: true` was due a notification that was not sent because you had already answered it from another client or marked it done; it is not quiet digest mail. Optionally also what was dealt with in the last seven days, and what is put off until later. Start here for "what needs me". |
| `list_mail` | Recently processed mail (24 hours by default), filtered by level, exact category, mailbox, spam only or pushed only. |
| `list_threads` | Recent conversations, grouped by their References/In-Reply-To root, each with how many of your own messages it holds in the window (`sentCount`) and whether the latest word is yours (`lastWordYours`). |
| `search_mail` | Keyword search over subject, sender, category, summary, reason, the stored body preview and attachment metadata. |
| `get_mail` | The stored triage record for one Message-ID, with a bounded body preview. |
| `mail_summary` | Processed and pushed totals for a time window, spam and spam rescues included. |
| `list_digest` | The messages waiting for the next daily digest. |
| `list_accounts` | The monitored mailboxes, their providers and the folders being watched; with the write credential, each mailbox's signature. |
| `list_folders` | One mailbox's IMAP folders, what each is for, and how many messages each holds and how many are unread where the server says so cheaply. |
| `browse_folder` | One folder of a mailbox, live, newest first, a page at a time: any folder, and older mail than mailsift keeps. Each message has a live handle. |
| `search_mailbox` | A search the mailbox's own server runs (Gmail in its own syntax), live, for mail mailsift never stored. Says when it could only read the subject and sender of recent mail. |
| `find_contacts` | Addresses for a name or part of one, as the web view's composer suggests them: those you have written to first, then people who wrote to you. |
| `read_message` | One message as the web view shows it, read live: its text with the quoted history apart, who it is from and to, the provider's verdict on the sender, its flags and folder. Takes a stored Message-ID or a live handle. |
| `prepare_reply` | What an answer to a message would start from: recipients, subject, thread references, the original quoted. Sends nothing. |
| `prepare_forward` | What a forward of a message would start from: its subject, the forwarded block, and the original's attachments by part id. Sends nothing. |
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
| `snooze` | Write: put a message out of `needs_you` until a time, when it comes back and the owner's devices are reminded; bring it back now; or cancel the reminder. |
| `send_mail` | Write: answer a stored message, forward one with its attachments, or send a new one, from a monitored mailbox. |
| `set_signature` | Write: set or remove a mailbox's signature, the plain text the page and `send_mail` put under a letter from it. |
| `record_feedback` | Write: label a message `false_positive`, `missed`, `handled` or `correct`. |
| `retry_dead_letter` | Write: rewind one folder cursor so the next poll retries a dead letter. |

### Resources

| Resource | What it reads |
| --- | --- |
| `mailsift://search-syntax` | Every filter the tools accept, the category and importance vocabularies, and what the store does not hold. Rendered from the constants the triage code uses, so it cannot describe a vocabulary that no longer exists. |
| `mailsift://mail/{messageId}` | One stored judgement as a markdown page: headers, how it was judged and why, the bounded body preview, the attachment list. |
| `mailsift://thread/{threadKey}` | A conversation as one markdown page, oldest first: its newest 50 messages, your own among them and marked as yours, with a line saying how many older ones are left out. Thread keys come from `list_threads`. |
| `mailsift://imap/{account}/{messageId}` | A bounded normalized body, fetched from the mailbox on demand. |
| `mailsift://imap/{account}/{messageId}/attachment/{partId}` | One attachment, fetched on demand. |

The first three are markdown because a model reads them: the headings say what each field means, which a JSON object has to be told. The same records are still JSON from `get_mail` and `list_threads`, which is what an application should parse. Nothing fetched live is persisted. The webhook's [signal event](signal-event-v1.md) carries the `mailsift://imap/...` form as its reference.

### Your own mail

The poll reads each mailbox's Sent folder, and what `send_mail` and the web view send is stored as it leaves (see [The conversation, and your own mail](web-view.md#the-conversation-and-your-own-mail)). It is stored locally like the snippets of the mail you receive, used for the conversation only, and never judged or sent to the model. Three things read it:

- The thread resource lists your messages among the others, the newest 50 of the conversation (`Older messages not shown: N` says what was left out), each marked "From the owner", with whom it went to (To, Cc and Bcc), its date, its subject when it differs, the names of its files, and the text you wrote without the quoted history below it, at most 8,000 characters. A conversation that holds only your own messages so far can be read there too.
- `list_threads` stays the mail you received in the window, and says of each thread how many of your messages it holds in that window (`sentCount`) and whether yours is the latest word (`lastWordYours`). A copy of one of your own messages that came back into the mailbox (a mailing list's, a Bcc to yourself) is counted as yours, once, here and in the thread page.
- `find_contacts` (`query`, `limit` up to 20, default 8) turns "write to Alice" into an address. It ranks the addresses you have written to, in To, Cc or Bcc, by how often and how lately, then people who wrote to you and look like people: not spam, not newsletters, notices, codes or no-reply and other role addresses, not your own mailboxes. A name matches from the start of any of its words, an address from the start of its local part, of a word of it or of its domain, in either case, and a Chinese, Japanese or Korean name anywhere in it. Each result has one name, the most recent one seen with the address, and `source`: `sent` (written to) or `received` (only ever wrote). It needs only the read credential. Names were written by whoever sent the mail; ask the user when more than one address fits.

`needs_you`, `list_mail`, `search_mail`, `get_mail` and the digest are received mail only. A reply found in Sent takes the message it answers out of `needs_you`, as answering it through `send_mail` does; see [What needs you](web-view.md#what-needs-you) for the rule. `SENT_MAIL_ENABLED=false` stops reading and storing it.

`list_folders` takes the exact account address returned by `list_accounts` and lists its decoded IMAP folder paths, each with its `name` and `parent`, its `role` (`inbox`, `archive`, `all`, `sent`, `drafts`, `junk`, `trash`, `starred`, `important`, or null for a folder of the owner's own), hierarchy delimiter, flags, special-use marker and selectability, the inbox and the other folders every mailbox has first. `messages` and `unseen` are how many messages a folder holds and how many are unread, where the server says so cheaply: in the folder list itself (`LIST-STATUS`), or else by `STATUS` one folder at a time for a few seconds, the rest without them. It opens no folder and changes no mail. It is the list the web view's folder panel shows.

## The rest of the mailbox, live

The tools above are what mailsift fetched and judged: the monitored folders, within `STATE_RETENTION_DAYS`. `browse_folder` and `search_mailbox` reach the rest, live from IMAP: any folder, older mail, the archive, the Sent folder. They read envelopes and flags only, never a body, store nothing, and nothing they list is judged, sent to the model or put in `needs_you`. They need only the read credential, and are what the web view's folders and its "Search the mailbox" show.

- `browse_folder` (`account`, `folder` as `list_folders` gives it, `limit` up to 100, default 50) lists a folder newest first. `next` is passed back as `before` for the next page; it is tied to the folder's UIDVALIDITY, and a folder rebuilt in between is refused with `NOT_FOUND` (`liveCursor`), to be listed again from the top.
- `search_mailbox` (`account`, `query`, optional `folder`, `before`, `limit`) runs the mailbox's own search, newest first. Without `folder` it searches the inbox and the archive; on Gmail, All Mail alone, in Gmail's own syntax (`from:`, `has:attachment`, `older_than:1y`). Elsewhere the subject, the sender and the text are searched, in UTF-8 where the query needs it. QQ's IMAP search cannot be trusted (it answers some searches with the wrong messages and ignores Chinese on some accounts), so on QQ, and on any server that refuses a search or finds nothing for text outside ASCII, the newest 2,000 messages of each folder searched are read envelope by envelope and only their subject and sender compared. The answer then has `limited` (`reason`: `provider`, `refused` or `unicode`; `scanned`: how many were read): it is not a full search, and an assistant must say so.

Each message they list has `from`, `to`, `subject`, `date`, `size`, `flags` (`seen`, `flagged`, `answered`), `attachments` (whether it carries files) and a `handle`, a string that starts `live:` and names the message by its mailbox, folder, the folder's UIDVALIDITY, its UID and its Message-ID. A message mailsift stored also has `key` (its `dedupKey`) and `stored`: how it was judged and whether it was dealt with or put off.

A handle can be given wherever a tool takes a `messageId`: `read_message`, `prepare_reply`, `prepare_forward`, `list_attachments`, `inspect_mail_safety`, `scan_attachment`, the `mailsift://imap/...` resources, `manage_mail`, and `send_mail` as `replyTo` or `forward`. The message is then read and acted on exactly where the handle says. Each time, the server checks that the mailbox is configured, the folder exists and has not been rebuilt, and that the UID still carries that Message-ID (under the writable lock, for an action); when one of these no longer holds the call fails with `NOT_FOUND` and a hint to list the folder again, and nothing is looked for elsewhere. A handle that is not one this server made is `INVALID_ARGUMENT`. After a move, `manage_mail` answers with the message's new `handle` where the server said where it landed. A message named by a handle that mailsift stored is the stored record for everything else: archiving or binning it counts it as dealt with, answering it takes it out of `needs_you`. `mark_handled`, `snooze` and `record_feedback` take a handle only for such a message, and refuse one for a message mailsift never stored with `ACTION_REFUSED`: it has no place in the queue and no judgement to correct. A sender can write a Message-ID that looks like a handle: a string that starts `live:` only ever names a live message, and one that is also a stored record's Message-ID or key is refused with `INVALID_ARGUMENT`, to be named by the record's `dedupKey` instead.

The audit records which mailbox and folder were browsed or searched, never what was searched for.

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
| `ATTACHMENT_UNSUPPORTED` | Skipped by the size or type limit. From `send_mail`, a forward whose attachments come to more than one message may carry (`send_too_large`): nothing was sent. |
| `ACTION_REFUSED` | The mailbox or the mail server refused: a folder that does not exist, a recipient the server would not take, too many messages in a minute. |
| `WRITE_DISABLED` | No write credential is configured. |
| `SERVER_MISCONFIGURED` | mailsift cannot read its own settings. This needs a person, not another call. |
| `PROVIDER_ERROR` | Anything else. The underlying message is never passed through, because it can carry a credential. `send_mail` answers with this code and `send_timeout` in its message when the mail server did not confirm a message: it may have left, so look in Sent before sending again. |

A Message-ID that was never seen is not an error: `get_mail` answers `found: false`, because absence is a result.

## Write tools and the write token

`manage_mail`, `mark_handled`, `snooze`, `send_mail`, `set_signature`, `record_feedback`, and `retry_dead_letter` are write tools, and they are not registered at all unless `MCP_WRITE_TOKEN` is set. The separate token keeps a leaked read credential from changing mailbox contents, sending mail or changing future triage policy.

**The write token is the owner's key.** A caller that presents it is given what a browser signed in with it has in the [web view](web-view.md#signing-in-and-what-a-session-may-do), and the tools run the page's own code, so the two cannot differ: the same checks, the same limits (ten messages a minute per client), the same audit. That includes the two things that act for you in the world, binning a message and sending one. The page can do one thing more, attach a file from the device it runs on (see what stays with the page, below). An MCP client is a model, and the mail it reads is written by strangers who can address it directly, so give this token only to a client you would hand your mailbox to, and prefer one that asks before it sends. The server's instructions, each tool's description and the [skill](../.agents/skills/mailsift/SKILL.md) all tell a model to act only on your request and never on a message's; that is guidance, not a lock. `SMTP_ENABLED=false` switches sending off for the page and for MCP alike.

`manage_mail` supports `mark_read`, `mark_unread`, `star`, `unstar`, `archive`, `inbox`, `trash` and `move`. `archive` files a message in the mailbox's own archive folder (All Mail on Gmail; refused where there is none); `inbox` brings one back from spam, the archive or the bin; `trash` moves it to the mailbox's bin, which the provider empties on its own schedule; `move` takes a folder path from `list_folders`. Archiving and binning count the message as dealt with, and so does a `move` into the bin or a folder inside it. Every operation looks the message up again in the mailbox, starting where mailsift last saw it, and checks its Message-ID inside a writable IMAP lock before changing anything; then it records an audit row. After a move the stored record follows the message, so the web view and the next call look where it now is.

`mark_handled` is the ring in the web view: it takes a message out of the queue, or with `handled: false` puts it back. Marking one done also marks it read in its mailbox, in the background, and that is audited too; a mailbox that cannot be reached does not undo the mark.

`snooze` is the web view's "Remind me" ([Later](web-view.md#later)): "not now, remind me at nine on Monday". `until` is an ISO 8601 time with its offset and seconds, written in the owner's own time zone (for example `2026-11-16T09:00:00+08:00`), still to come and at most a year ahead. The tool's description names the server's time zone (`TZ`, Asia/Shanghai in the compose file) so an assistant has a zone to start from, and the answer adds `snoozedUntilLocal`, the same time on the server's clock. A time without an offset is refused by the argument schema, and one in the past or further off with `INVALID_ARGUMENT` (`snoozePast`, `snoozeFar`). The message leaves `needs_you` at once. From that minute it is back in it for 30 days, whatever it was judged, since the owner asked to be reminded, and every device with the web view's notifications on is told ("Reminder: <sender>"). Putting off a message that was marked done puts it back, since a reminder is for what is not done. `until: "now"` brings it back at once, as the page's "Back now" does: its reminder counts as having come, so it is in `needs_you` whatever it was judged and however long ago it arrived, and no device is notified, since the owner is the one asking. `until: null` cancels the reminder instead and leaves the message to its judgement: it is in `needs_you` only if it was judged to matter (critical or notified) and arrived within the last 30 days, and otherwise only in the list (`list_mail` with `hours`, or `search_mail`, reaches older mail). The answer's `inNeedsYou` says where it is. A message put off is not notified as new mail before its time, on any output, even when it is judged again meanwhile; a notification that was waiting for a retry, or that a late verdict calls for, goes out on Feishu or the webhook at the time chosen (sooner if the time is moved sooner, at once if the reminder is cancelled, never after "now"), and one for a message marked done is dropped. `recovery_status` marks such a waiting notification with `heldUntil`, and the health counts leave it out of what is waiting to be delivered. It changes nothing in the mailbox. `needs_you` with `includeSnoozed: true` adds `snoozed`, what is put off and still to come, soonest first, each with its `snoozedUntil` (the first 50; `snoozedCount` says how many in all); every record carries `snoozedUntil` (null when no reminder was asked for), and in `needs_you` a past one says the message is there because a reminder brought it back.

`send_mail` is the composer. With `replyTo` (a stored Message-ID) the answer leaves from the mailbox that received the original and continues its thread. Where `to` is left out it goes to whoever the original asks answers to, or to its sender when the original asks for answers only at your own address. Where the message names no sender and no reply address, or is from your own address (which a sender can forge, and where the page's composer would continue it to everyone it went to), `send_mail` refuses until `to` is given, and with `to` given and `replyAll` the others are copied. Where `cc` is left out, `replyAll: true` puts the other recipients in copy (never your own addresses, and nobody twice). The subject is "Re:" the original's, and the original is quoted below the text unless `quote: false`. If the original can no longer be read from its mailbox, an answer still goes when `to` and `quote: false` are given (and `cc` too with `replyAll`, since who else it went to cannot be read either). With `account` instead of `replyTo` it sends a new message from that mailbox. Text is plain text, and the mailbox's signature goes under it (after the standard `-- ` line, above any quote or forwarded message) unless `signature: false`. Afterwards, as in the page, a copy is filed in Sent where the provider does not file one itself (`savedCopy` says whether one is there), the original is marked answered and counted as dealt with, and the audit has a row saying that a message left, from where and when, without its recipients or its text. The letter itself is stored for its conversation, as in the page (see [Your own mail](#your-own-mail)). A `note` in the result says something about where it went: an answer addressed for the caller to a Reply-To on another domain than the sender's, or with no sender address to compare it with (`prepare_reply` shows the same as `replyToElsewhere`, and where `to` came from as `addressedTo`), or an original that could not be quoted.

With `forward` (a stored Message-ID) and `to`, which a forward always needs, `send_mail` passes the message on: the subject is "Fwd:" the original's unless one is given, and under the text and the signature comes the forwarded block `prepare_forward` shows (who it was from, when, its subject, who it went to, then its text). A forward starts a conversation of its own, so it carries no `In-Reply-To` or `References`, and the original is counted as dealt with but not marked answered, unless every recipient (`to`, `cc` and `bcc`) is one of your own mailboxes: a message forwarded from home to work, to deal with it there, stays in `needs_you`, since the copy that arrives at work is ruled a forwarded copy and not put before you again. `originalHandled` in the result says which, and the page follows the same answer. It leaves from the mailbox that received the original unless `from` (an address from `list_accounts`) names another of your mailboxes, as the page's From picker does, and then it carries that mailbox's signature; `account` only picks the copy when one message is stored for more than one mailbox. `text` may be empty for a forward, as in the page, and the letter then starts with the signature or the forwarded block; anything else needs words of its own. `includeAttachments` sends the original's attachments with it: `true` (the default) for what the page sends by default, every file but the pictures of the original's body; a list of part ids from `prepare_forward` for exactly those, pictures included when named; `false` or `[]` for none. A picture of the body (`inline: true` in `prepare_forward`) is an image sent inline whose Content-ID the original's markup shows: a logo, an icon, a portrait in a signature, which a plain-text forward would otherwise carry by the dozen as files nobody chose. Anything else sent inline is a file like the rest; Apple Mail sends a PDF or a photo that way. A part that holds other parts rather than being one file (a Mac file sent as `multipart/appledouble`) cannot be forwarded: `prepare_forward` lists it under `notForwardable`, and naming it is refused. The server reads each file from the mailbox as it sends, holds the whole letter to `SMTP_ATTACHMENT_MAX_BYTES` (20 MiB by default) and twenty files, and sends nothing if one of them cannot be read: `NOT_FOUND` or `MAILBOX_UNAVAILABLE` with `forward_attachment_unavailable` naming the file. Where the original cannot be read for its files when the forward is sent, nothing is sent either and no file is named: `forward_original_gone` (`NOT_FOUND`) when it was moved or deleted in its mailbox or no longer has that file, so find it again and forward it from there, and `forward_original_unavailable` (`MAILBOX_UNAVAILABLE`) when its mailbox did not list its attachments, so try again. Where the original's attachments cannot be listed at all, a forward that asked for any of them is refused rather than sent with fewer, as the page asks before it sends one without them. Each file goes as the sender attached it, byte for byte, and a text file keeps the character set it was labelled with. This is the only way a file leaves through MCP: by reference to a stored message's own attachments. Nothing can be uploaded, and the result names the files that went.

`set_signature` sets the signature of one mailbox (`account` and `text`, plain text of at most 2,000 characters; empty text removes it). It is the one the page's composer shows under a letter from that mailbox and lets the owner edit, so a change made here is a change there. Only that it changed, and for which mailbox, is audited, never what it says. `list_accounts`, `prepare_reply` and `prepare_forward` show signatures only to a caller holding the write credential, as the page shows them only to a session that may send.

One letter is sent once. A letter's name is what the caller called it (`id`, optional) bound to what it says and who it goes to, as the page names its own, so the same request repeated within fifteen minutes is answered with `repeated: true`, a `notice`, and the same account of the first attempt (mailbox, recipients, any `note`) instead of a second copy; a name reused for a different letter does not answer for the first. A repeat that arrives while the first attempt is still running waits for it as long as that attempt may take (a forward's reading of its files included, and its files' time to travel), as the page's own repeat does, so a letter still on its way is never called unconfirmed. When the mail server did not confirm a message, the answer is `PROVIDER_ERROR` with `send_timeout`: the message may have left, and the same request again gets the same answer without another attempt, until what became of the attempt is known. Then a repeat is answered with that: the letter left, or it failed before it was handed over and is sent. A different `id` sends it after all, once the owner has looked in Sent. That memory is the running process's: a restart forgets it. A call the client walks away from still runs to its end, and what it did is still recorded.

Set `MCP_WRITE_TOKEN` to a second secret that differs from `MCP_TOKEN`; reusing one value for both is refused at startup. Present it as the bearer token to get the full surface. `MCP_TOKEN` then stays a read-only credential, which is what any shared client should hold. Over stdio the caller can already read the env file, so setting `MCP_WRITE_TOKEN` alone enables the write tools there without a second presentation.

One message can be stored once per monitored mailbox (a forwarded copy, or a message sent to two of them). `manage_mail`, `mark_handled`, `snooze`, `record_feedback`, `read_message`, `prepare_reply`, `prepare_forward`, and `send_mail` with `replyTo` or `forward` take an optional `account`, and refuse an ambiguous id without one, naming the mailboxes, rather than acting on whichever copy was stored first. `get_mail` returns the first stored copy, lists the others under `storedFor`, and takes `account` to pick one. These tools take Message-IDs, as `list_mail` shows them, a record's key (`dedupKey`), and live handles (see [The rest of the mailbox, live](#the-rest-of-the-mailbox-live)). A sender can write a Message-ID that spells another record's key; a string that is both one record's key and another message's Message-ID is refused with `INVALID_ARGUMENT` rather than guessed, and each record is then reached by a name only it has. A string shaped like a key (an email address, `|`, the rest) only ever names a record by its key, so a key whose record is gone is not found rather than taken as a look-alike's Message-ID.

What stays with the page: its own assistant (asking a question across your mail, drafting a reply), since an MCP client is itself the model that would do that; notifications to installed copies of the page, which belong to a browser; and attaching a file from your own device, which only the page can read. Everything else a letter can be in the page, it can be through `send_mail`: an answer, a forward from any of your mailboxes with any of the original's files, Bcc, and the signature or none.

`record_feedback` records `false_positive`, `missed`, `handled`, and `correct` labels for later rule and triage evaluation. Two `missed` or two `false_positive` records for one sender become a rule; see [Configuration](configuration.md#your-own-rules). The `handled` label also takes the message out of the queue, but it cannot put one back: `mark_handled` is the tool for the queue.

## Attachments

`list_attachments` takes a configured account and a Message-ID or live handle, and returns MIME metadata plus a `mailsift://imap/.../attachment/{partId}` resource URI for each file. Read the resource to fetch that one file from IMAP. The web view also lists and downloads attachments from a message's detail panel. Reads use a read-only mailbox lock; attachment bytes are never stored. New triage records keep only a bounded manifest of names, MIME types, part IDs, and reported sizes.

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

Every tool and live resource call is audited by name, outcome, caller fingerprint, and (where useful) a bounded account/message/part target; rejected authentication attempts are included. What the web view does is recorded the same way: its mailbox actions and each message it sends (as `send`, without recipients or text) in the mailbox-action audit, and marking done, putting off, feedback, questions, drafts and notification subscriptions as `web:*` rows in the access audit. `list_audit` returns recent rows and mailbox-action audit, and `observability` groups the access audit by tool. Credentials, message bodies, and URL query strings are never stored in the audit.
