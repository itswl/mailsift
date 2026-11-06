/**
 * Redaction regression set.
 *
 * Every entry is a shape seen in real mail, with the values replaced by
 * synthetic ones. Checksum-carrying values use numbers that pass their check
 * digit on purpose; the "kept" entries are the false-positive guards.
 */
export interface RedactionCase {
  name: string;
  input: string;
  output: string;
}

export const REDACTION_CASES: RedactionCase[] = [
  {
    name: 'email and international phone',
    input: 'Contact a@example.com or +86 138-1234-5678.',
    output: 'Contact [EMAIL] or [PHONE].',
  },
  {
    name: 'phone written with spaces and a country code',
    input: '电话 +86 138 0013 8000',
    output: '电话 [PHONE]',
  },
  {
    name: 'mainland mobile without separators',
    input: '手机 13800138000，座机 010-12345678',
    output: '手机 [PHONE]，座机 [PHONE]',
  },
  {
    name: 'parenthesised area code',
    input: '收到来自 (877) 880-3205 的新短信',
    output: '收到来自 [PHONE] 的新短信',
  },
  {
    name: 'card with spaces',
    input: '卡号 4111 1111 1111 1111',
    output: '卡号 [CARD]',
  },
  {
    name: 'unionpay card',
    input: 'UnionPay 6200 0000 0000 0005',
    output: 'UnionPay [CARD]',
  },
  {
    name: 'iban',
    input: 'IBAN GB82 WEST 1234 5698 7654 32',
    output: 'IBAN [IBAN]',
  },
  {
    name: 'resident id',
    input: '身份证 11010519491231002X',
    output: '身份证 [ID]',
  },
  {
    name: 'us ssn',
    input: 'SSN 123-45-6789',
    output: 'SSN [SSN]',
  },
  {
    name: 'licence plate',
    input: '车牌 京A12345',
    output: '车牌 [PLATE]',
  },
  {
    name: 'jwt',
    input: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    output: 'Bearer [KEY]',
  },
  {
    name: 'provider token',
    input: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    output: 'token [KEY]',
  },
  {
    name: 'order number survives',
    input: '订单 2345678901234567890 已支付',
    output: '订单 2345678901234567890 已支付',
  },
  {
    name: 'waybill number survives',
    input: '顺丰运单 SF1234567890123 已发出',
    output: '顺丰运单 SF1234567890123 已发出',
  },
  {
    name: 'balance followed by a date survives',
    input: '积分余额 118 2026/09/20',
    output: '积分余额 118 2026/09/20',
  },
  {
    name: 'date and amount survive',
    input: '2026-11-05 发货，金额 1,234.56 元',
    output: '2026-11-05 发货，金额 1,234.56 元',
  },
  {
    name: 'phone-shaped digits are not a card',
    input: '电话 +86 138-1234-5678',
    output: '电话 [PHONE]',
  },
  {
    name: 'invalid checksum is left alone',
    input: '卡号 4111 1111 1111 1112',
    output: '卡号 4111 1111 1111 1112',
  },
  {
    name: 'plain mention of a key is not a secret',
    input: 'The API key is stored server-side.',
    output: 'The API key is stored server-side.',
  },
];
