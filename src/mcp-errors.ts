/**
 * Typed errors for the MCP surface.
 *
 * A tool failure reaches a model as text, and "mail account not found" tells it
 * nothing about what to do next: it cannot tell a wrong argument it should fix
 * from a mailbox that is down, so it retries the same call or gives up. Every
 * failure here carries a stable `code` the caller can branch on and a `hint`
 * naming the next move.
 *
 * Tools answer with `isError` and the body as JSON, which is the shape the
 * protocol has for a failure a model is meant to read. Resources have no such
 * shape, so the same body travels in a JSON-RPC error's `data`.
 */
import { ErrorCode as RpcErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConfigError } from './config.js';
import { redactSecrets } from './logger.js';

export const MCP_ERROR_CODES = [
  'NOT_FOUND',
  'ACCOUNT_UNKNOWN',
  'INVALID_ARGUMENT',
  'MAILBOX_UNAVAILABLE',
  'ATTACHMENT_UNSUPPORTED',
  'ACTION_REFUSED',
  'WRITE_DISABLED',
  'SERVER_MISCONFIGURED',
  'PROVIDER_ERROR',
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/** What a caller should do next. Shown to the model, so each one names an action. */
const HINTS: Record<McpErrorCode, string | undefined> = {
  NOT_FOUND:
    'The id is unknown to mailsift. Call list_mail or search_mail to get a current Message-ID.',
  ACCOUNT_UNKNOWN: 'Call list_accounts for the exact addresses this deployment monitors.',
  INVALID_ARGUMENT: 'Check the argument against the tool schema and call it again.',
  MAILBOX_UNAVAILABLE:
    'The mailbox could not be read just now. Call health to see whether that account is failing; stored records stay available meanwhile.',
  ATTACHMENT_UNSUPPORTED:
    'Skipped by the size or type limit. list_attachments shows each file with its type and size.',
  ACTION_REFUSED: 'The action or destination is not allowed. Read the manage_mail schema for the permitted set.',
  WRITE_DISABLED: 'This deployment has no write credential configured, so the mailbox cannot be changed.',
  SERVER_MISCONFIGURED:
    'mailsift cannot read its own settings, so no mailbox can be reached. This needs a person, not another call.',
  PROVIDER_ERROR: undefined,
};

export interface McpErrorBody {
  code: McpErrorCode;
  message: string;
  hint?: string;
}

export class McpToolError extends Error {
  override readonly name = 'McpToolError';
  readonly code: McpErrorCode;
  readonly hint: string | undefined;

  constructor(code: McpErrorCode, message?: string, hint?: string) {
    super(message ?? code);
    this.code = code;
    this.hint = hint ?? HINTS[code];
  }

  toBody(): McpErrorBody {
    const body: McpErrorBody = { code: this.code, message: redactSecrets(this.message) };
    if (this.hint !== undefined) body.hint = this.hint;
    return body;
  }
}

function isMcpToolError(error: unknown): error is McpToolError {
  return error instanceof McpToolError;
}

/**
 * An unknown throw is never passed on as it is: it may carry a credential from
 * an IMAP or HTTP client, and its internals are no use to the caller anyway.
 */
function bodyFor(error: unknown): McpErrorBody {
  if (isMcpToolError(error)) return error.toBody();
  // A broken .env is the server's fault, not the caller's, and retrying cannot fix it.
  if (error instanceof ConfigError) return new McpToolError('SERVER_MISCONFIGURED', error.message).toBody();
  if (error instanceof McpError && typeof (error.data as McpErrorBody | undefined)?.code === 'string') {
    return error.data as McpErrorBody;
  }
  return { code: 'PROVIDER_ERROR', message: 'The mailbox or a stored record could not be read.' };
}

/** The reply a failing tool returns: the structured body, then one line a person can read. */
export function toToolError(error: unknown): CallToolResult {
  const body = bodyFor(error);
  return {
    isError: true,
    content: [
      { type: 'text', text: JSON.stringify(body, null, 2) },
      { type: 'text', text: `${body.code}: ${body.message}` },
    ],
  };
}

/** The same body for a resource read, where the protocol only has JSON-RPC errors. */
export function toResourceError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  const body = bodyFor(error);
  const rpcCode =
    body.code === 'NOT_FOUND' || body.code === 'INVALID_ARGUMENT' || body.code === 'ACCOUNT_UNKNOWN'
      ? RpcErrorCode.InvalidParams
      : RpcErrorCode.InternalError;
  return new McpError(rpcCode, `${body.code}: ${body.message}`, body);
}
