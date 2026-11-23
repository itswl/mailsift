# Deployment and operations

This page describes a fresh install of mailsift 0.2.0. Nothing is configured in a file: the server starts with a setup page, and every setting is made in the web view and kept in its database. There is no migration from an older deployment configured with a `.env` file; start with empty volumes and set it up in the browser.

- [Docker](#docker)
- [First start](#first-start)
- [Setup](#setup)
- [Reaching it from another computer](#reaching-it-from-another-computer)
- [Signing in](#signing-in)
- [Gmail and Outlook sign-in](#gmail-and-outlook-sign-in)
- [How saved settings are applied](#how-saved-settings-are-applied)
- [Backups and the encryption key](#backups-and-the-encryption-key)
- [Upgrading](#upgrading)
- [Building the image from source](#building-the-image-from-source)
- [Without Docker](#without-docker)
- [Commands](#commands)
- [Monitoring](#monitoring)
- [Recovery](#recovery)

## Docker

The repository's `docker-compose.yml` runs the published image. It reads no `.env` file and fills in no variables, so there is nothing to edit before the first start:

```bash
docker compose up -d
```

What it sets up:

- **The port**, published as `127.0.0.1:8410` only. The server itself can reach it and nothing else can; see [Reaching it from another computer](#reaching-it-from-another-computer).
- **Two named volumes.** `mailsift-data`, at `/app/data`, holds the SQLite database: the settings, the mailboxes with their passwords and OAuth records (encrypted), and the triage records. `mailsift-secrets`, at `/app/secrets`, holds the 32-byte key those credentials are encrypted with (AES-256-GCM). See [Backups and the encryption key](#backups-and-the-encryption-key).
- **`restart: unless-stopped`** and **`init: true`**. Logs go to Docker's json-file driver, rotated at 10 MB, three files. **`stop_grace_period: 60s`**, because on a stop mailsift finishes the poll in progress first.

The container runs as uid `10001`. The image sets `MCP_BIND=0.0.0.0` and `MCP_PORT=8410` (so Docker's port forwarding reaches the service; Compose then publishes it on loopback only), `STATE_DB_PATH` and `MAILSIFT_KEY_FILE` (the database and the key, one in each volume), and `TZ=Asia/Shanghai`. The time zone is a setting like the others: Settings → Checking and digest → Time zone. Its command is the supervisor, `node dist/src/server.js`, which runs the service and starts it again when saved settings need a restart (see [How saved settings are applied](#how-saved-settings-are-applied)).

## First start

```bash
docker compose logs mailsift
```

The log shows a framed block:

```text
──────────────────────────────────────────────────────────────
 mailsift is waiting to be set up.

 Open http://127.0.0.1:8410/ on this machine.
 On a remote server, tunnel the port first from your computer:
   ssh -N -L 8410:127.0.0.1:8410 you@your-server

 One-time setup code: XXXX-XXXX-XXXX-XXXX
 (a new code is printed each time mailsift starts until it is used)
──────────────────────────────────────────────────────────────
```

On a remote server, run the `ssh` line on your own computer, with your login and the server's address, and leave it running; then open `http://127.0.0.1:8410/` on your computer. The code is sixteen characters in four groups. Case, dashes and spaces do not matter when you type it.

Until the code is used, every start prints a new one and the previous one stops working. A code lost with the log is therefore not a dead end: `docker compose restart mailsift` prints a fresh one.

The page opens on **Set up mailsift**. Enter the code and choose an administrator password of at least 10 characters. The code is then spent, and the browser is signed in.

## Setup

Four steps follow:

1. **Mailboxes.** Add at least one that is ready: a password mailbox with its app password (**Test connection** signs in once and lists its folders), or a Gmail or Outlook mailbox signed in with OAuth (see [Gmail and Outlook sign-in](#gmail-and-outlook-sign-in)). The fields are described in [Configuration](configuration.md#mailboxes-and-folders).
2. **AI model.** Optional. A provider, a model and an API key; **Test** sends one short request with the values as typed. Without a model, mail is judged by your rules and keywords. See [Triage](triage.md#the-llm).
3. **Notifications.** Optional. A Feishu or Lark bot, a webhook of your own, or both; **Send a test** sends one with the values as typed. See [Configuration](configuration.md#outputs).
4. **Start.** A summary of the above and the time zone. **Start mailsift** restarts the service into monitoring, the first check of your mailboxes begins, and the page moves to the mail view.

Before Start, nothing connects to a mailbox and nothing is polled, and MCP answers `503` (`setup_required`). Everything else (triage rules, checking and the digest, privacy, web mail, access, limits) is in Settings whenever you want it: the gear icon in the mail view, or `/settings`.

Once setup is finished, a server with no mailbox it can check (all switched off, or all waiting for sign-in) serves the web view only, and Settings says so.

## Reaching it from another computer

mailsift has no TLS of its own. It accepts passwords, setup codes, OAuth codes and API tokens only on a channel where they cannot cross a network in clear:

- **A loopback address.** The address in the browser is `localhost`, `127.0.0.1` or `[::1]`: the server itself, or your computer at the end of an SSH tunnel.
- **HTTPS.** TLS on the connection, or a reverse proxy that terminated TLS and says so with `X-Forwarded-Proto: https` (or `Forwarded: proto=https`).

Anything else, such as plain `http://<public-ip>:8410/` on a port published beyond loopback, gets a 403 page that explains the tunnel and the proxy; MCP and `/api` get a JSON 403 with `https_required`. The decision is made on the address the browser was pointed at (its `Host` and `Origin` headers), not on the connection's peer address, because behind Docker's port forwarding every peer is the bridge gateway. `/healthz` is exempt.

**An SSH tunnel** is enough for setup and for occasional use:

```bash
ssh -N -L 8410:127.0.0.1:8410 you@your-server
```

Then open `http://127.0.0.1:8410/` on your computer.

**An HTTPS reverse proxy** is the way to use it every day, from a phone or another computer. Run it on the same host, forward to `127.0.0.1:8410`, pass on the `Host` the browser asked for, and set `X-Forwarded-Proto`. Caddy does all of that by default, and obtains the certificate:

```caddy
mail.example.com {
    reverse_proxy 127.0.0.1:8410
}
```

With nginx:

```nginx
server {
    listen 443 ssl;
    server_name mail.example.com;
    # ssl_certificate and ssl_certificate_key as usual

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 40m;          # letters with attachments

    location / {
        proxy_pass http://127.0.0.1:8410;
    }
    location /api/events {             # the page's live updates: never buffered, long-lived
        proxy_pass http://127.0.0.1:8410;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
    location /api/send {               # a send can wait minutes for the mail server
        proxy_pass http://127.0.0.1:8410;
        proxy_read_timeout 10m;
    }
}
```

`client_max_body_size 40m` covers the default attachment limit (a letter with 20 MiB of files is about 28 MB as a request); raise it to `48m` if you raise Settings → Web mail → Attachment limit per letter to its ceiling. Why each line matters is in [Behind a reverse proxy](web-view.md#behind-a-reverse-proxy).

With the proxy in place:

- Turn on Settings → Access → More options → **Trust the proxy's client address** (`TRUSTED_PROXY`) only when the port is reachable solely through that proxy, as it is with the compose file's loopback-only port. It makes the rate limits and the audit count each visitor rather than the proxy; anyone who can reach the port directly could forge the header it reads.
- Cookies are marked `Secure` automatically when a request comes over HTTPS. Settings → Access → More options → **Secure cookies** can make that Always or Never instead of Automatic.
- Browser notifications and installing the page as an app need HTTPS, or a localhost address.

The MCP endpoint is then `https://mail.example.com/mcp`; see [MCP](mcp.md#connecting).

## Signing in

The web view and Settings are opened with the administrator password, on the sign-in form at `/signin`. A browser stays signed in for 30 days. Settings need that password: an MCP token, even the write token, can open the mail view (see [Web view](web-view.md#signing-in-and-what-a-session-may-do)) but never Settings, so a client holding a token can act on mail and cannot reconfigure the server.

Settings → Access:

- **Change password** asks for the current one and signs out every other browser.
- **Sign out other browsers** ends every session but your own.
- **MCP** shows the endpoint and generates new read and write tokens; see [MCP](mcp.md#connecting).

If the password is forgotten:

```bash
docker compose exec mailsift node dist/src/main.js --reset-admin
```

This clears the password and every browser session, and prints a new one-time setup code. Open the page, which shows **Set up mailsift** again, enter the code and choose a new password. Mailboxes, settings and tokens are not touched.

## Gmail and Outlook sign-in

Gmail and Outlook usually refuse app passwords, so their mailboxes sign in with OAuth, through an OAuth app you register once with Google or Microsoft. Enter it under Settings → Mailboxes → **Gmail and Outlook sign-in**, or in the dialog when you add the first such mailbox; every mailbox of that provider then uses it. A personal Gmail account can instead use the **Gmail (app password)** preset with an app password; Google Workspace accounts cannot.

**Google**

1. In Google Cloud Console, go to APIs & Services → Credentials and create an OAuth client ID of type **Desktop app**.
2. Enter its client ID and client secret as **Google client ID** and **Google client secret**.
3. While the OAuth consent screen is in Testing, add your address as a test user. Publish the consent screen when it works: in Testing, the sign-in expires every 7 days.

**Microsoft**

1. In Microsoft Entra, go to App registrations and register an application. Under Authentication, add the platform **Mobile and desktop applications** with the redirect URI `http://localhost`, and allow public client flows.
2. Under API permissions, add the delegated permissions `IMAP.AccessAsUser.All`, `SMTP.Send` and `offline_access`.
3. Enter the **Microsoft application (client) ID**. Leave the client secret empty for a public client. **Microsoft tenant** is `common` for personal accounts, or your organisation's tenant ID.
4. Outlook.com may also need IMAP turned on in the mailbox's own settings, where it is off by default.

**Signing in a mailbox**

Add the mailbox and press **Save and sign in**, or **Sign in** on one already saved. The provider's page opens in a new tab. After you allow access:

- If the page is open at a loopback address (on the server, or through the SSH tunnel), the provider sends the browser straight back to `http://localhost:<port>/`, and the page finishes by itself and tests the mailbox.
- If the page is reached over HTTPS through a proxy, the provider sends the browser to `http://localhost:8765/`, which does not load. Copy that full address from the address bar and paste it into the **Finish signing in** dialog.

The code in that address is exchanged by the server and works once; a sign-in left unfinished expires after 15 minutes. A Google Desktop app client accepts both addresses without registering them, and Microsoft's `http://localhost` redirect covers them because Microsoft ignores the port of a localhost redirect.

Gmail's one scope covers reading and sending. Outlook asks for permission to send only while sending is on (Settings → Web mail → **Allow sending from the web view and MCP**); a mailbox signed in before that shows "Signed in for reading only — sign in again to send", and **Sign in again** asks for it.

The sign-in records are encrypted in the database and refreshed automatically. Deleting a mailbox forgets its record. If the provider revokes access, the web view's status line names the mailbox (see [Web view](web-view.md#mailboxes-that-cannot-be-read)); sign in again from its entry under Settings → Mailboxes.

A terminal fallback exists for a browser that cannot reach the page at all. It uses the mailboxes and the OAuth app saved in Settings, prints the provider's address to open on any computer, and asks for the address the browser ends on:

```bash
docker compose exec -it mailsift node dist/scripts/oauth-setup.js --account you@gmail.com --manual
docker compose restart mailsift
```

Add `--send` for an Outlook mailbox that should send, and `--force` to sign in a mailbox that already has a record.

## How saved settings are applied

Each section of Settings has its own **Save**. Values are checked on the server, and one it refuses is marked at its field with the reason. Secrets (API keys, webhook addresses, passwords) are never sent back to the page: a secret field shows only **Set** or **Not set**, a value typed into it replaces what is stored, and **Remove** clears it. The AI model and Notifications sections have test buttons, which use the values as typed, before they are saved.

Most settings are read when the service starts, so a save that changes what the running service uses restarts it. The poll in progress finishes, the service exits, and the supervisor (`node dist/src/server.js`, the image's command) starts it again at once; saves in quick succession restart once. The page shows "Applying changes — mailsift is restarting…" and then "Changes applied." A save that changes nothing the service runs on, such as adding a Gmail mailbox that still waits for sign-in, does not restart it. Generating a new MCP token restarts it too, which is when the old token stops working.

Started without the supervisor (`node dist/src/main.js` directly), mailsift cannot start itself again: the page says the change is saved and that mailsift has to be restarted by hand. Any exit other than a restart for settings, a crash included, is passed on to Docker's or systemd's restart policy.

## Backups and the encryption key

Back up both volumes, together:

- `mailsift-data` (`/app/data`): `mailsift.db`, the SQLite database. It holds the settings and the mailboxes, with their passwords and OAuth records encrypted, the triage records, the audit and the notification subscriptions.
- `mailsift-secrets` (`/app/secrets`): `mailsift.key`, the key the settings and credentials are encrypted with.

Neither is of use without the other. A copy of the database alone carries no credential, and the key alone is 32 random bytes. Together they hold every mailbox credential, so keep the backup as safe as the mailboxes themselves. One way, with the service stopped so the database is quiet:

```bash
docker compose stop mailsift
docker run --rm -v mailsift_mailsift-data:/data -v mailsift_mailsift-secrets:/secrets -v "$PWD":/backup \
  alpine tar czf /backup/mailsift-backup.tgz /data /secrets
docker compose start mailsift
```

Compose prefixes the volume names with the project name, by default the name of the directory holding `docker-compose.yml`; `docker volume ls` shows them.

If the key is missing while the database holds encrypted settings, or a different key is present, mailsift refuses to start and the log says that the stored settings cannot be read. It never makes a new key over existing data, which would destroy every stored credential. Restore the key from the backup of `mailsift-secrets`. To start over instead, remove both volumes:

```bash
docker compose down -v
```

That deletes every setting, credential and triage record. Mail on the servers is not touched.

## Upgrading

```bash
docker compose pull && docker compose up -d
```

When running from a git checkout, pull the source as well so the compose file matches the release. Settings, credentials and records stay in the volumes. To stay on one release, replace `latest` in the compose file's `image:` line with its version, written without the leading `v` (`0.2.0`); the Releases page lists them.

## Building the image from source

To build the checked-out source instead of pulling the image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Without Docker

mailsift needs Node 22.5 or newer.

```bash
npm ci
npm run build
npm start
```

`npm start` runs the supervisor, `dist/src/server.js`, and the setup block appears in the terminal. By default the service listens on `127.0.0.1:8410`, keeps its database in `data/mailsift.db` and the key in `data/mailsift.key`, relative to the working directory. Where it keeps its files and where it listens are the only things set outside the web view: `STATE_DB_PATH` and `MAILSIFT_KEY_FILE` move the database and the key (the image puts them in separate volumes), and `MCP_BIND` and `MCP_PORT` move the listening address.

For a persistent install, use [deploy/mailsift.service](../deploy/mailsift.service), which runs `dist/src/server.js` under systemd. Set `WorkingDirectory` to the application directory and `ExecStart` to the absolute Node path, and run it as a dedicated low-privilege user that owns the directory (the unit's comments show how). It gives a stop 90 seconds, so the poll in progress can finish.

```bash
sudo cp deploy/mailsift.service /etc/systemd/system/mailsift.service
sudo systemctl daemon-reload && sudo systemctl enable --now mailsift
journalctl -u mailsift -f
```

The journal shows the setup block. The commands below run as `node dist/src/main.js <flag>` from the application directory, as the service user.

## Commands

In Docker, run them in the running container:

```bash
docker compose exec mailsift node dist/src/main.js --check
```

| Flag | Does |
|---|---|
| `--reset-admin` | Clears the administrator password and every browser session, and prints a new one-time setup code. |
| `--check` | Reports on the stored configuration: each mailbox and whether it is signed in, the outputs, the model, the thresholds and the schedule. Exits with status `1` when a mailbox waits for sign-in. |
| `--healthcheck` | Asks the running service's `/healthz`; what the image's healthcheck runs. |
| `--once` | Polls once and exits, with status `2` if a mailbox could not be read. |
| `--dry-run` | Logs notifications instead of sending them, and sends no mail. With `--once`, for trying things by hand. |
| `--digest-now` | Sends the current digest at once. |
| `--recover` | Drops records an interrupted run left undecided and rewinds the folder cursors; see [Recovery](#recovery). |

Without a flag, `main.js` is the service itself; the supervisor runs it.

From a source checkout, `npm run check` is `--check`, and `npm run probe` signs in to each stored mailbox and lists its folders, their recent message counts, and whether the server supports IMAP IDLE (`npm run probe -- --account me@example.com` for one mailbox, `-- --no-counts` for a lighter look). In Docker: `docker compose exec mailsift node dist/scripts/probe.js`.

## Monitoring

The image's healthcheck runs `node dist/src/main.js --healthcheck` every minute, which asks the service's `/healthz`. Waiting for setup counts as healthy, and so does a server with no mailbox to check. While mailboxes are being checked, it is unhealthy only when no check has finished for three poll intervals, after a 15-minute grace at start for a first check that takes long (a large backfill, say). `/healthz` needs no credential and answers `{status, mode, version, boot}`, where `mode` is `setup`, `idle` or `running`, with `lastPollAt` once a check has finished.

A healthy container does not prove that every mailbox, LLM call or notification output is healthy. The web view's status line names a mailbox that cannot be read, and MCP `health` and `recovery_status` give the details (see [MCP](mcp.md#health-and-recovery)). mailsift alerts through the configured outputs when a mailbox or the LLM keeps failing; see [Configuration](configuration.md#alerts).

To notice when the host or the process stops, enter a monitor's address under Settings → Notifications → **Heartbeat URL** (`HEARTBEAT_PING_URL`). mailsift sends it a plain GET after each completed poll; the request carries no mail data, does not hold up a poll, and only the monitor's host is logged.

Logs are plain lines on stderr, because stdout is the MCP protocol channel in stdio mode. Settings → Advanced → **Log level** sets the level. Credentials are redacted from lines mailsift writes, including OAuth tokens and client secrets, JWTs, authorization headers, and secrets in URLs and form bodies.

Metrics use OpenTelemetry and stay off until Settings → Advanced → **OpenTelemetry collector** is set. Metric attributes use low-cardinality values such as provider, outcome, channel, importance and decision source; they never include mailbox addresses, Message-IDs or subjects.

## Recovery

Triage state is stored in the same SQLite database (`data/mailsift.db`, in the `mailsift-data` volume). Messages are deduplicated by mailbox plus Message-ID.

If processing was interrupted and left records that were never decided, `--recover` drops them and clears the folder cursors, so the next poll fetches the last few days again (Settings → Checking and digest → More options → **Days looked back for a new mailbox**, 3 by default). Messages already handled are skipped by deduplication. With nothing interrupted it changes nothing.

```bash
docker compose stop mailsift
docker compose run --rm mailsift node dist/src/main.js --recover
docker compose start mailsift
```

Messages that cannot be processed become dead letters; see [MCP](mcp.md#health-and-recovery) for `list_dead_letters` and `retry_dead_letter`.
