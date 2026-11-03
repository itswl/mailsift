# Deployment and operations

- [Docker](#docker)
- [Upgrading](#upgrading)
- [Building from source](#building-from-source)
- [systemd](#systemd)
- [Gmail and Outlook OAuth](#gmail-and-outlook-oauth)
- [Commands](#commands)
- [Monitoring](#monitoring)
- [Recovery](#recovery)

## Docker

`docker-compose.yml` runs the published image (linux/amd64 and linux/arm64): `latest`, unless `MAILSIFT_VERSION` in `.env` pins a release. Pinning is recommended, because with `latest` the next `docker compose pull` moves to whatever was released last. The Releases page lists the versions; write them without the leading `v`, as in `MAILSIFT_VERSION=0.1.99`.

The container runs as uid `10001` and stores SQLite state (`data/mailsift.db`) and OAuth refresh tokens in the `mailsift-data` named volume; a root-owned host bind mount would not be writable for that user. MCP and the web view listen on `MCP_PORT` (default `8410`), published on the host's loopback address unless `MCP_PUBLIC_HOST` says otherwise; see [MCP](mcp.md#connecting). `TZ` (default `Asia/Shanghai`) sets the clock that `DIGEST_HOUR` is read on. Logs go to stdout and Docker rotates them. On shutdown mailsift finishes the current poll first, so the compose file allows it 60 seconds.

Docker's healthcheck runs `--healthcheck`, which only checks for a recent poll heartbeat; see [Monitoring](#monitoring) for the rest.

## Upgrading

With a pinned version, raise `MAILSIFT_VERSION` in `.env` first. Then:

```bash
docker compose pull && docker compose up -d
```

On `latest`, the same two commands move to the newest release.

When you run from a git checkout, pull it as well so the compose file matches the release.

## Building from source

To build from the checked-out source instead of pulling the image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## systemd

For systemd, first run `npm install` and `npm run build`, then use [deploy/mailsift.service](../deploy/mailsift.service). Change `WorkingDirectory` to the directory containing `.env` and `data/`, and change `ExecStart` if `which node` is not `/usr/bin/node`. The service user must own or be able to write the data directory; a dedicated low-privilege user is recommended.

## Gmail and Outlook OAuth

Gmail and Outlook require OAuth for most accounts. The two Discussions guides linked from the [README](../README.md#gmail-and-outlook) cover the provider side: the scopes and redirect this code uses, the traps that cost the most time, and how to avoid Gmail's OAuth by forwarding.

```bash
npm run oauth
```

For a headless server or Docker:

```bash
docker compose run --rm mailsift node dist/scripts/oauth-setup.js --manual
```

Without flags it authorizes every OAuth account that is not authorized yet. `--account` selects one account. `--manual` prints the authorization URL: open it on any computer, approve access, and paste the complete redirected URL back into the terminal. `--force` repeats the authorization for an account that already has one. The callback listener uses `OAUTH_REDIRECT_PORT` (default `8765`); register `http://localhost:<port>/` with the provider.

The refresh-token store is `data/tokens.json`. Treat it as a long-lived mailbox credential, keep it out of version control, and preserve its file ownership in Docker (`uid 10001`). A host-side `npm run oauth` writes to `./data/tokens.json`, which is not the Docker volume; run the OAuth command through `docker compose run --rm mailsift ...` when authorizing the container's accounts.

Access tokens refresh automatically. Re-authorize with `--force` after revocation or credential changes. Personal Gmail can use `gmail_pw` with an app password instead of OAuth; Google Workspace cannot.

## Commands

```bash
docker compose up -d
docker compose logs -f
docker compose pull && docker compose up -d

npm run check
npm run dev -- --once
npm run dev -- --once --dry-run
npm run probe
npm run probe -- --account me@example.com --no-counts
npm run oauth -- --account me@example.com --manual --force
npm run dev -- --digest-now
npm run dev -- --healthcheck
npm run dev -- --recover
```

`--once` polls once and exits with status `2` if an account fetch fails. `--check` validates configuration and OAuth authorization; `--dry-run` logs notifications without sending them; `--digest-now` sends the current digest; `--healthcheck` checks only whether a recent poll heartbeat exists; and `--recover` drops undispatched records and rewinds cursors after an interrupted run.

`probe` checks folders and recent counts by default, and whether each server supports IMAP IDLE. Use `--no-counts` for a lighter connectivity/folder check, or `--account` to select one account.

In Docker, run the same entry points from the image: `node dist/src/main.js` with the flags above, `node dist/scripts/probe.js` and `node dist/scripts/oauth-setup.js`, each after `docker compose run --rm mailsift`. For example:

```bash
docker compose run --rm mailsift node dist/src/main.js --check
```

## Monitoring

The Docker healthcheck checks only the poll heartbeat; a healthy container does not prove that every account, LLM call, or notification sink is healthy. Use MCP `health` and `recovery_status` for those details (see [MCP](mcp.md#health-and-recovery)). mailsift alerts on its own when a mailbox or the LLM keeps failing; see [Configuration](configuration.md#alerts).

Every alert mailsift raises is sent by mailsift, so a stopped process or host is silent. Set `HEARTBEAT_PING_URL` to a push or heartbeat monitor (an Uptime Kuma push monitor, healthchecks.io, a Better Stack heartbeat) and mailsift sends it a plain GET after every completed poll; the monitor raises the alarm when the pings stop. The request carries nothing about mail, never holds up a poll, and only the monitor's host is logged, because the URL is usually its secret. A URL with a user name and password is not used, because fetch refuses to send one; `--check` shows whether a monitor is configured and why one is not used. A `--once` run waits for its ping before it exits.

Metrics are instrumented with OpenTelemetry and disabled by default. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send OTLP metrics to an OpenTelemetry Collector. The instruments cover poll duration, account outcomes, triage decisions, notifications, dead letters, and the outbox. Attributes intentionally use only low-cardinality values such as provider, outcome, channel, importance, and decision source, never mailbox addresses, Message-IDs or subjects.

## Recovery

State is stored in SQLite (`data/mailsift.db`); Docker persists it in the `mailsift-data` named volume. Messages are deduplicated by account plus Message-ID.

If processing was interrupted and left records that were never decided, `--recover` drops them and clears the UID cursors, so the next poll fetches the last `INITIAL_LOOKBACK_DAYS` again; messages already handled are skipped by the deduplication. With nothing interrupted it changes nothing.

```bash
docker compose run --rm mailsift node dist/src/main.js --recover
```

Messages that cannot be processed at all become dead letters; see [MCP](mcp.md#health-and-recovery) for `list_dead_letters` and `retry_dead_letter`.
