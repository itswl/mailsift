# mailsift signal event v1

mailsift keeps the existing `mail` / `triage` webhook payload and adds a
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
    "uri": "mailsift://imap/account%40example.com/%3Cmessage-id%3E"
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
Consumers that need more context use the `evidence_ref` URI with the mailsift MCP
server's Resource API. The reference is Bearer-authenticated only when
`MCP_TOKEN` is configured. A loopback listener with an empty token is intentionally
unauthenticated and must not be exposed beyond the host.

The IMAP Resource fetches a bounded normalized body on demand, in read-only mode,
and does not persist it. Lookup is bounded by `MCP_LIVE_BODY_CHARS`,
`MCP_LIVE_SOURCE_BYTES`, `MCP_LIVE_LOOKBACK_DAYS`, and
`MCP_LIVE_SEARCH_MAX_MESSAGES`; an over-limit lookup fails rather than scanning
without a bound. The reference contains identifiers only; it never carries
credentials or tokens.
