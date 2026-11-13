/**
 * Body cleaning: quoted history, signatures, whitespace.
 *
 * Triage sees only the first `LLM_BODY_CHARS` of a body (1200 by default) and
 * the stored preview is the first `SNIPPET_CHARS`. A reply carries the whole
 * earlier thread below the new text and nearly every message ends in a
 * signature block, so without this the budget is spent on text the sender did
 * not write today: the model reads last week's mail and rates this one on it.
 *
 * Everything here is pure, plain text in and out, and runs on every message,
 * so it stays to anchored line scans rather than parsing.
 *
 * Quotes: three markers, all of which put the quoted text below them, so the
 * first one found ends the message. Chinese clients are included because QQ,
 * 163 and Outlook in Chinese write their own attribution lines.
 *
 * Signatures: the `-- ` delimiter and a sign-off phrase on its own line, both
 * only near the end.
 *
 * Both steps give the original text back when they would leave nothing, so a
 * message that is only a quote, or only "Thanks", still reaches triage.
 */

/** "On <date>, <name> wrote:" and the common localised forms. */
const WROTE_LINE = /^(?:On|Le|Am|El|Op)\b.*\b(?:wrote|a écrit|schrieb|escribió|schreef)\s*[:：]\s*$/i;
/** First line of a wrapped "On ... wrote:" attribution. */
const WROTE_START = /^(?:On|Le|Am|El|Op)\s\S/;
/** Last line of a wrapped attribution, and the whole line when a client writes it on one. */
const WROTE_END = /\b(?:wrote|a écrit|schrieb|escribió|schreef)\s*[:：]\s*$/i;
/**
 * Chinese attribution: "在 2026年11月3日 10:00，X <x@qq.com> 写道：". QQ, 163 and
 * Foxmail all write their own date format, so the trailing verb is the marker.
 * The colon is required and 说道 is left out, because both appear in ordinary
 * Chinese prose where this must not cut the message short.
 */
const WROTE_LINE_CJK = /(?:写道|寫道)\s*[:：]\s*$/;

/** "-----Original Message-----", and what QQ, 163 and Outlook write in Chinese. */
const ORIGINAL_MESSAGE =
  /^\s*[-_=]{2,}\s*(?:Original\s+Message|Ursprüngliche\s+Nachricht|Message\s+d'origine|Mensaje\s+original|Oorspronkelijk\s+bericht|原始邮件|原始郵件|邮件原件|郵件原件)\s*[-_=]{2,}\s*$/i;

/**
 * A forward's header block looks exactly like a quoted Outlook block. The
 * content of a forward is usually the point of the message, so this marker
 * protects the header lines that follow it. "转发的邮件" is the one mailsift
 * writes itself (see forwardEnvelope in smtp.ts).
 */
const FORWARDED_MESSAGE =
  /^\s*[-_=]{2,}\s*(?:Forwarded\s+message|Weitergeleitete\s+Nachricht|Message\s+transféré|Mensaje\s+reenviado|Doorgestuurd\s+bericht|转发邮件|轉發郵件|转发的邮件|轉發的郵件|已转发邮件|已轉發郵件)[^-_=]*[-_=]{2,}\s*$/i;

/** Outlook header lines. `\W{0,2}` allows the `*From:*` left by bold-to-text conversion. */
const HDR_FROM = /^\W{0,2}(?:From|Von|De|Van|发件人|發件人)\s*[:：]/i;
const HDR_SENT =
  /^\W{0,2}(?:Sent|Date|Gesendet|Envoyé|Enviado|Verzonden|Datum|发送时间|發送時間|发件时间|日期|时间|時間)\s*[:：]/i;
const HDR_TO_OR_SUBJECT =
  /^\W{0,2}(?:To|Cc|Subject|An|Betreff|À|Objet|Para|Asunto|Aan|Onderwerp|收件人|抄送|主题|主題)\s*[:：]/i;

const QUOTED_LINE = /^\s*>/;

/** How far after a `From:` line the rest of a header block may appear. */
const HEADER_BLOCK_LINES = 4;
/** How far after a forwarded marker its own header block reaches. */
const FORWARD_HEADER_LINES = 4;

/**
 * A lone `From:` is ordinary prose ("From: the desk of ..."), so it only ends
 * the message when a date line and a recipient or subject line follow it.
 */
function isHeaderBlock(lines: readonly string[], from: number): boolean {
  let dated = false;
  let addressed = false;
  for (let i = from + 1; i <= from + HEADER_BLOCK_LINES && i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (HDR_SENT.test(line)) dated = true;
    else if (HDR_TO_OR_SUBJECT.test(line)) addressed = true;
  }
  return dated && addressed;
}

/** Index of the line that starts the quoted history, or -1 when there is none. */
export function findQuoteStart(lines: readonly string[]): number {
  let forwardedAt = -Infinity;

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;

    if (FORWARDED_MESSAGE.test(line)) {
      forwardedAt = i;
      continue;
    }
    if (WROTE_LINE.test(line) || WROTE_LINE_CJK.test(line)) return i;
    if (ORIGINAL_MESSAGE.test(line)) return i;

    // A wrapped attribution: "On Mon, 3 Nov 2026 at 10:00" / "X <x@y> wrote:".
    if (WROTE_START.test(line) && !line.endsWith(':') && !line.endsWith('：')) {
      const next = (lines[i + 1] ?? '').trim();
      if (next !== '' && WROTE_END.test(next)) return i;
    }

    const insideForward = i - forwardedAt <= FORWARD_HEADER_LINES;
    if (!insideForward && HDR_FROM.test(line) && isHeaderBlock(lines, i)) return i;
  }
  return -1;
}

/** Drop the quoted history and any `>` lines above it. The original is kept if nothing is left. */
export function stripQuotes(text: string): string {
  const lines = text.split('\n');
  const start = findQuoteStart(lines);
  const kept = (start === -1 ? lines : lines.slice(0, start)).filter((line) => !QUOTED_LINE.test(line));
  const result = kept.join('\n').trim();
  return result === '' ? text.trim() : result;
}

/** Below this many characters left over, the signature is part of the message. */
export const MIN_BODY_AFTER_SIGNATURE = 200;
/** A marker this far from the end is a sign-off, not a sentence in the middle. */
export const MAX_SIGNATURE_LINES = 15;

/** The RFC 3676 delimiter: dash, dash, space, and nothing else. Never trimmed before matching. */
const SIG_DELIMITER = /^-- $/;

const SIGN_OFF =
  /^(?:thanks|thank you|many thanks|thanks again|thanks in advance|regards|best regards|kind regards|warm regards|warmest regards|best|all the best|best wishes|cheers|sincerely|yours sincerely|yours truly|yours faithfully|take care|talk soon|speak soon|sent from my .+|sent from outlook.*|get outlook for .+|此致|敬礼|敬上|顺颂商祺|顺祝商祺|祝好|祝顺利|谢谢|多谢|发自我的.+|发自.{0,10}(?:邮箱|手机).*|来自.{0,10}(?:邮箱|手机).*)[,.!，。！]?\s*$/i;

/** Index of the line where the signature starts, or -1. */
export function findSignatureStart(lines: readonly string[]): number {
  const earliest = Math.max(0, lines.length - MAX_SIGNATURE_LINES - 1);
  for (let i = earliest; i < lines.length; i += 1) {
    if (SIG_DELIMITER.test(lines[i] ?? '')) return i;
  }
  for (let i = earliest; i < lines.length; i += 1) {
    if (SIGN_OFF.test((lines[i] ?? '').trim())) return i;
  }
  return -1;
}

/** Drop the signature, unless doing so would leave too little to judge the message on. */
export function stripSignature(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  const lines = trimmed.split('\n');
  const start = findSignatureStart(lines);
  if (start === -1) return trimmed.trim();

  const kept = lines.slice(0, start).join('\n').trim();
  return kept.length < MIN_BODY_AFTER_SIGNATURE ? trimmed.trim() : kept;
}

/**
 * CRLF to LF, no trailing spaces, at most one blank line. `[^\S\n]` covers the
 * no-break and ideographic spaces mail HTML is full of, which a plain `\s`
 * class would collapse along with the line breaks this needs to keep.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The whole pipeline: normalize, then quotes, then signature. Line structure is kept. */
export function cleanBody(text: string): string {
  if (text.trim() === '') return '';
  return normalizeWhitespace(stripSignature(stripQuotes(normalizeWhitespace(text))));
}
