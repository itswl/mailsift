/**
 * HTML escaping for the few pages this project serves itself.
 *
 * Everything else goes to Feishu as Markdown; the only HTML is the OAuth callback
 * page, which echoes query parameters straight from the browser's address bar.
 */

/** Escape the five characters that can break out of text or an attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
