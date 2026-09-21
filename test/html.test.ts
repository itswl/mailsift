import { describe, expect, it } from 'vitest';
import './setup.js';
import { escapeHtml } from '../src/html.js';

describe('escapeHtml', () => {
  it('neutralizes markup from the OAuth error parameter', () => {
    // The callback page echoes ?error= back to the browser, so a crafted redirect
    // must land as visible text rather than as an element.
    const rendered = `<p>${escapeHtml('<img src=x onerror=alert(1)>')}</p>`;
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;img');
  });

  it('escapes the ampersand first so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('escapes quotes so the value cannot break out of an attribute', () => {
    expect(escapeHtml('" onload="x')).toBe('&quot; onload=&quot;x');
    expect(escapeHtml("' onload='x")).toBe('&#39; onload=&#39;x');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('invalid_grant: code already used')).toBe('invalid_grant: code already used');
  });
});
