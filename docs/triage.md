# Triage

This page explains how mailsift decides what a message is worth, and what it sends to the LLM.

- [How a message is judged](#how-a-message-is-judged)
- [What the model is shown](#what-the-model-is-shown)
- [The LLM](#the-llm)
- [Two-stage triage](#two-stage-triage)
- [When the LLM fails](#when-the-llm-fails)
- [Verification codes and sign-in links](#verification-codes-and-sign-in-links)

## How a message is judged

1. A forwarded copy of mail that another of your mailboxes already received is recorded but not judged again (`SUPPRESS_SELF_FORWARDS`; see [Configuration](configuration.md#mailboxes-and-folders)).
2. Sender rules decide without the LLM: `MAIL_ALWAYS_IMPORTANT`, `MAIL_NEVER_IMPORTANT`, and the rules inferred from feedback (see [Configuration](configuration.md#your-own-rules)).
3. The content of verification codes, one-time passwords and sign-in links never reaches the LLM (see [below](#verification-codes-and-sign-in-links)).
4. Everything else goes to the LLM in batches of `LLM_BATCH_SIZE` (default `10`), or through the two-stage pipeline when that is configured.
5. Without an LLM, or when a call fails, the local keyword fallback decides.

The result is a level (`critical`, `warning` or `info`), a category, a one-line summary, the reason, and a deadline when there is one. The level decides what is pushed and what waits for the digest (see [Configuration](configuration.md#what-gets-pushed)).

## What the model is shown

Before any of this, the body is cleaned: the quoted history below a reply, and the signature at the end, are removed.

The budget is the reason. Only the first `LLM_BODY_CHARS` of a body (1200 by default) is sent, and the stored preview is shorter still, so a reply that answers in one line would otherwise spend the rest of both on last week's mail and a footer. Three quote markers are recognised, in English and in what QQ, 163, Foxmail and Outlook write in Chinese: an attribution line (`On ... wrote:`, `... 写道：`), an original-message separator, and a header block (`From:`/`Sent:`/`To:`, `发件人：`/`发送时间：`/`收件人：`). A forwarded message is deliberately kept, header block and all, because its content is usually the point.

Both steps give the whole text back when they would leave nothing, and the signature is kept when under 200 characters would be left, so a message that is only "Thanks" or only a quoted block still reaches triage intact. Cleaning happens once, when the message is first read, so it also shapes the stored preview, the digest and what `search_mail` matches on. The full body is untouched: `mailsift://imap/{account}/{messageId}` still fetches the message as the mailbox has it.

## The LLM

Pick a provider preset with `LLM_PROVIDER`, `LLM_MODEL` and `LLM_API_KEY`; `.env.example` lists the presets. For any other OpenAI-compatible endpoint, a self-hosted one included, leave `LLM_PROVIDER` empty and set `LLM_BASE_URL`.

The LLM integration is OpenAI-compatible: mailsift posts to `${LLM_BASE_URL}/chat/completions` with `model`, `messages`, and (when enabled) `response_format: {"type":"json_object"}`. The response must provide JSON in `choices[0].message.content` with one result per input index. Set `LLM_JSON_MODE=false` for providers that reject `response_format`; mailsift also retries once without it when the rejection is explicit.

`LLM_OUTPUT_LANGUAGE` sets the language of summaries and reasons: `en` (default), `zh-CN`, `zh-TW`, `auto` to follow each message, or any language name.

Categories are not translated. They come from a fixed vocabulary, `Security`, `Finance`, `Delivery`, `Travel`, `Health`, `Legal`, `Work`, `Personal`, `Social`, `Marketing`, `System`, `Other`, and anything else the model returns is folded into `Other`. The daily digest groups by category and MCP callers search on it, so a stable vocabulary matters more than a vivid label. Rule-decided mail may also carry `Always important`, `Never important`, `Feedback rule` or `Forwarded copy`.

`LLM_BODY_CHARS` (default `1200`) is how much of each body is sent. A larger `LLM_BATCH_SIZE` costs less, but a failed call then affects more messages.

`LLM_THREAD_CONTEXT_MESSAGES` (default `3`, range `0`-`5`) adds recent earlier messages from the same mailbox thread to a new message's LLM input. It uses stored subjects, senders, summaries, and bounded snippets, plus bounded snippets from earlier messages fetched in the same poll. It does not fetch older messages or persist additional body text. Context is sent only when the message already needs LLM classification, and the normal PII redaction applies. Set it to `0` to disable.

`LLM_REDACT_PII=true` (the default) redacts direct identifiers from fields sent to the LLM: email addresses, phone numbers, payment card numbers (Luhn-checked), IBANs (mod-97), resident IDs (ISO 7064), US SSNs, license plates, and common API keys or tokens. A value that fails its checksum is left alone, so waybill, order, and invoice numbers stay readable in summaries. The recogniser list runs most-specific first, so an IBAN is not half-eaten by the phone rule. Local state and notifications keep the original values. Set it to `false` only when the configured endpoint is trusted and the additional context is necessary.

`LLM_SCAN_OUTPUT=false` (the default) counts direct identifiers that the model repeats in its summary or reason and logs a warning with the types and counts only — never the values. The text is not rewritten: the summary is for the reader, and silently changing it would hide the problem. Turn it on when tuning a new model or prompt; it costs one pass over each generated summary.

The regression corpus in `test/fixtures/verification.ts` and `test/fixtures/redaction.ts` pins the shapes this logic must keep handling. When a real message defeats a heuristic, add it there (with synthetic values) before changing the rule.

## Two-stage triage

By default one batched LLM call decides everything: the level, the category, and the summary. Setting the `DECIDER_*` variables splits that into two stages. A calibrated decision model (Cloudflare Clef on Workers AI) answers typed questions to decide `importance`, `category`, and `action_required` first, then the LLM above only writes the `summary`, `reason`, and `deadline`:

```bash
DECIDER_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/run/@cf/cloudflare
DECIDER_MODEL=clef-flash
DECIDER_API_TOKEN=
```

Why: the decision model cannot invent a label outside the vocabulary (it answers a `choice`, not free text), returns a confidence with every answer, and screens a message for roughly a quarter of the tokens of the cheapest text model. The summary keeps the nuance only a generative model has.

The decision stage inherits `LLM_BODY_CHARS`, `LLM_REDACT_PII`, `LLM_SKIP_SENSITIVE`, and your `MAIL_CONTEXT`; verification-code mail is hidden from it exactly as from the LLM. If the decision service fails, the batch falls back to the single-stage pipeline. After `LLM_ALERT_AFTER_FAILURES` polls in a row in which it failed, an alert says so. It is not repeated within `ACCOUNT_ALERT_COOLDOWN_SECONDS` while the service keeps failing, and a recovery notice follows once it answers again. If only the summary stage fails, the validated decisions are kept and the summary degrades to the decision's level and confidence. Remove the `DECIDER_*` lines to return to the original flow.

Set `AI_GATEWAY_ID` (e.g. `default`) to route both stages through a Cloudflare AI Gateway for per-request analytics, logs, and rate limiting. The gateway changes nothing about the models, their responses, or the free Neuron allocation; leave the variable unset when the triage endpoints are not Cloudflare.

## When the LLM fails

If an LLM request fails, returns invalid JSON/schema, or returns duplicate or out-of-range indices, the affected batch uses the local fallback, because a misaligned index list cannot be trusted for any message in it. A message that is merely omitted from an otherwise valid response falls back on its own. Keyword matches (`MAIL_KEYWORDS` plus a built-in list of high-risk words) remain warning-level and can be pushed; messages without a high-risk keyword become info and are queued for digest/review. Fallback does not stop polling.

After `LLM_ALERT_AFTER_FAILURES` consecutive failures, mailsift sends an outage alert. When calls recover, it re-triages fallback messages that are still waiting in the digest, using their locally stored snippets; already delivered messages are left alone. If re-triage also fails, those digest entries stay available for a later retry.

## Verification codes and sign-in links

A verification code appears in the Feishu card itself; the webhook payload and the signal event only say that one arrived. In the [web view](web-view.md#verification-codes) the code is set large and copies on tap.

`LLM_SKIP_SENSITIVE=true` (the default) keeps verification codes, one-time passwords, and auth-code messages in the local keyword/rule path. They remain eligible for normal notifications, but their content is never sent to the configured LLM.

Sign-in and password-reset links are handled the same way. mailsift recognises one by two things together: a subject that offers a sign-in link, a magic link or a password reset (or starts "Sign in to …", "Log in to …"), and a link in the body that carries a token where tokens are put. The token is either in a parameter such as `token=`, `code=` or `reset_password_token=`, or after a path segment such as `/reset/` or `/login/`, and mixes letters with digits. Replies, repository notification threads ("[owner/repo] …"), confirmations that a password was changed, slugs and unsubscribe links do not count.

A third kind covers credential leaks: a private-key block, a JWT the message presents as a credential (near "token", "bearer" and the like), or a token with a provider prefix (`ghp_`, `github_pat_`, `sk-`, `sk_live_`, `AKIA`, `xox…`, `AIza…`). Such a message is judged locally and its body is replaced wherever it would be shown or sent, because forwarding a live key to a model is worse than losing a summary. A message that merely mentions "API key" without one is not affected, and neither is a JWT inside a link: unsubscribe URLs and tracking pixels carry one routinely. Set `SENSITIVE_SECRET_MAIL=false` to treat credential mail as ordinary; its values are still redacted before the LLM sees them.

Such a message is judged locally, and the push, the digest, the webhook payload and the signal event say only that a link arrived, so the link that would sign someone in never leaves the host; open the original message to use it. Even with `LLM_SKIP_SENSITIVE=false`, the LLM sees placeholders in place of all three kinds.

A sender you muted through feedback still gets its codes and sign-in links through, because that is mail you asked for and are waiting on; an explicit `MAIL_NEVER_IMPORTANT` rule still wins. A sign-in link in bulk mail or in a spam folder is the exception: a reset lure is the commonest phishing, so it is hidden all the same but kept for the digest, and every output carries a warning not to open it unless you asked for it. Only an always-important rule, or with `LLM_SKIP_SENSITIVE=false` the model judging from the sender alone, can push it.

In the web view these messages say they were judged by a "local check", which is not the keyword fallback used when the LLM fails. It is a heuristic: a link mail it does not recognise is triaged like any other message.
