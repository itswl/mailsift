# Development

mailsift needs Node 22.5 or newer.

```bash
npm install
npm run dev        # run from source: the supervisor (src/server.ts) and the service, restarting on saved settings
npm run check      # report on the settings stored in the local database
npm test
npm run typecheck
npm run build
```

`npm run dev` keeps its database and key in `data/` (`STATE_DB_PATH` and `MAILSIFT_KEY_FILE` move them) and prints the first-run setup block in the terminal; open `http://127.0.0.1:8410/` and set it up as on a server. It does not reload on code changes; stop and start it.

## Settings

Every setting the page offers is listed once, in `src/settings-catalog.ts`: its key (the environment name the code has always read), section, type, limits, default and words in both languages. The settings store (`src/services/settings-store.ts`) keeps them encrypted in the database, and `src/bootstrap.ts` hands them to the rest of the code as `process.env` values and to `config.ts` as the mailboxes, before any other module loads. So a module reads its setting the way it always has; a new setting needs only its catalog entry. The settings pages are `src/settings-page.ts` (whose script, like the page's, is a `String.raw` template) and the API behind them `src/admin-api.ts`. Tests and one-off tools that never load `bootstrap.ts` can still set `MAIL_ACCOUNT_N` and the other names in the environment.

## Working on the web view

To work on the page without a mailbox, `npx tsx scripts/web-preview.ts` serves it over a week of fixture mail at `http://127.0.0.1:8499/`. Nothing real is behind it: opening a message reads a made-up body (one of them hostile, to see the reader hold), actions move rows between pretend folders, sending goes nowhere (the console prints each letter as it would leave, with its copies and files), forwarding the invoice carries its two made-up files and leaves out the two pictures in its body until asked, and the assistant answers from a script. Two messages are put off, one until tomorrow morning and one whose reminder has come, and a reminder set in the page comes back on its minute, as in the service; a device that subscribed would be told on the console instead.

| Flag | Does |
|---|---|
| `--port N` | Listen on another port. |
| `--write-token T` | The token that signs in with the right to act (default `write`). Sign in at `/signin`. |
| `--token T` | A read token as well; signing in with it gives the read-only page. |
| `--arrive N` | File a new message every N seconds, to watch the live line bring it in. |
| `--failing` | Leave one mailbox failing to sign in. |

Its refresh button files one more verification code each time it is pressed. Behind the stored mail is a made-up mailbox (`scripts/preview-mailbox.ts`): each pretend account has folders with counts (the Gmail one with nested labels, enough for the folder panel's filter box), older mail to page through, a search (Gmail's over subject, sender and text, QQ's limited to subject and sender, as the real one is), and actions that move messages between its folders and refuse a live handle once its message has moved.

The page script is assembled from six parts (`src/web-client.ts` and `src/web-client-*.ts`) into one inline `<script>`. Five of them are `String.raw` templates, written as the browser runs them, so they must contain no backtick and no `${`; a test checks. The first is an ordinary template, where a backslash has to be doubled. Every word the page shows lives in `src/web-strings.ts`, in English and Chinese together. Mail markup is never inserted into the page: it is rebuilt from an allowlist into a sandboxed frame (`cleanMail` in `src/web-client-reader.ts`), and the routes return a response object rather than writing to the socket, so `test/web-actions.test.ts` exercises all of them without a server.

Regenerate the icon with `npx tsx scripts/icons.ts` after changing the mark.

## Releases

Pushing a `v*` tag runs the release workflow: the tests, an image for linux/amd64 and linux/arm64 published to GHCR under the version (and `latest`), and a GitHub Release with generated notes.
