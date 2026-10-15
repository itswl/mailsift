/**
 * Bounded, local-only security heuristics.
 *
 * This module deliberately does not execute, unpack, upload, or persist mail
 * data. It receives attachment metadata and a small in-memory prefix, or a
 * bounded text body, and returns clues that a human can review. These are not
 * antivirus, sandbox, reputation, or sender-authentication verdicts.
 */
import { isIP } from 'node:net';
import {
  attachmentSafetyWarnings,
  type AttachmentInfo,
  type AttachmentSafetyWarningCode,
} from './imap/message.js';

export type SecuritySeverity = 'info' | 'caution' | 'warning';

export interface AttachmentScanFinding {
  code: string;
  severity: SecuritySeverity;
  detail: string;
}

export interface AttachmentScanReport {
  partId: string;
  filename?: string;
  contentType: string;
  sizeBytes?: number;
  scannedBytes: number;
  truncated: boolean;
  findings: AttachmentScanFinding[];
  limitations: string;
}

export interface LinkRiskFinding {
  code: string;
  severity: SecuritySeverity;
  detail: string;
  /** Host only; query strings and URL paths are intentionally omitted. */
  host?: string;
}

export interface LinkRiskReport {
  checked: boolean;
  bodyPart: string | null;
  scannedBytes: number;
  truncated: boolean;
  linksFound: number;
  findings: LinkRiskFinding[];
  findingsTruncated: boolean;
  limitations: string;
}

const EXECUTABLE_EXTENSIONS = new Set([
  'app', 'apk', 'com', 'cpl', 'deb', 'dmg', 'dll', 'exe', 'jar', 'msi', 'msp', 'pkg', 'rpm', 'scr', 'sys',
]);
const SCRIPT_EXTENSIONS = new Set([
  'bash', 'bat', 'cmd', 'command', 'hta', 'js', 'jse', 'lnk', 'ps1', 'psm1', 'sh', 'url', 'vbe', 'vbs',
  'wsf', 'wsh', 'zsh',
]);
const ACTIVE_EXTENSIONS = new Set(['htm', 'html', 'mht', 'mhtml', 'svg', 'xhtml']);
const MACRO_EXTENSIONS = new Set(['docm', 'dotm', 'ppsm', 'pptm', 'potm', 'xlam', 'xlsm', 'xltm']);
const DOUBLE_EXTENSION_SINKS = new Set([
  ...EXECUTABLE_EXTENSIONS,
  ...SCRIPT_EXTENSIONS,
  ...ACTIVE_EXTENSIONS,
]);

/** Common filename to MIME expectations used only to flag an inconsistency. */
const MIME_BY_EXTENSION: Record<string, string[]> = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  svg: ['image/svg+xml', 'application/xhtml+xml'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv', 'text/plain'],
  html: ['text/html', 'application/xhtml+xml'],
  htm: ['text/html', 'application/xhtml+xml'],
  zip: ['application/zip'],
  rar: ['application/vnd.rar', 'application/x-rar-compressed'],
  '7z': ['application/x-7z-compressed'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};

function cleanFilename(value: string | undefined): string {
  return value?.trim().split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
}

function filenameParts(filename: string): string[] {
  return filename.split('.').filter(Boolean);
}

function extensionOf(filename: string): string {
  const parts = filenameParts(filename);
  return parts.at(-1) ?? '';
}

function normalizedContentType(contentType: string): string {
  return contentType.trim().toLowerCase().split(';', 1)[0] ?? '';
}

function warningFinding(code: AttachmentSafetyWarningCode): AttachmentScanFinding {
  switch (code) {
    case 'executable_or_installer':
      return { code: 'executable_or_installer', severity: 'warning', detail: 'Executable or installer type indicated by the filename or MIME type.' };
    case 'script_or_shortcut':
      return { code: 'script_or_shortcut', severity: 'warning', detail: 'Script or shortcut type indicated by the filename or MIME type.' };
    case 'macro_enabled_document':
      return { code: 'macro_enabled_document', severity: 'warning', detail: 'Macro-enabled document type indicated by the filename or MIME type.' };
    case 'active_content':
      return { code: 'active_content', severity: 'warning', detail: 'HTML, SVG, or other active-content type indicated by the filename or MIME type.' };
    case 'archive_not_scanned':
      return { code: 'archive_not_scanned', severity: 'caution', detail: 'Archive or disk-image contents were not unpacked or inspected.' };
  }
}

function hasBytes(prefix: Buffer, offset: number, bytes: number[]): boolean {
  if (prefix.length < offset + bytes.length) return false;
  return bytes.every((value, index) => prefix[offset + index] === value);
}

function startsWithText(prefix: Buffer, value: string): boolean {
  return prefix.subarray(0, Math.min(prefix.length, value.length)).toString('utf8').toLowerCase() === value.toLowerCase()
    && prefix.length >= value.length;
}

function textPrefix(prefix: Buffer): string {
  // A small text view is enough for signatures and keeps binary data out of
  // logs and reports. NULs are retained as separators rather than decoded.
  return prefix.subarray(0, 64 * 1024).toString('utf8').replace(/\u0000/g, ' ').toLowerCase();
}

/**
 * Scan an attachment's metadata and a bounded decoded prefix. The caller owns
 * fetching the prefix under a read-only IMAP lock; this function never retains
 * it after returning.
 */
export function scanAttachment(
  metadata: AttachmentInfo,
  prefix: Buffer,
  truncated: boolean,
): AttachmentScanReport {
  const filename = cleanFilename(metadata.filename);
  const extension = extensionOf(filename);
  const parts = filenameParts(filename);
  const contentType = normalizedContentType(metadata.contentType);
  const findings: AttachmentScanFinding[] = [];
  const seen = new Set<string>();
  const add = (finding: AttachmentScanFinding): void => {
    if (seen.has(finding.code)) return;
    seen.add(finding.code);
    findings.push(finding);
  };

  for (const code of attachmentSafetyWarnings({ filename, contentType })) add(warningFinding(code));

  if (parts.length >= 3 && DOUBLE_EXTENSION_SINKS.has(extension)) {
    add({
      code: 'double_extension',
      severity: 'warning',
      detail: 'The filename has multiple extensions ending in an executable, script, or active-content type.',
    });
  }

  const expected = MIME_BY_EXTENSION[extension];
  if (expected && contentType !== 'application/octet-stream' && !expected.includes(contentType)) {
    add({
      code: 'filename_mime_mismatch',
      severity: 'caution',
      detail: `The filename extension .${extension} does not match the reported MIME type ${contentType || 'unknown'}.`,
    });
  }
  if (MACRO_EXTENSIONS.has(extension)) {
    add({ code: 'macro_enabled_document', severity: 'warning', detail: 'The filename is a macro-enabled office document type.' });
  }

  if (startsWithText(prefix, 'MZ')) add({ code: 'pe_signature', severity: 'warning', detail: 'The bounded prefix starts with a Windows PE executable signature.' });
  if (hasBytes(prefix, 0, [0x7f, 0x45, 0x4c, 0x46])) add({ code: 'elf_signature', severity: 'warning', detail: 'The bounded prefix starts with an ELF executable signature.' });
  if (
    hasBytes(prefix, 0, [0xfe, 0xed, 0xfa, 0xce])
    || hasBytes(prefix, 0, [0xfe, 0xed, 0xfa, 0xcf])
    || hasBytes(prefix, 0, [0xce, 0xfa, 0xed, 0xfe])
    || hasBytes(prefix, 0, [0xcf, 0xfa, 0xed, 0xfe])
    || hasBytes(prefix, 0, [0xca, 0xfe, 0xba, 0xbe])
  ) add({ code: 'mach_o_signature', severity: 'warning', detail: 'The bounded prefix starts with a Mach-O or universal binary signature.' });

  const text = textPrefix(prefix).replace(/^\ufeff/, '').trimStart();
  if (text.startsWith('#!')) add({ code: 'script_signature', severity: 'warning', detail: 'The bounded prefix starts with a Unix script shebang.' });
  if (
    text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<svg')
    || /<script\b/i.test(text)
  ) add({ code: 'active_content_signature', severity: 'warning', detail: 'The bounded prefix contains HTML, SVG, or script active-content markers.' });

  if (hasBytes(prefix, 0, [0x50, 0x4b, 0x03, 0x04])) add({ code: 'zip_signature', severity: 'caution', detail: 'The bounded prefix starts with a ZIP container; its contents were not unpacked.' });
  if (hasBytes(prefix, 0, [0x1f, 0x8b])) add({ code: 'gzip_signature', severity: 'caution', detail: 'The bounded prefix starts with a GZIP container; its contents were not unpacked.' });
  if (hasBytes(prefix, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) add({ code: 'rar_signature', severity: 'caution', detail: 'The bounded prefix starts with a RAR container; its contents were not unpacked.' });
  if (hasBytes(prefix, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) add({ code: 'seven_zip_signature', severity: 'caution', detail: 'The bounded prefix starts with a 7z container; its contents were not unpacked.' });
  if (hasBytes(prefix, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    add({ code: 'ole_signature', severity: 'caution', detail: 'The bounded prefix starts with an OLE document container; embedded content was not unpacked.' });
  }

  return {
    partId: metadata.partId,
    ...(metadata.filename ? { filename: metadata.filename } : {}),
    contentType: metadata.contentType,
    ...(metadata.sizeBytes !== undefined ? { sizeBytes: metadata.sizeBytes } : {}),
    scannedBytes: prefix.length,
    truncated,
    findings,
    limitations:
      'Bounded local heuristics only. The file was not executed, unpacked, uploaded, or persisted; ' +
      'this is not an antivirus or malware verdict.',
  };
}

const SHORTENER_HOSTS = new Set([
  'bit.ly', 'buff.ly', 'cutt.ly', 'goo.gl', 'is.gd', 'lnkd.in', 'ow.ly', 'rebrand.ly', 's.id', 't.co',
  'tiny.cc', 'tinyurl.com',
]);
const URL_SCHEME_PATTERN = /\b(?:https?|ftp):\/\/[^\s<>"'`]+/gi;
const DANGEROUS_SCHEME_PATTERN = /\b(?:javascript|data|vbscript):[^\s<>"'`]+/gi;
const ATTRIBUTE_URL_PATTERN = /\b(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
const BARE_WEB_URL_PATTERN = /\bwww\.[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"'`]*)?/gi;

function trimUrl(value: string): string {
  return value.trim().replace(/[.,!?;:)\]}]+$/g, '');
}

function hostOf(url: URL): string | undefined {
  const host = url.hostname.trim().toLowerCase().replace(/\.$/, '');
  return host ? host.slice(0, 253) : undefined;
}

/** Parse bounded body text without contacting any URL or resolving DNS. */
export function inspectLinkRisks(
  body: string,
  options: { bodyPart?: string; scannedBytes?: number; truncated?: boolean } = {},
): LinkRiskReport {
  const candidates = new Set<string>();
  const addCandidate = (raw: string): void => {
    const value = trimUrl(raw);
    if (value.length > 4096 || candidates.size >= 1000) return;
    candidates.add(value);
  };
  for (const match of body.matchAll(URL_SCHEME_PATTERN)) addCandidate(match[0]);
  for (const match of body.matchAll(ATTRIBUTE_URL_PATTERN)) {
    const value = match[1] ?? '';
    addCandidate(value.startsWith('//') ? `https:${value}` : value);
  }
  for (const match of body.matchAll(BARE_WEB_URL_PATTERN)) addCandidate(`https://${match[0]}`);
  const dangerousSchemes = [...body.matchAll(DANGEROUS_SCHEME_PATTERN)]
    .map((match) => trimUrl(match[0] ?? '').slice(0, 4096))
    .filter(Boolean);

  const findings: LinkRiskFinding[] = [];
  const seen = new Set<string>();
  let findingsTruncated = false;
  const addFinding = (finding: LinkRiskFinding): void => {
    if (findings.length >= 200) {
      findingsTruncated = true;
      return;
    }
    const key = `${finding.code}|${finding.host ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const scheme of dangerousSchemes) {
    const code = scheme.toLowerCase().startsWith('javascript:')
      ? 'link_javascript'
      : scheme.toLowerCase().startsWith('vbscript:') ? 'link_vbscript' : 'link_data';
    addFinding({ code, severity: 'warning', detail: `The body contains a ${code.replace('link_', '')} URL scheme; it was not opened.` });
  }

  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const host = hostOf(url);
    if (!host) continue;
    if (url.protocol !== 'https:') {
      addFinding({ code: 'link_non_https', severity: 'caution', detail: 'A link uses a non-HTTPS scheme.', host });
    }
    if (isIP(host)) addFinding({ code: 'link_ip_host', severity: 'caution', detail: 'A link uses a literal IP address instead of a domain name.', host });
    if (host.split('.').some((part) => part.startsWith('xn--'))) {
      addFinding({ code: 'link_punycode', severity: 'caution', detail: 'A link uses a punycode domain; verify the displayed identity independently.', host });
    }
    if (url.username || url.password) addFinding({ code: 'link_userinfo', severity: 'warning', detail: 'A link contains a username or password before its host.', host });
    if (SHORTENER_HOSTS.has(host)) addFinding({ code: 'link_shortener', severity: 'caution', detail: 'A link uses a common URL-shortener domain, so its final destination is hidden.', host });
  }

  return {
    checked: true,
    bodyPart: options.bodyPart ?? null,
    scannedBytes: options.scannedBytes ?? Buffer.byteLength(body, 'utf8'),
    truncated: options.truncated === true,
    linksFound: candidates.size + dangerousSchemes.length,
    findings,
    findingsTruncated,
    limitations:
      'URLs were parsed from a bounded text body only. No link was opened, DNS-resolved, reputation-checked, ' +
      'or submitted to a remote service; a clean result does not prove safety.',
  };
}

