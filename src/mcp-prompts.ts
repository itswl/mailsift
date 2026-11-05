/**
 * Prompts: the workflows this server's tools are meant to be used in.
 *
 * The tools answer single questions, and a model asked something broad ("did I
 * miss anything?") has to guess the order to call them in. It usually starts
 * with a search, which is the one tool that cannot answer a question about what
 * was *not* delivered. Each prompt here fixes an order that works, names the
 * tools by hand, and says when to stop.
 *
 * The renderers are pure so the tests can read them; the register functions are
 * thin. MCP prompt arguments are always strings.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SEARCH_SYNTAX_URI } from './mcp-syntax.js';

const hours = z
  .string()
  .regex(/^\d{1,5}$/, 'a whole number of hours')
  .describe('How far back to look, in hours. 24 for a day, 168 for a week.');

export const CATCH_UP = 'catch_up';
export const WHY_NOT_NOTIFIED = 'why_not_notified';
export const REVIEW_TRIAGE = 'review_triage';

export function renderCatchUp(args: { hours: string; focus?: string | undefined }): string {
  const focus = args.focus?.trim();
  return [
    `Report what arrived in the last ${args.hours} hours and what needs the mailbox owner to act. The mailbox is read-only.`,
    focus ? `Pay particular attention to: ${focus}` : '',
    '',
    'Steps:',
    `1. Call mail_summary with hours=${args.hours} for the totals, so you know the size of what you are about to read.`,
    `2. Call list_mail with hours=${args.hours} and importance="critical", then again with importance="warning". These are what was judged worth interrupting someone for.`,
    `3. Call list_digest for what is queued but not yet sent. A message is there because it was judged below the push threshold, not because it is unimportant${focus ? ', and it is where a missed item matching the focus above is most likely to be' : ''}.`,
    '4. Only open a message with get_mail when its summary is not enough to say what it asks for.',
    '',
    'Then report, in this order:',
    '- Anything with a deadline, soonest first, with the date.',
    '- Anything where action_required is true, grouped by category.',
    '- One line for everything else, by category, with counts rather than a list.',
    '',
    'Rules:',
    '- The summaries are a model\'s judgement of mail it saw once, not fact. Say "judged critical", not "is critical".',
    '- Never guess at a message you did not read. If a summary is unclear, say so and give the Message-ID.',
    '- Verification codes and sign-in links are deliberately not stored. Say one arrived; never claim to know the code.',
    `- Read ${SEARCH_SYNTAX_URI} if you need a filter this does not name.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function renderWhyNotNotified(args: { about: string }): string {
  return [
    `Work out why this did not reach the mailbox owner as a notification: ${args.about}`,
    '',
    'A message reaches someone only if it was fetched, judged at or above the push threshold, and delivered. Check those in order; stop at the first that explains it.',
    '',
    'Steps:',
    '1. Call health. Its delivery block reports the push threshold, the digest settings, the spam bonus and whether self-forwards are suppressed. Its account block reports any mailbox that is failing, and healthy is false while one is at the alert threshold. Most answers are here.',
    '2. If every mailbox is being read, call search_mail for the message. Found and pushed=false means it was judged below the threshold: report its importance, category and reason, and that the digest carries it.',
    '3. Not found at all means it was never fetched. Call recovery_status for folder progress and list_dead_letters for messages that were skipped as oversized or unparseable. Check with list_accounts that the mailbox and folder are even monitored.',
    '4. Found and pushed=true means mailsift delivered it. Call recovery_status for anything still queued in the outbox, with its next attempt time; a queued entry means delivery genuinely failed.',
    '',
    'Then say, in one paragraph: where it stopped, which setting or failure caused that, and the one change that would have delivered it. Name the setting.',
    '',
    'Rules:',
    '- Do not propose lowering PUSH_MIN_IMPORTANCE or raising SPAM_RANK_BONUS without saying what else that would start delivering.',
    '- If the evidence does not single out one cause, say which two remain and what would tell them apart.',
  ].join('\n');
}

export function renderReviewTriage(args: { hours: string }): string {
  return [
    `Review how mail from the last ${args.hours} hours was judged, and record feedback where it was wrong.`,
    '',
    'Steps:',
    `1. Call list_mail with hours=${args.hours} and read each summary, reason and importance.`,
    '2. Call feedback_rules for the sender rules already inferred, so you do not propose one that exists.',
    '3. Group what you find: notified but not worth interrupting someone (false_positive), left for the digest but clearly needed attention (missed), and judged well (correct).',
    '4. Show the groups and ask which to record. Do not call record_feedback before the answer.',
    '5. Record only what was confirmed, one call per message, with the label and a short note.',
    '',
    'Rules:',
    '- Two feedback records for one sender become a standing rule, so propose feedback only when the sender would always be judged that way, not just this once.',
    '- Mail decided by a rule rather than the model is already settled; feedback on it changes nothing. Say so instead of recording it.',
    '- Never record feedback on a verification code or a sign-in link. Those are judged locally on purpose.',
  ].join('\n');
}

/** Write-capable prompts are registered only where the write tools exist. */
export function registerPrompts(server: McpServer, options: { writable: boolean }): void {
  server.registerPrompt(
    CATCH_UP,
    {
      title: 'Catch up on the mailbox',
      description:
        'Report what arrived and what needs action, reading the judgements and the pending digest rather than searching.',
      argsSchema: {
        hours,
        focus: z.string().optional().describe('Optional: what matters most this time, in plain language.'),
      },
    },
    (args) => ({
      description: `What arrived in the last ${args.hours} hours`,
      messages: [{ role: 'user', content: { type: 'text', text: renderCatchUp(args) } }],
    }),
  );

  server.registerPrompt(
    WHY_NOT_NOTIFIED,
    {
      title: 'Why was I not notified',
      description:
        'Diagnose a missing notification in order: mailbox read, judged above the threshold, delivered.',
      argsSchema: {
        about: z
          .string()
          .min(1)
          .describe('The message that should have arrived: a sender, a subject, or what it was about.'),
      },
    },
    (args) => ({
      description: `Why nothing arrived about: ${args.about}`,
      messages: [{ role: 'user', content: { type: 'text', text: renderWhyNotNotified(args) } }],
    }),
  );

  if (!options.writable) return;

  server.registerPrompt(
    REVIEW_TRIAGE,
    {
      title: 'Review recent judgements',
      description:
        'Go through how recent mail was judged and record feedback on what was wrong. Asks before recording anything.',
      argsSchema: { hours },
    },
    (args) => ({
      description: `Review the last ${args.hours} hours of judgements`,
      messages: [{ role: 'user', content: { type: 'text', text: renderReviewTriage(args) } }],
    }),
  );
}
