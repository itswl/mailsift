# Web view

`WEB_UI_ENABLED=true` serves mailsift's own mail client at `http://<host>:<MCP_PORT>/`, on the same port and behind the same tokens as MCP, because it is the same trust boundary.

It is a mail client built around the triage rather than around a folder list. It opens on what needs you, shows each message as it was sent, and lets you deal with it there: mark it done, file it, answer it, or ask a question across everything that was judged.

It is off by default. A page a browser can reach is a wider surface than a JSON-RPC endpoint, so enable it deliberately, keep the port on loopback (`MCP_PUBLIC_HOST` in Docker, `MCP_BIND` otherwise), and put TLS in front of it if you reach it from a phone. Notifications, the installed app and offline opening all need HTTPS.

- [Signing in, and what a session may do](#signing-in-and-what-a-session-may-do)
- [What needs you](#what-needs-you)
- [The list](#the-list)
- [Verification codes](#verification-codes)
- [Reading a message](#reading-a-message)
- [The conversation, and your own mail](#the-conversation-and-your-own-mail)
- [The whole mailbox](#the-whole-mailbox)
- [Acting on a message](#acting-on-a-message)
- [Many at once](#many-at-once)
- [Correcting a judgement](#correcting-a-judgement)
- [Writing](#writing)
- [Asking](#asking)
- [Live updates](#live-updates)
- [Notifications](#notifications)
- [Keyboard and the command palette](#keyboard-and-the-command-palette)
- [Mailboxes that cannot be read](#mailboxes-that-cannot-be-read)
- [Refreshing](#refreshing)
- [Theme and language](#theme-and-language)
- [Installing, and opening offline](#installing-and-opening-offline)
- [How the page is protected](#how-the-page-is-protected)
- [Behind a reverse proxy](#behind-a-reverse-proxy)

## Signing in, and what a session may do

Signing in posts a token and exchanges it for an `HttpOnly` cookie that lasts six months and is renewed on each visit, so a browser in regular use is never asked again. The form carries an account field so a password manager will offer to save the token. An installed app keeps its own cookies on iOS, so expect to sign in once inside it even if the browser is already signed in.

Which token you sign in with decides what the page may do, the same split MCP makes between its two credentials:

| | `MCP_TOKEN` (read) | `MCP_WRITE_TOKEN` (write) |
|---|---|---|
| Read the list, a message, attachments | yes | yes |
| Open any folder, search the mailbox | yes | yes |
| Search, ask a question, get notifications | yes | yes |
| Mark done, put off until later | only when no write token is configured | yes |
| Archive, bin, star, mark read, move to any folder, spam and not spam | no | yes |
| The same to many messages at once | no (done and later: as above) | yes |
| Reply, forward and send; change a signature | no | yes |
| Correct a judgement, draft with the model | no | yes |

With `MCP_WRITE_TOKEN` unset the page reads and never touches a mailbox; the one credential may still tick things off, because that is the page's own bookkeeping and the credential is the owner's. Once a write token exists, the read token is strictly read-only, so it can be given to something that should only look. The footer says which kind of session this is, and `/signin` signs in again with the other token without signing out first.

Pressing an action a session may not take explains this instead of failing.

## What needs you

The page opens on a queue: the mail that was judged to matter (critical, or pushed) and that nobody has dealt with yet, most pressing first. A deadline that has passed or falls within three days comes first, then a reminder that came back in the last day (see [Later](#later)), then what was judged critical, then other deadlines this week, then the rest, newest first. The first sentence of the page counts it, and the number is also the badge on the installed app's icon.

Each row has a ring. Pressing it, swiping the row to the right on a phone, or `e` on a desk marks the message done: it leaves the queue at once, and a toast offers Undo. With a write session the message is also marked read in its mailbox, so "done" here is done there. Archiving, binning, answering and forwarding a message count as dealing with it too.

Answering a message from your phone's mail app, or any other client, counts as well. The poll reads each mailbox's Sent folder (see [The conversation, and your own mail](#the-conversation-and-your-own-mail)), and a reply found there takes the message it answers off the queue: the message it names in In-Reply-To (else the last of its References), in the same mailbox, that is in the queue or put off. A reply that went only to your own addresses does not count, as a forward to your own mailboxes does not. Your own decisions come first: a message you put back, put off, or whose reminder you moved or took away is taken off only by a reply written after that, never by one from before (decisions made before this version are read from the audit). A message judged warning or critical that arrives already answered (the reply was sent before mailsift saw the message) is stored as done and never notified, by any output or on any device; one that would have been notified is not listed in the digest either. So is a message answered while it waits for a verdict after an LLM outage or for a notification that could not be delivered yet, and so is one you mark done while its notification waits. Such a message reads "dealt with before notified" in the list and "not notified: you had already answered it or marked it done" under the message, and its judgement is asked about as a notified one's is. It is listed under Done like anything else, so it can be put back, and comes back to the queue when it is, as a notified message would; the mail-action audit says `handled` by `sent-folder` when a reply did it. A notification delivered late, on a retry, marks the message notified as one delivered at once does. Each reply is held against the queue once: a message you put back is not taken off again by the same reply.

Done moves nothing and deletes nothing, and there is a way back after the toast is gone. Under the queue a line reads "Done · 3": it opens what was dealt with in the last seven days, most recent first, including mail older than the list below is showing. A done row carries a check where its ring was, here and in the list, and pressing the check (or `e`, or "Not done" under the open message) puts the message back; one that was judged to matter returns to the queue.

Verification codes and sign-in links never enter the queue by themselves, since they expire in minutes, and neither do mailsift's own health alerts or digests; one you put off comes back like anything else (see [Later](#later)). The queue starts on the day this version is first run, so an upgrade does not present a month of old mail as unfinished, and it looks back at most thirty days.

### Later

A message that needs you, but not now, can be put off. "Remind me" under the open message (beside the star on a desk, under "more" on a phone), `b` on a desk, or the clock on a row that is already put off, opens a small panel of times under it, in this device's own time, each with the time it means:

| Choice | When | Offered |
|---|---|---|
| Later today | three hours on, rounded up to the next quarter hour | until 20:00, not when it would be before 07:00, and not when it would be no sooner than this evening |
| This evening | 19:00 | until 17:00 |
| Tomorrow morning | 09:00 tomorrow; before 05:00, 09:00 today, called "This morning" | always |
| Next week | 09:00 on Monday | unless that is the morning already offered |
| Pick a date and time | any minute still to come, within a year | always |

The message leaves the queue at once, the reader closes on a phone as it does for Done, and a toast says when it comes back ("Reminder set for tomorrow 09:00") and offers Undo. Under the queue, beside "Done · 3", a line reads "Later · 2": it opens what is put off, soonest first. A message that is put off carries a clock where its ring was, and its line of details says when it comes back ("reminder tomorrow 09:00"), here and anywhere else in the list. Pressing the clock opens the times again, with "Back now" first. The times are listed soonest first, and a time within the coming week is named by its weekday, a later one by its date (with the year when it is in another).

At its time the message comes back to the queue, whatever it was judged, since you asked to be reminded of it; its line of details says "reminder". The queue's thirty days are counted from the reminder, not from the day the message came. Every device with notifications on is told, whatever it chose to hear (see [Notifications](#notifications)). Open pages bring it back on its minute, and one without the live line within the minute after.

Putting off is the queue's own note, like Done: nothing changes in the mailbox. A reminder is for what is not done, so the page offers it for a message that is not done, and MCP's `snooze` puts back a message marked done when asked to remind of it; one marked done after it was put off keeps its time but is no longer listed under Later, and nobody is reminded of it. "Back now" brings the message back as if its time had come: it is in the queue whatever it was judged and however long ago it arrived, with "reminder" in its details, and no device is notified, since you are the one who asked; a toast offers Undo while the old time is still to come. Undo after putting off a message puts back what it had: no reminder for one that had none, the earlier time while that is still to come, and for a reminder that had already come, the message back in the queue. Putting off is open to the sessions that may mark mail done, and recorded in the audit as `web:snooze`, `web:wake` (Back now) and `web:unsnooze` (a reminder taken away by Undo).

## The list

Under the queue is everything that arrived, grouped by day: sender, the model's one-line summary, level and category, the deadline when there is one, and for critical mail the reason it was judged so. A status line says where the mail came from and when the mailboxes were last checked.

Filters (window, level, category, mailbox, spam only, notified only, codes only, messages or threads) and the search live in one form and are mirrored to the URL, so a reload or a shared link restores the view. The codes-only filter also lists verification emails whose code could not be extracted.

The threads view groups the list by conversation. A thread's count includes your own messages in it from the same window, and its line of details says how many are yours ("2 from you") or, when the latest word in it is yours, "you replied last". The list itself stays the mail you received in the window: a conversation that so far holds only your own messages is not in it, and your sent mail is never in the queue, the search or the digest.

The queue behind the next digest is listed at the end with the hour it will be sent, and the digest that last went out stays under it for 18 hours. Every entry in either opens its message, and every message links out to the provider's own client.

## Verification codes

A verification code is the most frequent reason to open the page, so it is never a sentence to read: the digits are set large in the row and are themselves the copy button. A code that arrived in the last ten minutes is lifted above the list with its sender and age, and `/?focus=code`, one of the two home-screen shortcuts the manifest offers next to `/?importance=critical`, lands on it. Codes older than fifteen minutes go grey, so a stale one is recognisable before it is pasted.

The shortcut is usually pressed right after asking a site for a code, before it has arrived. With no fresh code to show, the lane says it is waiting and watches for up to three minutes, and asks for one immediate poll through the same rate-limited path as the refresh button, so a code filed to spam is not left for the next interval. The code slides in already focused, unless you are busy elsewhere on the page; the status line then says it came. If nothing comes, the status line says no new code arrived.

## Reading a message

Tapping a message opens it in a sheet over the list on a phone, and in a pane beside the list from 900px up. The sheet closes with its close button, a drag on its handle, Escape or the system back gesture; the arrows in its header, or `j` and `k`, step to the next and previous message without going back to the list.

The message is read live from the mailbox, under a read-only lock, so opening it here does not mark it read there. Nothing of it is written to disk; a copy is kept in memory for ten minutes so that answering it does not fetch it twice. The reader keeps one connection per mailbox, made when the page is opened and kept for ten minutes after its last use, so the text, the attachment list and a download are three requests on one connection rather than three sign-ins. When a provider is slow to sign in, further attempts are started beside the first two seconds apart and whichever gets through is used; when none does, the page says so within about fifteen seconds. Each message's place in its folder (its UID, and the folder's UIDVALIDITY) is kept beside its record, from the poll that first saw it or from the first time it is opened, so a message is fetched directly and checked against its Message-ID rather than searched for; it is searched for only when it is no longer there. That matters most on QQ, whose search for one Message-ID answers with nothing or with the whole folder. A message too large to fetch whole (over `MCP_LIVE_SOURCE_BYTES`, 5 MB by default, which means a large attachment) is read as its headers and its text alone, so it opens and can be answered like any other.

It is shown as the sender laid it out, and three layers keep that safe:

1. **Rebuilt, not filtered.** The page parses the HTML and builds a new document from an allowlist of elements and attributes. Scripts, forms, frames, embedded objects, SVG and remote stylesheets are never copied across; a link keeps only an `http`, `https`, `mailto` or `tel` address and always opens in a new tab with no referrer.
2. **Sandboxed.** The result is drawn in a frame with its own content policy in which no script runs and nothing loads except images, and those only when asked.
3. **Disclosed.** What the message tried to do is said above it, in the page's own words where no styling inside the message can reach.

That third layer is where the reader's judgement comes in:

- **Remote images are held** until you ask, per message. Each one leaves a box of its own size with its description. A sender can be remembered so their images always load, but only when the mailbox's own server vouched for that sender (see below): anyone can write a From line.
- **Tracking pixels are dropped**, never loaded even with images on, and counted.
- **A link whose text names one site and whose address is another** is marked beside the link and listed above the message as `shown → real`. Hovering any link shows where it really goes.
- **The sender's authentication** is shown under the sender's name when the mailbox's provider reported one: "Verified sender · example.com" when the provider says DMARC passed, a warning when it says DMARC failed. Where the provider reports no DMARC result, a DKIM signature counts only if it was made by the From domain itself or a domain above it. mailsift verifies nothing itself. It reads the first `Authentication-Results` header, and believes it only when it names the server your mailbox is actually on, since a sender can write that header too. Gmail, Outlook, Yahoo, iCloud, Fastmail and QQ (`imap.qq.com`) are recognised; for any other provider set `MAIL_ACCOUNT_N_AUTHSERV_ID` to what its receiving server calls itself (the first word after `Authentication-Results:` in a message you received), and until then no verdict is shown rather than a forgeable one.

A message designed for a light page keeps its paper in the dark theme; one that sets no colours takes the page's own. A layout wider than the screen is scaled to fit, with a switch to its actual size. "Plain text" shows the words alone, quoted history is folded under the reply it belongs to, and a `List-Unsubscribe` address is offered as a link, which nothing requests until you press it.

Attachments are listed with download and a bounded local scan, images open in a viewer, and the spam and safety clues are a tap away (see [MCP](mcp.md#attachments) for their limits). Files are downloaded on request and never cached or kept by mailsift.

## The conversation, and your own mail

Under a message, below its attachments and safety clues, is the rest of its conversation when there is any: a short timeline, oldest first, of the messages in its thread that mailsift has stored, with the one you are reading marked "This message". A message you received opens as itself, with its own text and actions. One of yours is marked "You" (我), with whom it went to, when, and its first lines; pressing it opens it in place to the text you wrote, with its recipients (Bcc included) and the names of its files. Nothing is shown when the thread holds only this message. The timeline is read from mailsift's own store, never from the mailbox, and is drawn after the message itself, under everything, so it never moves what is already on the screen. It shows at most fifty messages: the one you are reading and the newest of the rest, and says how many more the conversation holds. When an older message is opened, a quiet line under it says how many messages after it are not shown, since a reply to it may be among them. A copy of one of your own messages that came back into the mailbox (a mailing list sending your post back to you, a Bcc to yourself) is shown once, as yours, and counts once in a thread. The timeline is drawn again when something in it changes, and only then, so a keyboard or screen-reader user on it keeps their place.

Your own messages come from two places:

- **What you send from here**, or through MCP's `send_mail`, is stored the moment it leaves, with its exact Message-ID, recipients (Bcc included) and text, so the reply is in the conversation at once, before any poll.
- **Each mailbox's Sent folder**, which the poll reads after the folders it monitors, so a reply sent from your phone or another computer joins the conversation too and takes what it answered off the queue (see [What needs you](#what-needs-you)). The Sent folder is found the way a reply is filed (the server's `\Sent` flag, then the usual names); a mailbox without one is normal. The first time, the poll looks back `SENT_LOOKBACK_DAYS` (30 by default; `0` for no look back at all), newest first and at most 500 messages, over as many polls as that takes; after that it reads what is new. A server that refuses the search is asked again on the next poll rather than taken for an empty folder; while it refuses to search the look back, new mail is still read, and a lasting refusal is logged once. Setting `SENT_LOOKBACK_DAYS` to `0` or lower later also stops or shortens a look back already under way. It has a cursor of its own, separate from any you have on the same folder as a monitored one, and a budget of its own of 50 messages per mailbox per poll, outside `MAX_MESSAGES_PER_POLL_TOTAL`. Of each message it reads the envelope, the References line and the first 64 KB of the message: enough for the text, never a whole attachment. A Sent folder that cannot be read is logged and read again next time; it never makes a mailbox look unhealthy, and nothing in it is a dead letter.

What is kept of a sent message is what a conversation shows: who it went to, its subject and date, the names of its files, and the text you wrote, without the quoted history below it (an "On … wrote:" or "在 … 写道：" line, an Outlook header block, a message forwarded under it, and lines quoted with `>`), at most 8,000 characters. It is stored locally in the state database like the snippets of the mail you receive, kept for `STATE_RETENTION_DAYS` counted from the day it was sent, and used for the conversation only: it is never judged, never sent to the model, never notified and never in a digest, the queue, the list or the search. `SENT_MAIL_ENABLED=false` stops reading Sent and storing what is sent from here; what was stored before stays until retention removes it.

## The whole mailbox

Everything above is what mailsift fetched and judged: the folders it watches, as far back as `STATE_RETENTION_DAYS`. The rest of each mailbox is a tap away, read from the mailbox when it is asked for and kept nowhere.

- **Folders.** The folder button beside the window (or `g`, or "Folders…" in the palette) opens a small panel under it with the mailbox's folders: the ones every mailbox has first (Inbox, Starred, Drafts, Sent, Archive or All Mail, Spam, Trash), called that in the page's language wherever the server keeps them, then your own, each under its parent. Each says how many of its messages are unread, or how many it holds, when the server says so cheaply: in its folder list where it can (`LIST-STATUS`), and otherwise by asking each folder in turn for a few seconds, the rest without a count. A long list has a box to find a folder by part of its name, and with more than one mailbox a switch at the top picks which. A folder the palette has seen once is in it by name.
- **A folder** takes the list's place, newest first, fifty at a time as you scroll. The line above it names the mailbox and the folder (press it to pick another) and says "Live from the mailbox, not triaged", with how many messages the folder holds; the arrow before it goes back to the triaged views, as do `Esc` and the back gesture. The window and the filters, which are the triaged views', are not shown meanwhile. Each row is what the mailbox says: the sender, the subject, the date, a dot and a heavier name while it is unread, and whether it is starred, answered or carries files. Only the messages' envelopes and flags are read, never a body, and nothing of it is stored, judged or put in the queue; nothing of it goes to the model unless you ask, with Draft with AI (see [Writing](#writing)). A message mailsift did store is the same row as in the triaged list, with its ring, its check or its clock, so it can be marked done or put off from here, and its line of details says how it was judged. It is that record only where the record says it is: in the same mailbox and folder and, when mailsift knows it, at the same UID in the same version of the folder (its UIDVALIDITY); for a record with no UID known, from the same sender as well, and the listing then remembers its UID, so the match holds after a restart too. A message without a Message-ID is matched by its place alone. Another message with the same Message-ID (your copy in Sent, a copy in another folder, or a look-alike someone sent with a borrowed Message-ID) is a message of its own: it is listed without the record's judgement, and reading it, acting on it or putting it in spam leaves the record, its place and its sender alone.
- **Reading** a message from a folder is the same reader as anywhere: its text, its pictures (held until asked), its attachments and safety clues, Reply, Reply all and Forward. What exists only for mail mailsift stored (the summary, the judgement and the way to correct it, Done, Remind me, the conversation) is left out for a message it never stored. Archive is not offered in the archive or in All Mail, nor Bin in the bin.
- **Search the mailbox.** The search field searches what mailsift stored, as before. With a query in it, a quiet line at the end of the list offers "Search the mailbox" (one name per mailbox when there are several and no mailbox is picked in the filters), so typing never moves the list: the provider's own search, in the inbox and the archive. Gmail searches All Mail in its own syntax, so what works in its search box (`from:`, `has:attachment`, `older_than:1y`) works here; other servers are asked for the words in the subject, the sender and the text, in UTF-8 where the words need it. In a folder, the field searches that folder when Enter is pressed, and clearing it goes back to the folder. Results are listed like a folder, newest first, with how many were found.
- **QQ, and searches that cannot be trusted.** QQ's IMAP search answers some searches with the wrong messages and ignores Chinese on some accounts. So on QQ, and wherever a server refuses a search or finds nothing for text outside ASCII, the newest 2,000 messages of each folder searched are read envelope by envelope and only their subject and sender compared. The line above the results then says, every time, that only the subject and sender of the newest 2,000 messages in each folder were searched. A search that takes too long (25 seconds on the mailbox, 30 in all) is stopped and said to be slow, with the way to make it quicker (other words, or one folder), not that the provider is down; a new search from the same tab takes the place of one still running (another tab's searches are its own). A search runs on a connection of its own, so reading a message or acting on one never waits behind it. A mailbox has at most two such connections, since providers limit how many sessions an account may have and the listeners, the poll and the reader use some already; a third search waits for one. A new one signs in in turn with the mailbox's other sign-ins, and the last one is kept for 15 seconds, so the next page of results does not sign in again. A search stopped, replaced or left (the tab closed or gone elsewhere) has its connection closed at once, even in the middle of signing in. When a limited search finds nothing, the line above the list says what was read (in "this folder" when one folder was searched), and the list says only that no subject or sender matches.

A message listed this way is named by a live handle: its mailbox, folder, the folder's UIDVALIDITY, its UID and its Message-ID, signed by this server with a key kept in the state database, so text a sender wrote (a Message-ID that starts `live:`) can never pass for one. A Message-ID too long to carry (any sender can write one) is carried as its SHA-256 digest, so every message listed can be opened and acted on. Whatever is done with it is done exactly there. Every time, the server checks that the mailbox is configured, the folder still exists and has not been rebuilt, and (under the lock it acts in, for an action) that the message at that UID still has that Message-ID; when it does not, the request is refused rather than sent looking for the message elsewhere, and the page lists the folder again. Where the server says where a moved message landed, the answer gives its new handle.

The address keeps the folder or the search on show (`?in=` the mailbox, `&folder=`, and `&mq=` for a search), so a reload or a shared link comes back to it, over the triaged view: Back, or closing a panel, stays in mailsift. A reload, or the installed app coming back, adds nothing to the history. The access audit records which mailbox and folder were listed or searched (`web:folders`, `web:folder`, `web:search`), never what was searched for.

## Acting on a message

With a write session the bar under a message offers Done, Reply, Archive, and under "more": Reply all, Forward, Remind me (see [Later](#later)), Star, Mark unread, Move to…, Spam (Not spam for a message in the spam folder) and Bin. On a desk, Reply all, Star and Remind me sit in the bar itself.

Each action is applied in the mailbox itself, to the message found by its Message-ID, and recorded in the same audit table the MCP write tools use. A stored message is looked for first where mailsift last saw it; found anywhere else, a message with its Message-ID is it only when it is from the same sender. So once the real one has been moved or deleted with another mail client, a look-alike that borrowed its Message-ID (in the inbox, or in spam) is not opened, answered or acted on in its name: the message is said to be no longer where it was filed, and the record stays as it was. Its books (where it is, whether it is done) follow only its own message. Archive and Bin go to the folder the server marks for that purpose (the special-use flag, then the well-known names); a mailbox that has no such folder is told so rather than given a new one. On Gmail, archiving removes the message from the inbox and leaves it in All Mail. The page follows a message to its new folder, so it can still be opened, answered, or brought back afterwards.

**Move to…** opens the folder panel under the control that asked for it, to pick where the message goes: the folders you moved mail to lately first (kept in this browser, five per mailbox), then the rest of its mailbox, with the box to find one by name, and without the folder it is in. A message moves within its own mailbox.

**Spam** moves a message into its mailbox's spam folder (the server's `\Junk` flag, then the usual names) and counts it as dealt with; **Not spam**, offered for a message in the spam folder, moves it to the inbox. Either is also a judgement, recorded as feedback (`spam`, `not_spam`) the triage learns from: two of one sender's messages put in spam make that sender's mail low priority from then on, as two corrections of a notification do (see [Correcting a judgement](#correcting-a-judgement)), until you take one of that sender's messages out of spam again. Not spam also undoes what Spam did to the queue: a message Spam counted as dealt with is open again, while one you had marked done before stays done. When a vote makes a sender's mail low priority, the line that says what happened says so. A mailbox with no spam folder says so, and nothing is moved.

A message mailsift never stored that you move (Move to…, Archive, Bin, Inbox, Spam or Not spam) is written down as filed by you where it lands, under the name the poll would give it there. When it lands in a folder mailsift watches (Not spam into the inbox, say), the poll leaves it alone: you have just dealt with it, so it is not judged, notified, queued or put in a digest as new mail. The note is kept as long as the rest of the state (`STATE_RETENTION_DAYS`).

There is no permanent delete.

## Many at once

Any list can be acted on many at a time: the triaged list and the queue, a folder, the results of a search.

- **Picking.** On a desk, a box appears to the left of a row under the pointer or the keyboard; pressing it picks the row, and with Shift held picks every row between it and the last one pressed. `x` picks the row that is open. A narrow window used with a mouse makes the same room on its left for the box, so it never covers a row's ring, clock or check. On a phone, a long press on a row starts picking (the phone gives a short buzz where it can), the rows' marks become boxes, and a tap then picks or puts down a row rather than opening it.
- **The bar.** While anything is picked, a bar takes the place of the window and filters line and stays at the top as the list scrolls: how many are picked, Select all (every row the page has loaded), the way to put the selection down, and the actions. Done (or Not done, when every one picked is done), Archive and Bin are in the bar; Mark read and unread, Star and Remove star, Move to…, Spam or Not spam and Remind me are under "more". Each is offered only when at least one picked message can take it: Done and Remind me need a message mailsift stored, Move to needs messages of one mailbox. `Esc`, or the back gesture on a phone, puts the selection down before it closes anything else.
- **What happens.** At most 100 messages go at once, in one request; the server reaches each mailbox over its connection eight messages at a time, giving the connection up in between so that opening or acting on another message never waits for the whole batch, checks each message as it would one alone (a live handle exactly where it was listed), and answers for each. A message the action does not apply to (Done for one mailsift never stored, Not spam for one outside the spam folder, Spam for one already there, Remind me for one already marked done) is skipped, not failed. A line says what happened ("Archived 12 · 2 skipped"), and why, in the page's words, when none went for one reason. Messages the mailbox has not answered for when the page stops waiting are said to be still under way, not failed; they are recorded when it answers, and the list is read again shortly after. The line offers Undo for what has an Undo one at a time: Done, and Remind me, which gives each message back the reminder it had. Undo acts on the batch it undoes and on nothing else, whatever is picked when it is pressed, and on all of it, whatever the page has loaded or left since (a folder closed, the lists read again). Each message is audited as it would be alone, and the same press arriving twice is done once.
- **Keys.** With messages picked, `e`, `y`, `#`, `s` and `b` act on what is picked, as the bar does: `e` only where the bar offers Done or Not done, and `s` takes the star off when every one picked has it. `x` picks or puts down the open message.

## Correcting a judgement

## Correcting a judgement

Under every judgement is a line that asks whether it was right. "Right" records agreement; the other answer records a false positive for something that was pushed and a miss for something that was not. Two corrections of the same kind for one sender become a rule, and the page says so when your vote was the one that made it, because that changes how future mail from that sender is judged. See [Configuration](configuration.md#your-own-rules).

## Writing

Reply, Reply all, Forward and a new message (the pencil in the header, or `n`) open the composer. It is plain text on purpose: a letter does not need markup, and composing HTML would mean sanitising it on the way out.

- A reply leaves from the mailbox that received the original, addressed the way a mail client would address it: to the Reply-To address when there is one (to the sender when it names only you), never to yourself. A plain Reply to a message that names neither a usable sender nor a Reply-To is left unaddressed for you to fill, and the composer says why; Reply all goes to everyone it was sent to, and a message from your own address is continued to the people it went to, with Cc kept for Reply all. It is threaded under the original, which is quoted below what you write.
- **Forward** (`f`) passes a message on to someone it never named, so To starts empty. The subject is "Fwd:" the original's, and under what you write comes the forwarded message: a header line each for who it was from, when, its subject and who it went to (in the page's language), then its text. The original's attachments come along as chips. One taken off stays in the row, crossed out, with Put back. Pictures of the original's body (logos, icons, a portrait in a signature: images sent inline that its markup shows) are left out, since a plain-text forward would carry each as a file nobody attached: one line under the chips counts them and includes them on request. Anything else sent inline is a file with a chip like the rest, going unless taken off; Apple Mail sends a PDF or a photo that way. A part that holds other parts rather than being one file (a Mac file sent as `multipart/appledouble`) cannot be sent on as that file, and is not offered. The files are sent by reference: the server reads them from the mailbox as the forward leaves, so they never pass through the browser, and if one of them cannot be read nothing is sent and the page says which. When the original's attachments could not be listed, a line under the files says so for as long as the letter is open, and Send asks once before the forward goes without them. A forward starts a conversation of its own (it is not threaded under the original), leaves from the mailbox the original reached unless you pick another, and counts the original as dealt with without marking it answered; one sent only to your own mailboxes (from home to work, to deal with it there) leaves it in the queue, since the copy that arrives is not put before you again. It may go without a word of your own.
- A new message leaves from whichever of your mailboxes you pick.
- **Cc / Bcc** at the end of the To line shows both copy lines. Blind-copied addresses are not in the message the recipients get; the copy filed in Sent keeps them.
- **Addresses are suggested** as you type in To, Cc or Bcc, for the address at the caret, between commas or semicolons: first the people you have written to, by how often and how lately, then people who wrote to you and look like people (not spam, newsletters, notices, codes or no-reply addresses). A name matches from the start of any of its words, an address from the start of its local part, of a word in it or of its domain, in either case; a Chinese, Japanese or Korean name matches anywhere in it. The list opens under the field, over the letter rather than pushing it down. Up and Down move through it, Enter or Tab puts the highlighted address in place of what you typed, followed by a comma, and Escape closes the list and leaves the letter open; a tap or a click does the same as Enter. Enter there never sends, and the list only ever replaces the address it was drawn for: typing on narrows it at once, and moving the caret to another address closes it. Text being composed with an input method keeps its keys, and Ctrl or Cmd with Enter still sends. The bare address goes in, since that is what a letter is sent to, and an address already on the letter is not offered again.
- **Attachments**: the paperclip at the end of the subject line opens a file picker, and files or pictures pasted into the text or dropped on the composer are attached too. A pasted picture with no name of its own becomes `image-1.png`, `image-2.png` and so on, by its type. Each is a chip with its name and size and a way to take it off. A letter carries at most twenty files and `SMTP_ATTACHMENT_MAX_BYTES` (20 MiB by default) in all, the forwarded ones included; the page refuses what would go over before it sends, and says which limit. Files are read only when the letter leaves, under each file's own name without any path. The page holds them while it is open, so a letter closed and opened again still has them; they are not kept on the device, so a draft restored in a new page lists their names and says, in a line of its own under the files, which to add again until every one is back (or the draft is discarded). Pressed while some are still missing, Send says which and sends nothing; pressed again, it sends the letter without them.
- **Signature**: each mailbox has one, plain text of at most 2,000 characters, kept on the server and shown muted under the text of a letter from that mailbox. Edit (or Add a signature, while there is none) changes it in place for every letter from that mailbox; Leave out drops it from this letter only. Switching the mailbox a new message or a forward leaves from switches the signature. While the signature is open for editing, Send asks for it to be saved or cancelled first, since the letter would otherwise carry a signature that is not on show. A letter is put together as the composer shows it: your text, then `-- ` on a line of its own and the signature, then the quoted original or the forwarded message. MCP's `send_mail` signs the same way, and `set_signature` changes the same text.
- **Draft with AI** writes a first version from the message being answered and, optionally, a line from you about what to say (for a forward or a new message, from that line and the subject alone). It never sends; it fills the box, and you edit. Pressing it is asking for the text of the message being answered to go to the model, the same one, through the same endpoint and key, that triages your mail, after the same redaction (`LLM_REDACT_PII`). That holds for a message listed live that mailsift never stored too: its text reaches the model then, because you asked, and at no other time. A verification code, a sign-in link or a credential is never sent; drafting is refused for it. Each draft is audited (`web:draft`), never its text.
- What you type is kept in the browser as a draft per message (an answer and a forward of the same message are two drafts) until it is sent or discarded.
- **Send can be undone for five seconds.** The message leaves after that, and also at once if you put the page away in the meantime (a locked phone stops its timers). Closing the page outright sends it too when it is small enough to leave with the page; a larger letter, or one with files added from this device, goes back to being a draft. A forward's own files are only named in the request and read by the server, so a small forward goes with them.
- **A send is never silently repeated.** If the mail server takes longer than a minute (plus the time a letter's files take to travel, about a second for every 256 KB: there, as long again for the server to read them before it answers, and once more to Sent), or the connection drops after the message was handed over, the page says the message was not confirmed and to look in Sent first. So does a proxy in front of mailsift that stops waiting first. An upload to mailsift is given as long as the largest letter takes at about half a megabit a second; one cut off before it arrives whole sent nothing. A send that finishes late is still recorded and filed, and pressing send again on the same unchanged letter reports that it went instead of sending a second copy.
- Once sent, an answered original is marked answered in the mailbox, and an answered or forwarded one is done in the queue, unless it was forwarded only to your own mailboxes; the page follows what the server says about that. Where the provider does not file a copy in Sent by itself, mailsift appends one, with its Bcc line and its attachments.

Mail is sent over the provider's own SMTP submission server, always encrypted, signed in with the same credential that reads the mailbox. The presets cover every listed provider; a mailbox on a custom host needs `MAIL_ACCOUNT_N_SMTP_HOST`. The audit records of a sent message that one left, from which mailbox and when; never the recipients, the text or the names of its files. The message itself is kept for its conversation (see [The conversation, and your own mail](#the-conversation-and-your-own-mail)) unless `SENT_MAIL_ENABLED=false`. Changing a signature is recorded as that, for which mailbox, never what it says.

Two cases need a step first:

- **Outlook with OAuth.** Microsoft grants sending separately from reading, and mailsift asks only for reading by default. To answer from such a mailbox, authorize it again with `npm run oauth -- --account you@outlook.com --send --force` (see [Deployment](deployment.md#gmail-and-outlook-oauth)). Gmail's authorization already covers sending.
- **`SMTP_ENABLED=false`** switches sending off for every mailbox, and `DRY_RUN=true` does the same.

## Asking

When an LLM is configured for triage, the search field is also a question box: type a question and press Ask, or ask from the palette. "What do I need to pay this week?" is answered in a few sentences, each claim marked with the message it came from, and each of those opens.

The question goes to the same model, through the same endpoint and key, that already reads your mail for triage. What it is given is the question and at most forty stored judgements: date, mailbox, sender, level, category, deadline, subject and summary. No message body, no attachment name and never a verification code. Everything passes the same redaction as triage (`LLM_REDACT_PII`), and mail recognised as a code, a sign-in link or a credential is described only by the safe sentence it was stored with.

Finding the relevant judgements is done locally, by words, with no embeddings and no second service. Its known limit is a question in one language about summaries written in another.

`WEB_ASSISTANT_DAILY_LIMIT` (default `300`) caps the model calls the page makes in a day, across questions and drafts and whoever is asking.

## Live updates

The page keeps one long-lived request open (`/api/events`, server-sent events) on which the server says that the stored mail changed or that a poll finished; the page then fetches exactly that. A message appears when it is judged, not at the next minute, and a small dot on the status line shows the line is up. The stream carries no mail, only two opaque signatures.

When you have scrolled down, new mail does not push the list under your finger: a pill offers it, and the list stays where it was until you take it. Rows that arrived settle in with a tint that fades.

Without the line (a proxy that buffers, too many open pages) the page falls back to asking once a minute. The server takes at most 32 streams, 12 from one client.

## Notifications

The bell turns on Web Push for the device you are holding: a verification code on the lock screen with the code in it, and important mail the moment it is judged. Each device chooses whether it wants codes, and critical mail only or warnings too. A test button sends one now.

- Notifications are encrypted from this server to the device (RFC 8291); the push service relays them and cannot read them. The server's signing key is generated on first use and kept in the state database.
- Delivery is at most once. A code that could not be delivered is not sent late; the page still lists it.
- A notification is about mail that still needs you and has only just arrived: nothing is sent for a message already marked done, for a code fetched more than fifteen minutes ago or sent more than an hour before it was fetched, or for other mail more than a day old, so catching up after downtime does not bury a phone. Mail that was filed quietly while the LLM was down is notified when it is judged properly. A dry run notifies nobody.
- A reminder you asked for ([Later](#later)) is sent to every device with notifications on, whatever level it chose and whether or not it wants codes: "Reminder: Vendor", with the summary or the subject under it. Nothing is sent for one marked done before its time, for one brought back with "Back now", or for one that came more than a day before the service was running to send it; it is back in the queue all the same. A message put off is not notified as mail before its time, here or on Feishu or the webhook, even when it is judged again meanwhile: a notification it was owed waits for that time (and moves with it, or is dropped by Back now), and one for a message marked done meanwhile is dropped. Reminders that come together, as every "Tomorrow morning" does at 09:00, go after a fresh code, never instead of it. The time reminders were last looked for is kept in the database, so a restart neither skips a reminder nor sends one twice.
- Tapping one opens that message, or the code.
- On iPhone and iPad, notifications work only from the app installed to the Home Screen.
- The panel under the bell lists the other devices that have notifications on, and the owner can remove one, which is how a lost phone is cut off. A subscription is also tied to the token it was made under: replace `MCP_TOKEN` or `MCP_WRITE_TOKEN` and restart, and every device that subscribed under the old one stops being told.
- Subscriptions are accepted only for the push services browsers actually use (Google, Mozilla, Apple, Microsoft), because the endpoint is an address this server will post to. `WEB_PUSH_ALLOWED_HOSTS` adds others. `WEB_PUSH_ENABLED=false` removes the feature.

## Keyboard and the command palette

`⌘K` (or `Ctrl K`) opens a palette that reaches everything: any filter, any mailbox or category, a message by sender or subject, compose, check mail, copy the newest code, theme, language, and a question to the model.

| Key | Does |
|---|---|
| `j` `k` | next, previous message |
| `Enter` | open |
| `e` | done |
| `r` `a` | reply, reply all |
| `f` | forward |
| `y` | archive |
| `s` | star |
| `#` | bin |
| `b` | remind me later |
| `g` | folders |
| `x` | pick, for acting on many at once |
| `n` | new message |
| `c` | copy the newest code |
| `/` | search |
| `.` | check mail now |
| `Esc` | close |
| `?` | this list |

## Mailboxes that cannot be read

A mailbox that cannot be read says so instead of looking quiet. Once one has failed `ACCOUNT_ALERT_AFTER_FAILURES` polls in a row, a line under the status names it ("work-gmail not checked since yesterday 08:26"), and an empty list says that mail may be missing rather than that there is none.

Tapping the line lists every mailbox with its last good check and failure count, and what usually fixes that kind of failure: a refused login, an OAuth account that was never authorized on this server, folders that cannot be opened, or a server that cannot be reached. For a Gmail or Outlook OAuth account it adds the exact re-authorization command with a copy button, written for Docker when mailsift runs in a container. Notifications still waiting in the outbox are counted there too.

## Refreshing

The header's refresh button, or `.`, runs a poll immediately instead of waiting for the next interval. It scans the same folders the scheduled poll does, spam included. The status line narrates it ("Checking 2 mailboxes…", then "Checked just now · 3 new"). A press during a running poll joins it rather than opening a second set of IMAP connections, and manual presses are rate-limited per client.

The page has no pull-to-refresh of its own: in the installed app, scrolling back to the top set it off too easily.

The button appears only when the page is served by the long-running service; the standalone MCP server has no poller to trigger. Its status line still says when the mailboxes were last checked, because it reads the same database.

## Theme and language

The header carries a light/dark switch. The page starts light and does not follow the system setting. The choice is stored in the browser and applied before the body renders, so it never flashes the other theme.

Next to it is a language switch between English and Simplified Chinese. The page follows the browser's language until the switch is used; that choice is kept in a cookie, so the server renders the page, and the sign-in form before it, in that language from the first paint. Only the page's own words change. Subjects, summaries and reasons are shown as stored, in the language `LLM_OUTPUT_LANGUAGE` told the model to write.

## Installing, and opening offline

It installs to a home screen: the manifest and a maskable icon are served without a session, since a browser asks for them before it has one. The offer to install is a line in the list on a phone, and never appears inside the installed app. Installed, it opens without browser chrome, paints the status bar to match the page, and shows the length of the queue on its icon.

The page opens at once and then catches up. The browser keeps the last list it showed, so the installed app paints that immediately and replaces it when the server answers; without a connection it says so and stays readable. Two things are kept and nothing else:

- the service worker caches the page's shell (the markup and script, no mail), only when the server marks it as such, and always prefers the network;
- the page keeps a snapshot of the first page of the unfiltered list in the browser's storage, without verification codes.

Message bodies, attachments and API answers are never cached, by the worker or by any HTTP cache. Signing out removes the snapshot, the cached shell, the drafts and this device's notification subscription.

## How the page is protected

- **Tokens** are compared in constant time, and the cookie is `HttpOnly` and `SameSite=Lax`. Sign-in has a small rate budget of its own.
- **Every request that changes something is a POST, and a POST another site started is refused** (`Sec-Fetch-Site`, then `Origin`), whatever cookie came with it. That includes signing in.
- **The page runs only its own script.** Each response carries a content policy with a fresh nonce; nothing is loaded from another origin, the page cannot be framed, and a message's markup is never inserted into it (see [Reading a message](#reading-a-message)).
- **Nothing under `/api` can be loaded as an image, stylesheet or frame**, so a message shown with its images cannot use your session by naming this server as one.
- **With no token set, the server answers only to this machine's own names** (`localhost`, `127.0.0.1`, `[::1]`). An unauthenticated server is only allowed on loopback, and this is what keeps a web page elsewhere from reaching it through a host name of its own (DNS rebinding). If a proxy on the same machine forwards a public name without a token in front, list that name in `MCP_ALLOWED_HOSTS`; setting `MCP_TOKEN` is the better answer.
- **Sending is narrow.** The sender is always the mailbox's own address, every recipient is checked as one bare address before a connection is opened, nothing a request carries can add a header, and sends are rate-limited.
- **Everything that acts is on record**: mailbox actions and sent messages in the mail-action audit, the rest in the MCP audit log, keyed to a fingerprint of the caller.

## Behind a reverse proxy

Set `TRUSTED_PROXY=true`. Otherwise every request arrives from the proxy's address, the per-client limits collapse into one shared budget, and a single noisy caller can lock out your own browser and any MCP client. With it set, the limits and the audit log key on `CF-Connecting-IP`, `X-Real-IP` or the first `X-Forwarded-For` entry. Leave it off when the port is reached directly, since anyone can send those headers.

The live line is a response that never ends, so the proxy must not buffer it or cut it for being quiet. mailsift sends `X-Accel-Buffering: no`, which nginx honours, and a keep-alive every twenty seconds. If the dot on the status line never appears, turn buffering off for `/api/events` and raise the read timeout:

```nginx
location /api/events {
    proxy_pass http://127.0.0.1:8410;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

The page works without it, a minute behind.

A letter with files is one large request: up to about 28 MB with the default `SMTP_ATTACHMENT_MAX_BYTES` of 20 MiB (the files in base64, which is a third larger, and the letter), and up to about 48 MB with the 35 MiB ceiling. nginx refuses anything over 1 MB unless told otherwise, and on a slow link to the mail server the answer can take a few minutes, so give `/api/send` room for both:

```nginx
location /api/send {
    proxy_pass http://127.0.0.1:8410;
    client_max_body_size 30m;   # 48m if SMTP_ATTACHMENT_MAX_BYTES is raised to its ceiling
    proxy_read_timeout 10m;
}
```

Without it, any letter with more than about 750 KB of files is refused by the proxy before mailsift sees it, and the page says that the server in front of mailsift refused a letter that large. A proxy that stops waiting before the letter is confirmed (Cloudflare does after 100 seconds) makes the page say the message was not confirmed and to look in Sent before sending it again; pressing send again on the same letter is answered with what became of the first attempt.
