# mailsift signal event v1

mailsift keeps the existing `mail` / `triage` WebhookWise payload and adds a
source-neutral `signal` object. This lets a downstream work system consume a
small event without copying the message body through every hop.

```json
{
  "schema": "signal.v1",
  "source": "mailsift",
  "type": "email.received",
  "source_event_id": "<message-id>",
  "occurred_at": "2026-09-16T10:00:00.000Z",
  "title": "Domain renewal notice",
  "summary": "example.com expires on 2026-09-20; renew it to avoid service interruption.",
  "priority": "critical",
  "dedup_key": "account@example.com|<message-id>",
  "evidence_ref": {
    "kind": "mcp",
    "uri": "mailsift://mail/%3Cmessage-id%3E"
  },
  "payload": {
    "account": "account@example.com",
    "account_label": "personal",
    "provider": "imap",
    "folder": "INBOX",
    "in_spam": false,
    "from": "billing@example.com",
    "from_name": "Example Billing",
    "category": "Renewal",
    "deadline": "2026-09-20",
    "has_attachments": false
  }
}
```

The event contains a decision-ready summary and metadata, not the raw body.
Consumers that need more context use the `evidence_ref` URI with the authenticated
mailsift MCP server's Resource API. The reference contains an identifier only; it
never carries credentials or tokens.
