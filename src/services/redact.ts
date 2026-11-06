/**
 * Local redaction of direct identifiers before text goes to an LLM.
 *
 * The pipeline is a short list of recognisers instead of one regex per leak:
 * each entry matches one kind of value and replaces it with a typed placeholder
 * (`[EMAIL]`, `[IBAN]`, …), so a value is handled once and the next recogniser
 * cannot re-interpret a placeholder. Checksums decide the ambiguous cases: a
 * long digit run is a card or a resident ID only when its check digit holds, so
 * order and waybill numbers stay readable.
 *
 * This is the same shape as Presidio's analyzer/anonymizer split, trimmed to
 * what a single process needs: no NER model, no mapping store, no dependencies.
 */

import { JWT_SOURCE, KEY_PREFIX_SOURCE, PRIVATE_KEY_SOURCE } from '../imap/message.js';

interface Recognizer {
  pattern: RegExp;
  type: string;
  /** Optional confirmation: a failed check leaves the text untouched. */
  valid?: (match: string) => boolean;
}

/**
 * Payment card numbers carry a Luhn check digit. Order, tracking, and invoice
 * numbers of the same length almost never do, so checking it keeps those
 * business identifiers readable for the LLM instead of redacting every long
 * digit run.
 */
export function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/[ -]/g, '');
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double && (digit *= 2) > 9) digit -= 9;
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CN_ID_CHECK = '10X98765432';

/** GB 11643 resident ID: a plausible birth date in positions 7-14 plus the ISO 7064 check character. */
export function looksLikeChineseId(candidate: string): boolean {
  const month = Number(candidate.slice(10, 12));
  const day = Number(candidate.slice(12, 14));
  if (!/^(?:19|20)\d{2}$/.test(candidate.slice(6, 10)) || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const sum = CN_ID_WEIGHTS.reduce((acc, weight, i) => acc + weight * (candidate.charCodeAt(i) - 48), 0);
  return CN_ID_CHECK[sum % 11] === candidate[17]!.toUpperCase();
}

/** IBAN: two letters, two check digits, then BBAN groups. ISO 13616 defines the mod-97 test. */
export function passesIbanMod97(candidate: string): boolean {
  const compact = candidate.replace(/[ ]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Cards are printed as one run or as groups of four; a phone grouping is not a card. */
export function looksLikeCardShape(candidate: string): boolean {
  const groups = candidate.trim().split(/[ -]/);
  return groups.length === 1 || groups.every((group) => group.length === 4);
}

const PHONE = /(?<![\d/])(?:\+\d{1,3}[ -]?)?(?:\(\d{3}\)[ -]?\d{3}[- ]\d{4}|\d{3}[- ]\d{4}[- ]\d{4}|\d{3}[- ]\d{3}[- ]\d{4}|\d{3}[- ]\d{4})(?![\d/])/;
/** Mainland mobile numbers are 11 digits starting 13-19 and need no separators. */
const CN_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const CN_LANDLINE = /(?<!\d)0\d{2,3}[- ]\d{7,8}(?!\d)/;
/** Province character + letter + five alphanumerics, with the usual suffix characters. */
const CN_PLATE = /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-HJ-NP-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]/;
const JWT = new RegExp(JWT_SOURCE, 'g');
const KEY_PREFIX = new RegExp(KEY_PREFIX_SOURCE, 'g');
const PRIVATE_KEY = new RegExp(PRIVATE_KEY_SOURCE, 'g');
const US_SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;

/**
 * Recognisers run in this order. Specific, high-signal values come first so a
 * later, broader pattern cannot claim part of them: an IBAN must not be read as
 * a phone number, which is what the old replace chain did.
 */
const RECOGNIZERS: Recognizer[] = [
  { pattern: PRIVATE_KEY, type: 'KEY' },
  { pattern: JWT, type: 'KEY' },
  { pattern: KEY_PREFIX, type: 'KEY' },
  { pattern: /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, type: 'EMAIL' },
  {
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    type: 'IBAN',
    valid: passesIbanMod97,
  },
  {
    pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g,
    type: 'CARD',
    valid: (match) => looksLikeCardShape(match) && passesLuhn(match),
  },
  {
    pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    type: 'ID',
    valid: looksLikeChineseId,
  },
  { pattern: CN_MOBILE, type: 'PHONE' },
  { pattern: CN_LANDLINE, type: 'PHONE' },
  { pattern: PHONE, type: 'PHONE' },
  { pattern: US_SSN, type: 'SSN' },
  { pattern: CN_PLATE, type: 'PLATE' },
];

/**
 * Count the direct identifiers in a piece of text without changing it.
 *
 * Meant for model output: a summary that echoes an address or a card number is
 * worth knowing about, but rewriting it would hide the problem from the reader
 * and from the log. Only types and counts are reported, never values.
 */
export function countIdentifiers(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { pattern, type, valid } of RECOGNIZERS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(global)) {
      if (valid && !valid(match[0])) continue;
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Remove common direct identifiers before a message is sent to an LLM.
 *
 * Numeric identifiers are only treated as cards or ID numbers when their
 * checksum holds, so waybill, order, and invoice numbers usually survive.
 */
export function redactForLlm(value: string): string {
  let text = value;
  for (const { pattern, type, valid } of RECOGNIZERS) {
    text = text.replace(pattern, (match) => (valid && !valid(match) ? match : `[${type}]`));
  }
  return text;
}
