import { describe, expect, it } from 'vitest';
import './setup.js';
import { RecordingSink } from './helpers.js';
import { StateStore } from '../src/services/state.js';
import { AuthError } from '../src/imap/auth.js';
import type { Account } from '../src/config.js';
import {
  mailboxStatuses, oauthCommand, recordAccountFailure, recordAccountSuccess, recordDeciderFailure, recordDeciderSuccess,
  recordLlmFailure, recordLlmSuccess, recordStartupFailure, ALERTED_AT_KEY, LLM_ALERTED_AT_KEY,
} from '../src/services/health.js';

const QQ: Account = {
  name: 'QQ-主号', provider: 'qq', username: 'me@qq.com',
  host: 'imap.qq.com', port: 993, auth: 'password', password: 'x',
  folders: ['INBOX', 'spam'], useSsl: true,
};
const GMAIL: Account = { ...QQ, name: 'Gmail', provider: 'gmail', username: 'me@gmail.com', auth: 'gmail_oauth' };
const OUTLOOK: Account = { ...QQ, name: 'Outlook', provider: 'outlook', username: 'me@outlook.com', auth: 'outlook_oauth' };

const store = () => new StateStore(':memory:');

describe('account outages', () => {
  it('debounces a single authentication failure', async () => {
    const s = store();
    const sink = new RecordingSink();
    expect(await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'))).toBe(false);
    expect(sink.pushed).toHaveLength(0);
  });

  it('alerts after consecutive authentication failures', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'))).toBe(true);
    const [message, result] = sink.pushed[0]!;
    expect(result.importance).toBe('critical');
    expect(message.subject).toContain('unavailable');
  });

  it('waits for a second non-authentication failure', async () => {
    process.env.ACCOUNT_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    expect(await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'))).toBe(false);
    expect(await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'))).toBe(true);
  });

  it('does not repeat alerts during the cooldown', async () => {
    const s = store();
    const sink = new RecordingSink();
    for (let i = 0; i < 5; i += 1) await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(sink.pushed).toHaveLength(1);
  });

  it('alerts again after the cooldown expires', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    s.setMeta(ALERTED_AT_KEY + GMAIL.username, new Date(Date.now() - 7 * 3_600_000).toISOString());
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(sink.pushed).toHaveLength(2);
  });

  it('explains what is no longer being monitored', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('authentication failed'));
    await recordAccountFailure(s, sink, QQ, new Error('authentication failed'));
    expect(sink.pushed[0]![0].body).toContain('including spam');
  });

  it('mentions the Gmail seven-day testing trap in the recovery advice', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('7 days');
    expect(body).toContain('Testing');
  });

  it('mentions the Outlook IMAP switch first in the recovery advice', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, OUTLOOK, new Error('invalid_grant'));
    await recordAccountFailure(s, sink, OUTLOOK, new Error('invalid_grant'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('Forwarding and IMAP');
    expect(body).toContain('disabled by default');
  });

  it('includes the IMAP check for every provider', async () => {
    // Most mailboxes disable IMAP by default, making it the most common setup issue.
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('login failed'));
    await recordAccountFailure(s, sink, QQ, new Error('login failed'));
    expect(sink.pushed[0]![0].body).toContain('IMAP');
  });

  it('sends a recovery notification', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(await recordAccountSuccess(s, sink, GMAIL)).toBe(true);
    expect(sink.pushed[1]![0].subject).toContain('recovered');
  });

  it('does not notify when a transient failure recovers', async () => {
    process.env.ACCOUNT_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, QQ, new Error('ETIMEDOUT'));
    expect(await recordAccountSuccess(s, sink, QQ)).toBe(false);
    expect(sink.pushed).toHaveLength(0);
  });

  it('does not notify recovery for an undelivered outage alert', async () => {
    const s = store();
    const sink = new RecordingSink('failed');
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(await recordAccountSuccess(s, sink, GMAIL)).toBe(false);
    expect(sink.pushed).toHaveLength(1);
  });

  it('does not emit messages for a continuously healthy account', async () => {
    const sink = new RecordingSink();
    expect(await recordAccountSuccess(store(), sink, QQ)).toBe(false);
    expect(sink.pushed).toHaveLength(0);
  });
});

describe('LLM outages', () => {
  it('alerts only after reaching the threshold', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '2';
    const s = store();
    const sink = new RecordingSink();
    expect(await recordLlmFailure(s, sink, new Error('HTTP 401'))).toBe(false);
    expect(await recordLlmFailure(s, sink, new Error('HTTP 401'))).toBe(true);
    expect(sink.pushed[0]![1].importance).toBe('critical');
  });

  it('explains the consequences of fallback instead of only reporting the error', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    await recordLlmFailure(s, sink, new Error('HTTP 401 invalid api key'));
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('keyword fallback');
    expect(body).toContain('daily digest');
    expect(body).toContain('401');
  });

  it('enforces the cooldown', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    for (let i = 0; i < 6; i += 1) await recordLlmFailure(s, sink, new Error('x'));
    expect(sink.pushed).toHaveLength(1);
  });

  it('points to the digest for review in the recovery notice', async () => {
    process.env.LLM_ALERT_AFTER_FAILURES = '1';
    const s = store();
    const sink = new RecordingSink();
    await recordLlmFailure(s, sink, new Error('x'));
    s.setMeta(LLM_ALERTED_AT_KEY, new Date().toISOString());
    expect(await recordLlmSuccess(s, sink)).toBe(true);
    expect(sink.pushed[1]![0].body).toContain('digest');
  });
});

describe('startup failures', () => {
  it('explains that nothing is being monitored and gives a check command', async () => {
    process.env.STATE_DB_PATH = ':memory:';
    const sink = new RecordingSink();
    expect(await recordStartupFailure(new Error('MAIL_ACCOUNT_1 格式不对'), sink)).toBe(true);
    const body = sink.pushed[0]![0].body;
    expect(body).toContain('will be checked');
    expect(body).toContain('--check');
  });

  it('logs without masking the original error when no sink is configured', async () => {
    process.env.STATE_DB_PATH = ':memory:';
    const sink = new RecordingSink();
    sink.configured = false;
    expect(await recordStartupFailure(new Error('x'), sink)).toBe(false);
  });
});

describe('mailbox status for the page', () => {
  it('names a mailbox only once it has failed long enough to alert', async () => {
    const s = store();
    const sink = new RecordingSink();
    await recordAccountSuccess(s, sink, GMAIL);
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    let [gmail] = mailboxStatuses(s, [GMAIL]);
    expect(gmail).toMatchObject({ name: 'Gmail', consecutiveFailures: 1, failing: false });
    expect(gmail!.lastSuccessAt).toBeTruthy();

    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    [gmail] = mailboxStatuses(s, [GMAIL]);
    expect(gmail).toMatchObject({ failing: true, fix: 'google' });
    // The command re-authorizes this account alone, not every OAuth mailbox.
    expect(gmail!.command).toContain('--account=me@gmail.com');

    await recordAccountSuccess(s, sink, GMAIL);
    [gmail] = mailboxStatuses(s, [GMAIL]);
    expect(gmail).toMatchObject({ consecutiveFailures: 0, failing: false });
    expect(gmail!.fix).toBeUndefined();
  });

  it('suggests the fix that matches the failure', async () => {
    const s = store();
    const sink = new RecordingSink();
    for (let n = 0; n < 2; n += 1) {
      await recordAccountFailure(s, sink, QQ, new Error('Authentication failed'));
      await recordAccountFailure(s, sink, OUTLOOK, new Error('ETIMEDOUT'));
    }
    const [qq, outlook] = mailboxStatuses(s, [QQ, OUTLOOK]);
    expect(qq).toMatchObject({ fix: 'password' });
    expect(qq!.command).toBeUndefined();
    expect(outlook).toMatchObject({ fix: 'connection' });
  });

  it('offers the authorization command when the token was never stored here', async () => {
    // A host-side "npm run oauth" writes ./data/tokens.json, not the container's volume.
    const s = store();
    const sink = new RecordingSink();
    const missing = new AuthError('me@gmail.com has no authorization record. Run: npm run oauth -- --account me@gmail.com');
    for (let n = 0; n < 2; n += 1) await recordAccountFailure(s, sink, GMAIL, missing);
    const [gmail] = mailboxStatuses(s, [GMAIL]);
    expect(gmail).toMatchObject({ failing: true, fix: 'authorize' });
    expect(gmail!.command).toContain('--account=me@gmail.com');
    // The remedy, not the error text (which names the host-side command itself).
    expect(sink.pushed[0]![0].body).toContain('**Failure type**: authentication');
    expect(sink.pushed[0]![0].body).toContain('--manual --force --account=me@gmail.com');
  });

  it('does not send anyone to re-authorize during a provider outage or for a broken token file', async () => {
    const s = store();
    const sink = new RecordingSink();
    const outage = new AuthError('gmail token request failed: HTTP 503 Service Unavailable');
    for (let n = 0; n < 2; n += 1) await recordAccountFailure(s, sink, GMAIL, outage);
    expect(mailboxStatuses(s, [GMAIL])[0]).toMatchObject({ fix: 'connection' });
    expect(mailboxStatuses(s, [GMAIL])[0]!.command).toBeUndefined();
    expect(sink.pushed.at(-1)![0].body).toContain('**Failure type**: connection');
    const corrupt = new AuthError('Token store is not valid JSON; refusing to replace it');
    for (let n = 0; n < 2; n += 1) await recordAccountFailure(s, sink, OUTLOOK, corrupt);
    expect(mailboxStatuses(s, [OUTLOOK])[0]).toMatchObject({ fix: 'setup' });
    expect(mailboxStatuses(s, [OUTLOOK])[0]!.command).toBeUndefined();
    // The alert points at the token store, not at a command that would fail on the same file.
    const alert = sink.pushed.at(-1)![0].body;
    expect(alert).toContain('**Failure type**: OAuth setup');
    expect(alert).toContain('TOKEN_STORE_PATH');
    expect(alert).not.toContain('--account=');
    const refused = new AuthError('outlook token request failed: HTTP 400 {"error":"invalid_client"}');
    const t = store();
    for (let n = 0; n < 2; n += 1) await recordAccountFailure(t, sink, OUTLOOK, refused);
    expect(mailboxStatuses(t, [OUTLOOK])[0]).toMatchObject({ fix: 'outlook' });
  });

  it('tells a folder that cannot be opened apart from a server that cannot be reached', async () => {
    const s = store();
    const sink = new RecordingSink();
    for (let n = 0; n < 2; n += 1) {
      await recordAccountFailure(s, sink, QQ, new Error('no selectable folders to scan; configured folders: Inbx'));
    }
    expect(mailboxStatuses(s, [QQ])[0]).toMatchObject({ fix: 'folders' });
  });

  it('quotes an address the shell would otherwise break on', () => {
    expect(oauthCommand({ username: "o'brien@contoso.com" })).toContain(`--account='o'\\''brien@contoso.com'`);
    expect(oauthCommand({ username: 'a!b@contoso.com' })).toContain("--account='a!b@contoso.com'");
    expect(oauthCommand({ username: 'me+tag@gmail.com' })).toContain('--account=me+tag@gmail.com');
    // A leading dash would read as another option without the '='.
    expect(oauthCommand({ username: '-ops@contoso.com' })).toContain('--account=-ops@contoso.com');
  });

  it('puts the account in the re-authorization command on the alert card', async () => {
    expect(oauthCommand(GMAIL)).toContain('--manual --force --account=me@gmail.com');
    const s = store();
    const sink = new RecordingSink();
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    await recordAccountFailure(s, sink, GMAIL, new Error('invalid_grant'));
    expect(sink.pushed[0]![0].body).toContain('--account=me@gmail.com');
  });
});

describe('decision model outages', () => {
  it('says once that two-stage triage is off, then that it is back', async () => {
    const s = store();
    const sink = new RecordingSink();
    expect(await recordDeciderFailure(s, sink, new Error('decider HTTP 401'))).toBe(false);
    expect(await recordDeciderFailure(s, sink, new Error('decider HTTP 401'))).toBe(true);
    expect(sink.pushed).toHaveLength(1);
    expect(sink.pushed[0]![0].body).toContain('Two-stage triage is off');
    expect(sink.pushed[0]![0].body).toContain('401');
    // Within the cooldown it stays quiet.
    expect(await recordDeciderFailure(s, sink, new Error('decider HTTP 401'))).toBe(false);
    expect(sink.pushed).toHaveLength(1);

    expect(await recordDeciderSuccess(s, sink)).toBe(true);
    expect(sink.pushed).toHaveLength(2);
    expect(sink.pushed[1]![0].subject).toContain('restored');
  });
});
