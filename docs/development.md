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

To work on the page without a mailbox, `npx tsx scripts/web-preview.ts` serves it over a week of fixture mail at `http://127.0.0.1:8499/`; `--token` adds the sign-in form, and its refresh button files one more verification code each time it is pressed.

Regenerate the icon with `npx tsx scripts/icons.ts` after changing the mark.

## Releases

Pushing a `v*` tag runs the release workflow: the tests, an image for linux/amd64 and linux/arm64 published to GHCR under the version (and `latest`), and a GitHub Release with generated notes.
