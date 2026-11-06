import { describe, expect, it } from 'vitest';
import './setup.js';
import {
  containsSensitiveVerificationContent,
  extractVerificationCode,
  sensitiveKindOf,
} from '../src/imap/message.js';
import { redactForLlm } from '../src/services/redact.js';
import { REDACTION_CASES } from './fixtures/redaction.js';
import { VERIFICATION_CASES } from './fixtures/verification.js';

/**
 * The regression corpus. A heuristic change must keep every case below
 * working, and a new real-world shape belongs here before the rule changes.
 */
describe('verification corpus', () => {
  for (const item of VERIFICATION_CASES) {
    it(item.name, () => {
      expect(sensitiveKindOf(item.subject, item.body) ?? null).toBe(item.kind);
      expect(containsSensitiveVerificationContent(item.subject, item.body)).toBe(item.kind === 'code');
      expect(extractVerificationCode(item.subject, item.body)).toBe(item.code);
    });
  }
});

describe('redaction corpus', () => {
  for (const item of REDACTION_CASES) {
    it(item.name, () => {
      expect(redactForLlm(item.input)).toBe(item.output);
    });
  }
});
