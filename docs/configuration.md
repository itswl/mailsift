# Configuration

Everything is configured in the web view, under **Settings** (the gear icon in the mail view, or `/settings`), signed in with the administrator password. The sections are Mailboxes, AI model, Notifications, Triage rules, Checking and digest, Privacy and retention, Web mail, Access and Advanced; the less common settings of a section are under its **More options**. Each field has its default as a placeholder and a line of help. This page explains what needs more than that.

A setting is named here by its section and label. The key the code reads is given in backticks where it helps, because the log and `--check` use it. How a save is applied, and which saves restart the service, is in [Deployment](deployment.md#how-saved-settings-are-applied).

- [Mailboxes and folders](#mailboxes-and-folders)
- [Sending mail](#sending-mail)
- [Your sent mail](#your-sent-mail)
- [Outputs](#outputs)
- [What gets pushed](#what-gets-pushed)
- [Your own rules](#your-own-rules)
- [Daily digest](#daily-digest)
- [Polling and limits](#polling-and-limits)
- [Real-time wake-ups with IMAP IDLE](#real-time-wake-ups-with-imap-idle)
- [Alerts](#alerts)

The AI model settings are described in [Triage](triage.md), the Access settings in [Deployment](deployment.md#signing-in) and [MCP](mcp.md#connecting), and what the web view does with the settings below in [Web view](web-view.md).

## Mailboxes and folders

Settings → Mailboxes lists the mailboxes, each marked Ready, Off, Needs sign-in, Needs password or Check settings. **Add mailbox** opens a dialog; any number can be added.

- **Provider**: a preset that knows the provider's servers. QQ Mail, Tencent Exmail, NetEase 163 and 126, Sina Mail, Alibaba Mail, Feishu Mail, Lark Mail, Gmail (Google sign-in), Gmail (app password), Outlook / Microsoft 365, iCloud Mail, Fastmail, Yahoo Mail, Zoho Mail, Yandex Mail and GMX, or **Other IMAP server**, for which you enter the server.
- **Email address** and **App password**. Most providers want an app password (or authorization code) created in their settings, with IMAP turned on, rather than your login password. Gmail (Google sign-in) and Outlook / Microsoft 365 sign in with OAuth instead; see [Deployment](deployment.md#gmail-and-outlook-sign-in).
- **Display name**: how the mailbox is named in notifications and the web view.
- **Folders to check**: **Inbox and spam** (the default), **All folders except Sent, Drafts and Trash**, which also leaves out provider-wide views such as Gmail's All Mail, or **Choose folders**, whose list appears after **Test connection**. The spam folder is found per provider and checked like the inbox.
- **Server and sending**: **IMAP server**, **IMAP port** and **Use SSL/TLS** for a server of your own; **SMTP server**, **SMTP port** and **Send as (name)** for sending (see [Sending mail](#sending-mail)); and the **Authentication-Results server ID** (see [Reading a message](web-view.md#reading-a-message)).

**Test connection** signs in once and lists the mailbox's folders. A saved password is never shown again: leave the field empty to keep it. Turning off **Check this mailbox** stops checking a mailbox without forgetting it. Deleting one stops checking it and forgets its password or OAuth record; mail on the server is not touched. From a terminal, `npm run probe` lists the folders a server offers (see [Commands](deployment.md#commands)).

Settings → Triage rules → More options → **Ignore copies forwarded between your own mailboxes** (`SUPPRESS_SELF_FORWARDS`, on by default) stops one message notifying twice when your mailboxes forward to each other. A forwarded copy is a new message with its own Message-ID, so deduplication cannot recognise it, but its sender is one of your own mailboxes. Such a copy is recorded and stays searchable through `list_mail`, but it is neither pushed nor repeated in the daily digest, since the original was already triaged at its source. It costs no LLM call either. Mail you send to yourself inside a single mailbox is unaffected, and a sender listed under **Always important senders** still wins. For the same reason a message forwarded from the web view or `send_mail` only to your own mailboxes stays in the queue where it is: the copy that arrives is not put before you again.

## Sending mail

Sending is available to the owner in the [web view](web-view.md#writing), and to an MCP client only when it presents the write token. A reply, forward, or new message leaves through the provider's own encrypted SMTP submission server, signed in with the mailbox's credential.

Every provider preset knows its server, so most mailboxes need nothing here. The exceptions:

- **A custom host** has no known submission server. Enter its **SMTP server** and **SMTP port** under the mailbox's Server and sending. Port 465 is TLS from the first byte; any other port must offer STARTTLS. There is no setting that sends a password unencrypted.
- **Outlook with OAuth** asks for permission to send when it signs in while sending is on. The Microsoft app needs the delegated `SMTP.Send` permission; see [Deployment](deployment.md#gmail-and-outlook-sign-in). Gmail's OAuth scope already covers sending.

**Send as (name)** is the name mail is sent under; without it the bare address is used. The sender is always the mailbox's own address.

Gmail, Outlook and QQ file a copy of what was sent into Sent by themselves. For every other provider mailsift appends the copy over IMAP.

Turning off Settings → Web mail → **Allow sending from the web view and MCP** (`SMTP_ENABLED`) switches sending off for every mailbox, and so does Settings → Notifications → More options → **Dry run**.

Settings → Web mail → More options → **Attachment limit per letter (bytes)** (`SMTP_ATTACHMENT_MAX_BYTES`) is how many bytes of files one message may carry, decoded, counting the files added in the web view and those a forward carries on from the original: 20 MiB (`20971520`) by default, and never more than 35 MiB however it is set. Files grow by a third when they are encoded for mail, and most providers take about 25 MB of files on a message (about 35 MB as the message travels): the default, about 28 MB as it travels, is within that, so raise it only for a provider known to take more. A message also carries at most twenty files. The web view refuses what would go over before it sends, and the server refuses it again with `send_too_large` and the limit. Behind a reverse proxy, the proxy has to accept a request of that size for `/api/send` (the files in base64 and the letter: at least `client_max_body_size 30m` in nginx for the default, `48m` for the ceiling), or it refuses the letter before mailsift sees it; see [Behind a reverse proxy](web-view.md#behind-a-reverse-proxy).

The **Authentication-Results server ID** is unrelated to sending but lives beside these settings: it names the server that receives this mailbox's mail, so the reader can tell a provider's verdict on a sender from one the sender wrote. See [Reading a message](web-view.md#reading-a-message).

## Your sent mail

Settings → Privacy and retention → **Read Sent folders into conversations** (`SENT_MAIL_ENABLED`, on by default) has the poll read each mailbox's Sent folder, after the folders it monitors, and store what you sent, so that a conversation in the web view and in MCP has both sides, a message you answered from another mail client leaves the queue, and the composer can suggest the people you write to. What is sent from the web view or through `send_mail` is stored the moment it leaves. It is one switch for every mailbox.

A sent message is stored locally, in the state database, like the snippets of the mail you receive: who it went to (Bcc included), its subject and date, the names of its files, and the text you wrote without the quoted history below it, at most 8,000 characters. It is used for the conversation only. It is never judged, never sent to the model, never notified, never in a digest, and never in the queue, the list or the search. It is removed with everything else after the retention period (**Keep triage records for**, below), counted from the day it was sent.

More options → **First look back into Sent (days)** (`SENT_LOOKBACK_DAYS`, default `30`, from 1 to 365, and never more than the retention period) is how far back the first look at a Sent folder reaches. That look reads the newest messages first, 500 at most, and spreads them over polls: each poll reads at most 50 sent messages per mailbox, new ones before the rest of the look back, on a budget of its own outside **Messages per check in total**. Of each message it reads the envelope, the References line and the first 64 KB, never a whole attachment. A mailbox without a Sent folder is normal, and one whose Sent folder cannot be read is logged and read again on the next poll; neither makes the mailbox look unhealthy.

A letter sent from mailsift is stored the moment it leaves, and its copy in Sent is the same letter: Outlook and QQ give a letter sent through them a Message-ID of their own, which is the one its recipients see and answer, so the copy is matched to the letter by mailbox, subject and recipients within a quarter of an hour and the letter is kept once, under the provider's id.

Turning it off stops reading Sent and stops storing what is sent from mailsift. What was stored before stays, and still shows in its conversations, until retention removes it; delete the rows from the `sent_mail` table to remove it sooner.

## Outputs

Settings → Notifications. External outputs are optional and can be used together. With neither, mail is still triaged and shown in the web view, and browser notifications still work, but no daily digest is sent: the digest needs a destination outside mailsift. Browser notifications are turned on per device with the bell in the mail view (see [Notifications](web-view.md#notifications)); turning off **Browser notifications** here removes the feature.

- **Feishu or Lark**: **Feishu / Lark bot webhook** is a custom bot's webhook (in the group: Group settings → Bots → Add bot → Custom bot). **Feishu signing secret** is needed only when the bot verifies signatures. **Feishu receives** (`FEISHU_MIN_IMPORTANCE`) raises the bar for Feishu alone.
- **Webhook**: **Webhook address** is the complete endpoint each push is posted to as JSON. **Webhook token**, when set, is sent as a `token` header.

**Send a test** sends a test notification with the values as typed, before they are saved.

A verification code appears in the Feishu card itself. The webhook payload only says that one arrived; see [Triage](triage.md#verification-codes-and-sign-in-links).

### Signal events

Webhook deliveries carry the `mail` / `triage` payload and a small source-neutral `signal.v1` event. It carries the triage summary and an MCP lookup reference instead of copying the raw message body. The reference can fetch a bounded normalized body from IMAP on demand without persisting it; Settings → Advanced → **MCP: body characters returned** (`MCP_LIVE_BODY_CHARS`) caps the returned body. Live lookup is read-only and bounded by the other MCP limits in Advanced (`MCP_LIVE_SOURCE_BYTES`, `MCP_LIVE_LOOKBACK_DAYS`, `MCP_LIVE_SEARCH_MAX_MESSAGES`).

The reference needs an MCP token as its bearer credential; generate one under Settings → Access → MCP. Credentials are accepted only over HTTPS or at a localhost address; see [Deployment](deployment.md#reaching-it-from-another-computer). See [signal-event-v1.md](signal-event-v1.md) for the contract.

### Delivery retries

A push that fails with a network error, a timeout, or HTTP 408/429/5xx is retried up to Settings → Notifications → More options → **Delivery attempts** times (`SINK_RETRY_ATTEMPTS`, default `3`, seconds apart) and then waits in the durable outbox. Outbox retries back off exponentially, and the backoff is kept in the database: the first waits a minute, and the wait doubles up to an hour, so a failed endpoint is not hammered on every poll. Once an endpoint has used up its retries, later pushes to it make a single attempt until one succeeds, so a dead endpoint does not stretch every poll. MCP `recovery_status` shows the next attempt time.

Only real failures wait in the outbox. An output that declines a message under its own threshold, such as **Feishu receives**, settles it immediately and the digest carries it, so a pending count in MCP `health` always means something is genuinely undelivered.

## What gets pushed

Triage rates every message `critical`, `warning` or `info`. Settings → Triage rules → **Push in real time** (`PUSH_MIN_IMPORTANCE`, default Warning and above) is the lowest level pushed in real time. Everything below it waits for the daily digest.

More options → **Importance boost for mail in spam** (`SPAM_RANK_BONUS`) lifts spam-folder mail by whole importance levels, so with the default Warning and above a boost of `1` pushes every spam-folder message: warning and critical were already above the line and info now sits on it. Leave it at `0` unless **Push in real time** is Critical only and you want spam-folder warnings to break through anyway. Catching a message wrongly filed as spam does not need it, because triage assesses spam normally and rates a real bill or code warning or critical there. The boost applies to every delivery decision, an output's own threshold such as **Feishu receives** included. `--check` warns about the combinations that deliver the whole spam folder.

## Your own rules

Settings → Triage rules → **About you** (`MAIL_CONTEXT`) is a few sentences about you that the LLM reads with every batch: who you are and what you want pushed. Leave out secrets.

**Always important senders** and **Never important senders** (`MAIL_ALWAYS_IMPORTANT`, `MAIL_NEVER_IMPORTANT`) are comma-separated sender rules: a match is marked critical or info without consulting the LLM. Sender rules take three forms: `@bank.com` matches the address domain or a subdomain of it, `alerts@bank.com` matches exactly that address, and anything else is a substring test on the address and display name. The first two ignore the display name so a look-alike domain or a crafted name cannot trigger an always-important rule.

More options → **Fallback keywords** (`MAIL_KEYWORDS`) are the keywords the local fallback looks for, on top of its built-in list, when no LLM is configured or it fails; see [Triage](triage.md#when-the-llm-fails).

Feedback becomes rules too. After two feedback records for the same sender, recorded through MCP `record_feedback` or by correcting a judgement in the web view, `missed` feedback infers an always-important rule and `false_positive` feedback infers a never-important rule. Putting a message in spam (Spam in the web view, `manage_mail` with `spam`) records `spam` feedback, which counts towards a never-important rule as `false_positive` does; taking one of that sender's messages out of spam again (`not_spam`) stops their earlier spam records counting. Rules entered in Settings take precedence; inspect inferred rules with MCP `feedback_rules`.

## Daily digest

Settings → Checking and digest → **Daily digest** (`DIGEST_ENABLED`, on by default) collects the messages below the push threshold into one message a day, sent to the Feishu bot and the webhook; with neither, no digest is sent. **The digest includes** (`DIGEST_MIN_IMPORTANCE`, default Everything) sets the lowest level it lists. `--digest-now` sends the current digest at once, and MCP `list_digest` previews it.

**Digest hour (0–23)** (`DIGEST_HOUR`, default `9`) is a whole hour in the server's time zone, **Time zone** in the same section (`TZ`): an IANA name such as `Asia/Shanghai` or `Europe/Berlin`, `Asia/Shanghai` in the published image until it is changed. The digest goes out with the first poll after that hour, once per local calendar day.

## Polling and limits

Settings → Checking and digest → **Check every (seconds)** (`POLL_INTERVAL_SECONDS`, default `300`) is the time between polls. The rest is under More options.

The first scan of a new mailbox looks back **Days looked back for a new mailbox** (`INITIAL_LOOKBACK_DAYS`, default `3`). If a fresh folder or a folder whose UIDVALIDITY changed returns more than **Backfill batch size** (`MAX_MESSAGES_PER_LOOKBACK`, default `500`) messages, mailsift processes the oldest bounded chunk and continues the backfill on later polls. It never advances past an unprocessed backlog just to avoid repeated work.

Each folder is limited to **Messages per folder per check** (`MAX_MESSAGES_PER_POLL`, default `200`). All mailboxes and folders share **Messages per check in total** (`MAX_MESSAGES_PER_POLL_TOTAL`, default `500`); reading Sent has a budget of its own (see [Your sent mail](#your-sent-mail)). When the total is reached, unprocessed folders keep their cursors and continue on the next poll. Selected UIDs are processed oldest-first so a cap does not skip older mail. **Mailboxes checked at once** (default `5`) bounds how many are polled in parallel.

Messages up to Settings → Advanced → **Largest message read whole (bytes)** (`MAX_MESSAGE_SOURCE_BYTES`, default 5 MiB) use the normal MIME parser. For larger messages, mailsift reads only the selected `text/plain` body part, falling back to HTML, so a large attachment is not pulled into triage. If that text body alone exceeds the limit, the message is recorded as a dead letter and can be inspected through `list_dead_letters`; `list_attachments` can still look up its files by account and Message-ID.

Settings → Privacy and retention → **Keep triage records for (days)** (`STATE_RETENTION_DAYS`, default `90`) is how long the state database keeps what it records about each message, and its audit; older rows are pruned once a day. It never deletes mail on the server. **Show handled mail from the last (days)** (`DONE_LIST_DAYS`, default `7`, from `1` to `365`) is how far back "Done · N" under the web view's queue, and `needs_you` with `includeDone`, reach. They list the most recent 50 and count them all. Nothing older than the retention period is kept to list; mail marked done before the window is still in the list with a longer window, and can be put back from there.

## Real-time wake-ups with IMAP IDLE

Settings → Checking and digest → **Real-time wake-ups (IMAP IDLE)** (`IMAP_IDLE_ENABLED`, off by default) keeps one read-only connection open per mailbox and folder in **Folders to listen on** (`IMAP_IDLE_FOLDERS`, default `INBOX`). When the server reports new mail, mailsift fetches that folder at once on the same connection and runs the usual deduplicate, triage, and deliver pipeline, so a wake-up costs no extra login. Some servers miss a notification now and then (QQ's does, for some deliveries), so each listening connection also asks its folder where its next UID stands (a NOOP and a STATUS on the connection already open: no new sign-in), and fetches what the server did not announce: every minute for QQ, every five minutes for other providers, whose notifications only need a safety net. More options → **Listener safety check (seconds)** (`IMAP_IDLE_CHECK_SECONDS`) sets one interval for every mailbox instead (`0` turns the check off). Polling continues as the reconciliation pass; with IDLE on, **Check every** can usually be raised to 900-1800. `npm run probe` shows whether a server advertises IDLE; mailboxes without it stay on polling. Listeners reconnect with backoff after a drop, log out cleanly on shutdown, and the MCP `health` tool reports the last wake-up per mailbox.

Folders listed to listen on must also be checked, and `all` is not accepted there.

## Alerts

mailsift reports through the Feishu bot and the webhook when it cannot do its job. With neither, these alerts are visible only in the web view's health panel and the service log; browser notifications are for mail and reminders:

- A mailbox that fails Checking and digest → More options → **Alert after failed checks in a row** (`ACCOUNT_ALERT_AFTER_FAILURES`, default `2`) raises an alert that names the kind of failure and what usually fixes it. While it keeps failing, the alert is not repeated within **Repeat a mailbox alert after (seconds)** (`ACCOUNT_ALERT_COOLDOWN_SECONDS`, default six hours), and a recovery notice follows once it works again.
- The LLM failing AI model → More options → **Alert after this many failed requests in a row** (`LLM_ALERT_AFTER_FAILURES`, default `2`) raises an outage alert, and so does the decision stage of two-stage triage; see [Triage](triage.md#when-the-llm-fails).
- A stopped process or host cannot report itself. For that, see the heartbeat in [Deployment](deployment.md#monitoring).
