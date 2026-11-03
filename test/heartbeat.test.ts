import { describe, expect, it, vi } from 'vitest';
import './setup.js';
import { heartbeatUrl, pingHeartbeat } from '../src/services/heartbeat.js';

describe('external heartbeat', () => {
  it('stays silent unless a monitor URL is set', async () => {
    const fetcher = vi.fn();
    await pingHeartbeat(fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('pings the monitor with a plain GET and nothing about mail', async () => {
    process.env.HEARTBEAT_PING_URL = 'https://kuma.example/api/push/abc123';
    const fetcher = vi.fn(async () => new Response('ok'));
    await pingHeartbeat(fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://kuma.example/api/push/abc123');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('ignores a value that is not an http(s) URL', async () => {
    process.env.HEARTBEAT_PING_URL = 'file:///etc/passwd';
    expect(heartbeatUrl()).toBeUndefined();
    process.env.HEARTBEAT_PING_URL = 'not a url';
    expect(heartbeatUrl()).toBeUndefined();
  });

  it('never throws when the monitor is down, so a poll is never held up', async () => {
    process.env.HEARTBEAT_PING_URL = 'https://kuma.example/api/push/abc123';
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(pingHeartbeat(fetcher as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});

describe('external heartbeat secrets and one-shot runs', () => {
  it('turns away a URL with a user name or password instead of failing and logging it every poll', async () => {
    process.env.HEARTBEAT_PING_URL = 'https://user:hunter2@kuma.example/api/push/SECRETTOKEN';
    const { heartbeatProblem } = await import('../src/services/heartbeat.js');
    expect(heartbeatUrl()).toBeUndefined();
    expect(heartbeatProblem()).toContain('user name or password');
    const fetcher = vi.fn();
    await pingHeartbeat(fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('logs the host and the kind of failure, never the URL an error quotes', async () => {
    process.env.HEARTBEAT_PING_URL = 'https://kuma.example/api/push/SECRETTOKEN?status=up';
    process.env.LOG_LEVEL = 'warn';
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const fetcher = vi.fn(async () => {
        throw new TypeError('fetch failed: https://kuma.example/api/push/SECRETTOKEN?status=up', { cause: { code: 'ECONNREFUSED' } });
      });
      await pingHeartbeat(fetcher as unknown as typeof fetch);
    } finally {
      spy.mockRestore();
    }
    const logged = written.join('');
    expect(logged).toContain('kuma.example');
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).not.toContain('SECRETTOKEN');
  });

  it('lets a one-shot run wait for the ping it started', async () => {
    process.env.HEARTBEAT_PING_URL = 'https://kuma.example/api/push/abc123';
    const { flushHeartbeats } = await import('../src/services/heartbeat.js');
    let answered = false;
    const fetcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      answered = true;
      return new Response('ok');
    });
    void pingHeartbeat(fetcher as unknown as typeof fetch);
    expect(answered).toBe(false);
    await flushHeartbeats();
    expect(answered).toBe(true);
  });
});

describe('the ping in the poll loop', () => {
  it('goes out once per completed poll, and can be waited for', async () => {
    process.env.HEARTBEAT_PING_URL = 'https://kuma.example/api/push/abc123';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response('ok');
    }));
    try {
      const { flushHeartbeats } = await import('../src/services/heartbeat.js');
      const { StateStore } = await import('../src/services/state.js');
      const { Watcher } = await import('../src/services/watcher.js');
      const { RecordingSink } = await import('./helpers.js');
      const watcher = new Watcher(
        { accounts: [], rules: { alwaysImportant: [], neverImportant: [], keywords: [], context: '' } },
        new StateStore(':memory:'), new RecordingSink(),
      );
      await watcher.pollOnce();
      await flushHeartbeats();
      expect(calls).toEqual(['https://kuma.example/api/push/abc123']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
