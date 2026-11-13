/**
 * Two documents the web view serves besides its own page, and the security
 * headers all three go out under.
 *
 * The service worker: what makes the page installable, lets it open with no
 * network, and receives notifications while it is closed.
 *
 * The mail frame: the empty document a message's HTML is put into. A message
 * is the one thing on the page written by a stranger, so it gets a document
 * of its own with a policy of its own, in which nothing can run.
 */

/** Marks the signed-in application shell, so the worker keeps that and never a sign-in form. */
export const SHELL_HEADER = 'x-mailsift-shell';

/**
 * The worker.
 *
 * Caching: exactly one thing is kept, the application shell at "/", which is
 * markup, styles and script and holds no mail. It is fetched from the network
 * every time and the stored copy is used only when the network does not
 * answer, so an installed app still opens in a tunnel and says it is offline
 * instead of showing the browser's error page. No API response is ever
 * stored here: a list of yesterday's judgements served as today's would be
 * worse than none. What the page shows while offline is its own last
 * snapshot, labelled with its time.
 *
 * Notifications: the payload is the notice the server composed. Every push
 * shows one, because a browser withdraws the subscription of a site that
 * receives pushes silently.
 */
export const SERVICE_WORKER = [
  "const SHELL = 'mailsift-shell-v1';",
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', (event) => event.waitUntil((async () => {",
  "  for (const name of await caches.keys()) if (name !== SHELL) await caches.delete(name);",
  '  await self.clients.claim();',
  '})()));',
  "self.addEventListener('fetch', (event) => {",
  '  const request = event.request;',
  "  if (request.method !== 'GET' || request.mode !== 'navigate') return;",
  '  const url = new URL(request.url);',
  "  if (url.origin !== self.location.origin || url.pathname !== '/') return;",
  '  event.respondWith((async () => {',
  '    const cache = await caches.open(SHELL);',
  '    try {',
  '      const response = await fetch(request);',
  `      if (response.ok && response.headers.get('${SHELL_HEADER}') === '1') await cache.put('/', response.clone());`,
  '      return response;',
  '    } catch (error) {',
  "      const kept = await cache.match('/');",
  '      if (kept) return kept;',
  '      throw error;',
  '    }',
  '  })());',
  '});',
  "self.addEventListener('message', (event) => {",
  "  if (event.data && event.data.type === 'signout') event.waitUntil(caches.delete(SHELL));",
  '});',
  "self.addEventListener('push', (event) => {",
  '  let notice = {};',
  '  try { notice = event.data ? event.data.json() : {}; } catch (error) { notice = {}; }',
  '  event.waitUntil((async () => {',
  "    if (typeof notice.badge === 'number' && self.navigator.setAppBadge) {",
  '      try {',
  '        if (notice.badge > 0) await self.navigator.setAppBadge(notice.badge);',
  '        else await self.navigator.clearAppBadge();',
  '      } catch (error) {}',
  '    }',
  "    await self.registration.showNotification(notice.title || 'mailsift', {",
  "      body: notice.body || '',",
  "      tag: notice.tag || 'mailsift',",
  '      renotify: true,',
  "      icon: '/icon-192.png?v=3',",
  "      data: { url: notice.url || '/', key: notice.key || null, kind: notice.kind || 'mail' },",
  '    });',
  '  })());',
  '});',
  "self.addEventListener('notificationclick', (event) => {",
  '  event.notification.close();',
  '  const data = event.notification.data || {};',
  '  event.waitUntil((async () => {',
  "    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });",
  '    for (const client of windows) {',
  '      if (new URL(client.url).origin !== self.location.origin) continue;',
  '      try { await client.focus(); } catch (error) {}',
  "      client.postMessage({ type: 'open', url: data.url || '/', key: data.key || null, kind: data.kind || 'mail' });",
  '      return;',
  '    }',
  "    await self.clients.openWindow(new URL(data.url || '/', self.location.origin).href);",
  '  })());',
  '});',
].join('\n');

/**
 * The policy of the application page.
 *
 * Nothing loads from anywhere but this server, and only the script carrying
 * this response's nonce runs. The page builds everything from text, so there
 * is no known way to inject markup into it; this is the lock behind that door.
 */
export function appPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The policy of the document a message is shown in.
 *
 * `sandbox` without allow-scripts: no script, no event handler, no
 * javascript: link, no form, no automatic refresh, whatever the markup says.
 * allow-same-origin is there so the page can put the (already cleaned)
 * message into the document and measure it; with scripts off it grants the
 * message nothing. Links may open a new tab, which leaves the sandbox behind.
 *
 * Images: nothing remote loads unless the reader asked for this message's
 * images, since fetching one tells its sender the mail was opened, when, and
 * from where. Inline images arrive as data: and are always allowed. Fonts,
 * stylesheets and everything else remote never load.
 */
export function framePolicy(remoteImages: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${remoteImages ? ' https:' : ''}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  ].join('; ');
}

/** An empty document. The page fills it; it carries no script and no message. */
export const MAIL_FRAME = '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="referrer" content="no-referrer"><title>message</title></head><body></body></html>';
