import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './setup.js';

/**
 * The MCP server has no process of its own: it runs inside the one that
 * checks the mail, at /mcp, behind a token. A client still configured for the
 * stdio transport starts `dist/src/mcp.js`, and what it must not get is a
 * process that hangs on an empty channel or serves without a token.
 */
describe('the MCP server started as a process of its own', () => {
  it('says why nothing is served, writes nothing to stdout, and stops', () => {
    const started = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(started.error).toBeUndefined();
    expect(started.signal).toBeNull();
    expect(started.status).toBe(1);
    expect(started.stdout).toBe('');
    expect(started.stderr).toContain('the MCP server is not run as a process of its own');
    // Where to point the client instead.
    expect(started.stderr).toContain('/mcp');
  }, 60_000);
});
