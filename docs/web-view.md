# Web view

`WEB_UI_ENABLED=true` serves a read-only browser view of the triage results at `http://<host>:<MCP_PORT>/`, on the same port and behind the same `MCP_TOKEN` as MCP, because it is the same trust boundary.

It is off by default. A page a browser can reach is a wider surface than a JSON-RPC endpoint, so enable it deliberately, keep the port on loopback (`MCP_PUBLIC_HOST` in Docker, `MCP_BIND` otherwise), and put TLS in front of it if you reach it from a phone.

- [Signing in](#signing-in)
- [The page](#the-page)
- [Verification codes](#verification-codes)
- [Mailboxes that cannot be read](#mailboxes-that-cannot-be-read)
- [Reading a message](#reading-a-message)
- [Refreshing](#refreshing)
- [Theme and language](#theme-and-language)
- [Installing to the home screen](#installing-to-the-home-screen)
- [Behind a reverse proxy](#behind-a-reverse-proxy)

## Signing in

Signing in posts the token and exchanges it for an `HttpOnly` cookie that lasts six months and is renewed on each visit, so a browser in regular use is never asked again. The form carries an account field so a password manager will offer to save the token rather than leaving you to type it. An installed app keeps its own cookies on iOS, so expect to sign in once inside it even if the browser is already signed in.

## The page

The page opens on one sentence, "11 messages, 6 of them notified, 1 critical.", whose numbers are filters, with a status line under it saying where the mail came from and when the mailboxes were last checked. Below it is a single list of judgements grouped by day: sender, the model's one-line summary, level and category, the deadline when there is one, and for critical mail the reason it was judged so.

Filters (window, level, category, mailbox, spam only, notified only, codes only, messages or threads) and the search live in one form and are mirrored to the URL, so a reload or a shared link restores the view. The codes-only filter also lists verification emails whose code could not be extracted, so it shows every one of them, not only those with digits.

The queue behind the next digest is listed at the end with the hour it will be sent, and the digest that last went out stays under it for 18 hours, open the first time it is seen and folded to one line after that. Every entry in either opens its message, and every message links out to the provider's own client.

## Verification codes

A verification code is the most frequent reason to open the page, so it is never a sentence to read: the digits are set large in the row and are themselves the copy button. A code that arrived in the last ten minutes is lifted above the list with its sender and age, and `/?focus=code`, one of the two home-screen shortcuts the manifest offers next to `/?importance=critical`, lands on it. Codes older than fifteen minutes go grey, so a stale one is recognisable before it is pasted.

The shortcut is usually pressed right after asking a site for a code, before it has arrived. With no fresh code to show, the lane says it is waiting and watches for up to three minutes, reading what the poller has stored every few seconds, and asks for one immediate poll through the same rate-limited path as the refresh button, so a code filed to spam is not left for the next interval. The code slides in already focused, unless you are busy elsewhere on the page (typing in the search field, focused on another control, or in an open sheet, which hands the focus to the code when it closes); the status line then says it came. A fresh verification email whose code could not be extracted counts as well, already there or arriving: its row is focused, because the code is in it. If nothing comes, the status line says no new code arrived.

## Mailboxes that cannot be read

A mailbox that cannot be read says so instead of looking quiet. Once one has failed `ACCOUNT_ALERT_AFTER_FAILURES` polls in a row, a line under the status names it ("work-gmail not checked since yesterday 08:26"), and an empty list says that mail may be missing rather than that there is none.

Tapping the line lists every mailbox with its last good check and failure count, and what usually fixes that kind of failure: a refused login, an OAuth account that was never authorized on this server, folders that cannot be opened, or a server that cannot be reached. For a Gmail or Outlook OAuth account it adds the exact re-authorization command with a copy button, written for Docker when mailsift runs in a container. Notifications still waiting in the outbox are counted there too. A refresh that a mailbox did not answer names it in the status line.

## Reading a message

Tapping a message opens it in a sheet that slides up over the list on a phone, and in a pane beside the list from 900px up. The sheet closes with Done, a drag on its handle, Escape or the system back gesture, because opening it pushes a history entry.

The detail carries the judgement and its reason, the summary as prose, the provider link, and three things fetched live from the mailbox on request: the full text body, the attachment list with download and a bounded scan, and the spam and safety clues (see [MCP](mcp.md#attachments) for the limits). Attachment files are downloaded and never cached or persisted by mailsift.

On a desk, ↑ and ↓ move through the list, Enter opens, `c` copies the newest code, `/` focuses the search and Escape closes.

The browser view remains read-only in the strict sense: mailbox calls fetch a message body or a selected MIME part under a read-only lock. Use MCP with the separate write token for the small audited action set; sending, replying, deleting, and other mailbox management still belong in a real webmail client such as Roundcube.

## Refreshing

The header's refresh button runs a poll immediately instead of waiting for the next interval. It scans the same folders the scheduled poll does, spam included. The status line narrates it ("Checking 2 mailboxes…", then "Checked just now · 3 new") and the rows that arrived settle in with a tint that fades, so what changed is visible without comparing two lists. A click during a running poll joins it rather than opening a second set of IMAP connections, and manual presses are rate-limited per client.

The page has no pull-to-refresh of its own: in the installed app, scrolling back to the top set it off too easily.

The button appears only when the page is served by the long-running service; the standalone MCP server has no poller to trigger. Its status line still says when the mailboxes were last checked, because it reads the same database, and falls back to when the view itself was last updated only before any poll has completed.

## Theme and language

The header carries a two-state light/dark switch. The page starts light and does not follow the system setting. The choice is stored in the browser and applied before the body renders, so it never flashes the other theme, and it moves the status bar colour with it rather than leaving the top of an installed app behind.

Next to it is a language switch between English and Simplified Chinese. The page follows the browser's language until the switch is used; that choice is kept in a cookie, so the server renders the page, and the sign-in form before it, in that language from the first paint. Only the page's own words change. Subjects, summaries and reasons are shown as stored, in the language `LLM_OUTPUT_LANGUAGE` told the model to write, and the digest preview is the text that will actually be sent.

## Installing to the home screen

It installs to a home screen: the manifest, a maskable icon and a service worker that caches nothing are served without a session, since a browser asks for them before it has one. The offer to install is a line in the list on a phone, and never appears inside the installed app. On a desk the page makes no offer of its own and leaves installing to the browser. Installed, it opens without browser chrome, paints the status bar to match the page in either colour scheme, and reaches under a notch with the safe-area insets padded back. The worker deliberately caches nothing, because a page showing yesterday's triage would be worse than no page.

## Behind a reverse proxy

Behind a reverse proxy, set `TRUSTED_PROXY=true`. Otherwise every request arrives from the proxy's address, the per-client rate limit collapses into one shared budget, and a single noisy caller can lock out your own browser and any MCP client. With it set, the limit and the audit log key on `CF-Connecting-IP`, `X-Real-IP` or the first `X-Forwarded-For` entry. Leave it off when the port is reached directly, since anyone can send those headers. Sign-in gets a separate, much smaller budget of its own, because it is the only route that answers without credentials.
