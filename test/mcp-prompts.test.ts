import { describe, expect, it } from 'vitest';
import './setup.js';
import { renderCatchUp, renderReviewTriage, renderWhyNotNotified } from '../src/mcp-prompts.js';

describe('catch_up', () => {
  it('reads the judgements and the pending digest rather than searching', () => {
    const text = renderCatchUp({ hours: '24' });
    expect(text).toContain('mail_summary');
    expect(text).toContain('list_mail');
    // The digest queue is the half a search would miss: it was never delivered.
    expect(text).toContain('list_digest');
    expect(text).not.toContain('search_mail');
  });

  it('starts from the queue, which is what "needs action" means, and changes nothing', () => {
    const text = renderCatchUp({ hours: '24' });
    expect(text.indexOf('needs_you')).toBeGreaterThan(-1);
    expect(text.indexOf('needs_you')).toBeLessThan(text.indexOf('mail_summary'));
    expect(text).toContain('change nothing');
    expect(text).not.toContain('mark_handled');
    // The page can act on mail now; the prompt no longer says the mailbox cannot be changed.
    expect(text).not.toContain('read-only');
  });

  it('carries the window into every step, so the model does not pick its own', () => {
    expect(renderCatchUp({ hours: '168' }).match(/168/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('mentions the focus only when one was given', () => {
    expect(renderCatchUp({ hours: '24' })).not.toContain('Pay particular attention');
    expect(renderCatchUp({ hours: '24', focus: 'invoices' })).toContain('invoices');
  });

  it('says the judgements are a model opinion, not fact', () => {
    expect(renderCatchUp({ hours: '24' })).toContain('judged critical');
  });

  it('forbids claiming to know a code, which is never stored', () => {
    expect(renderCatchUp({ hours: '24' })).toContain('never claim to know the code');
  });
});

describe('why_not_notified', () => {
  const text = renderWhyNotNotified({ about: 'the renewal notice from my registrar' });

  it('repeats what is being looked for', () => {
    expect(text).toContain('renewal notice from my registrar');
  });

  it('starts at health, which answers most of these on its own', () => {
    expect(text.indexOf('health')).toBeLessThan(text.indexOf('search_mail'));
  });

  it('covers all three ways a message fails to arrive', () => {
    expect(text).toContain('below the threshold');
    expect(text).toContain('never fetched');
    expect(text).toContain('outbox');
  });

  it('refuses a fix whose cost is unstated', () => {
    expect(text).toContain('PUSH_MIN_IMPORTANCE');
    expect(text).toContain('what else that would start delivering');
  });
});

describe('review_triage', () => {
  const text = renderReviewTriage({ hours: '72' });

  it('asks before recording anything, because feedback becomes a standing rule', () => {
    expect(text).toContain('Do not call record_feedback before the answer');
    expect(text).toContain('become a standing rule');
  });

  it('checks the rules that already exist first', () => {
    expect(text).toContain('feedback_rules');
  });

  it('leaves rule-decided and locally judged mail alone', () => {
    expect(text).toContain('already settled');
    expect(text).toContain('Never record feedback on a verification code');
  });
});
