import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/mcp.js';
import { StateStore } from '../src/services/state.js';
import * as imap from '../src/imap/client.js';

/**
 * The resource and scan paths read the mailbox through these, not through the
 * page's backend; here they fail as the mailbox's own code fails, so what a
 * caller is told about a file can be checked without a mail server.
 */
vi.mock('../src/imap/client.js', async (original) => {
  const real = await original<typeof import('../src/imap/client.js')>();
  return { ...real, fetchAttachmentByMessageId: vi.fn(), scanAttachmentByMessageId: vi.fn() };
});

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close().catch(() => undefined);
  vi.mocked(imap.fetchAttachmentByMessageId).mockReset();
  vi.mocked(imap.scanAttachmentByMessageId).mockReset();
});

async function connect(): Promise<Client> {
  const state = new StateStore(':memory:');
  state.markSeen('k1', 'me@qq.com', 'Invoice');
  state.recordOutcome('k1', 'warning', true, { messageId: '<inv@x>', sender: 'billing@vendor.com', folder: 'INBOX' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ state, client: 'test' });
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(async () => { await client.close(); await server.close(); });
  return client;
}

/** The typed body a resource read failed with. */
async function resourceFailure(client: Client, uri: string): Promise<{ rpc: number; code: string; hint?: string }> {
  try {
    await client.readResource({ uri });
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    const data = (error as McpError).data as { code: string; hint?: string };
    return { rpc: (error as McpError).code, code: data.code, ...(data.hint ? { hint: data.hint } : {}) };
  }
  throw new Error(`${uri} was read`);
}

describe('a file of a message that cannot be had', () => {
  it('is said to be over the limit, or not there, rather than that the mailbox is down', async () => {
    process.env.MAIL_ACCOUNT_1 = 'qq|me@qq.com|pw';
    const client = await connect();
    const uri = (part: string) => `mailsift://imap/me%40qq.com/%3Cinv%40x%3E/attachment/${part}`;

    vi.mocked(imap.fetchAttachmentByMessageId).mockRejectedValueOnce(new imap.AttachmentTooLargeError(4));
    const large = await resourceFailure(client, uri('2'));
    expect(large).toMatchObject({ code: 'ATTACHMENT_UNSUPPORTED', rpc: -32602 });
    expect(large.hint).not.toMatch(/health/);

    vi.mocked(imap.fetchAttachmentByMessageId).mockRejectedValueOnce(new imap.AttachmentNotFoundError('9'));
    const missing = await resourceFailure(client, uri('9'));
    expect(missing).toMatchObject({ code: 'NOT_FOUND', hint: expect.stringMatching(/list_attachments/) });

    vi.mocked(imap.scanAttachmentByMessageId).mockRejectedValueOnce(new imap.AttachmentNotFoundError('9'));
    const scanned = await client.callTool({ name: 'scan_attachment', arguments: { account: 'me@qq.com', messageId: '<inv@x>', partId: '9' } });
    expect(scanned).toMatchObject({ isError: true });
    expect(JSON.parse((scanned.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_FOUND' });

    // A mailbox that really could not be read is still said to be that.
    vi.mocked(imap.fetchAttachmentByMessageId).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    expect(await resourceFailure(client, uri('2'))).toMatchObject({ code: 'MAILBOX_UNAVAILABLE' });
  });
});
