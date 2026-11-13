import { describe, expect, it } from 'vitest';
import './setup.js';
import {
  inlineCidImages, MAX_HTML_BYTES, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_TOTAL_BYTES, MAX_TEXT_CHARS,
  authservTrust, mailboxAuthHeaders, parseAuthenticationResults, parseReadable, splitQuoted, unsubscribeUrl,
} from '../src/imap/readable.js';

/** A message source from its lines, with the CRLF line endings mail travels with. */
const eml = (...lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8');

/** A 1x1 PNG: small enough to read in a diff, real enough to be an image. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const HEAD = [
  'From: "Stripe" <billing@stripe.com>',
  'To: Me <me@gmail.com>',
  'Subject: Invoice #4821',
  'Message-ID: <inv-4821@stripe.com>',
  'Date: Thu, 12 Nov 2026 10:00:00 +0800',
  'MIME-Version: 1.0',
];

describe('what the reader gets', () => {
  it('keeps both halves of an alternative: the markup as sent and the text with its lines', async () => {
    const message = await parseReadable(eml(
      ...HEAD,
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Invoice #4821 is due.',
      '',
      'Pay from the dashboard.',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><h1>Invoice</h1><p onclick="x()">Pay <a href="https://stripe.com/pay">here</a></p></body></html>',
      '--alt--',
      '',
    ));
    // The paragraphs survive: triage collapses a body to one line, a reader must not.
    expect(message.text).toBe('Invoice #4821 is due.\n\nPay from the dashboard.');
    expect(message.quoted).toBe('');
    // The markup is handed over untouched; making it safe is the browser's job.
    expect(message.html).toContain('<h1>Invoice</h1>');
    expect(message.html).toContain('onclick="x()"');
    expect(message).toMatchObject({
      htmlOmitted: false, truncated: false, subject: 'Invoice #4821', messageId: '<inv-4821@stripe.com>',
      date: '2026-11-12T02:00:00.000Z', inReplyTo: null, references: [], inlineImages: 0,
      from: { name: 'Stripe', address: 'billing@stripe.com' },
      to: [{ name: 'Me', address: 'me@gmail.com' }], cc: [], replyTo: [],
    });
  });

  it('reads the markup as text when the sender wrote no text part', async () => {
    const message = await parseReadable(eml(
      ...HEAD,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div>First line</div><div>Second&nbsp;line</div><style>p{color:red}</style>',
    ));
    expect(message.html).toContain('<div>First line</div>');
    // Each block on its own line, the style rule gone, the entity decoded.
    expect(message.text.split(/\n+/)).toEqual(['First line', 'Second line']);
  });

  it('decodes a quoted-printable GBK body and an encoded Chinese subject', async () => {
    const message = await parseReadable(eml(
      'From: =?UTF-8?B?6LSm5Y2V5o+Q6YaS?= <notice@bank.example>',
      'To: me@qq.com',
      'Subject: =?UTF-8?B?6LSm5Y2V5o+Q6YaS?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=gbk',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=C4=E3=BA=C3=A3=AC=CA=C0=BD=E7=A1=A3=D1=E9=D6=A4=C2=EB 482913',
    ));
    expect(message.subject).toBe('账单提醒');
    expect(message.from).toEqual({ name: '账单提醒', address: 'notice@bank.example' });
    expect(message.text).toBe('你好，世界。验证码 482913');
    expect(message.html).toBeNull();
  });

  it('decodes a base64 UTF-8 body without losing its line break', async () => {
    const message = await parseReadable(eml(
      ...HEAD,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      '5L2g5aW977yM6L+Z5piv5q2j5paH44CCCuesrOS6jOauteOAgg==',
    ));
    expect(message.text).toBe('你好，这是正文。\n第二段。');
  });

  it('lists everyone a message went to, groups included, and where a reply would go', async () => {
    const message = await parseReadable(eml(
      'From: Mia <mia@team.example>',
      'To: Me <ME@Gmail.com>, Team: sam@team.example, "Lee, K" <lee@team.example>;',
      'Cc: ops@team.example',
      'Reply-To: Review Desk <reviews@team.example>',
      'In-Reply-To: <prev@team.example>',
      'References: <root@team.example> <prev@team.example>',
      'Subject: Re: PR #61',
      '',
      'ok',
    ));
    expect(message.to).toEqual([
      { name: 'Me', address: 'me@gmail.com' },
      { name: '', address: 'sam@team.example' },
      { name: 'Lee, K', address: 'lee@team.example' },
    ]);
    expect(message.cc).toEqual([{ name: '', address: 'ops@team.example' }]);
    expect(message.replyTo).toEqual([{ name: 'Review Desk', address: 'reviews@team.example' }]);
    expect(message.inReplyTo).toBe('<prev@team.example>');
    expect(message.references).toEqual(['<root@team.example>', '<prev@team.example>']);
    // No Date header is not today's date: the page has the stored one.
    expect(message.date).toBeNull();
    // Everyone is listed, so nothing says the list was cut.
    expect(message).not.toHaveProperty('toTruncated');
    expect(message).not.toHaveProperty('ccTruncated');
  });

  it('lists fifty of a crowd and says there were more, groups included', async () => {
    const crowd = Array.from({ length: 60 }, (_, n) => `p${n}@list.example`);
    const message = await parseReadable(eml(
      'From: Mia <mia@team.example>',
      `To: ${crowd.slice(0, 30).join(', ')}, Everyone: ${crowd.slice(30).join(', ')};`,
      `Cc: ${crowd.slice(0, 50).join(', ')}`,
      'Subject: All hands',
      '',
      'ok',
    ));
    expect(message.to).toHaveLength(50);
    expect(message.to.at(-1)).toEqual({ name: '', address: 'p49@list.example' });
    expect(message.toTruncated).toBe(true);
    // Exactly fifty is all of them.
    expect(message.cc).toHaveLength(50);
    expect(message).not.toHaveProperty('ccTruncated');
  });
});

describe('quoted history', () => {
  it('splits a reply where the earlier conversation starts', async () => {
    const message = await parseReadable(eml(
      ...HEAD,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Sounds good, shipping Tuesday.',
      '',
      'On Mon, 9 Nov 2026 at 10:00, Mia <mia@team.example> wrote:',
      '> Can we ship on Tuesday?',
      '> The release notes are ready.',
    ));
    expect(message.text).toBe('Sounds good, shipping Tuesday.');
    expect(message.quoted).toBe(
      'On Mon, 9 Nov 2026 at 10:00, Mia <mia@team.example> wrote:\n> Can we ship on Tuesday?\n> The release notes are ready.',
    );
  });

  it('recognises the attribution a Chinese client writes', () => {
    const split = splitQuoted('好的，周二发。\n\n在 2026年11月9日 10:00，Mia <mia@x.com> 写道：\n> 周二可以发吗？');
    expect(split.text).toBe('好的，周二发。');
    expect(split.quoted).toContain('写道：');
  });

  it('shows a message that is only a quote in full, rather than an empty page', () => {
    const only = 'On Mon, 9 Nov 2026 at 10:00, Mia <mia@team.example> wrote:\n> Can we ship on Tuesday?';
    expect(splitQuoted(only)).toEqual({ text: only, quoted: '' });
    expect(splitQuoted('No history here.\nJust two lines.')).toEqual({ text: 'No history here.\nJust two lines.', quoted: '' });
  });

  it('bounds the text, taking the quote first', async () => {
    const long = `${'word '.repeat(MAX_TEXT_CHARS / 5 + 200)}`;
    const message = await parseReadable(eml(...HEAD, 'Content-Type: text/plain; charset=utf-8', '', long));
    expect(message.text.length).toBe(MAX_TEXT_CHARS);
    expect(message.truncated).toBe(true);

    const reply = await parseReadable(eml(
      ...HEAD, 'Content-Type: text/plain; charset=utf-8', '',
      'Short answer.', '', '-----Original Message-----', `${'earlier '.repeat(MAX_TEXT_CHARS / 8 + 500)}`,
    ));
    expect(reply.text).toBe('Short answer.');
    expect(reply.text.length + reply.quoted.length).toBe(MAX_TEXT_CHARS);
    expect(reply.truncated).toBe(true);
  });
});

describe('images that travel inside the message', () => {
  const related = (html: string, parts: string[]): Buffer => eml(
    ...HEAD,
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    ...parts,
    '--rel--',
    '',
  );
  const part = (id: string, type: string, base64: string): string[] => [
    '--rel',
    `Content-Type: ${type}`,
    `Content-ID: <${id}>`,
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: inline',
    '',
    base64,
  ];

  it('puts a related image into the markup that refers to it', async () => {
    const message = await parseReadable(related(
      '<p>Hi</p><img src="cid:logo@x"><img src="cid:logo@x"><img src="https://tracker.example/p.gif">',
      part('logo@x', 'image/png', PNG),
    ));
    expect(message.html).toContain(`<img src="data:image/png;base64,${PNG}">`);
    expect(message.html).not.toContain('cid:');
    // Remote images are not this module's business: they stay as written.
    expect(message.html).toContain('https://tracker.example/p.gif');
    expect(message.inlineImages).toBe(1);
  });

  it('never substitutes an id into a longer one that merely starts with it', async () => {
    const message = await parseReadable(related(
      '<img src="cid:logo@x.large"><img src="cid:logo@x"><img src="cid:absent@x">',
      part('logo@x', 'image/png', PNG),
    ));
    expect(message.html).toContain('<img src="cid:logo@x.large">');
    expect(message.html).toContain('<img src="cid:absent@x">');
    expect(message.html).toContain(`<img src="data:image/png;base64,${PNG}">`);
    expect(message.inlineImages).toBe(1);
  });

  it('finds an id a client percent-encoded, whatever its case', () => {
    const inlined = inlineCidImages('<img src="CID:Image001.png%4001DC">', {
      attachments: [{ cid: 'image001.png@01DC', contentType: 'image/jpeg', content: Buffer.from('jpeg') }] as never,
    });
    expect(inlined).toEqual({ html: `<img src="data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}">`, inlined: 1 });
  });

  it('inlines raster images only, and none that are large', () => {
    const big = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1, 1);
    const html = '<img src="cid:vector"><img src="cid:big"><img src="cid:page"><img src="cid:ok">';
    const inlined = inlineCidImages(html, {
      attachments: [
        { cid: 'vector', contentType: 'image/svg+xml', content: Buffer.from('<svg onload="x()"/>') },
        { cid: 'big', contentType: 'image/png', content: big },
        { cid: 'page', contentType: 'text/html', content: Buffer.from('<script>x()</script>') },
        { cid: 'ok', contentType: 'IMAGE/GIF; name=a.gif', content: Buffer.from('gif') },
      ] as never,
    });
    expect(inlined.inlined).toBe(1);
    expect(inlined.html).toContain('cid:vector');
    expect(inlined.html).toContain('cid:big');
    expect(inlined.html).toContain('cid:page');
    expect(inlined.html).toContain('data:image/gif;base64,');
  });

  it('stops at a total budget, so one image repeated cannot multiply the response', () => {
    const image = Buffer.alloc(MAX_INLINE_IMAGE_BYTES, 1);
    const uses = MAX_INLINE_TOTAL_BYTES / MAX_INLINE_IMAGE_BYTES;
    const html = '<img src="cid:hero">'.repeat(uses + 3);
    const inlined = inlineCidImages(html, { attachments: [{ cid: 'hero', contentType: 'image/png', content: image }] as never });
    expect(inlined.html.match(/data:image\/png/g)).toHaveLength(uses);
    expect(inlined.html.match(/cid:hero/g)).toHaveLength(3);
    expect(inlined.inlined).toBe(1);
  });

  it('remembers which parts its markup shows, inlined or not, so a forward can tell its pictures from its files', async () => {
    const message = await parseReadable(related(
      '<img src="cid:Logo@X"><img src="cid:image001.png%4001DC"><img src="cid:absent@x"><img src="https://tracker.example/p.gif">',
      part('logo@x', 'image/png', PNG),
    ));
    expect(message.inlineImages).toBe(1);
    // Lowercased, in the forms a client writes them; a picture that could not be put in is one all the same.
    expect(message.bodyCids).toEqual(expect.arrayContaining(['logo@x', 'image001.png%4001dc', 'image001.png@01dc', 'absent@x']));
    // A message without markup shows no part of itself.
    const plain = await parseReadable(eml(...HEAD, 'Content-Type: text/plain; charset=utf-8', '', 'Hello'));
    expect(plain.bodyCids).toBeUndefined();
    // Markup too large to send to the page is still read for what it shows.
    const huge = await parseReadable(related(`<img src="cid:logo@x"><p>${'x'.repeat(MAX_HTML_BYTES)}</p>`, part('logo@x', 'image/png', PNG)));
    expect(huge.htmlOmitted).toBe(true);
    expect(huge.bodyCids).toEqual(['logo@x']);
  });
});

describe('what the receiving server said about the sender', () => {
  const REAL = 'Authentication-Results: mx.google.com;\r\n'
    + '       dkim=pass header.i=@github.com header.s=pf2023 header.b=abc;\r\n'
    + '       spf=pass (google.com: domain of noreply@github.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=noreply@github.com;\r\n'
    + '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=github.com';

  it('reads the verdict of the server the mailbox lives on', () => {
    expect(parseAuthenticationResults(REAL, 'noreply@github.com')).toEqual({
      result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'github.com',
    });
  });

  const GMAIL = { authserv: { id: 'mx.google.com' } };

  it('hears the mailbox\'s own server first: a header further down cannot overrule it', async () => {
    const forgedBelow = await parseReadable(eml(
      'Authentication-Results: mx.google.com; dkim=fail header.d=paypa1.example; spf=softfail smtp.mailfrom=x@paypa1.example; dmarc=fail header.from=paypal.com',
      'Authentication-Results: mx.google.com; dkim=pass header.d=paypal.com; spf=pass; dmarc=pass header.from=paypal.com',
      'From: PayPal <service@paypal.com>',
      'Subject: Verify your account',
      '',
      'Click here.',
    ), GMAIL);
    expect(forgedBelow.auth).toEqual({ result: 'fail', dkim: 'fail', spf: 'softfail', dmarc: 'fail', signedBy: null });

    const realAbove = await parseReadable(eml(
      ...REAL.split('\r\n'),
      'Authentication-Results: forged.example; dkim=fail; dmarc=fail',
      'From: GitHub <noreply@github.com>',
      'Subject: hello',
      '',
      'hi',
    ), GMAIL);
    expect(realAbove.auth.result).toBe('pass');
    expect(realAbove.auth.signedBy).toBe('github.com');
  });

  it('believes no header that does not name the mailbox\'s own server', async () => {
    // The whole attack: the mailbox's server wrote nothing, the sender wrote this.
    const forged = [
      'Authentication-Results: mx.attacker.example; dkim=pass header.d=paypal.com; spf=pass; dmarc=pass header.from=paypal.com',
      'From: PayPal <service@paypal.com>',
      'Subject: Verify your account',
      '',
      'Click here.',
    ];
    expect((await parseReadable(eml(...forged), GMAIL)).auth.result).toBe('none');
    // A mailbox whose server is not known shows no verdict at all, forged or real.
    expect((await parseReadable(eml(...forged))).auth.result).toBe('none');
    expect((await parseReadable(eml(...REAL.split('\r\n'), 'From: GitHub <noreply@github.com>', '', 'hi'))).auth.result).toBe('none');
    // A name that merely ends like the server's is another server.
    const lookalike = ['Authentication-Results: evilmx.google.com.attacker.example; dmarc=pass', 'From: a@paypal.com', '', 'x'];
    expect((await parseReadable(eml(...lookalike), GMAIL)).auth.result).toBe('none');
    // Microsoft names no server; that form is believed only for a Microsoft mailbox.
    const bare = ['Authentication-Results: spf=pass smtp.mailfrom=paypal.com; dkim=pass header.d=paypal.com; dmarc=pass', 'From: a@paypal.com', '', 'x'];
    expect((await parseReadable(eml(...bare), GMAIL)).auth.result).toBe('none');
    expect((await parseReadable(eml(...bare), { authserv: { bare: true } })).auth.result).toBe('pass');
  });

  it('reads Outlook.com as it really writes it: a named server, a version, and other headers around it', async () => {
    // The shape of twelve out of twelve messages in a live Outlook.com mailbox.
    const outlook = { authserv: authservTrust('outlook.office365.com')! };
    const message = await parseReadable(eml(
      'Received: from a.prod.outlook.com by b.prod.outlook.com',
      'ARC-Authentication-Results: i=2; mx.microsoft.com 1; spf=pass; dmarc=pass; dkim=pass; arc=pass',
      'Received: from c.prod.outlook.com by a.prod.outlook.com',
      'Authentication-Results: mx.microsoft.com 1; spf=pass (sender ip is 192.0.2.9) smtp.rcpttodomain=live.com'
        + ' smtp.mailfrom=github.com; dmarc=pass (p=reject sp=reject pct=100) action=none header.from=github.com;'
        + ' dkim=pass (signature was verified) header.d=github.com; compauth=pass reason=100',
      'ARC-Authentication-Results: i=1; mx.microsoft.com 1; spf=pass; dmarc=pass; dkim=pass; arc=none',
      'From: GitHub <noreply@github.com>',
      'Subject: hello',
      '',
      'hi',
    ), outlook);
    expect(message.auth).toEqual({ result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'github.com' });
    // The business service writes no name, and is still believed for a Microsoft mailbox.
    const bare = await parseReadable(eml(
      'Authentication-Results: spf=pass smtp.mailfrom=contoso.com; dkim=pass header.d=contoso.com; dmarc=pass header.from=contoso.com',
      'From: it@contoso.com', '', 'hi',
    ), outlook);
    expect(bare.auth.result).toBe('pass');
    // Someone else's server name on top is still someone else's.
    const stranger = await parseReadable(eml(
      'Authentication-Results: mx.attacker.example 1; dmarc=pass header.from=github.com',
      'From: GitHub <noreply@github.com>', '', 'hi',
    ), outlook);
    expect(stranger.auth.result).toBe('none');
  });

  it('knows what the common providers call their receiving server', () => {
    expect(authservTrust('imap.gmail.com')).toEqual({ id: 'mx.google.com' });
    expect(authservTrust('outlook.office365.com')).toEqual({ id: 'mx.microsoft.com', bare: true });
    expect(authservTrust('imap.mail.yahoo.com')).toEqual({ id: 'yahoo.com', subdomains: true });
    expect(authservTrust('imap.mail.me.com')).toEqual({ id: 'icloud.com', subdomains: true, perCheck: true });
    expect(authservTrust('imap.fastmail.com')).toEqual({ id: 'messagingengine.com', subdomains: true });
    // Read from a live QQ mailbox: its own header opens with exactly this name.
    expect(authservTrust('imap.qq.com')).toEqual({ id: 'mx.qq.com' });
    // Unknown until the operator says: no verdict is better than a forgeable one.
    // QQ's business mail was not looked at, and a name that merely ends alike is not QQ.
    expect(authservTrust('imap.exmail.qq.com')).toBeUndefined();
    expect(authservTrust('imap.qq.com.example')).toBeUndefined();
    expect(authservTrust('mail.example.org')).toBeUndefined();
    expect(authservTrust('notgmail.com.example')).toBeUndefined();
    expect(authservTrust('mail.example.org', 'MX.Example.org.')).toEqual({ id: 'mx.example.org', subdomains: true });
    expect(authservTrust('imap.gmail.com', 'none')).toBeUndefined();
    expect(authservTrust('mail.example.org', 'mx example;dmarc=pass')).toBeUndefined();
  });

  it('believes only the first header: a second one under the same name is what a sender would add', async () => {
    // The real header says nothing about DKIM or DMARC, and the copy below it supplies both.
    const lines = [
      'Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=bounce@evil.example',
      'Received: from evil.example by mx.google.com',
      'Authentication-Results: mx.google.com; dkim=pass header.i=@bank.example; dmarc=pass header.from=bank.example',
      'From: CEO <ceo@bank.example>',
      'Subject: Wire transfer',
      '',
      'Today, please.',
    ];
    const message = await parseReadable(eml(...lines), GMAIL);
    expect(message.auth).toEqual({ result: 'none', dkim: null, spf: 'pass', dmarc: null, signedBy: null });
    // The same for a name the operator configured, and for Microsoft's nameless form.
    const configured = lines.map((line) => line.replace(/mx\.google\.com;/, 'mx.corp.example;'));
    expect((await parseReadable(eml(...configured), { authserv: { id: 'mx.corp.example', subdomains: true } })).auth.result).toBe('none');
    const bare = lines.map((line) => line.replace(/ mx\.google\.com;/, ''));
    expect((await parseReadable(eml(...bare), { authserv: { bare: true } })).auth.result).toBe('none');
  });

  it('reads a provider that writes one header per check, and stops at a stranger or a repeat', () => {
    const icloud = { id: 'icloud.com', subdomains: true, perCheck: true };
    const headers = [
      'Authentication-Results: bimi.icloud.com; bimi=skipped reason="insufficient dmarc"',
      'Authentication-Results: dmarc.icloud.com; dmarc=fail header.from=paypal.com',
      'Authentication-Results: dkim-verifier.icloud.com; dkim=fail (bad signature) header.d=paypal.com',
      'Authentication-Results: spf.icloud.com; spf=softfail smtp.mailfrom=x@attacker.example',
      // What the sender put in, hoping to be read as one more of the above.
      'Authentication-Results: dkim-verifier.icloud.com; dkim=pass header.d=paypal.com; dmarc=pass',
    ];
    expect(mailboxAuthHeaders(headers, icloud)).toEqual(headers.slice(0, 4));
    expect(parseAuthenticationResults(mailboxAuthHeaders(headers, icloud), 'service@paypal.com')).toEqual({
      result: 'fail', dkim: 'fail', spf: 'softfail', dmarc: 'fail', signedBy: null,
    });
    // A real run reads as one verdict.
    const real = [
      'Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=github.com',
      'Authentication-Results: dkim-verifier.icloud.com; dkim=pass header.d=github.com',
      'Authentication-Results: spf.icloud.com; spf=pass',
    ];
    expect(parseAuthenticationResults(mailboxAuthHeaders(real, icloud), 'noreply@github.com')).toEqual({
      result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'github.com',
    });
    const stranger = [headers[0]!, 'Authentication-Results: mx.attacker.example; dmarc=pass', headers[1]!];
    expect(mailboxAuthHeaders(stranger, icloud)).toEqual([headers[0]]);
    expect(mailboxAuthHeaders(headers, undefined)).toEqual([]);
    // Everyone else writes one header, and only that one is taken.
    expect(mailboxAuthHeaders([headers[1]!, headers[2]!], { id: 'icloud.com', subdomains: true })).toEqual([headers[1]]);
    // A name under the server's own counts only where the provider is known to use such names.
    expect(mailboxAuthHeaders(['Authentication-Results: evil.mx.google.com; dmarc=pass'], { id: 'mx.google.com' })).toEqual([]);
  });

  it('accepts a signature by the From domain, or one above it, when the server reports no DMARC result', () => {
    const header = 'Authentication-Results: mx.qq.com; spf=pass smtp.mailfrom=bounce@mail.stripe.com; dkim=pass header.d=stripe.com header.s=s1';
    expect(parseAuthenticationResults(header, 'billing@stripe.com')).toMatchObject({ result: 'pass', dmarc: null, signedBy: 'stripe.com' });
    expect(parseAuthenticationResults(header, 'receipts@billing.stripe.com')).toMatchObject({ result: 'pass', signedBy: 'stripe.com' });
  });

  it('does not let a subdomain vouch for the domain above it without the server\'s own DMARC verdict', () => {
    // Anyone can own a name under a shared one (a hosting platform, a dynamic
    // DNS zone) and sign with it. That says nothing about the parent.
    const child = 'Authentication-Results: mx.example; dkim=pass header.i=@evil.github.io';
    expect(parseAuthenticationResults(child, 'security@github.io')).toMatchObject({ result: 'none', signedBy: 'evil.github.io' });
    // When the server did check DMARC and it failed, a related signature changes nothing.
    const failed = 'Authentication-Results: mx.example; dkim=pass header.i=@evil.github.io; dmarc=fail header.from=github.io';
    expect(parseAuthenticationResults(failed, 'security@github.io').result).toBe('fail');
    const exactButFailed = 'Authentication-Results: mx.example; dkim=pass header.d=bank.example; dmarc=fail header.from=bank.example';
    expect(parseAuthenticationResults(exactButFailed, 'ceo@bank.example').result).toBe('fail');
    // And when it passed, it passed: the server knows where an organisation ends.
    const passed = 'Authentication-Results: mx.example; dkim=pass header.d=mail.stripe.com; dmarc=pass header.from=stripe.com';
    expect(parseAuthenticationResults(passed, 'billing@stripe.com')).toMatchObject({ result: 'pass', signedBy: 'mail.stripe.com' });
    // DMARC can pass on SPF alone; then no signature is named as the sender's.
    const spfOnly = 'Authentication-Results: mx.example; dkim=pass header.d=sendgrid.net; spf=pass; dmarc=pass header.from=shop.example';
    expect(parseAuthenticationResults(spfOnly, 'orders@shop.example')).toMatchObject({ result: 'pass', signedBy: null });
  });

  it('cannot be talked into a result by text the server quoted or commented', () => {
    // A local part the sender chose, copied into the genuine header inside quotes.
    const quoted = 'Authentication-Results: mx.google.com; spf=pass smtp.mailfrom="a;dkim=pass header.d=bank.example;b"@evil.example';
    expect(parseAuthenticationResults(quoted, 'ceo@bank.example')).toEqual({ result: 'none', dkim: null, spf: 'pass', dmarc: null, signedBy: null });
    // The same trick aimed at the comment a server writes around an address.
    const commented = 'Authentication-Results: mx.google.com; spf=pass (google.com: domain of "x) ; dmarc=pass ; dkim=pass header.d=bank.example (y"@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=evil.example';
    expect(parseAuthenticationResults(commented, 'ceo@bank.example')).toMatchObject({ result: 'none', dkim: null, dmarc: null });
    // A quote that never closes takes the rest of the line with it: less is read, never more.
    const open = 'Authentication-Results: mx.google.com; spf=softfail smtp.mailfrom="x; dkim=pass header.d=bank.example; dmarc=pass';
    expect(parseAuthenticationResults(open, 'ceo@bank.example')).toMatchObject({ result: 'none', dkim: null, dmarc: null });
  });

  it('does not take a signature from an unrelated domain as the sender\'s', () => {
    // A bulk sender signs with its own domain; that vouches for the relay, not for From.
    const header = 'Authentication-Results: mx.example; dkim=pass header.d=sendgrid.net; spf=pass';
    expect(parseAuthenticationResults(header, 'ceo@yourbank.example')).toEqual({
      result: 'none', dkim: 'pass', spf: 'pass', dmarc: null, signedBy: 'sendgrid.net',
    });
    // Whole labels from the right: a lookalike suffix is not alignment.
    const lookalike = 'Authentication-Results: mx.example; dkim=pass header.d=github.com.evil.example';
    expect(parseAuthenticationResults(lookalike, 'noreply@github.com').result).toBe('none');
  });

  it('prefers the signature that speaks for the sender among several', () => {
    const header = 'Authentication-Results: mx.example; dkim=pass header.i=@mailgun.org; dkim=pass header.i=bot@notify.github.com; dkim=fail header.d=other.example';
    // Named, because it is the one related to the sender; not believed alone, because it is a subdomain's.
    expect(parseAuthenticationResults(header, 'noreply@github.com')).toMatchObject({ result: 'none', dkim: 'pass', signedBy: 'notify.github.com' });
    expect(parseAuthenticationResults(`${header}; dmarc=pass`, 'noreply@github.com')).toMatchObject({ result: 'pass', signedBy: 'notify.github.com' });
    const exact = 'Authentication-Results: mx.example; dkim=pass header.i=@mailgun.org; dkim=pass header.d=github.com';
    expect(parseAuthenticationResults(exact, 'noreply@github.com')).toMatchObject({ result: 'pass', signedBy: 'github.com' });
  });

  it('calls it failed only on a failed policy, or when both mechanisms failed', () => {
    const both = 'Authentication-Results: mx.example; dkim=fail (bad signature) header.d=x.example; spf=softfail';
    expect(parseAuthenticationResults(both, 'a@x.example').result).toBe('fail');
    // SPF alone breaks on every forward; that is not a verdict.
    const forwarded = 'Authentication-Results: mx.example; dkim=none; spf=softfail';
    expect(parseAuthenticationResults(forwarded, 'a@x.example')).toMatchObject({ result: 'none', dkim: 'none', spf: 'softfail' });
    expect(parseAuthenticationResults('Authentication-Results: mx.example; dmarc=fail (p=NONE) header.from=x.example', 'a@x.example').result).toBe('fail');
  });

  it('reads the header Outlook writes, which names no server first', () => {
    const header = 'Authentication-Results: spf=pass (sender IP is 192.0.2.9) smtp.mailfrom=contoso.com; dkim=pass (signature was verified) header.d=contoso.com;dmarc=pass action=none header.from=contoso.com;compauth=pass reason=100';
    expect(parseAuthenticationResults(header, 'it@contoso.com')).toEqual({
      result: 'pass', dkim: 'pass', spf: 'pass', dmarc: 'pass', signedBy: 'contoso.com',
    });
  });

  it('is not talked into a result by the prose of a comment', () => {
    const header = 'Authentication-Results: mx.example; spf=neutral (sender says dmarc=pass and dkim=pass (really)) smtp.mailfrom=x';
    expect(parseAuthenticationResults(header, 'a@x.example')).toEqual({
      result: 'none', dkim: null, spf: 'neutral', dmarc: null, signedBy: null,
    });
  });

  it('says nothing when the server said nothing', async () => {
    expect(parseAuthenticationResults(undefined, 'a@x.example')).toEqual({
      result: 'none', dkim: null, spf: null, dmarc: null, signedBy: null,
    });
    const message = await parseReadable(eml(...HEAD, '', 'plain'));
    expect(message.auth.result).toBe('none');
  });
});

describe('unsubscribing', () => {
  it('offers the https target, even when a mailto comes first', async () => {
    const message = await parseReadable(eml(
      ...HEAD,
      'List-Unsubscribe: <mailto:unsub@news.example?subject=stop>,',
      ' <https://news.example/unsubscribe?u=42&t=abc>',
      '',
      'news',
    ));
    expect(message.unsubscribe).toBe('https://news.example/unsubscribe?u=42&t=abc');
  });

  it('offers nothing it would not want a reader to follow', () => {
    expect(unsubscribeUrl('List-Unsubscribe: <mailto:unsub@news.example>')).toBeNull();
    expect(unsubscribeUrl('List-Unsubscribe: <http://news.example/u>')).toBeNull();
    expect(unsubscribeUrl('List-Unsubscribe: <javascript:alert(1)>')).toBeNull();
    expect(unsubscribeUrl('List-Unsubscribe: <https://user:pw@news.example/u>')).toBeNull();
    expect(unsubscribeUrl('List-Unsubscribe: https://news.example/u')).toBeNull();
    expect(unsubscribeUrl(`List-Unsubscribe: <https://news.example/${'a'.repeat(3000)}>`)).toBeNull();
    expect(unsubscribeUrl(undefined)).toBeNull();
    expect(unsubscribeUrl('List-Unsubscribe: <https://>, <https://ok.example/u>')).toBe('https://ok.example/u');
  });
});

describe('limits and damage', () => {
  it('withholds markup too large to lay out, and still has the words', async () => {
    const filler = `<p>${'x'.repeat(1000)}</p>`.repeat(Math.ceil(MAX_HTML_BYTES / 1000));
    const message = await parseReadable(eml(
      ...HEAD,
      'Content-Type: text/html; charset=utf-8',
      '',
      `<p>Opening line.</p>${filler}`,
    ));
    expect(message.html).toBeNull();
    expect(message.htmlOmitted).toBe(true);
    expect(message.text.startsWith('Opening line.')).toBe(true);
    expect(message.truncated).toBe(true);
  });

  it('answers with empty fields for something that is not a message', async () => {
    const empty = {
      html: null, htmlOmitted: false, text: '', quoted: '', truncated: false,
      from: null, to: [], cc: [], replyTo: [], subject: '', date: null,
      messageId: null, inReplyTo: null, references: [],
      auth: { result: 'none', dkim: null, spf: null, dmarc: null, signedBy: null },
      unsubscribe: null, inlineImages: 0,
    };
    expect(await parseReadable(Buffer.alloc(0))).toEqual(empty);
    expect(await parseReadable(undefined as unknown as Buffer)).toEqual(empty);
    const garbage = await parseReadable(Buffer.from([0, 1, 2, 255, 254, 13, 10, 13, 10, 0, 0, 200]));
    expect(garbage.html).toBeNull();
    expect(garbage.from).toBeNull();
    expect(garbage.auth.result).toBe('none');
  });

  it('survives a message whose structure promises parts it does not have', async () => {
    const message = await parseReadable(eml(
      ...HEAD,
      'Content-Type: multipart/mixed; boundary="never-closed"',
      '',
      '--never-closed',
      'Content-Type: text/plain; charset="no-such-charset"',
      'Content-Transfer-Encoding: base64',
      '',
      '!!!not base64!!!',
    ));
    expect(message.subject).toBe('Invoice #4821');
    expect(typeof message.text).toBe('string');
  });
});
