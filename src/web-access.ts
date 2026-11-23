/**
 * Whether a request travelled a channel credentials may cross.
 *
 * mailsift has no TLS of its own. Passwords, setup codes, OAuth codes and API
 * tokens are accepted over:
 * - HTTPS: TLS on the socket, or a reverse proxy that terminated TLS and says
 *   so in X-Forwarded-Proto / Forwarded;
 * - loopback: the browser's address is localhost, 127.0.0.1 or [::1]. That is
 *   the browser on the server itself, or one at the end of an SSH tunnel
 *   (`ssh -L 8410:127.0.0.1:8410 server`), where the hop over the network is
 *   encrypted by SSH.
 *
 * The decision is made on what the browser was pointed at (Host, Origin), not
 * on the socket's peer address: behind Docker's port forwarding every peer is
 * the bridge gateway, whatever the browser typed. A browser never invents
 * these headers, so someone reaching the port at http://<public address>/ is
 * refused before a password can be typed, which is the point: the check
 * protects the owner's credentials from a plain-text network, while a client
 * that forges headers still needs the credentials themselves.
 */
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

export type Channel = 'https' | 'loopback' | 'insecure';

export function isLoopbackName(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '[::1]' || name === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** The name part of a Host header: `[::1]:8410` → `[::1]`, `example.com:443` → `example.com`. */
export function hostName(header: string | undefined): string {
  const raw = (header ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  return raw.replace(/:\d+$/, '');
}

/** The port in a Host header, or the scheme's default. */
export function hostPort(header: string | undefined, fallback = 80): number {
  const raw = (header ?? '').trim();
  const match = /:(\d+)$/.exec(raw.startsWith('[') ? raw.slice(raw.indexOf(']') + 1) : raw);
  return match ? Number(match[1]) : fallback;
}

/** The scheme a proxy reports the browser used, if one does. */
export function forwardedProto(req: IncomingMessage): string | undefined {
  const xfp = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase();
  if (xfp) return xfp;
  const forwarded = String(req.headers['forwarded'] ?? '');
  const match = /(?:^|[;,\s])proto=("?)([a-z]+)\1/i.exec(forwarded);
  return match?.[2]?.toLowerCase();
}

export function requestChannel(req: IncomingMessage): Channel {
  if ((req.socket as TLSSocket | undefined)?.encrypted) return 'https';
  const proto = forwardedProto(req);
  if (proto === 'https') return 'https';
  // A proxy in front that says the browser used plain HTTP: whatever the
  // Host header was rewritten to, the browser's leg was not encrypted.
  if (proto) return 'insecure';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const url = new URL(origin);
      if (url.protocol === 'https:') return 'https';
      if (!isLoopbackName(url.hostname)) return 'insecure';
    } catch {
      return 'insecure';
    }
  }
  return isLoopbackName(hostName(req.headers.host)) ? 'loopback' : 'insecure';
}

/** The answer to a request over a channel credentials must not cross. */
export function insecureChannelResponse(req: IncomingMessage): { status: number; contentType: string; body: string } {
  const wantsPage = String(req.headers.accept ?? '').includes('text/html') && !(req.url ?? '').startsWith('/api/');
  const host = hostName(req.headers.host) || 'your-server';
  if (!wantsPage || (req.url ?? '').startsWith('/mcp')) {
    return {
      status: 403,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        error: 'https_required',
        message: 'mailsift accepts credentials only over HTTPS or from localhost. ' +
          'Use an HTTPS reverse proxy, or an SSH tunnel and http://127.0.0.1:8410.',
      }),
    };
  }
  const zh = /^zh/i.test(String(req.headers['accept-language'] ?? ''));
  const text = zh
    ? {
        title: '请通过 HTTPS 或本机地址访问',
        body: 'mailsift 不会通过未加密的远程连接接收密码、授权信息或访问令牌。',
        tunnel: '在你的电脑上建立 SSH 隧道，然后打开 <a href="http://127.0.0.1:8410/">http://127.0.0.1:8410</a>：',
        proxy: '或者在 mailsift 前面配置一个 HTTPS 反向代理（如 Caddy、nginx），通过 https:// 访问。',
      }
    : {
        title: 'Open mailsift over HTTPS or from localhost',
        body: 'mailsift does not accept passwords, authorizations or access tokens over an unencrypted remote connection.',
        tunnel: 'Open an SSH tunnel from your computer, then visit <a href="http://127.0.0.1:8410/">http://127.0.0.1:8410</a>:',
        proxy: 'Or put an HTTPS reverse proxy (Caddy, nginx) in front of mailsift and use its https:// address.',
      };
  const safeHost = host.replace(/[^a-z0-9.:[\]-]/gi, '');
  return {
    status: 403,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">`
      + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>mailsift</title>'
      + '<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;'
      + 'max-width:560px;margin:14vh auto;padding:0 24px;color:#15171b;background:#f4f5f7}'
      + 'h1{font-size:22px;font-weight:600;margin:0 0 12px}p{color:#4a505c}a{color:#3358d4}'
      + 'code{display:block;padding:10px 12px;margin:8px 0 16px;background:#eceef2;border-radius:8px;'
      + 'font:13px ui-monospace,Menlo,monospace;overflow-x:auto}</style></head><body>'
      + `<h1>${text.title}</h1><p>${text.body}</p><p>${text.tunnel}</p>`
      + `<code>ssh -N -L 8410:127.0.0.1:8410 you@${safeHost}</code><p>${text.proxy}</p></body></html>`,
  };
}
