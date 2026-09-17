import { dedupKey, type MailMessage } from '../imap/message.js';
import { headline, type TriageResult } from './triage.js';

/**
 * The source-neutral event sent alongside the legacy WebhookWise payload.
 *
 * It deliberately contains a useful summary but no message body. Consumers
 * that need more context can use the MCP evidence reference to query mailsift.
 */
export interface MailSignalEvent {
  schema: 'signal.v1';
  source: 'mailsift';
  type: 'email.received';
  source_event_id: string;
  occurred_at: string;
  title: string;
  summary: string;
  priority: TriageResult['importance'];
  dedup_key: string;
  evidence_ref: {
    kind: 'mcp';
    uri: string;
  };
  payload: {
    account: string;
    account_label: string;
    provider: string;
    folder: string;
    in_spam: boolean;
    from: string;
    from_name: string;
    category: string;
    deadline: string;
    has_attachments: boolean;
  };
}

export function buildMailSignalEvent(message: MailMessage, result: TriageResult): MailSignalEvent {
  return {
    schema: 'signal.v1',
    source: 'mailsift',
    type: 'email.received',
    source_event_id: message.messageId,
    occurred_at: message.date,
    title: message.subject || '(no subject)',
    summary: headline(result),
    priority: result.importance,
    dedup_key: dedupKey(message),
    evidence_ref: {
      kind: 'mcp',
      uri: `mailsift://imap/${encodeURIComponent(message.account)}/${encodeURIComponent(message.messageId)}`,
    },
    payload: {
      account: message.account,
      account_label: message.accountLabel,
      provider: message.provider,
      folder: message.folder,
      in_spam: message.inSpam,
      from: message.fromAddr,
      from_name: message.fromName,
      category: result.category,
      deadline: result.deadline,
      has_attachments: message.hasAttachments,
    },
  };
}
