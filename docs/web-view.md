# Web view

`WEB_UI_ENABLED=true` serves mailsift's own mail client at `http://<host>:<MCP_PORT>/`, on the same port and behind the same tokens as MCP, because it is the same trust boundary.

It is a mail client built around the triage rather than around a folder list. It opens on what needs you, shows each message as it was sent, and lets you deal with it there: mark it done, file it, answer it, or ask a question across everything that was judged.

It is off by default. A page a browser can reach is a wider surface than a JSON-RPC endpoint, so enable it deliberately, keep the port on loopback (`MCP_PUBLIC_HOST` in Docker, `MCP_BIND` otherwise), and put TLS in front of it if you reach it from a phone. Notifications, the installed app and offline opening all need HTTPS.

- [Signing in, and what a session may do](#signing-in-and-what-a-session-may-do)
- [What needs you](#what-needs-you)
- [The list](#the-list)
- [Verification codes](#verification-codes)
- [Reading a message](#reading-a-message)
- [Acting on a message](#acting-on-a-message)
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
| Search, ask a question, get notifications | yes | yes |
| Mark done | only when no write token is configured | yes |
| Archive, bin, star, mark read, move out of spam | no | yes |
| Reply and send | no | yes |
| Correct a judgement, draft with the model | no | yes |

With `MCP_WRITE_TOKEN` unset the page reads and never touches a mailbox; the one credential may still tick things off, because that is the page's own bookkeeping and the credential is the owner's. Once a write token exists, the read token is strictly read-only, so it can be given to something that should only look. The footer says which kind of session this is, and `/signin` signs in again with the other token without signing out first.

Pressing an action a session may not take explains this instead of failing.

## What needs you

The page opens on a queue: the mail that was judged to matter (critical, or pushed) and that nobody has dealt with yet, most pressing first. A deadline that has passed or falls within three days comes first, then what was judged critical, then other deadlines this week, then the rest, newest first. The first sentence of the page counts it, and the number is also the badge on the installed app's icon.

Each row has a ring. Pressing it, swiping the row to the right on a phone, or `e` on a desk marks the message done: it leaves the queue at once, and a toast offers Undo. With a write session the message is also marked read in its mailbox, so "done" here is done there. Archiving, binning and answering a message count as dealing with it too.

Done moves nothing and deletes nothing, and there is a way back after the toast is gone. Under the queue a line reads "Done · 3": it opens what was dealt with in the last seven days, most recent first, including mail older than the list below is showing. A done row carries a check where its ring was, here and in the list, and pressing the check (or `e`, or "Not done" under the open message) puts the message back; one that was judged to matter returns to the queue.

Verification codes and sign-in links never enter the queue, since they expire in minutes, and neither do mailsift's own health alerts or digests. The queue starts on the day this version is first run, so an upgrade does not present a month of old mail as unfinished, and it looks back at most thirty days.

## The list

Under the queue is everything that arrived, grouped by day: sender, the model's one-line summary, level and category, the deadline when there is one, and for critical mail the reason it was judged so. A status line says where the mail came from and when the mailboxes were last checked.

Filters (window, level, category, mailbox, spam only, notified only, codes only, messages or threads) and the search live in one form and are mirrored to the URL, so a reload or a shared link restores the view. The codes-only filter also lists verification emails whose code could not be extracted.

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

## Acting on a message

With a write session the bar under a message offers Done, Reply, Archive, and under "more": Reply all, Star, Mark unread, Not spam (for a message in the spam folder) and Bin.

Each action is applied in the mailbox itself, to the message found by its Message-ID, and recorded in the same audit table the MCP write tools use. Archive and Bin go to the folder the server marks for that purpose (the special-use flag, then the well-known names); a mailbox that has no such folder is told so rather than given a new one. On Gmail, archiving removes the message from the inbox and leaves it in All Mail. The page follows a message to its new folder, so it can still be opened, answered, or brought back afterwards.

There is no permanent delete, and no move to a folder of your choosing: that stays with MCP's `manage_mail`.

## Correcting a judgement

Under every judgement is a line that asks whether it was right. "Right" records agreement; the other answer records a false positive for something that was pushed and a miss for something that was not. Two corrections of the same kind for one sender become a rule, and the page says so when your vote was the one that made it, because that changes how future mail from that sender is judged. See [Configuration](configuration.md#your-own-rules).

## Writing

Reply, Reply all and a new message (the pencil in the header, or `n`) open the composer. It is plain text on purpose: a reply does not need markup, and composing HTML would mean sanitising it on the way out.

- A reply leaves from the mailbox that received the original, addressed the way a mail client would address it: to the Reply-To address when there is one (to the sender when it names only you), never to yourself. A plain Reply to a message that names neither a usable sender nor a Reply-To is left unaddressed for you to fill, and the composer says why; Reply all goes to everyone it was sent to, and a message from your own address is continued to the people it went to, with Cc kept for Reply all. It is threaded under the original, which is quoted below what you write.
- A new message leaves from whichever of your mailboxes you pick.
- **Draft with AI** writes a first version from the message being answered and, optionally, a line from you about what to say. It never sends; it fills the box, and you edit.
- What you type is kept in the browser as a draft per message until it is sent or discarded.
- **Send can be undone for five seconds.** The message leaves after that, and also at once if you close the page or put it away in the meantime (a locked phone stops its timers).
- **A send is never silently repeated.** If the mail server takes longer than a minute, or the connection drops after the message was handed over, the page says the message was not confirmed and to look in Sent first. A send that finishes late is still recorded and filed, and pressing send again on the same unchanged letter reports that it went instead of sending a second copy.
- Once sent, the original is marked answered in the mailbox and done in the queue. Where the provider does not file a copy in Sent by itself, mailsift appends one, with its Bcc line.

Mail is sent over the provider's own SMTP submission server, always encrypted, signed in with the same credential that reads the mailbox. The presets cover every listed provider; a mailbox on a custom host needs `MAIL_ACCOUNT_N_SMTP_HOST`. What is recorded about a sent message is that one left, from which mailbox and when; never the recipients or the text.

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
- Tapping one opens that message, or the code.
- On iPhone and iPad, notifications work only from the app installed to the Home Screen.
- The bell's sheet lists the other devices that have notifications on, and the owner can remove one, which is how a lost phone is cut off. A subscription is also tied to the token it was made under: replace `MCP_TOKEN` or `MCP_WRITE_TOKEN` and restart, and every device that subscribed under the old one stops being told.
- Subscriptions are accepted only for the push services browsers actually use (Google, Mozilla, Apple, Microsoft), because the endpoint is an address this server will post to. `WEB_PUSH_ALLOWED_HOSTS` adds others. `WEB_PUSH_ENABLED=false` removes the feature.

## Keyboard and the command palette

`⌘K` (or `Ctrl K`) opens a palette that reaches everything: any filter, any mailbox or category, a message by sender or subject, compose, check mail, copy the newest code, theme, language, and a question to the model.

| Key | Does |
|---|---|
| `j` `k` | next, previous message |
| `Enter` | open |
| `e` | done |
| `r` `a` | reply, reply all |
| `y` | archive |
| `s` | star |
| `#` | bin |
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
