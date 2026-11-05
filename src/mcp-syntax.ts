/**
 * `mailsift://search-syntax`: the page a model reads before filtering mail.
 *
 * Every filter a caller can set, the vocabulary it is matched against, and the
 * rules that decide what is even in the database. The vocabularies are rendered
 * from the constants the triage code itself uses, so this page cannot tell a
 * caller about a category that no longer exists, or omit one that was added.
 *
 * Pure: no credentials, no mail, no state. Rendered on every read.
 */
import { IMPORTANCE } from './config.js';
import { CATEGORIES, RULE_CATEGORIES } from './services/triage.js';

export const SEARCH_SYNTAX_URI = 'mailsift://search-syntax';

interface FilterDoc {
  name: string;
  tools: string;
  notes: string;
}

/** One row per filter the mail-listing tools accept, in the order they are applied. */
const FILTERS: readonly FilterDoc[] = [
  {
    name: 'hours',
    tools: 'list_mail, list_threads, mail_summary',
    notes: 'How far back to look, in hours. Default 24. Counted from now, not from midnight.',
  },
  {
    name: 'importance',
    tools: 'list_mail',
    notes: `Exactly one of ${IMPORTANCE.join(', ')}. Omit it for every level.`,
  },
  {
    name: 'category',
    tools: 'list_mail',
    notes: 'Exact match on one of the categories below. Use search_mail for a substring match.',
  },
  {
    name: 'account',
    tools: 'list_mail, list_threads, search_mail',
    notes: 'One mailbox address, exactly as list_accounts returns it.',
  },
  {
    name: 'spamOnly',
    tools: 'list_mail',
    notes: 'true keeps only mail that was filed in a spam folder. Spam is triaged like any other mail.',
  },
  {
    name: 'pushedOnly',
    tools: 'list_mail',
    notes: 'true keeps only what was delivered in real time. Everything else waited for the digest.',
  },
  {
    name: 'limit / cursor',
    tools: 'list_mail, search_mail, list_threads',
    notes: 'Page size, then the opaque nextCursor from the previous page. A full page always returns nextCursor.',
  },
  {
    name: 'query',
    tools: 'search_mail',
    notes:
      'Substring match over subject, Message-ID, sender, category, summary, reason, the stored body preview and attachment metadata. One string, no operators.',
  },
];

/** Grounded in what the tools actually answer, so a model does not ask for what is not stored. */
const NOT_STORED: readonly string[] = [
  'Full message bodies. Only a bounded preview is stored. Read mailsift://imap/{account}/{messageId} to fetch one body live from the mailbox.',
  'Attachment contents. Only names, MIME types, part ids and sizes are stored; list_attachments fetches a file on demand.',
  'Verification codes and sign-in links from mail that was judged locally. Those are deliberately kept out of stored text.',
  'Anything older than STATE_RETENTION_DAYS, which defaults to 90 days.',
];

export function renderSearchSyntax(): string {
  const lines = [
    '# mailsift search syntax',
    '',
    'mailsift watches mailboxes over IMAP, judges each message, and stores the judgement.',
    'These tools read that store. They never fetch a mailbox unless a tool says it does, and they never change mail.',
    '',
    '## Filters',
    '',
    '| Filter | Tools | Notes |',
    '| --- | --- | --- |',
    ...FILTERS.map((f) => `| \`${f.name}\` | ${f.tools} | ${f.notes} |`),
    '',
    '## Importance',
    '',
    `Triage rates every message ${IMPORTANCE.map((i) => `\`${i}\``).join(', ')}.`,
    'What is pushed in real time is set by the deployment (`PUSH_MIN_IMPORTANCE`, `warning` by default); the rest waits for the daily digest.',
    'A level is a judgement about this mailbox owner, not a property of the message: call health to see the thresholds in force.',
    '',
    '## Categories',
    '',
    'A fixed vocabulary, so `category` is an exact match. Anything a model returned outside it was folded into `Other`.',
    '',
    ...CATEGORIES.map((c) => `- \`${c}\``),
    '',
    'Mail decided by a rule instead of the model carries one of these instead:',
    '',
    ...Object.values(RULE_CATEGORIES).map((c) => `- \`${c}\``),
    '',
    '## What is not in the store',
    '',
    ...NOT_STORED.map((line) => `- ${line}`),
    '',
    '## Worked examples',
    '',
    '**Critical mail from the last three days.**',
    '',
    '```json',
    JSON.stringify({ tool: 'list_mail', arguments: { hours: 72, importance: 'critical' } }, null, 2),
    '```',
    '',
    '**What a sender wrote, whatever it was judged.** `search_mail` covers the sender field, so the address is enough.',
    '',
    '```json',
    JSON.stringify({ tool: 'search_mail', arguments: { query: 'billing@example.com', hours: 720 } }, null, 2),
    '```',
    '',
    '**Bills that were never pushed.** These are the ones the digest carried, so they are easy to miss.',
    '',
    '```json',
    JSON.stringify({ tool: 'list_mail', arguments: { hours: 168, category: 'Finance' } }, null, 2),
    '```',
    '',
    '**Why a message did not reach me.** Start with `health`: its `delivery` block reports the thresholds, the spam bonus and whether self-forwards are suppressed, which explains most of these without further digging. `recovery_status` then shows anything still queued.',
    '',
  ];
  return lines.join('\n');
}
