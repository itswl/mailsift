/**
 * The reader part of the page script: a message as it was written, and the
 * things that can be done to it.
 *
 * Showing the sender's HTML is the one place this page handles markup it did
 * not write, so it is done in three layers, each of which would be enough for
 * the threats it covers:
 *
 * 1. Rebuilt, not passed through. The markup is parsed into an inert document
 *    (nothing in it loads or runs) and walked; for each element on a short
 *    allowlist a NEW element is created with only allowlisted attributes.
 *    Scripts, forms, frames, embeds, meta tags and event handlers have no way
 *    to be copied, because nothing is copied.
 * 2. A document of its own. The result is put into a frame served with its
 *    own policy (see web-worker.ts): sandboxed with scripts off, and with
 *    remote images, fonts and stylesheets blocked by the browser itself.
 * 3. Told, not trusted. Remote images are held back until the reader asks,
 *    one-pixel trackers are dropped even then, and a link whose text names
 *    one site while it leads to another gets its real destination written
 *    beside it.
 *
 * String.raw: the script below is written as it runs. It must hold no
 * backtick and no dollar sign followed by a brace.
 */
export function readerPart(): string {
  return String.raw`
// ---- What the mailbox said about a message, kept while the page is open ----
const liveData = new Map();
const flagsByKey = new Map();
function rememberLive(key, data) {
  liveData.delete(key);
  liveData.set(key, data);
  // A handful is plenty: each can hold a whole newsletter.
  while (liveData.size > 12) liveData.delete(liveData.keys().next().value);
  if (data && data.flags) flagsByKey.set(key, data.flags);
}
function rowByKey(key) {
  for (const m of lastMail || []) if (rowKey(m) === key) return m;
  for (const m of attention || []) if (rowKey(m) === key) return m;
  for (const th of lastThreads || []) {
    if (th.latest && rowKey(th.latest) === key) return th.latest;
    for (const m of th.messages || []) if (rowKey(m) === key) return m;
  }
  return extraRows.get(key) || null;
}
// A row the server sent back after an action replaces every copy of it.
function applyRow(row) {
  if (!row) return;
  const key = rowKey(row);
  const swap = (m) => { if (m && rowKey(m) === key) Object.assign(m, row); };
  for (const m of lastMail || []) swap(m);
  for (const m of attention || []) swap(m);
  for (const th of lastThreads || []) { swap(th.latest); for (const m of th.messages || []) swap(m); }
  swap(extraRows.get(key));
}

// ---- Cleaning a message's HTML: an allowlist, rebuilt element by element ----
const MAIL_TAGS = new Set(('a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del '
  + 'details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q '
  + 'rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr').split(' '));
// Dropped with everything inside them. Anything else unknown is unwrapped: its text stays.
const MAIL_DROP = new Set(('script style iframe frame frameset object embed applet input button select textarea option optgroup '
  + 'link meta base title head noscript template svg math audio video source track canvas map area dialog slot param').split(' '));
const MAIL_ATTRS = new Set(('align alt bgcolor border cellpadding cellspacing class color colspan dir face height id lang nowrap '
  + 'rowspan size span start style title type valign width').split(' '));
const COLOURED = /(^|[;{\s])(color|background(-color|-image)?)\s*:/i;
// What a stylesheet may fetch: an inline image always, a remote one only
// when the reader asked for this message's images. Everything else is cut
// from the CSS itself, so the frame's policy never has anything to refuse.
function cssUrls(css, imagesOn, out) {
  return String(css).replace(/url\(([^)]*)\)/gi, (whole, inner) => {
    const target = inner.trim().replace(/^['"]|['"]$/g, '');
    if (/^data:image\/(png|jpe?g|gif|webp);/i.test(target)) return whole;
    if (/^https?:/i.test(target) && !ownAddress(target)) {
      if (imagesOn) return whole;
      out.remote += 1;
    }
    return 'none';
  });
}
const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp);/i;
// An address on this very server. A message has no business loading one: the
// request would carry the reader's session. Unparseable counts as ours.
function ownAddress(value) {
  try { return new URL(value).origin === location.origin; } catch (e) { return true; }
}
// The part of a host name a person would call the site: two labels, or three
// for the two-letter country domains that keep a short second level (co.uk).
function siteOf(host) {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1], second = labels[labels.length - 2];
  return labels.slice(tld.length === 2 && second.length <= 3 ? -3 : -2).join('.');
}
function cleanMail(html, doc, imagesOn) {
  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  const out = { body: doc.createDocumentFragment(), styles: [], remote: 0, trackers: 0, deceptive: 0, misleading: [], plain: true };
  for (const sheet of parsed.querySelectorAll('style')) {
    // Remote stylesheets and fonts never load here; drop the rules that ask.
    const css = cssUrls(String(sheet.textContent || '').replace(/@import[^;]*;?/gi, '').replace(/@font-face\s*\{[^}]*\}/gi, ''), imagesOn, out);
    if (!css.trim()) continue;
    out.styles.push(css);
    if (COLOURED.test(css)) out.plain = false;
  }
  const copyAttributes = (from, to) => {
    for (const attr of Array.from(from.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === 'background' && /^https?:/i.test(attr.value.trim())) { out.remote += 1; continue; }
      if (!MAIL_ATTRS.has(name)) continue;
      // What the sender wrote under a link is not where the link goes; the real address is set below.
      if (name === 'title' && from.localName === 'a') continue;
      let value = attr.value;
      if (name === 'style') {
        // Dead and dangerous CSS from other eras goes; the rest is the sender's layout.
        if (/expression\s*\(|behavior\s*:|-moz-binding|@import/i.test(value)) continue;
        if (COLOURED.test(value)) out.plain = false;
        value = cssUrls(value, imagesOn, out);
      } else if (name === 'bgcolor' || name === 'color') out.plain = false;
      to.setAttribute(name, value);
    }
  };
  const size = (node, name) => {
    const attr = parseInt(node.getAttribute(name) || '', 10);
    if (!isNaN(attr)) return attr;
    const m = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*(\\d+)px', 'i').exec(node.getAttribute('style') || '');
    return m ? Number(m[1]) : null;
  };
  // An image that is not loaded leaves a quiet box of its own size, with its
  // description, rather than the browser's broken-image mark.
  const held = (node) => {
    const box = doc.createElement('span');
    box.setAttribute('data-ms-held', '');
    const w = size(node, 'width'), h = size(node, 'height');
    if (w) box.style.width = Math.min(w, 600) + 'px';
    if (h) box.style.height = Math.min(h, 400) + 'px';
    box.textContent = (node.getAttribute('alt') || '').slice(0, 80);
    return box;
  };
  const image = (node) => {
    const src = (node.getAttribute('src') || '').trim();
    const img = doc.createElement('img');
    copyAttributes(node, img);
    if (RASTER_DATA.test(src)) { img.setAttribute('src', src); return img; }
    if (/^https?:\/\//i.test(src)) {
      if (ownAddress(src)) return null;
      const w = size(node, 'width'), h = size(node, 'height');
      const unseen = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute('style') || '');
      // An image nobody can see exists to report that the mail was opened.
      if ((w !== null && w <= 2) || (h !== null && h <= 2) || unseen) { out.trackers += 1; return null; }
      out.remote += 1;
      if (!imagesOn) return held(node);
      img.setAttribute('src', src);
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.setAttribute('loading', 'lazy');
      return img;
    }
    // An inline image the message did not carry. Any other scheme has no business here.
    if (/^cid:/i.test(src)) return held(node);
    return null;
  };
  const link = (node, copy) => {
    let url = null;
    try { url = new URL((node.getAttribute('href') || '').trim()); } catch (e) { url = null; }
    if (!url || ['https:', 'http:', 'mailto:', 'tel:'].indexOf(url.protocol) === -1) return null;
    copy.setAttribute('href', url.href);
    // Every link leaves the frame for a tab of its own, and takes nothing with it.
    copy.setAttribute('target', '_blank');
    copy.setAttribute('rel', 'noopener noreferrer nofollow');
    // Hovering a link always shows where it really goes.
    if (url.protocol.indexOf('http') === 0) {
      copy.setAttribute('title', url.href.length > 140 ? url.href.slice(0, 137) + '…' : url.href);
    }
    return url;
  };
  const walk = (from, to, depth) => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === 3) { to.appendChild(doc.createTextNode(node.nodeValue || '')); continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.localName;
      if (MAIL_DROP.has(tag) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      if (depth > 250) continue;
      if (!MAIL_TAGS.has(tag)) { walk(node, to, depth + 1); continue; }
      if (tag === 'img') { const img = image(node); if (img) to.appendChild(img); continue; }
      const copy = doc.createElement(tag);
      copyAttributes(node, copy);
      const url = tag === 'a' ? link(node, copy) : null;
      walk(node, copy, depth + 1);
      to.appendChild(copy);
      if (!url || url.protocol.indexOf('http') !== 0) continue;
      // Text that names a site, on a link that goes to a different one.
      const shown = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[\/:?#]|$)/i.exec((node.textContent || '').trim());
      if (!shown || siteOf(shown[1]) === siteOf(url.hostname)) continue;
      out.deceptive += 1;
      // Told twice. Next to the link, where the eye is; and in the page's own
      // note above the message, which no styling inside the message can hide.
      const pair = shown[1].toLowerCase() + ' → ' + url.hostname;
      if (out.misleading.length < 4 && out.misleading.indexOf(pair) === -1) out.misleading.push(pair);
      const real = doc.createElement('span');
      real.setAttribute('data-ms-goes', '');
      real.textContent = ' → ' + url.hostname;
      to.appendChild(real);
    }
  };
  const wrap = doc.createElement('div');
  // The body element's own presentation carries over to the wrapper.
  copyAttributes(parsed.body, wrap);
  walk(parsed.body, wrap, 0);
  out.body.appendChild(wrap);
  return out;
}

// ---- The frame a message is shown in ----
const SYSTEM_FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",Roboto,"Noto Sans CJK SC","Microsoft YaHei",sans-serif';
function frameCss(look) {
  return ':root{color-scheme:' + look.scheme + '}'
    + 'html{background:' + look.bg + ';overflow-y:hidden}'
    + 'body{margin:0;padding:' + look.pad + ';display:flow-root;color:' + look.text + ';font:15px/1.55 ' + SYSTEM_FONT
    + ';overflow-wrap:break-word;-webkit-text-size-adjust:100%;text-size-adjust:100%}'
    + 'a{color:' + look.link + '}'
    + 'img{max-width:100%;height:auto}'
    + 'pre{white-space:pre-wrap}'
    + 'blockquote{margin:.6em 0 .6em .2em;padding-left:.8em;border-left:2px solid ' + look.line + '}'
    + '[data-ms-held]{display:inline-block;box-sizing:border-box;max-width:100%;min-width:18px;min-height:18px;padding:2px 6px;border-radius:4px;outline:1px dashed ' + look.line
    + ';outline-offset:-1px;overflow:hidden;color:' + look.muted + ';font:12px/1.4 ' + SYSTEM_FONT + ';vertical-align:middle}'
    + '[data-ms-goes]{white-space:nowrap}';
}
// The mark beside a link that goes elsewhere is styled on the element itself
// and marked important, which a stylesheet in the message cannot outrank.
function goesCss(look) {
  return ['display:inline', 'visibility:visible', 'opacity:1', 'position:static', 'float:none', 'clip:auto', 'clip-path:none',
    'transform:none', 'max-width:none', 'max-height:none', 'overflow:visible', 'text-indent:0', 'letter-spacing:normal',
    'background:none', 'color:' + look.warn, 'font:500 12px/1.4 ' + SYSTEM_FONT]
    .map((rule) => rule + ' !important').join(';');
}
// Called once the frame's own document has loaded: clean the message into it,
// then size the frame to what it holds.
function fillFrame(frame, html, state) {
  let doc = null;
  try { doc = frame.contentDocument; } catch (e) { doc = null; }
  if (!doc || !doc.body) return null;
  const clean = cleanMail(html, doc, state.images);
  const dark = document.documentElement.dataset.theme === 'dark';
  // A message that sets colours was designed for a light page. In the dark
  // theme it keeps its paper; one that sets none takes the page's own colours.
  const paper = dark && !clean.plain;
  frame.classList.toggle('paper', paper);
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  const look = paper
    ? { scheme: 'light', bg: '#fff', text: '#1a1c20', link: '#3358d4', line: '#d3d7de', muted: '#5a616c', warn: '#8c5204', pad: '14px' }
    : { scheme: dark ? 'dark' : 'light', bg: 'transparent', text: token('--text'), link: token('--accent'),
      line: token('--line-strong'), muted: token('--muted'), warn: token('--warning-text'), pad: '0' };
  const base = doc.createElement('style');
  base.textContent = frameCss(look);
  doc.head.appendChild(base);
  for (const sheetText of clean.styles) {
    const style = doc.createElement('style');
    style.textContent = sheetText;
    doc.head.appendChild(style);
  }
  doc.body.replaceChildren(clean.body);
  const goes = goesCss(look);
  for (const mark of doc.querySelectorAll('[data-ms-goes]')) mark.setAttribute('style', goes);
  sizeFrame(frame, state);
  return clean;
}
function sizeFrame(frame, state) {
  const measure = () => {
    if (!frame.isConnected) return false;
    let doc = null;
    try { doc = frame.contentDocument; } catch (e) { doc = null; }
    if (!doc || !doc.body) return false;
    const root = doc.documentElement, body = doc.body;
    const width = frame.clientWidth;
    if (!width) return true;
    // Measured at its natural size first: a layout wider than the frame is
    // scaled down to fit, the way a mail app shows a desktop newsletter.
    body.style.zoom = '';
    const natural = Math.max(root.scrollWidth, body.scrollWidth);
    const overflows = natural > width + 2;
    if (overflows !== state.overflows) { state.overflows = overflows; if (state.changed) state.changed(); }
    if (overflows && state.fit) body.style.zoom = String(Math.max(0.3, width / natural));
    root.style.overflowX = overflows && !state.fit ? 'auto' : 'hidden';
    const height = Math.ceil(body.getBoundingClientRect().height) + (overflows && !state.fit ? 16 : 0);
    if (Math.abs(height - state.height) > 1) { state.height = height; frame.style.height = Math.max(24, height) + 'px'; }
    return true;
  };
  state.height = 0;
  state.measure = measure;
  measure();
  // Images arrive after the text. Listeners inside a script-less frame are not
  // dependable in every engine, so the frame is simply measured again for a
  // few seconds, and whenever its width changes.
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; if (!measure() || ticks > 28) clearInterval(timer); }, 250);
  if (window.ResizeObserver) {
    try { new ResizeObserver(() => measure()).observe(frame); } catch (e) {}
  }
}

// ---- Plain text: paragraphs kept, addresses made into links ----
function linkified(value) {
  const frag = document.createDocumentFragment();
  const s = String(value);
  const pattern = /https?:\/\/[^\s<>"'　-〿＀-￯]+/g;
  let at = 0, m;
  while ((m = pattern.exec(s))) {
    // Punctuation that ends the sentence is not part of the address.
    const raw = m[0].replace(/[.,;:!?)\]}]+$/, '');
    let url = null;
    try { url = new URL(raw); } catch (e) { url = null; }
    if (!url) continue;
    if (m.index > at) frag.appendChild(textNode(s.slice(at, m.index)));
    const a = el('a', null, raw);
    a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
    frag.appendChild(a);
    at = m.index + raw.length;
  }
  if (at < s.length) frag.appendChild(textNode(s.slice(at)));
  return frag;
}
function textBody(value, quoted) {
  const box = el('div', 'mail-text');
  box.appendChild(linkified(value || t('detail.noBody')));
  if (quoted) {
    const fold = document.createElement('details');
    fold.className = 'quoted';
    fold.appendChild(el('summary', null, t('reader.quoted')));
    const older = el('div', 'mail-text quoted-text');
    older.appendChild(linkified(quoted));
    fold.appendChild(older);
    box.appendChild(fold);
  }
  return box;
}

// ---- Remote images: off until asked, remembered per sender ----
let readerMode = 'html';
const imagesShown = new Set();
function imageSenders() {
  try { const list = JSON.parse(readStorage('imagesFrom') || '[]'); return Array.isArray(list) ? list : []; } catch (e) { return []; }
}
// "Always for this sender" is a promise about an address, and an address is
// only known to be the sender's when the mailbox's own server vouched for it.
// Anyone can write a From line; without that verdict images stay held.
function vouchedSender(row, data) {
  if (!data || !data.auth || data.auth.result !== 'pass') return '';
  return String((data.from && data.from.address) || row.sender || '').toLowerCase();
}
function imagesAllowed(row, data) {
  if (imagesShown.has(rowKey(row))) return true;
  const sender = vouchedSender(row, data);
  return Boolean(sender) && imageSenders().indexOf(sender) !== -1;
}
function alwaysImages(sender) {
  if (!sender) return;
  const list = imageSenders().filter((s) => s !== sender);
  list.push(sender);
  writeStorage('imagesFrom', JSON.stringify(list.slice(-200)));
}

// ---- The message itself: fetched when a message is opened ----
// Sections on the page that can draw themselves again, for a theme change.
const openMessages = new Set();
function loadMessage(row, section, hooks, fresh) {
  const key = rowKey(row);
  if (!row.messageId) { section.hidden = true; return; }
  const waiting = el('p', 'inline-status reading', t('detail.loading'));
  section.replaceChildren(waiting);
  const have = !fresh && liveData.get(key);
  if (have) { renderMessage(row, have, section, hooks); return; }
  // A mailbox with poor search can take a while; say so rather than looking stuck.
  const slow = setTimeout(() => { if (waiting.isConnected) waiting.textContent = t('detail.loading') + ' ' + t('detail.slow'); }, 8000);
  const failed = (d) => {
    clearTimeout(slow);
    section.replaceChildren(el('p', 'inline-error', d && (d.code || d.error) ? failure(d) : t('detail.networkFailed')));
    const retry = el('button', 'text-btn', t('detail.retry'));
    retry.type = 'button';
    retry.onclick = () => loadMessage(row, section, hooks, true);
    section.appendChild(retry);
  };
  const go = () => {
    // Moved on before the read began (arrowing down a list): nothing to fetch.
    if (!section.isConnected) { clearTimeout(slow); return; }
    fetch('/api/message?live=true' + (fresh ? '&fresh=true' : '') + '&id=' + encodeURIComponent(key)).then(async (r) => {
      if (r.status === 401) { location.reload(); return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { failed(d); return; }
      clearTimeout(slow);
      rememberLive(key, d);
      renderBars();
      if (section.isConnected) renderMessage(row, d, section, hooks);
    }).catch(() => failed(null));
  };
  // On a desk a short pause lets the arrow keys run down the list without a
  // mailbox read per row; on a phone a message was opened on purpose. Either
  // way it starts after this section has been put on the page.
  setTimeout(go, isWide() ? 240 : 0);
}
function renderMessage(row, data, section, hooks) {
  const key = rowKey(row);
  if (hooks.trust) showTrust(hooks.trust, data);
  if (hooks.to) showRecipients(hooks.to, data);
  if (hooks.actions && data.unsubscribe && !hooks.actions.querySelector('.unsub')) {
    const a = el('a', 'unsub', t('reader.unsubscribe'));
    a.href = data.unsubscribe; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
    a.appendChild(icon('i-arrow'));
    hooks.actions.appendChild(a);
  }
  const hasHtml = Boolean(data.html);
  const state = { mode: hasHtml && readerMode === 'html' ? 'html' : 'text', images: imagesAllowed(row, data), fit: true, overflows: false, height: 0 };
  const head = el('div', 'message-head');
  const notes = el('div', 'message-notes');
  const body = el('div', 'message-body');
  section.replaceChildren(head, notes, body);
  const quiet = (label, run) => {
    const b = el('button', 'text-btn quiet small', label);
    b.type = 'button';
    b.onclick = run;
    return b;
  };
  const drawHead = () => {
    head.replaceChildren(el('h4', 'section-label', t('detail.body')));
    const tools = el('span', 'message-tools');
    if (state.mode === 'html' && state.overflows) {
      tools.appendChild(quiet(t(state.fit ? 'reader.actual' : 'reader.fit'), () => { state.fit = !state.fit; if (state.measure) state.measure(); drawHead(); }));
    }
    if (hasHtml) {
      tools.appendChild(quiet(t(state.mode === 'html' ? 'reader.viewText' : 'reader.viewOriginal'), () => {
        state.mode = state.mode === 'html' ? 'text' : 'html';
        readerMode = state.mode;
        draw();
      }));
    }
    head.appendChild(tools);
  };
  state.changed = drawHead;
  const note = (text, cls) => { const p = el('p', 'message-note' + (cls ? ' ' + cls : ''), text); notes.appendChild(p); return p; };
  const drawNotes = (clean) => {
    notes.replaceChildren();
    if (clean && clean.deceptive) {
      const warn = note('', 'caution');
      warn.appendChild(icon('i-alert'));
      const said = el('span', null, t('reader.deceptive') + ' ');
      said.appendChild(el('b', null, clean.misleading.join(lang === 'zh-CN' ? '；' : '; ')));
      warn.appendChild(said);
    }
    if (clean && clean.remote && !state.images) {
      const line = note(clean.remote === 1 ? t('reader.images1') : fill('reader.images', { count: clean.remote }));
      line.appendChild(quiet(t('reader.showImages'), () => { imagesShown.add(key); state.images = true; draw(); }));
      const vouched = vouchedSender(row, data);
      if (vouched) line.appendChild(quiet(fill('reader.alwaysImages', { sender: vouched }), () => {
        alwaysImages(vouched); imagesShown.add(key); state.images = true; draw();
      }));
    }
    if (clean && clean.trackers) note(clean.trackers === 1 ? t('reader.trackers1') : fill('reader.trackers', { count: clean.trackers }));
    if (data.htmlOmitted && state.mode !== 'html') note(t('reader.htmlOmitted'));
    if (data.truncated) note(t('reader.truncated'));
  };
  const draw = () => {
    body.replaceChildren();
    drawHead();
    if (state.mode !== 'html') { drawNotes(null); body.appendChild(textBody(data.text, data.quoted)); return; }
    drawNotes(null);
    const frame = document.createElement('iframe');
    frame.className = 'mail-frame';
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = t('reader.frameTitle');
    frame.addEventListener('load', () => {
      const clean = fillFrame(frame, data.html, state);
      // A frame the page cannot reach into shows nothing; the words still can.
      if (!clean) { state.mode = 'text'; draw(); return; }
      drawNotes(clean);
    }, { once: true });
    frame.src = '/mail-frame' + (state.images ? '?images=1' : '');
    body.appendChild(frame);
  };
  draw();
  // Messages that are no longer on the page are let go here, with their
  // frames, and a section drawn again replaces its own entry.
  for (const known of Array.from(openMessages)) {
    if (known.section === section || !known.section.isConnected) openMessages.delete(known);
  }
  openMessages.add({ section, draw });
}
function redrawMessages() {
  for (const entry of Array.from(openMessages)) {
    if (!entry.section.isConnected) openMessages.delete(entry);
    else entry.draw();
  }
}
function showTrust(node, data) {
  const auth = data.auth;
  if (!auth || auth.result === 'none') { node.hidden = true; return; }
  node.hidden = false;
  node.className = 'trust ' + auth.result;
  node.title = t('auth.hint');
  const words = auth.result === 'pass'
    ? (auth.signedBy ? fill('auth.pass', { domain: auth.signedBy }) : t('auth.passPlain'))
    : t('auth.fail');
  node.replaceChildren(icon(auth.result === 'pass' ? 'i-shield' : 'i-alert'), textNode(words));
}
function showRecipients(node, data) {
  const people = (data.to || []).concat(data.cc || []).map((p) => p.address).filter(Boolean);
  if (!people.length) { node.hidden = true; return; }
  const shown = people.slice(0, 3).join(', ') + (people.length > 3 ? ' +' + (people.length - 3) : '');
  node.hidden = false;
  node.textContent = fill('reader.to', { list: shown });
  node.title = people.join(', ');
}

// ---- Attachments: listed at once when triage already knew them ----
const previewable = (item) => /^image\/(png|jpeg|gif|webp)$/i.test(String(item.contentType || ''));
function attachmentSection(box, row) {
  const manifest = row.attachmentManifest;
  if (manifest && Array.isArray(manifest.items)) {
    if (!manifest.items.length && !manifest.truncated) return;
    const section = el('section', 'attachments');
    section.appendChild(el('h4', 'section-label', t('detail.attachments') + DOT + manifest.items.length));
    const body = el('div', 'attachments-body');
    renderAttachmentManifest(body, manifest, row);
    section.appendChild(body);
    box.appendChild(section);
    return;
  }
  disclosure(box, t('detail.attachments'), (body) => {
    fetching(body, '/api/attachments?id=' + encodeURIComponent(row.dedupKey || row.messageId), t('detail.loadingAttachments'),
      (target, result) => renderAttachmentManifest(target, result, row));
  });
}
const lightbox = $('#lightbox');
let lightboxUrl = null;
async function openLightbox(href, name) {
  try {
    const r = await fetch(href);
    if (!r.ok) throw new Error('http ' + r.status);
    const blob = await r.blob();
    // Only what an <img> can show and nothing that could be a document.
    if (!/^image\/(png|jpeg|gif|webp)$/i.test(blob.type)) throw new Error('not an image');
    if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
    lightboxUrl = URL.createObjectURL(blob);
    const img = lightbox.querySelector('img');
    img.src = lightboxUrl;
    img.alt = name || '';
    if (!lightbox.open) lightbox.showModal();
  } catch (e) {
    toast(t('detail.networkFailed'), true);
  }
}
lightbox.addEventListener('close', () => {
  if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
  lightboxUrl = null;
  lightbox.querySelector('img').removeAttribute('src');
});
lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target.tagName === 'IMG') lightbox.close(); });
$('#lightbox-close').onclick = () => lightbox.close();

// ---- Correcting a judgement ----
function feedbackLine(row) {
  const line = el('div', 'feedback');
  line.appendChild(el('span', null, t('fb.ask')));
  const vote = (label, value) => {
    const b = el('button', 'text-btn quiet small', label);
    b.type = 'button';
    b.onclick = async () => {
      if (!requireWrite()) return;
      const r = await post('/api/feedback', { key: rowKey(row), label: value });
      if (!r.ok) { toast(failure(r.data), true); return; }
      const sender = row.senderName || row.sender || '';
      line.replaceChildren(el('span', null, r.data.rule === 'never' ? fill('fb.ruleNever', { sender })
        : r.data.rule === 'always' ? fill('fb.ruleAlways', { sender }) : t('fb.thanks')));
    };
    line.appendChild(b);
  };
  vote(t('fb.right'), 'correct');
  vote(t(row.pushed ? 'fb.wrongPushed' : 'fb.wrongQuiet'), row.pushed ? 'false_positive' : 'missed');
  return line;
}

// ---- Detail: the same content in the sheet and in the pane ----
function detail(row) {
  const box = el('div', 'detail');
  box.dataset.key = rowKey(row);
  const now = new Date();
  const d = dateOf(row);
  // A verification code is the reason the message exists, so it comes before
  // everything and can be copied in one tap.
  if (row.verificationCode) {
    const band = codeButton(row, 'code-band');
    band.appendChild(el('span', 'caption', [t('detail.code'), row.senderName || row.sender || '', hhmm(d)].filter(Boolean).join(DOT)));
    box.appendChild(band);
  }
  const title = el('h3', null, row.subject || t('noSubject'));
  title.tabIndex = -1;
  box.appendChild(title);

  const byline = el('div', 'byline');
  const from = el('p', 'from');
  from.appendChild(el('b', null, row.senderName || row.sender || t('unknownSender')));
  if (row.senderName && row.sender) from.appendChild(el('span', 'addr', ' <' + row.sender + '>'));
  byline.appendChild(from);
  const trust = el('p', 'trust');
  trust.hidden = true;
  byline.appendChild(trust);
  const to = el('p', 'to');
  to.hidden = true;
  byline.appendChild(to);
  byline.appendChild(el('p', 'where', [row.accountLabel || row.account, row.folder, dayLabel(d, now) + NB + hhmm(d)].filter(Boolean).join(DOT)));
  box.appendChild(byline);

  const judgement = el('div', 'judgement');
  const line = el('div', 'line');
  line.appendChild(el('span', 'mark ' + level(row)));
  const by = word('by.', row.decidedBy);
  let judged = by ? fill('detail.judgedAs', { level: word('level.', row.importance), by }) : word('level.', row.importance);
  if (row.pushed) judged += DOT + fill('detail.notifiedAt', { time: hhmm(new Date(row.createdAt)) });
  line.appendChild(textNode(judged));
  judgement.appendChild(line);
  const dl = el('dl');
  const add = (k, v, cls) => { if (!v) return; dl.appendChild(el('dt', null, t(k))); dl.appendChild(el('dd', cls, v)); };
  add('detail.why', row.reason);
  const due = dueInfo(row.deadline, now);
  if (due) add('detail.deadline', due.days === null ? row.deadline : row.deadline + DOT + due.text, due.late && !row.handledAt ? 'due late' : 'due');
  if (row.inSpam) {
    const folder = row.folder || t('spam');
    add('detail.mailbox', fill(row.pushed ? 'detail.rescued' : 'detail.foundIn', { folder }), row.pushed ? 'due' : null);
  }
  if (dl.childNodes.length) judgement.appendChild(dl);
  if (row.importance && row.decidedBy !== 'health' && row.decidedBy !== 'digest') judgement.appendChild(feedbackLine(row));
  box.appendChild(judgement);
  if (row.summary) box.appendChild(el('p', 'summary', row.summary));

  const actions = el('div', 'actions');
  if (row.link && row.link.url && row.link.exact) {
    const a = el('a', null, linkLabel(row));
    a.href = row.link.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.appendChild(icon('i-arrow'));
    actions.appendChild(a);
  }
  box.appendChild(actions);

  const message = el('section', 'message');
  box.appendChild(message);
  attachmentSection(box, row);
  safetySection(box, row);
  loadMessage(row, message, { trust, to, actions }, false);
  return box;
}
function threadDetail(thread) {
  const box = detail(thread.latest);
  const older = (thread.messages || []).slice(1);
  if (!older.length) return box;
  const now = new Date();
  const history = el('section', 'thread-history');
  history.appendChild(el('h4', 'section-label', t('thread.earlier') + DOT + older.length));
  const ul = el('ul', 'timeline');
  for (const message of older) {
    const li = el('li');
    const d = dateOf(message);
    // Each earlier message opens as itself, with its own text and actions.
    const open = el('button', 'tl-open');
    open.type = 'button';
    open.onclick = () => { extraRows.set(rowKey(message), message); openDetail(rowKey(message)); };
    open.appendChild(el('div', 'tl-head', (message.senderName || message.sender || t('unknownSender')) + DOT + dayLabel(d, now) + NB + hhmm(d)));
    if (message.subject && message.subject !== thread.latest.subject) open.appendChild(el('div', 'tl-subject', message.subject));
    if (message.summary) open.appendChild(el('div', 'tl-sum', message.summary));
    li.appendChild(open);
    ul.appendChild(li);
  }
  history.appendChild(ul);
  box.appendChild(history);
  return box;
}
const detailFor = (item) => (isThread(item) ? threadDetail(item) : detail(item));

// ---- Acting on a message ----
function requireWrite() {
  if (session.writable) return true;
  $('#menu-title').textContent = t('readonly.title');
  const body = menuSheet.querySelector('.sheet-body');
  body.replaceChildren(el('p', 'sheet-text', t(session.writeConfigured ? 'readonly.body' : 'readonly.unset')));
  if (session.writeConfigured) {
    const again = el('a', 'primary-action', t('readonly.signin'));
    again.href = '/signin';
    body.appendChild(again);
  }
  openSheet(menuSheet, {});
  return false;
}
const ACTION_SAID = {
  archive: 'act.archived', trash: 'act.trashed', inbox: 'act.movedInbox', star: 'act.starred',
  unstar: 'act.unstarred', mark_unread: 'act.markedUnread', mark_read: 'act.markedRead',
};
// One of each at a time: a held key or a second tap is the same request.
const acting = new Set();
async function mailAction(key, action) {
  if (!requireWrite()) return;
  if (menuSheet.open) closeSheet(menuSheet, false);
  const name = action + ' ' + key;
  if (acting.has(name)) return;
  acting.add(name);
  const r = await post('/api/action', { key, action });
  acting.delete(name);
  if (!r.ok) { toast(r.data && (r.data.code || r.data.error) ? failure(r.data) : t('act.failed'), true); return; }
  applyRow(r.data.row);
  liveData.delete(key);
  const flags = Object.assign({}, flagsByKey.get(key) || {});
  if (action === 'star' || action === 'unstar') flags.flagged = action === 'star';
  if (action === 'mark_read' || action === 'mark_unread') flags.seen = action === 'mark_read';
  flagsByKey.set(key, flags);
  if (typeof r.data.attention === 'number') attentionCount = r.data.attention;
  toast(t(ACTION_SAID[action]));
  renderList();
  renderLede();
  renderBars();
  updateBadge();
  // Filed away: the reader goes back to the list on a phone.
  if ((action === 'archive' || action === 'trash') && sheet.open && isOpenRow(key)) closeSheet(sheet, false);
  else if (action === 'inbox') renderPane(true);
}
function openMenu(key) {
  const row = rowByKey(key);
  if (!row) return;
  $('#menu-title').textContent = t('menu.title');
  const body = menuSheet.querySelector('.sheet-body');
  body.replaceChildren();
  const flags = flagsByKey.get(key) || {};
  const item = (glyph, label, run) => {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.appendChild(icon(glyph));
    b.appendChild(el('span', null, label));
    b.onclick = run;
    body.appendChild(b);
  };
  item('i-reply-all', t('act.replyAll'), () => { closeSheet(menuSheet, false); startReply(key, 'replyAll'); });
  item('i-star', t(flags.flagged ? 'act.unstar' : 'act.star'), () => mailAction(key, flags.flagged ? 'unstar' : 'star'));
  item('i-read', t(flags.seen === false ? 'act.markRead' : 'act.markUnread'), () => mailAction(key, flags.seen === false ? 'mark_read' : 'mark_unread'));
  if (row.inSpam) item('i-inbox', t('act.notSpam'), () => mailAction(key, 'inbox'));
  item('i-trash', t('act.trash'), () => mailAction(key, 'trash'));
  openSheet(menuSheet, {});
}
function barButton(glyph, label, run, cls) {
  const b = el('button', 'bar-btn' + (cls ? ' ' + cls : ''));
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(icon(glyph));
  b.appendChild(el('span', null, label));
  b.onclick = run;
  return b;
}
function fillBar(bar, row, wide) {
  bar.replaceChildren();
  if (!row) return;
  const key = rowKey(row);
  const flags = flagsByKey.get(key) || {};
  bar.appendChild(barButton('i-check', t(row.handledAt ? 'act.undone' : 'act.done'), () => complete(key, null, Boolean(row.handledAt)), 'primary' + (row.handledAt ? ' on' : '')));
  bar.appendChild(barButton('i-reply', t('act.reply'), () => startReply(key, 'reply')));
  if (wide) bar.appendChild(barButton('i-reply-all', t('act.replyAll'), () => startReply(key, 'replyAll'), 'icon-only'));
  bar.appendChild(barButton('i-archive', t('act.archive'), () => mailAction(key, 'archive'), wide ? 'icon-only' : ''));
  if (wide) bar.appendChild(barButton('i-star', t(flags.flagged ? 'act.unstar' : 'act.star'), () => mailAction(key, flags.flagged ? 'unstar' : 'star'), 'icon-only' + (flags.flagged ? ' lit' : '')));
  bar.appendChild(barButton('i-more', t('act.more'), () => openMenu(key), 'icon-only'));
  if (!wide) return;
  bar.appendChild(el('span', 'bar-space'));
  bar.appendChild(barButton('i-up', t('nav.prev'), () => stepMessage(-1), 'icon-only quiet'));
  bar.appendChild(barButton('i-down', t('nav.next'), () => stepMessage(1), 'icon-only quiet'));
  bar.appendChild(barButton('i-x', t('detail.close'), clearSelection, 'icon-only quiet'));
}
function renderBars() {
  const phone = openKey && sheet.open ? rowByKey(openKey) || (findItem(openKey) && rowOfItem(findItem(openKey))) : null;
  fillBar($('#sheet-bar'), phone, false);
  const item = isWide() && selectedKey ? findItem(selectedKey) : null;
  fillBar($('#pane-bar'), item ? rowOfItem(item) : null, true);
}

// ---- Opening a message: a sheet on a phone, the pane on a desk ----
function visibleKeys() {
  return Array.from(document.querySelectorAll('#queue li.row, #list li.row')).map((li) => li.dataset.key);
}
function stepMessage(delta) {
  const keys = visibleKeys();
  if (!keys.length) return;
  const current = keys.indexOf(isWide() ? selectedKey : openKey);
  const next = keys[Math.min(keys.length - 1, Math.max(0, current + delta))];
  if (!next || next === (isWide() ? selectedKey : openKey)) return;
  openDetail(next);
  const li = document.querySelector('li.row[data-key="' + CSS.escape(next) + '"]');
  if (li && isWide()) li.scrollIntoView({ block: 'nearest' });
}
function showInSheet(item, key) {
  const body = sheet.querySelector('.sheet-body');
  const content = detailFor(item);
  const title = content.querySelector('h3');
  if (title) title.id = 'sheet-title';
  body.replaceChildren(content);
  body.scrollTop = 0;
  return title;
}
function openDetail(key, here) {
  const item = findItem(key);
  if (!item) return;
  openKey = key;
  if (isWide()) {
    selectedKey = key;
    markSelected();
    renderPane();
    renderBars();
    history.replaceState(history.state, '', location.pathname + location.search + '#m=' + encodeURIComponent(key));
    return;
  }
  const title = showInSheet(item, key);
  const hash = '#m=' + encodeURIComponent(key);
  // Moving to the next message inside an open sheet changes what the entry
  // points at, instead of stacking an entry per message under the back button.
  if (sheet.open) history.replaceState(Object.assign({}, history.state, { key, hash }), '', location.pathname + location.search + hash);
  else openSheet(sheet, { key, hash }, here);
  renderBars();
  const keys = visibleKeys(), at = keys.indexOf(key);
  $('#sheet-prev').disabled = at <= 0;
  $('#sheet-next').disabled = at === -1 || at >= keys.length - 1;
  if (title) title.focus({ preventScroll: true });
}
$('#sheet-prev').onclick = () => stepMessage(-1);
$('#sheet-next').onclick = () => stepMessage(1);
// A message named by a link may lie outside the loaded window; it is fetched
// on its own then, without its body.
function openFromLink(key, here) {
  if (findItem(key)) { openDetail(key, here); return; }
  fetch('/api/message?id=' + encodeURIComponent(key)).then((r) => (r.ok ? r.json() : null)).then((row) => {
    if (!row || row.error) return;
    extraRows.set(key, row);
    openDetail(key, here);
  }).catch(() => {});
}
let paneKey;
function renderPane(force) {
  if (!isWide()) return;
  const body = pane.querySelector('.pane-body');
  const item = findItem(selectedKey);
  const key = item ? selectedKey : null;
  // A refresh must not throw away a message the reader is in the middle of,
  // so the pane is rebuilt only when its subject changes.
  if (!force && key === paneKey && body.childNodes.length) return;
  paneKey = key;
  body.replaceChildren();
  body.scrollTop = 0;
  pane.classList.toggle('empty', !item);
  if (!item) {
    const empty = el('div', 'pane-empty');
    empty.appendChild(envelope());
    empty.appendChild(el('p', null, t('pane.empty')));
    if (matchMedia('(pointer: fine)').matches) empty.appendChild(el('p', 'keys', t('keys.hint')));
    body.appendChild(empty);
    return;
  }
  body.appendChild(detailFor(item));
}
function clearSelection() {
  selectedKey = null; openKey = null;
  markSelected();
  renderPane();
  renderBars();
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
}
// Called by the sheet controller when any sheet has finished closing.
function sheetClosed(dialog) {
  if (dialog !== sheet) return;
  openKey = null;
  sheet.querySelector('.sheet-body').replaceChildren();
  renderBars();
}
matchMedia(WIDE).addEventListener('change', () => {
  if (isWide()) {
    if (sheet.open) { const key = openKey; closeSheet(sheet, false); selectedKey = key; }
    if (filterSheet.open) closeFilters();
    controlLine.hidden = false;
  } else {
    if (filterSheet.open && filterSheet.classList.contains('popover')) closeFilters();
    // On a phone the search line replaces the controls, so never show both; a
    // query in progress stays as a token the controls can clear.
    searchLine.hidden = true;
    controlLine.hidden = false;
    // A desk's selection is not something a phone has. Left on the address,
    // its mark would open that message again the next time a sheet closes.
    if (!sheet.open) {
      selectedKey = null;
      openKey = null;
      if (location.hash.indexOf('#m=') === 0) history.replaceState(history.state, '', location.pathname + location.search);
    }
  }
  markSelected();
  renderTokens();
  renderPane(true);
  renderBars();
});
`;
}
