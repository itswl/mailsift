# Development

mailsift needs Node 22.5 or newer.

```bash
npm install
npm run check      # validate .env
npm run dev        # run from source
npm test
npm run typecheck
npm run build
```

## Working on the web view

To work on the page without a mailbox, `npx tsx scripts/web-preview.ts` serves it over a week of fixture mail at `http://127.0.0.1:8499/`. Nothing real is behind it: opening a message reads a made-up body (one of them hostile, to see the reader hold), actions move rows between pretend folders, sending goes nowhere (the console prints each letter as it would leave, with its copies and files), forwarding the invoice carries its two made-up files and leaves out the two pictures in its body until asked, and the assistant answers from a script.

| Flag | Does |
|---|---|
| `--port N` | Listen on another port. |
| `--write-token T` | The token that signs in with the right to act (default `write`). Sign in at `/signin`. |
| `--token T` | A read token as well; signing in with it gives the read-only page. |
| `--arrive N` | File a new message every N seconds, to watch the live line bring it in. |
| `--failing` | Leave one mailbox failing to sign in. |

Its refresh button files one more verification code each time it is pressed.

The page script is assembled from five parts (`src/web-client.ts` and `src/web-client-*.ts`) into one inline `<script>`. Four of them are `String.raw` templates, written as the browser runs them, so they must contain no backtick and no `${`; a test checks. The first is an ordinary template, where a backslash has to be doubled. Every word the page shows lives in `src/web-strings.ts`, in English and Chinese together. Mail markup is never inserted into the page: it is rebuilt from an allowlist into a sandboxed frame (`cleanMail` in `src/web-client-reader.ts`), and the routes return a response object rather than writing to the socket, so `test/web-actions.test.ts` exercises all of them without a server.

Regenerate the icon with `npx tsx scripts/icons.ts` after changing the mark.

## Releases

Pushing a `v*` tag runs the release workflow: the tests, an image for linux/amd64 and linux/arm64 published to GHCR under the version (and `latest`), and a GitHub Release with generated notes.
