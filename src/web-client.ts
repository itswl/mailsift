/**
 * The browser code of the web view, as a string the shell inlines.
 *
 * Every value that came from a message is written with textContent and never
 * as markup: subjects, sender names and summaries are attacker-controlled, and
 * this is the one place in the service that renders them into a document. A
 * message's own HTML is the exception that proves it: it is rebuilt element
 * by element from an allowlist into a sandboxed frame (see the reader part).
 * Written without backticks of its own, so the server's template literal
 * interpolates only at its own marks.
 *
 * Shape of the page it drives: a sentence saying how much needs the reader,
 * over a queue of exactly that and then everything else grouped by day; a
 * fresh verification code lifted above both; a message opening in a bottom
 * sheet on a phone and in a pane beside the list on a desk, with the mail as
 * it was written and the things that can be done to it. Filters live in the
 * form under their names, so the query sent to the server is still built from
 * the form, and they are mirrored to the URL so a reload, a shared link or a
 * home-screen shortcut restores the view.
 *
 * The script is one scope assembled from parts: this file is the frame every
 * other part stands on (words, time, filters, sheets, status), and the list,
 * the reader, the composer and the live line each have a file of their own.
 */
import { composePart } from './web-client-compose.js';
import { listPart } from './web-client-list.js';
import { livePart } from './web-client-live.js';
import { readerPart } from './web-client-reader.js';
import { LANGUAGES, STRINGS } from './web-strings.js';

/**
 * The language choice. A cookie, unlike the theme's localStorage, because the
 * server has to see it: the shell and the sign-in form are rendered here, and
 * a page that arrives in one language and switches after its script runs is
 * exactly the flash the theme code goes out of its way to avoid. It holds
 * nothing secret, so the browser may write it, and the server only ever maps
 * it onto a fixed list.
 */
export const LANGUAGE_COOKIE = 'mailsift_lang';
/** A year. A language is not a choice anyone wants to make twice. */
const LANGUAGE_MAX_AGE = 365 * 24 * 60 * 60;

/** Browser code that records a language choice where the server sees it on the next request. */
export function storeLanguageScript(): string {
  return `function storeLanguage(l){document.cookie='${LANGUAGE_COOKIE}='+l+'; Path=/; Max-Age=${LANGUAGE_MAX_AGE}; SameSite=Lax'}`;
}

/** The whole script: the frame, then each part, then the lines that start it. */
export function clientScript(): string {
  return corePart() + listPart() + readerPart() + composePart() + livePart();
}

function corePart(): string {
  return `
const $ = (s) => document.querySelector(s);
const SVG_NS = 'http://www.w3.org/2000/svg';
const list = $('#list'), filters = $('#filters'), lane = $('#lane'), header = $('.app-header');
const sheet = $('#sheet'), pane = $('#pane'), filterSheet = $('#filter-sheet'), installHelp = $('#install-help');
const healthSheet = $('#health-sheet'), healthLine = $('#health');
const notifySheet = $('#notify-sheet'), keysSheet = $('#keys-sheet'), menuSheet = $('#menu-sheet'), composeSheet = $('#compose');
const queue = $('#queue'), answerBox = $('#answer');
// The separators every line of supporting text is joined with.
const DOT = ' \u00b7 ', NB = '\u00a0';
const MAIL_PAGE_SIZE = 100;
// A code is lifted above the list for ten minutes, and its digits go quiet after fifteen.
const FRESH_CODE_MS = 10 * 60 * 1000;
const STALE_CODE_MS = 15 * 60 * 1000;
const WIDE = '(min-width: 900px)';
const isWide = () => matchMedia(WIDE).matches;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Every language travels with the page, so the switch needs no round trip.
const LANGUAGES = ${JSON.stringify(LANGUAGES)};
const STRINGS = ${JSON.stringify(STRINGS)};
let lang = STRINGS[document.documentElement.lang] ? document.documentElement.lang : 'en';
const t = (key) => STRINGS[lang][key];
function fill(key, vars) {
  let text = t(key);
  for (const name in vars) text = text.split('{' + name + '}').join(vars[name]);
  return text;
}
// A vocabulary value, worded when the table knows it and shown as stored when
// not: records written before the vocabulary existed may hold free-form labels.
const word = (prefix, value) => STRINGS[lang][prefix + value] || value || '';
${storeLanguageScript()}

// ---- Small builders. Message text only ever travels through textContent. ----
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
const textNode = (value) => document.createTextNode(String(value));
function icon(id) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#' + id);
  use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + id);
  svg.appendChild(use);
  return svg;
}
// The app icon's envelope without its badge: the mark of a quiet day.
function envelope() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'envelope');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M16 20h32a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3V23a3 3 0 0 1 3-3zM13 23l19 12 19-12');
  svg.appendChild(path);
  return svg;
}

// ---- Time. Rows show the clock time; the day header carries the date. ----
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
function dateOf(row) {
  const d = new Date(row.mailDate || row.createdAt);
  return isNaN(d) ? new Date(row.createdAt) : d;
}
const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function dayLabel(d, now) {
  if (dayKey(d) === dayKey(now)) return t('day.today');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return t('day.yesterday');
  const options = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  try { return new Intl.DateTimeFormat(lang, options).format(d); } catch (e) { return (d.getMonth() + 1) + '-' + pad(d.getDate()); }
}
function ago(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return t('ago.now');
  if (minutes < 60) return fill('ago.min', { n: minutes });
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? rtf.format(-hours, 'hour') : rtf.format(-Math.floor(hours / 24), 'day');
  } catch (e) { return ''; }
}
// "since 09:14" today, "since yesterday 09:14", otherwise the day and the time.
function sinceText(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return hhmm(d);
  return dayPhrase(d, now) + '\\u00a0' + hhmm(d);
}
// A day label for the middle of an English sentence: "today", not "Today".
function dayPhrase(d, now) {
  const label = dayLabel(d, now);
  return lang === 'en' && (label === t('day.today') || label === t('day.yesterday')) ? label.toLowerCase() : label;
}
function when(row, now) {
  const d = dateOf(row);
  if (isNaN(d)) return '';
  const age = now - d;
  return age >= 0 && age < 3600000 ? ago(age) : hhmm(d);
}

// ---- Filters: the form is the state; the URL mirrors it. ----
const field = (name) => filters.elements.namedItem(name);
const URL_KEYS = ['hours', 'view', 'importance', 'category', 'account', 'q', 'spamOnly', 'pushedOnly', 'codesOnly'];
const URL_DEFAULTS = { hours: '24', view: 'mail' };
let pendingPicks = {};
function query() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(filters)) if (v) p.set(k, v === 'on' ? 'true' : v);
  // A category or mailbox asked for before its options arrived still applies.
  for (const name in pendingPicks) if (!p.has(name)) p.set(name, pendingPicks[name]);
  return p;
}
const dataPath = () => (filters.view.value === 'threads' ? '/api/threads' : '/api/mail');
function syncUrl() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(filters)) {
    if (!v || URL_DEFAULTS[k] === v) continue;
    p.set(k, v === 'on' ? '1' : v);
  }
  for (const name in pendingPicks) if (!p.has(name)) p.set(name, pendingPicks[name]);
  const search = p.toString() ? '?' + p.toString() : '';
  if (location.search !== search) history.replaceState(history.state, '', location.pathname + search + location.hash);
}
function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const name of URL_KEYS) {
    const value = p.get(name);
    if (value === null) continue;
    const f = field(name);
    if (!f) continue;
    if (f.tagName === 'SELECT') pendingPicks[name] = value;
    else setField(f, value);
  }
}
// Radios are set by checking the matching one: assigning RadioNodeList.value
// does not select a radio whose value is empty in every engine, which left the
// "any level" choice unreachable once another was picked. A value that no
// radio carries changes nothing.
function setField(f, v) {
  if (f instanceof RadioNodeList) {
    const match = Array.from(f).find((r) => r.value === String(v));
    if (match) match.checked = true;
  } else if (f.type === 'checkbox') f.checked = v === true || v === '1' || v === 'true';
  else f.value = v === null || v === undefined ? '' : String(v);
}
function setFilters(changes) {
  for (const name in changes) {
    delete pendingPicks[name];
    const f = field(name);
    if (f) setField(f, changes[name]);
  }
  onFiltersChanged();
}
function clearFilters() {
  setFilters({ importance: '', category: '', account: '', spamOnly: false, pushedOnly: false, codesOnly: false, q: '' });
}
function filtersActive() {
  return Boolean(filters.importance.value || filters.category.value || filters.account.value
    || filters.spamOnly.checked || filters.pushedOnly.checked || filters.codesOnly.checked || filters.q.value.trim()
    || Object.keys(pendingPicks).length);
}
function markSegs() {
  for (const label of filters.querySelectorAll('.seg')) {
    const input = label.querySelector('input');
    label.classList.toggle('on', Boolean(input && input.checked));
  }
}
function accountName(address) {
  const s = lastSummary;
  const match = s && Array.isArray(s.accounts) ? s.accounts.find((a) => a.address === address) : null;
  return match ? match.name : address;
}
function renderTokens() {
  const box = $('#tokens');
  box.replaceChildren();
  const items = [];
  if (filters.importance.value) items.push({ label: word('level.', filters.importance.value), clear: () => setFilters({ importance: '' }) });
  const category = filters.category.value || pendingPicks.category;
  const account = filters.account.value || pendingPicks.account;
  if (category) items.push({ label: word('category.', category), clear: () => setFilters({ category: '' }) });
  if (account) items.push({ label: accountName(account), clear: () => setFilters({ account: '' }) });
  if (filters.spamOnly.checked) items.push({ label: t('spam'), clear: () => setFilters({ spamOnly: false }) });
  if (filters.pushedOnly.checked) items.push({ label: t('notified'), clear: () => setFilters({ pushedOnly: false }) });
  if (filters.codesOnly.checked) items.push({ label: t('code.tag'), clear: () => setFilters({ codesOnly: false }) });
  const count = items.length + (filters.view.value === 'threads' ? 1 : 0);
  if (filters.view.value === 'threads') items.push({ label: t('view.threads'), clear: () => setFilters({ view: 'mail' }) });
  // The query shows as a token only where its field is out of sight: on a
  // phone, once the search line has given way to the controls again.
  const q = filters.q.value.trim();
  if (q && !isWide() && searchLine.hidden) items.push({ label: '\\u201c' + q + '\\u201d', clear: () => setFilters({ q: '' }) });
  box.hidden = !items.length;
  for (const item of items) {
    const b = el('button', 'token', item.label);
    b.type = 'button';
    b.onclick = item.clear;
    box.appendChild(b);
  }
  if (items.length > 1) {
    const clear = el('button', 'token clear', t('filter.clearAll'));
    clear.type = 'button';
    clear.onclick = () => { clearFilters(); setFilters({ view: 'mail' }); };
    box.appendChild(clear);
  }
  $('#filters-open').textContent = count ? fill('filter.moreActive', { count }) : t('filter.more');
}

// ---- Search: an icon on a phone, a field on a desk. ----
const searchLine = $('#search-line'), controlLine = $('#control-line'), searchInput = filters.q;
function showSearch() {
  searchLine.hidden = false;
  if (!isWide()) controlLine.hidden = true;
  renderTokens();
  searchInput.focus();
}
function hideSearch() {
  if (isWide()) return;
  searchLine.hidden = true;
  controlLine.hidden = false;
  renderTokens();
}
$('#search-open').onclick = showSearch;
$('#search-cancel').onclick = () => {
  if (searchInput.value) { searchInput.value = ''; onFiltersChanged(); }
  hideSearch();
};
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchInput.blur(); }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (searchInput.value) { searchInput.value = ''; onFiltersChanged(); } else { hideSearch(); searchInput.blur(); }
  }
});
filters.addEventListener('submit', (e) => e.preventDefault());

// ---- Sheets: one controller for every sheet on the page. ----
// Opening pushes a history entry so the system back gesture closes the sheet
// rather than the app; closing by any other means pops that entry again.
// Sheets stack: a reply opens over the message it answers, and back closes
// only the one on top.
const sheetStack = [];
// Popovers open now, with what opened each (see openPopover). Declared here: openSheet closes them.
const popovers = new Map();
const topSheet = () => (sheetStack.length ? sheetStack[sheetStack.length - 1].dialog : null);
// With here set, the current history entry becomes the sheet's instead of a new one:
// the entry already exists when a link or the forward button brought us to it.
function openSheet(dialog, state, here) {
  if (dialog.open) return;
  // A popover makes way for a sheet, which takes over its history entry.
  for (const [open, p] of [...popovers]) {
    const ours = p.history && history.state && history.state.popover === open.id;
    closePopover(open, ours);
    if (ours) here = true;
  }
  sheetStack.push({ dialog, back: document.activeElement });
  dialog.classList.remove('closing');
  dialog.showModal();
  // The sheet itself takes the focus, not its first button: a sheet opened by
  // a tap would otherwise show a keyboard focus ring on "Done".
  if (dialog.hasAttribute('tabindex')) dialog.focus({ preventScroll: true });
  dialog.classList.add('opening');
  dialog.addEventListener('animationend', () => dialog.classList.remove('opening'), { once: true });
  rehomeToast();
  const url = location.pathname + location.search + (state && state.hash ? state.hash : location.hash);
  const entry = Object.assign({ sheet: dialog.id, depth: sheetStack.length }, state || {});
  if (here) history.replaceState(entry, '', url);
  else history.pushState(entry, '', url);
}
// Several sheets closed in one go leave the history in one step, not one each:
// a second back() issued before the first has landed would be lost.
let backsOwed = 0;
function oweBack() {
  backsOwed += 1;
  if (backsOwed > 1) return;
  Promise.resolve().then(() => {
    const steps = backsOwed;
    backsOwed = 0;
    history.go(-steps);
  });
}
function closeSheet(dialog, viaHistory) {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  const at = sheetStack.findIndex((entry) => entry.dialog === dialog);
  const entry = at === -1 ? null : sheetStack.splice(at, 1)[0];
  rehomeToast();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.classList.remove('closing');
    dialog.style.transform = '';
    dialog.close();
    if (dialog === filterSheet) filtersOpen.setAttribute('aria-expanded', 'false');
    sheetClosed(dialog);
    const back = entry ? entry.back : null;
    // A redraw while the sheet was open may have replaced the opener; its
    // successor carries the same identity or key.
    const identity = back && !back.isConnected && back.dataset
      ? back.dataset.focus ? '[data-focus="' + CSS.escape(back.dataset.focus) + '"]'
        : back.dataset.key ? '#digest [data-key="' + CSS.escape(back.dataset.key) + '"]' : null
      : null;
    // A code that arrived while the sheet was in the way takes the focus it
    // was owed, brought into view: the list may have been scrolled far down.
    const owed = takeOwedFocus(dialog);
    if (owed) owed.scrollIntoView({ block: 'center' });
    const target = owed || (back && back.isConnected ? back : identity ? document.querySelector(identity) : null);
    if (target && target.focus) target.focus({ preventScroll: true });
  };
  if (reduceMotion()) finish();
  else {
    dialog.classList.add('closing');
    dialog.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 320);
  }
  if (!viaHistory && entry) oweBack();
}
// Drag the head down to dismiss; a short drag snaps back.
function enableDrag(dialog) {
  const head = dialog.querySelector('.sheet-head');
  let startY = 0, startT = 0, dy = 0, active = false;
  head.addEventListener('pointerdown', (e) => {
    // A press on Done or Clear is a click, not the start of a drag: capturing
    // the pointer here would retarget the click to the head and swallow it.
    if (e.button !== 0 || dialog.classList.contains('popover') || e.target.closest('button, a, input, select')) return;
    active = true; startY = e.clientY; startT = e.timeStamp; dy = 0;
    head.setPointerCapture(e.pointerId);
    dialog.style.transition = 'none';
  });
  head.addEventListener('pointermove', (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - startY);
    dialog.style.transform = 'translateY(' + dy + 'px)';
  });
  const end = (e) => {
    if (!active) return;
    active = false;
    dialog.style.transition = '';
    const velocity = dy / Math.max(1, e.timeStamp - startT);
    if (dy > 120 || velocity > 0.5) closeSheet(dialog, false);
    else dialog.style.transform = '';
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}
for (const dialog of [sheet, filterSheet, installHelp, healthSheet, notifySheet, keysSheet, menuSheet, composeSheet]) {
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dialog === filterSheet && dialog.classList.contains('popover')) closeFilters();
    else if (popovers.has(dialog)) closePopover(dialog, false);
    else closeSheet(dialog, false);
  });
  // A click on the dialog itself is a click on the backdrop: the content fills
  // the box. A letter being written is not thrown away by a stray tap.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog || dialog.classList.contains('popover') || dialog === composeSheet) return;
    closeSheet(dialog, false);
  });
  enableDrag(dialog);
}
$('#sheet-close').onclick = () => closeSheet(sheet, false);
$('#install-close').onclick = () => closeSheet(installHelp, false);
$('#install-done').onclick = () => closeSheet(installHelp, false);
$('#health-done').onclick = () => closePopover(healthSheet, false);
$('#notify-done').onclick = () => closePopover(notifySheet, false);
$('#keys-done').onclick = () => closeSheet(keysSheet, false);
$('#menu-done').onclick = () => closeSheet(menuSheet, false);
window.addEventListener('popstate', () => {
  // Close whatever is open above the entry we came back to.
  const depth = history.state && history.state.sheet ? history.state.depth || 1 : 0;
  while (sheetStack.length > depth) closeSheet(topSheet(), true);
  if (filterSheet.open && filterSheet.classList.contains('popover')) closeFilters();
  // A popover whose entry we have left: the back gesture closed it.
  for (const [open, p] of [...popovers]) {
    if (p.history && !(history.state && history.state.popover === open.id)) closePopover(open, true);
  }
  if (!sheetStack.length) {
    // A #m= link followed while the page is open, or the forward button back
    // onto a message: show it, on the entry we are already on.
    const key = keyFromHash(location.hash);
    if (key && key !== openKey) openFromLink(key, true);
  }
  // The entry we came back to predates any filter changed while a sheet was
  // open. The form is the truth, so put it back on the address.
  syncUrl();
});
// A message key from a #m= link. Keys are percent-encoded message ids, and a
// link cut off mid-escape must not take the whole page down with it.
function keyFromHash(hash) {
  if (hash.indexOf('#m=') !== 0) return null;
  try { return decodeURIComponent(hash.slice(3)) || null; } catch (e) { return null; }
}

// ---- Popovers: a small panel under the control that opened it. ----
// For what is looked at and set in a moment (notifications, the mailboxes'
// health, and on a desk the filters): it opens where the eye already is, with
// a notch pointing at its control, and dims nothing. It is not modal. A tap
// outside closes it, and on a touch screen that tap does nothing else, as in
// the system's own menus; so do Escape and its control again. On a phone it
// takes a history entry, so the back gesture closes it as it closes a sheet.
// Where it goes, through custom properties only the popover style reads. A
// control in the sticky header keeps its place on screen, so its popover is
// fixed; one in the page scrolls with it, in document coordinates.
function placePopover(dialog) {
  const p = popovers.get(dialog);
  if (!p) return;
  const r = p.anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  // On a phone the panel takes the width, margins aside: a panel nearly as wide as the screen that
  // stops short of one edge looks misplaced. The notch still points at its control.
  const width = vw < 600 ? vw - 24 : Math.min(p.width, vw - 24);
  const left = p.align === 'start'
    ? Math.max(12, Math.min(r.left - 4, vw - width - 12))
    : Math.max(12, Math.min(vw - 12, r.right + 4) - width);
  const top = r.bottom + 10;
  const sx = p.fixed ? 0 : window.scrollX, sy = p.fixed ? 0 : window.scrollY;
  dialog.classList.toggle('fixed', p.fixed);
  dialog.style.setProperty('--pop-left', (left + sx) + 'px');
  dialog.style.setProperty('--pop-top', (top + sy) + 'px');
  dialog.style.setProperty('--pop-width', width + 'px');
  dialog.style.setProperty('--pop-arrow', Math.max(20, Math.min(width - 20, r.left + r.width / 2 - left)) + 'px');
  dialog.style.setProperty('--pop-max', Math.max(240, window.innerHeight - top - 12) + 'px');
}
function openPopover(dialog, anchor, options) {
  if (dialog.open) return;
  const p = Object.assign({ anchor, width: 320, align: 'end', fixed: false, history: false }, options || {});
  popovers.set(dialog, p);
  dialog.classList.remove('closing');
  dialog.classList.add('popover');
  placePopover(dialog);
  dialog.show();
  dialog.focus({ preventScroll: true });
  if (!reduceMotion()) {
    dialog.classList.add('opening');
    dialog.addEventListener('animationend', () => dialog.classList.remove('opening'), { once: true });
  }
  anchor.setAttribute('aria-expanded', 'true');
  if (p.history) history.pushState({ popover: dialog.id, depth: sheetStack.length }, '', location.href);
}
function closePopover(dialog, viaHistory) {
  const p = popovers.get(dialog);
  popovers.delete(dialog);
  if (!p) return;
  dialog.classList.remove('opening');
  if (dialog.open) dialog.close();
  p.anchor.setAttribute('aria-expanded', 'false');
  if (p.history && !viaHistory && history.state && history.state.popover === dialog.id) oweBack();
}
function swallowNextClick() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  document.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', stop, true), 600);
}
document.addEventListener('pointerdown', (e) => {
  if (!popovers.size) return;
  const target = e.target;
  // The line that says what happened floats above everything, a popover included.
  if (target instanceof Element && target.closest('#toast, #sending')) return;
  let closed = false;
  for (const [dialog, p] of [...popovers]) {
    if (!dialog.open) { popovers.delete(dialog); continue; }
    if (dialog.contains(target) || p.anchor.contains(target)) continue;
    if (dialog === filterSheet) closeFilters(); else closePopover(dialog, false);
    closed = true;
  }
  if (closed && e.pointerType !== 'mouse') swallowNextClick();
}, true);
// Not modal, so the browser sends no cancel: Escape is ours to handle.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !popovers.size || document.querySelector('dialog[open]:not(.popover)')) return;
  const [dialog, p] = [...popovers].pop();
  e.preventDefault();
  e.stopPropagation();
  if (dialog === filterSheet) closeFilters(); else closePopover(dialog, false);
  p.anchor.focus({ preventScroll: true });
}, true);
window.addEventListener('resize', () => { for (const dialog of popovers.keys()) placePopover(dialog); });

// ---- The filter sheet: a sheet on a phone, a popover on a desk. ----
const filtersOpen = $('#filters-open');
function openFilters() {
  if (isWide()) openPopover(filterSheet, filtersOpen, { width: 320 });
  else {
    filterSheet.classList.remove('popover');
    openSheet(filterSheet, {});
    filtersOpen.setAttribute('aria-expanded', 'true');
  }
}
function closeFilters() {
  if (!filterSheet.open) return;
  if (popovers.has(filterSheet)) closePopover(filterSheet, false);
  else closeSheet(filterSheet, false);
}
filtersOpen.onclick = () => (filterSheet.open ? closeFilters() : openFilters());
$('#filter-done').onclick = closeFilters;
$('#filter-clear').onclick = () => { clearFilters(); setFilters({ view: 'mail' }); };

// ---- Status and announcements ----
let connectionProblem = !navigator.onLine;
let lastFetchAt = null;
let pollNarration = null, narrationTimer;
function setNetworkIssue(active) {
  const banner = $('#network');
  const text = active ? t(navigator.onLine ? 'network.unavailable' : 'network.offline') : '';
  // Spoken through the page's one live region: a region that appears with
  // its words already in place is not reliably announced.
  if (active && (!connectionProblem || $('#network-text').textContent !== text)) announce(text);
  connectionProblem = active;
  banner.hidden = !active;
  banner.classList.toggle('offline', !navigator.onLine);
  if (active) $('#network-text').textContent = text;
  document.body.classList.toggle('offline', active && !navigator.onLine);
  renderStatus();
}
$('#network-retry').onclick = () => { load(true); chrome(); };
function narrate(text, warn, holdMs) {
  clearTimeout(narrationTimer);
  pollNarration = text ? { text, warn: Boolean(warn) } : null;
  renderStatus();
  if (text && holdMs) narrationTimer = setTimeout(() => { pollNarration = null; renderStatus(); }, holdMs);
}
let announceTimer;
// Texts announced within the same moment are joined, not dropped: the wait
// and a failing mailbox can both have something to say on the way in.
let announcePending = '';
function announce(text) {
  const region = $('#announce');
  region.textContent = '';
  clearTimeout(announceTimer);
  announcePending = announcePending && announcePending !== text ? announcePending + ' \\u00b7 ' + text : text;
  announceTimer = setTimeout(() => {
    region.textContent = announcePending;
    announcePending = '';
  }, 50);
}
let toastTimer;
// Shown in the browser's top layer where it can be, so an open sheet does not
// cover it; elsewhere it is an ordinary fixed element.
// A modal sheet makes everything outside it inert, a toast included, so the
// toast lives inside whichever sheet is on top and moves when that changes.
function toastHost() {
  for (const id of ['lightbox', 'palette']) {
    const dialog = document.getElementById(id);
    if (dialog && dialog.open) return dialog;
  }
  return topSheet() || document.body;
}
function raiseToast(node) {
  const host = toastHost();
  try { if (node.matches(':popover-open')) node.hidePopover(); } catch (e) {}
  if (node.parentNode !== host) host.appendChild(node);
  // Clear of the reader's bar of actions when it is the reader that is open.
  node.classList.toggle('lifted', host === sheet);
  node.hidden = false;
  if (!node.showPopover) return;
  try { node.showPopover(); } catch (e) {}
}
function rehomeToast() {
  // The line that says what happened, and the count of a letter on its way out.
  for (const node of [$('#toast'), $('#sending')]) {
    if (!node.hidden && node.parentNode !== toastHost()) raiseToast(node);
  }
}
function hideToast() {
  const node = $('#toast');
  clearTimeout(toastTimer);
  node.hidden = true;
  if (node.hidePopover) { try { node.hidePopover(); } catch (e) {} }
}
// A line that says what just happened. With an action it also offers the one
// way back (undo), and stays a little longer so there is time to take it.
// A hold of zero keeps it until something replaces or hides it.
function toast(text, failed, action, hold) {
  const node = $('#toast');
  announce(text);
  node.replaceChildren(el('span', null, text));
  if (action) {
    const b = el('button', 'toast-action', action.label);
    b.type = 'button';
    b.onclick = () => { hideToast(); action.run(); };
    node.appendChild(b);
  }
  node.classList.toggle('failed', Boolean(failed));
  raiseToast(node);
  clearTimeout(toastTimer);
  if (hold !== 0) toastTimer = setTimeout(hideToast, hold || (action ? 6000 : 4000));
}

// ---- Data ----
// The last answers are kept so a language switch can reword the page from
// them instead of asking the server again.
let lastMail = null, lastThreads = null, lastSummary = null, lastDigest = null, loadFailed = false;
// Set while the lane waits for a code the page was opened for (see startCodeWait).
let codeWait = null;
let nextCursor = null, loadingMail = false, loadMoreFailed = false, mailRequestId = 0;
let selectedKey = null, openKey = null;
let washNext = false;
const renderedKeys = new Set();
const extraRows = new Map();
// What needs the reader: the rows of the queue, how many there are in all,
// and their keys, so any row anywhere knows whether it is one of them.
let attention = null, attentionCount = 0, attentionSet = new Set();
// What was dealt with lately, most recently first: the way back for a row
// that has left the queue. Each says whether it would return to the queue.
let doneRecent = [], doneExpanded = false;
// What this session may do; the summary carries it.
let session = { writable: false, writeConfigured: false, assistant: false, push: true, auth: false };
// Whether the page is on the server's live line, and so hears of mail as it is judged.
let live = false;
let sinceAt = Date.parse(readStorage('seenAt') || '') || 0;
let firstLoadDone = false;

function readStorage(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function writeStorage(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

const rowKey = (m) => m.dedupKey || m.messageId || '';
// Levels are a fixed vocabulary; anything else is shown as stored but styled as info.
const level = (m) => (m.importance === 'critical' || m.importance === 'warning' ? m.importance : 'info');
const isThread = (item) => Boolean(item && item.latest);
const threadKeyOf = (th) => th.threadKey || rowKey(th.latest || {});
const keyOf = (item) => (isThread(item) ? threadKeyOf(item) : rowKey(item));
const rowOfItem = (item) => (isThread(item) ? item.latest : item);
function findItem(key) {
  if (!key) return null;
  for (const item of (filters.view.value === 'threads' ? lastThreads : lastMail) || []) if (keyOf(item) === key) return item;
  for (const item of lastMail || []) if (keyOf(item) === key) return item;
  for (const item of lastThreads || []) if (keyOf(item) === key) return item;
  for (const item of attention || []) if (keyOf(item) === key) return item;
  for (const item of doneRecent) if (keyOf(item) === key) return item;
  return extraRows.get(key) || null;
}
function mergeMail(existing, incoming) {
  const byKey = new Map();
  for (const row of existing.concat(incoming)) byKey.set(row.dedupKey || row.messageId, row);
  return Array.from(byKey.values()).sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || '') ||
    (b.dedupKey || '').localeCompare(a.dedupKey || ''));
}

// ---- The sentence and the status line ----
function windowWord() {
  const h = filters.hours.value;
  return t(h === '720' ? 'window.long.30d' : h === '168' ? 'window.long.7d' : h === '72' ? 'window.long.3d' : 'window.long.24h');
}
// A template with {marks} becomes text nodes and, where an action is given for
// the mark, a button carrying the number. Only integers and table strings are
// involved, never message text.
function appendTemplate(node, key, vars, actions) {
  const template = t(key);
  const NB = '\\u00a0';
  const re = /\\{(\\w+)\\}/g;
  let last = 0, m;
  while ((m = re.exec(template))) {
    let before = template.slice(last, m.index);
    // A word joined to the number by a no-break space stays on its line with
    // it. The space alone cannot do that: a line may still break beside the
    // button, so the pair goes into one unbreakable group.
    let lead = '';
    if (before.endsWith(NB)) {
      const cut = before.lastIndexOf(' ') + 1;
      lead = before.slice(cut);
      before = before.slice(0, cut);
    }
    if (before) node.appendChild(textNode(before));
    const name = m[1];
    const value = String(vars[name]);
    const after = template.slice(re.lastIndex);
    let trail = '';
    if (after.startsWith(NB)) {
      const end = after.indexOf(' ');
      trail = end === -1 ? after : after.slice(0, end);
    }
    const action = actions && actions[name];
    let mark;
    if (action) {
      mark = el('button', 'num', value);
      mark.type = 'button';
      // The digit is what shows; the name also says what pressing it does.
      mark.title = t(action.label);
      mark.setAttribute('aria-label', value + t('lede.join') + t(action.label));
      mark.onclick = action.run;
    } else mark = textNode(value);
    if (lead || trail) {
      const glue = el('span', 'glue');
      if (lead) glue.appendChild(textNode(lead));
      glue.appendChild(mark);
      if (trail) glue.appendChild(textNode(trail));
      node.appendChild(glue);
    } else node.appendChild(mark);
    last = re.lastIndex + trail.length;
    re.lastIndex = last;
  }
  if (last < template.length) node.appendChild(textNode(template.slice(last)));
}
// The sentence: how much needs the reader. Under it, the count of what arrived.
function showQueue() {
  clearFilters();
  if (filters.view.value !== 'mail') setFilters({ view: 'mail' });
  const first = queue.querySelector('.ring, .who');
  if (first) { queue.scrollIntoView({ block: 'start' }); first.focus({ preventScroll: true }); }
}
function renderLede() {
  const node = $('#lede');
  const before = node.textContent;
  const fresh = el('p');
  const known = attention !== null || Boolean(lastSummary);
  node.classList.toggle('pending', !known);
  if (!known) fresh.textContent = t('lede.loading');
  else if (!attentionCount) fresh.textContent = t('lede.attention0') + t('lede.end');
  else {
    appendTemplate(fresh, attentionCount === 1 ? 'lede.attention1' : 'lede.attention', { n: attentionCount }, {
      n: { run: showQueue, label: 'lede.showQueue' },
    });
    fresh.appendChild(textNode(t('lede.end')));
  }
  node.classList.toggle('clear', known && !attentionCount);
  const focused = Array.from(node.querySelectorAll('.num')).indexOf(document.activeElement);
  node.replaceChildren(...fresh.childNodes);
  if (focused >= 0) {
    const again = node.querySelectorAll('.num')[focused];
    if (again) again.focus({ preventScroll: true });
  }
  // A sentence that changed fades in; one that did not is left alone.
  if (before && before !== node.textContent && !reduceMotion()) {
    node.style.transition = 'none';
    node.style.opacity = '0';
    void node.offsetWidth;
    node.style.transition = '';
    node.style.opacity = '';
  }
  renderTally();
}
function renderTally() {
  const node = $('#tally');
  const fresh = el('p');
  const s = lastSummary;
  if (!s) fresh.textContent = '';
  else if (!s.total) fresh.textContent = fill('lede.none', { window: windowWord() });
  else {
    const critical = (s.byImportance && s.byImportance.critical) || 0;
    appendTemplate(fresh, s.total === 1 ? 'lede.total1' : 'lede.total', { total: s.total }, {
      total: { run: clearFilters, label: 'lede.showAll' },
    });
    fresh.appendChild(textNode(t('lede.join')));
    // A single message that was notified needs no count of its own.
    const pushedKey = s.pushed === 0 ? 'lede.pushed0' : (s.total === 1 ? 'lede.pushed1' : 'lede.pushed');
    appendTemplate(fresh, pushedKey, { pushed: s.pushed }, {
      pushed: { run: () => setFilters({ pushedOnly: true }), label: 'lede.showPushed' },
    });
    if (critical > 0) {
      fresh.appendChild(textNode(t('lede.join')));
      appendTemplate(fresh, 'lede.critical', { critical }, {
        critical: { run: () => setFilters({ importance: 'critical' }), label: 'lede.showCritical' },
      });
    }
    fresh.appendChild(textNode(t('lede.end')));
  }
  const focused = Array.from(node.querySelectorAll('.num')).indexOf(document.activeElement);
  node.replaceChildren(...fresh.childNodes);
  if (focused >= 0) {
    const again = node.querySelectorAll('.num')[focused];
    if (again) again.focus({ preventScroll: true });
  }
}
function renderStatus() {
  const [text, warn] = statusLine();
  const node = $('#status');
  node.classList.toggle('warn', warn);
  // Writing the same words again would have the live region say them again.
  if (node.textContent !== text) node.textContent = text;
  // A dot ahead of the words while the page is on the live line.
  const on = live && !connectionProblem;
  node.classList.toggle('live', on);
  node.title = on ? t('status.liveHint') : '';
  renderHealthLine();
}

// ---- Mailboxes the poller cannot read ----
// The heartbeat is written after every poll, even one in which a mailbox
// failed, so "checked a minute ago" alone could vouch for a mailbox nobody has
// read for days. The line under the status names it, and opens the details.
function failingMailboxes() {
  const all = lastSummary && Array.isArray(lastSummary.mailboxes) ? lastSummary.mailboxes : [];
  return all.filter((m) => m.failing)
    .sort((a, b) => (Date.parse(a.lastSuccessAt || '') || 0) - (Date.parse(b.lastSuccessAt || '') || 0));
}
function renderHealthLine() {
  const down = failingMailboxes();
  healthLine.hidden = !down.length;
  if (!down.length) { healthLine.dataset.text = ''; return; }
  const first = down[0];
  const text = down.length > 1 ? fill('status.mailboxesDown', { count: down.length })
    : first.lastSuccessAt ? fill('status.mailboxDown', { name: first.name, since: sinceText(first.lastSuccessAt) })
      : fill('status.mailboxNever', { name: first.name });
  if (healthLine.dataset.text === text) return;
  healthLine.dataset.text = text;
  healthLine.replaceChildren(textNode(text), icon('i-chevron'));
  announce(text);
}
function renderHealth() {
  const body = healthSheet.querySelector('.sheet-body');
  body.replaceChildren();
  const now = new Date();
  for (const m of (lastSummary && lastSummary.mailboxes) || []) {
    const row = el('div', 'mailbox' + (m.failing ? ' failing' : ''));
    const head = el('div', 'mailbox-head');
    head.appendChild(el('span', 'mark ' + (m.failing ? 'critical' : 'info')));
    head.appendChild(el('b', null, m.name));
    head.appendChild(el('span', 'mailbox-address', m.address));
    row.appendChild(head);
    let state;
    const once = m.consecutiveFailures === 1 ? '1' : '';
    if (m.failing) state = m.lastSuccessAt
      ? fill('mailboxes.failing' + once, { since: sinceText(m.lastSuccessAt), count: m.consecutiveFailures })
      : fill('mailboxes.failingNever' + once, { count: m.consecutiveFailures });
    else state = m.lastSuccessAt ? fill('mailboxes.ok', { ago: ago(Math.max(0, now - new Date(m.lastSuccessAt))) }) : t('mailboxes.never');
    row.appendChild(el('p', 'mailbox-state', state));
    if (m.fix && STRINGS[lang]['mailboxes.fix.' + m.fix]) row.appendChild(el('p', 'mailbox-fix', t('mailboxes.fix.' + m.fix)));
    if (m.command) {
      const box = el('div', 'mailbox-command');
      const code = el('code', null, m.command);
      const copy = el('button', 'text-btn', t('detail.copyCode'));
      copy.type = 'button';
      copy.dataset.focus = 'copy-' + m.address;
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(m.command); copy.textContent = t('detail.copied'); }
        catch (e) {
          const range = document.createRange();
          range.selectNodeContents(code);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          copy.textContent = t('detail.selected');
        }
        setTimeout(() => { copy.textContent = t('detail.copyCode'); }, 1600);
      };
      box.appendChild(code);
      box.appendChild(copy);
      row.appendChild(box);
    }
    body.appendChild(row);
  }
  const waiting = lastSummary ? Number(lastSummary.outboxPending || 0) : 0;
  if (waiting > 0) body.appendChild(el('p', 'mailbox-outbox', waiting === 1 ? t('mailboxes.outbox1') : fill('mailboxes.outbox', { count: waiting })));
}
function openHealth() {
  if (healthSheet.open) { closePopover(healthSheet, false); return; }
  renderHealth();
  openPopover(healthSheet, healthLine, { align: 'start', width: 380, history: !isWide() });
}
// The minute refresh redraws the open sheet so its times stay true, but not
// while a command is selected for copying by hand, and keeps the focus.
function redrawHealth() {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && healthSheet.contains(selection.anchorNode)) return;
  const focus = focusIdentity(healthSheet);
  renderHealth();
  restoreIdentity(healthSheet, focus);
}
// What a redraw needs to put the focus back: a control's key or identity.
function focusIdentity(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a) || !a.dataset) return null;
  if (a.dataset.key) return '[data-key="' + CSS.escape(a.dataset.key) + '"]';
  if (a.dataset.focus) return '[data-focus="' + CSS.escape(a.dataset.focus) + '"]';
  return null;
}
function restoreIdentity(root, selector) {
  const again = selector ? root.querySelector(selector) : null;
  if (again) again.focus({ preventScroll: true });
}
healthLine.onclick = openHealth;
function statusLine() {
  if (connectionProblem) {
    if (!lastFetchAt) return ['', true];
    // What is shown may be days old; an hour alone would read as today's.
    const today = new Date();
    const time = dayKey(lastFetchAt) === dayKey(today) ? hhmm(lastFetchAt) : dayLabel(lastFetchAt, today) + ' ' + hhmm(lastFetchAt);
    return [fill('status.offline', { time }), true];
  }
  if (pollNarration) return [pollNarration.text, pollNarration.warn];
  const parts = [];
  let warn = false;
  const s = lastSummary;
  if (s) {
    if (s.fromSpamFolder > 0) parts.push(fill('status.spam', { count: s.fromSpamFolder }));
    if (s.rescuedFromSpam > 0) parts.push(fill('status.rescued', { count: s.rescuedFromSpam }));
    if (s.lastPollAt) {
      const at = new Date(s.lastPollAt);
      const age = Math.max(0, Date.now() - at);
      parts.push(fill('status.checked', { ago: ago(age) }));
      // The same staleness rule the health probe uses.
      warn = Boolean(s.pollIntervalSeconds && age > (s.pollIntervalSeconds * 3 + 120) * 1000);
    } else if (lastFetchAt) parts.push(fill('status.updated', { time: hhmm(lastFetchAt) }));
  }
  return [parts.join(' \\u00b7 '), warn];
}

// ---- Rows ----
// Six or eight digits read as two halves. The gap is CSS, not a character, so a
// selection or a long-press copy yields exactly the code the site expects.
function digitsNode(code) {
  const s = String(code);
  const b = el('b', 'digits');
  const cut = /^\\d{6}$/.test(s) ? 3 : (/^\\d{8}$/.test(s) ? 4 : 0);
  if (!cut) { b.textContent = s; return b; }
  b.appendChild(el('span', null, s.slice(0, cut)));
  b.appendChild(el('span', null, s.slice(cut)));
  return b;
}
async function copyCode(code, digits, verb) {
  try {
    await navigator.clipboard.writeText(code);
    verb.replaceChildren(icon('i-check'), textNode(t('detail.copied')));
    announce(t('detail.copied'));
    if (navigator.vibrate) navigator.vibrate(10);
  } catch (e) {
    // Clipboard access needs a secure context; selecting the digits keeps a
    // long-press copy working when it is unavailable.
    const range = document.createRange();
    range.selectNodeContents(digits);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    verb.textContent = t('detail.selected');
    verb.classList.add('selected');
  }
  setTimeout(() => { verb.classList.remove('selected'); verb.textContent = t('detail.copyCode'); }, 1600);
}
// The digits are the copy control: one tap, no row to open first.
function codeButton(row, cls) {
  const b = el('button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', fill('code.copyLabel', { code: row.verificationCode }));
  const digits = digitsNode(row.verificationCode);
  const verb = el('span', 'verb', t('detail.copyCode'));
  b.appendChild(digits);
  b.appendChild(verb);
  b.onclick = (e) => { e.stopPropagation(); copyCode(row.verificationCode, digits, verb); };
  return b;
}
// ---- The lane: the newest code, when it is fresh ----
let laneSender = '';
function freshCode(rows, now) {
  let best = null;
  for (const r of rows || []) {
    if (!r.verificationCode) continue;
    const d = dateOf(r);
    if (now - d < FRESH_CODE_MS && (!best || dateOf(best) < d)) best = r;
  }
  return best;
}
function renderLane(rows, now) {
  const threads = filters.view.value === 'threads';
  const fresh = threads ? null : freshCode(rows, now);
  lane.replaceChildren();
  if (!fresh && codeWait && !threads) {
    // Opened for a code that has not arrived yet: say so where it will appear.
    lane.hidden = false;
    const wait = el('div', 'lane-wait');
    wait.appendChild(el('span', 'eyebrow', t('code.waiting')));
    lane.appendChild(wait);
    return null;
  }
  lane.hidden = !fresh;
  laneSender = fresh ? fresh.senderName || fresh.sender || '' : '';
  if (!fresh) return null;
  const b = codeButton(fresh, 'lane-copy');
  if (washNext && !renderedKeys.has(rowKey(fresh))) b.classList.add('arrived');
  b.prepend(el('span', 'eyebrow', [t('code.fresh'), fresh.senderName || fresh.sender || '', ago(now - dateOf(fresh))].filter(Boolean).join(' \\u00b7 ')));
  lane.appendChild(b);
  return rowKey(fresh);
}

// ---- The list ----
function widenButton() {
  const widen = el('button', 'text-btn', t('empty.widen'));
  widen.type = 'button';
  widen.dataset.focus = 'empty-widen';
  widen.onclick = () => setFilters({ hours: '168' });
  return widen;
}
function emptyBlock() {
  const box = el('div', 'empty');
  const down = failingMailboxes();
  if (down.length && !filtersActive()) {
    // Not quiet: a mailbox that could not be read says nothing either way.
    box.appendChild(el('h3', null, t('empty.blind')));
    const first = down[0];
    box.appendChild(el('p', null, first.lastSuccessAt
      ? fill('empty.blindHint', { name: first.name, since: sinceText(first.lastSuccessAt) })
      : fill('empty.blindNever', { name: first.name })));
    const details = el('button', 'text-btn', t('mailboxes.title'));
    details.type = 'button';
    details.dataset.focus = 'blind-mailboxes';
    details.onclick = openHealth;
    box.appendChild(details);
    return box;
  }
  if (filtersActive()) {
    // Most often the window is simply too short for what was asked, so the
    // longer window is offered before clearing everything.
    box.appendChild(el('p', null, filters.codesOnly.checked ? t('code.none') : t('empty')));
    if (Number(filters.hours.value) <= 72) box.appendChild(widenButton());
    const clear = el('button', 'text-btn', t('filter.clearAll'));
    clear.type = 'button';
    clear.dataset.focus = 'empty-clear';
    clear.onclick = clearFilters;
    box.appendChild(clear);
    return box;
  }
  box.appendChild(envelope());
  box.appendChild(el('h3', null, t('empty.quiet')));
  const at = lastSummary && lastSummary.lastPollAt ? new Date(lastSummary.lastPollAt) : null;
  box.appendChild(el('p', null, at && !isNaN(at) ? fill('empty.quietHint', { time: hhmm(at) }) : t('empty.quietHintPlain')));
  if (Number(filters.hours.value) <= 72) box.appendChild(widenButton());
  return box;
}
function installLine() {
  const line = el('div', 'install-line');
  line.id = 'install-line';
  line.appendChild(el('span', null, t('install.hint')));
  const now = el('button', 'text-btn', t('pwa.install'));
  now.type = 'button';
  now.onclick = promptInstall;
  const later = el('button', 'text-btn quiet', t('install.later'));
  later.type = 'button';
  later.onclick = () => { writeStorage('installDismissed', String(Date.now() + 30 * 24 * 3600 * 1000)); line.remove(); };
  line.appendChild(now);
  line.appendChild(later);
  return line;
}
function loadMoreButton() {
  const more = el('button', 'text-btn load-more');
  more.type = 'button';
  if (loadingMail) { more.textContent = t('loadingMore'); more.disabled = true; }
  else if (loadMoreFailed) { more.textContent = t('loadMore.failed') + ' \\u00b7 ' + t('network.retry'); more.classList.add('failed'); }
  else more.textContent = t('loadMore');
  more.onclick = () => load(false);
  return more;
}
// The count is spoken when it changes or when the reader changed a filter,
// not every time the minute refresh redraws the same list.
let shownTimer, lastShown = null, announceNextList = false;
function announceShown(count) {
  if (!announceNextList && count === lastShown) return;
  announceNextList = false;
  lastShown = count;
  clearTimeout(shownTimer);
  shownTimer = setTimeout(() => announce(count === 1 ? t('announce.shown1') : fill('announce.shown', { count })), 600);
}
// A redraw must not throw keyboard focus back to the top of the page.
function focusedListControl() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  if (lane.contains(a)) return { lane: true };
  if (!list.contains(a) && !queue.contains(a)) return null;
  const li = a.closest('li.row');
  if (li) return { key: li.dataset.key, code: a.classList.contains('code-copy'), ring: a.classList.contains('ring') };
  if (a.dataset && a.dataset.focus) return { focus: a.dataset.focus };
  return a.classList.contains('load-more') ? { more: true } : null;
}
function restoreFocus(f) {
  if (!f) return;
  let target = null;
  if (f.lane) target = lane.querySelector('.lane-copy');
  else if (f.more) target = list.querySelector('.load-more');
  else if (f.focus) target = document.querySelector('#queue [data-focus="' + CSS.escape(f.focus) + '"], #list [data-focus="' + CSS.escape(f.focus) + '"]');
  else {
    const li = document.querySelector('#queue li.row[data-key="' + CSS.escape(f.key) + '"], #list li.row[data-key="' + CSS.escape(f.key) + '"]');
    if (li) target = (f.code && li.querySelector('.code-copy')) || (f.ring && li.querySelector('.ring')) || li.querySelector('.who');
  }
  if (target) target.focus({ preventScroll: true });
}
function sinceLine(tag, count) {
  const line = el(tag, 'since', fill('since.new', { count }));
  if (tag === 'li') line.setAttribute('role', 'presentation');
  return line;
}
function renderList() {
  const focus = focusedListControl();
  const free = Boolean(codeWait) && mayMoveFocus();
  // Patched in place, and the reader's place in it kept.
  keepPlace(buildList);
  // A code drawn while the lane waited for one ends the wait and takes the
  // focus the page was opened for, unless the reader is busy elsewhere.
  const arrived = codeWait && lane.querySelector('.lane-copy');
  if (arrived) {
    codeWait = null;
    if (free) {
      owedFocus = null;
      arrived.scrollIntoView({ block: 'center' });
      arrived.focus({ preventScroll: true });
      return;
    }
    oweFocus({ lane: true });
    narrateCode(fill('code.arrived', { sender: laneSender }));
  }
  restoreFocus(focus);
}
let codeSaid = '';
function narrateCode(text) {
  codeSaid = text;
  narrate(text, false, 8000);
}
// What arrived while a modal sheet was open is focused when that sheet
// closes. A popover is not owed anything: the reader is working in it.
let owedFocus = null;
function oweFocus(what) {
  // Popovers are opened without showModal and owe nothing (see openPopover).
  const sheet = document.querySelector('dialog[open]:not(.popover)');
  owedFocus = sheet ? Object.assign({ sheet }, what) : null;
}
function takeOwedFocus(dialog) {
  const what = owedFocus;
  owedFocus = null;
  if (!what || what.sheet !== dialog) return null;
  if (what.lane) return lane.querySelector('.lane-copy');
  const li = arrivalRow(what.key);
  return li ? li.querySelector('.code-copy') || li.querySelector('.who') : null;
}
// The row an arrival shows in: its own, or in the threads view its thread's.
function arrivalRow(key) {
  const own = list.querySelector('li.row[data-key="' + CSS.escape(key) + '"]');
  if (own || filters.view.value !== 'threads') return own;
  const thread = (lastThreads || []).find((th) => th.latest && rowKey(th.latest) === key);
  return thread ? list.querySelector('li.row[data-key="' + CSS.escape(threadKeyOf(thread)) + '"]') : null;
}
// Focus moves to what arrived only from where nobody is busy: not out of a
// field being typed in, and not from under an open sheet or popover.
function mayMoveFocus() {
  if (document.querySelector('dialog[open]')) return false;
  const a = document.activeElement;
  if (!a || a === document.body) return true;
  if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable) return false;
  return lane.contains(a) || list.contains(a) || queue.contains(a);
}
// ---- Detail: the same content in the sheet and in the pane ----
function linkLabel(row) {
  const name = STRINGS[lang]['provider.' + row.provider];
  return name ? fill(row.link.exact ? 'link.openIn' : 'link.open', { name }) : row.link.label;
}
function failure(d) {
  // The numbers and the file a refusal names come with it, to be said in the page's own words.
  return STRINGS[lang]['error.' + d.code]
    ? fill('error.' + d.code, {
      detail: d.detail || '', maxBytes: d.maxBytes ? sizeLabel(d.maxBytes) : '', maxFiles: d.maxFiles || '',
      maxChars: d.maxChars || '', file: d.file || '',
    })
    : (d.error || t('detail.failed'));
}
const SAFETY_FINDING_KEYS = {
  spam_folder: 'safety.spamFolder',
  bulk_headers: 'safety.bulkHeaders',
  reply_to_domain_mismatch: 'safety.replyMismatch',
  attachment_executable_or_installer: 'safety.executable',
  attachment_script_or_shortcut: 'safety.script',
  attachment_macro_enabled_document: 'safety.macro',
  attachment_active_content: 'safety.activeContent',
  attachment_archive_not_scanned: 'safety.archive',
  double_extension: 'safety.doubleExtension',
  filename_mime_mismatch: 'safety.filenameMimeMismatch',
  pe_signature: 'safety.peSignature',
  elf_signature: 'safety.elfSignature',
  mach_o_signature: 'safety.machOSignature',
  script_signature: 'safety.scriptSignature',
  active_content_signature: 'safety.activeContentSignature',
  zip_signature: 'safety.containerSignature',
  gzip_signature: 'safety.containerSignature',
  rar_signature: 'safety.containerSignature',
  seven_zip_signature: 'safety.containerSignature',
  ole_signature: 'safety.containerSignature',
  link_javascript: 'safety.linkJavascript',
  link_data: 'safety.linkData',
  link_vbscript: 'safety.linkVbscript',
  link_non_https: 'safety.linkNonHttps',
  link_ip_host: 'safety.linkIpHost',
  link_punycode: 'safety.linkPunycode',
  link_userinfo: 'safety.linkUserinfo',
  link_shortener: 'safety.linkShortener',
};
const ATTACHMENT_WARNING_KEYS = {
  executable_or_installer: 'safety.executable',
  script_or_shortcut: 'safety.script',
  macro_enabled_document: 'safety.macro',
  active_content: 'safety.activeContent',
  archive_not_scanned: 'safety.archive',
};
function sizeLabel(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return size + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[index];
}
function downloadFilename(value) {
  const source = typeof value === 'string' ? value : 'attachment';
  const safe = Array.from(source, (char) => {
    const code = char.charCodeAt(0);
    return char === '/' || code === 92 || code < 32 || code === 127 ? '_' : char;
  }).join('').trim().slice(0, 200);
  return safe || 'attachment';
}
function findingItem(finding, report) {
  const severity = ['warning', 'caution', 'info'].includes(finding.severity) ? finding.severity : 'info';
  const item = el('li', 'safety-finding ' + severity);
  const key = SAFETY_FINDING_KEYS[finding.code];
  const headers = report && report.spamSignals && Array.isArray(report.spamSignals.bulkHeaders)
    ? report.spamSignals.bulkHeaders.join(', ')
    : '';
  const label = finding.code === 'bulk_headers' && key ? fill(key, { headers }) : (key ? t(key) : (finding.detail || ''));
  item.appendChild(el('span', null, label));
  if (finding.attachment) item.appendChild(el('div', 'safety-meta', fill('safety.attachment', { name: finding.attachment })));
  if (finding.code === 'reply_to_domain_mismatch' && report && report.senderSignals) {
    item.appendChild(el('div', 'safety-meta', fill('safety.senderDomains', {
      from: report.senderSignals.fromAddress || '',
      replyTo: (report.senderSignals.replyToAddresses || []).join(', '),
    })));
  }
  if (finding.linkHost) item.appendChild(el('div', 'safety-meta', finding.linkHost));
  return item;
}
function renderAttachmentManifest(container, manifest, row) {
  container.replaceChildren();
  const items = Array.isArray(manifest.items) ? manifest.items
    : (Array.isArray(manifest.attachments) ? manifest.attachments : []);
  if (!items.length && !manifest.truncated) {
    container.appendChild(el('p', 'attachment-status', t('detail.noAttachments')));
    return;
  }
  const ul = el('ul', 'attachment-list');
  for (const item of items) {
    const entry = el('li', 'attachment-item');
    const filename = item.filename || fill('detail.unnamedAttachment', { partId: item.partId || '' });
    const link = el('a', null, filename);
    const href = '/api/attachment?id=' + encodeURIComponent(row.dedupKey || row.messageId)
      + '&part=' + encodeURIComponent(item.partId || '');
    link.href = href;
    link.download = downloadFilename(item.filename);
    const status = el('span', 'attachment-status');
    const scanButton = el('button', 'text-btn', t('detail.scanAttachment'));
    scanButton.type = 'button';
    const scanStatus = el('span', 'attachment-status');
    const scan = el('div', 'attachment-scan');
    scanButton.onclick = async () => {
      scanButton.disabled = true;
      scanButton.textContent = t('detail.scanningAttachment');
      scan.replaceChildren();
      try {
        const scanHref = '/api/attachment-scan?id=' + encodeURIComponent(row.dedupKey || row.messageId)
          + '&part=' + encodeURIComponent(item.partId || '');
        const response = await fetch(scanHref);
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          scanStatus.textContent = failure(result);
          scanButton.disabled = false;
          scanButton.textContent = t('detail.scanAttachment');
          return;
        }
        const findings = Array.isArray(result.findings) ? result.findings : [];
        if (!findings.length) scan.appendChild(el('p', 'safety-status', t('safety.scanNoIndicators')));
        else {
          const findingList = el('ul', 'safety-findings');
          for (const finding of findings) findingList.appendChild(findingItem(finding, null));
          scan.appendChild(findingList);
        }
        const suffix = result.truncated ? ' \\u00b7 ' + t('safety.scanTruncated') : '';
        scan.appendChild(el('p', 'safety-status', fill('safety.scanDetails', { bytes: sizeLabel(result.scannedBytes), suffix })));
        scanStatus.textContent = '';
        scanButton.remove();
      } catch (e) {
        scanStatus.textContent = t('detail.networkFailed');
        scanButton.disabled = false;
        scanButton.textContent = t('detail.scanAttachment');
      }
    };
    link.onclick = async (event) => {
      event.preventDefault();
      // A picture is looked at, not saved: it opens over the page.
      if (previewable(item)) { openLightbox(href, filename); return; }
      status.textContent = t('detail.downloadingAttachment');
      try {
        const response = await fetch(href);
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          status.textContent = failure(result);
          return;
        }
        const objectUrl = URL.createObjectURL(await response.blob());
        const save = document.createElement('a');
        save.href = objectUrl;
        save.download = downloadFilename(item.filename);
        document.body.appendChild(save);
        save.click();
        save.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        status.textContent = '';
      } catch (e) {
        status.textContent = t('detail.networkFailed');
      }
    };
    entry.appendChild(link);
    const details = [item.contentType, sizeLabel(item.sizeBytes), item.inline ? t('detail.inline') : '']
      .filter(Boolean).join(' \\u00b7 ');
    if (details) entry.appendChild(el('span', 'attachment-meta', details));
    if (Array.isArray(item.safetyWarnings)) {
      for (const warning of item.safetyWarnings) {
        const key = ATTACHMENT_WARNING_KEYS[warning];
        if (key) entry.appendChild(el('span', 'safety-warning', t(key)));
      }
    }
    entry.appendChild(scanButton);
    entry.appendChild(scanStatus);
    entry.appendChild(scan);
    entry.appendChild(status);
    ul.appendChild(entry);
  }
  container.appendChild(ul);
  if (manifest.truncated) container.appendChild(el('p', 'attachment-status', t('detail.attachmentsTruncated')));
}
function renderSafetyReport(container, report) {
  container.replaceChildren();
  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (!findings.length) container.appendChild(el('p', 'safety-status', t('safety.noClues')));
  else {
    const ul = el('ul', 'safety-findings');
    for (const finding of findings) ul.appendChild(findingItem(finding, report));
    container.appendChild(ul);
  }
  if (report.attachmentsTruncated) container.appendChild(el('p', 'safety-status', t('safety.attachmentsTruncated')));
  if (report.links && report.links.checked) {
    container.appendChild(el('p', 'safety-status', fill('safety.linksChecked', { count: report.links.linksFound || 0 })));
  } else container.appendChild(el('p', 'safety-status', t('safety.linksNotChecked')));
  container.appendChild(el('p', 'safety-status', t('safety.limits')));
}
// A row that expands on its first tap and fetches then, not before.
function disclosure(box, label, build) {
  const button = el('button', 'disclosure');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.appendChild(el('span', null, label));
  button.appendChild(icon('i-chevron'));
  const body = el('div', 'disclosure-body');
  body.hidden = true;
  let built = false;
  button.onclick = () => {
    const open = body.hidden;
    body.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open && !built) { built = true; build(body); }
  };
  box.appendChild(button);
  box.appendChild(body);
}
// A fetch into a disclosure body, with a retry line when it fails.
function fetching(body, path, pending, render) {
  body.replaceChildren(el('p', 'inline-status', pending));
  fetch(path).then(async (response) => {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw failure(result);
    render(body, result);
  }).catch((reason) => {
    body.replaceChildren();
    body.appendChild(el('p', 'inline-error', typeof reason === 'string' ? reason : t('detail.networkFailed')));
    const retry = el('button', 'text-btn', t('network.retry'));
    retry.type = 'button';
    retry.onclick = () => fetching(body, path, pending, render);
    body.appendChild(retry);
  });
}
function safetySection(box, row) {
  if (!row.messageId) return;
  disclosure(box, t('safety.title'), (body) => {
    fetching(body, '/api/safety?id=' + encodeURIComponent(row.dedupKey || row.messageId), t('safety.checking'), renderSafetyReport);
  });
}
// ---- Digest ----
const LEVEL_RANK = { critical: 3, warning: 2, info: 1 };
function digestItem(item) {
  // An entry with a key opens that message; older entries have none.
  const line = el(item.key ? 'button' : 'p', 'digest-item');
  if (item.key) {
    line.type = 'button';
    line.dataset.key = item.key;
    line.onclick = () => openFromLink(item.key, false);
  }
  const text = el('span', 'digest-line');
  text.appendChild(el('b', null, item.fromName || item.from || t('unknownSender')));
  text.appendChild(textNode(' \\u2014 '));
  text.appendChild(el('span', 'gist', item.summary || item.subject || ''));
  if (item.threadCount > 1) text.appendChild(textNode(' \\u00d7' + item.threadCount));
  if (item.deadline) { text.appendChild(textNode(' \\u00b7 ')); text.appendChild(el('span', 'due', t('detail.deadline') + ' ' + item.deadline)); }
  line.appendChild(text);
  return line;
}
// Which digest blocks the reader has expanded, so a redraw does not fold them again.
const digestExpanded = new Set();
function appendDigestGroups(container, items, block) {
  const groups = [];
  const spam = items.filter((i) => i.inSpam);
  if (spam.length) groups.push({ label: t('digest.spamGroup'), cls: 'spam', items: spam });
  const byCategory = new Map();
  for (const item of items.filter((i) => !i.inSpam)) {
    const key = item.category || 'Other';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(item);
  }
  const rank = (group) => Math.max(...group.map((i) => LEVEL_RANK[i.importance] || 0));
  for (const [key, group] of Array.from(byCategory.entries()).sort((a, b) =>
    rank(b[1]) - rank(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    groups.push({ label: word('category.', key), cls: '', items: group });
  }
  const wrap = el('div', 'digest-groups');
  let shown = 0, hidden = 0;
  const limit = isWide() || digestExpanded.has(block) ? Infinity : 6;
  const overflow = [];
  for (const group of groups) {
    const box = el('div', 'digest-group');
    box.appendChild(el('h4', group.cls, group.label));
    for (const item of group.items) {
      const line = digestItem(item);
      if (shown >= limit) { line.hidden = true; hidden += 1; overflow.push(line); }
      shown += 1;
      box.appendChild(line);
    }
    wrap.appendChild(box);
  }
  container.appendChild(wrap);
  if (hidden) {
    const more = el('button', 'text-btn', fill('digest.more', { count: hidden }));
    more.type = 'button';
    more.dataset.focus = 'more-' + block;
    more.onclick = () => {
      digestExpanded.add(block);
      for (const line of overflow) line.hidden = false;
      const next = overflow[0];
      more.remove();
      if (next) next.focus({ preventScroll: true });
    };
    container.appendChild(more);
  }
}
// The sent digest opens the first time it is seen and stays as the reader
// leaves it for the rest of the visit; afterwards it is one quiet line.
let sentDigestKey = null, sentDigestOpen = false;
function renderSentDigest(section, last) {
  if (sentDigestKey !== last.sentAt) {
    sentDigestKey = last.sentAt;
    sentDigestOpen = readStorage('digestSeen') !== last.sentAt;
    writeStorage('digestSeen', last.sentAt);
  }
  const block = el('div', 'digest-sent');
  const head = el('button', 'digest-sent-head');
  head.type = 'button';
  head.dataset.focus = 'sent-head';
  head.setAttribute('aria-expanded', String(sentDigestOpen));
  const sentAt = new Date(last.sentAt);
  head.appendChild(el('span', 'digest-sent-title', t('digest.lastTitle')));
  head.appendChild(el('span', 'digest-meta', fill(last.count === 1 ? 'digest.lastMeta1' : 'digest.lastMeta', {
    when: dayPhrase(sentAt, new Date()), time: hhmm(sentAt), count: last.count,
  })));
  head.appendChild(icon('i-chevron'));
  const body = el('div', 'digest-sent-body');
  body.hidden = !sentDigestOpen;
  appendDigestGroups(body, last.items, 'sent');
  head.onclick = () => {
    sentDigestOpen = body.hidden;
    body.hidden = !sentDigestOpen;
    head.setAttribute('aria-expanded', String(sentDigestOpen));
  };
  block.appendChild(head);
  block.appendChild(body);
  section.appendChild(block);
}
// The minute refresh redraws the digest only when what it says has changed,
// and puts the focus back on the same control when it does.
let digestDrawn = '';
function drawDigest(force) {
  const said = JSON.stringify(lastDigest) + '|' + lang + '|' + dayKey(new Date());
  if (!force && said === digestDrawn) return;
  digestDrawn = said;
  const section = $('#digest');
  const focus = focusIdentity(section);
  renderDigest();
  restoreIdentity(section, focus);
}
function renderDigest() {
  const section = $('#digest');
  section.replaceChildren();
  const g = lastDigest;
  const upcoming = Boolean(g && g.pending && g.enabled !== false);
  const last = g && g.last && Array.isArray(g.last.items) && g.last.items.length ? g.last : null;
  section.hidden = !upcoming && !last;
  if (upcoming) {
    section.appendChild(el('h2', null, t('digest.title')));
    // When it goes out, worked out by the server that sends it and shown in
    // this device's own clock.
    const next = g.nextAt ? new Date(g.nextAt) : null;
    if (next && !isNaN(next)) {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const whenWord = dayKey(next) === dayKey(tomorrow) ? t('digest.tomorrow') : dayLabel(next, now);
      const key = g.pending === 1 ? 'digest.meta1' : 'digest.meta';
      section.appendChild(el('p', 'digest-meta', fill(key, { when: whenWord, time: hhmm(next), count: g.pending })));
    }
    if (Array.isArray(g.items)) appendDigestGroups(section, g.items, 'next');
    // An older server: the rendered text, minus its markdown marks.
    else section.appendChild(el('p', 'digest-fallback', String(g.preview || '').replace(/\\*\\*/g, '').replace(/^- /gm, '')));
  }
  if (last) renderSentDigest(section, last);
}

// ---- Waiting for a code that is on its way ----
// The shortcut is usually pressed right after asking a site for a code, which
// often has not arrived yet. Rather than say "no code" and stop, the lane
// waits a few minutes, reading only what the poller has already stored.
const CODE_WAIT_MS = 3 * 60 * 1000;
const CODE_WAIT_POLL_MS = 2500;
function startCodeWait() {
  codeWait = { until: Date.now() + CODE_WAIT_MS, asked: false };
  renderList();
  announce(t('code.waiting'));
  tickCodeWait();
}
// Mail that IDLE is not watching, spam among it, arrives only with the next
// poll; ask for one, once, through the same rate-limited path as the refresh
// button. Its narration counts the mailboxes, which the summary knows.
function askForPoll() {
  if (!codeWait || codeWait.asked || !lastSummary) return;
  codeWait.asked = true;
  if (refreshButton) pollNow();
}
async function tickCodeWait() {
  if (!codeWait) return;
  if (Date.now() > codeWait.until) { endCodeWait(null); return; }
  askForPoll();
  if (!document.hidden && !loadingMail) {
    try {
      const r = await fetch('/api/mail?codesOnly=true&hours=1&limit=5');
      if (r.ok && codeWait) {
        const data = await r.json();
        const now = new Date();
        // A fresh code ends the wait. So does a fresh verification email whose
        // code could not be read: the code is in it, like a fresh code that
        // was already there would simply have been shown.
        const rows = (Array.isArray(data.mail) ? data.mail : []).filter((m) => now - dateOf(m) < FRESH_CODE_MS);
        const arrived = rows.find((m) => m.verificationCode) || rows[0];
        if (arrived && !loadingMail) {
          await refresh();
          // Drawn in the lane, renderList has ended the wait already.
          if (codeWait) endCodeWait(arrived);
          return;
        }
      }
    } catch (e) {}
  }
  setTimeout(tickCodeWait, CODE_WAIT_POLL_MS);
}
function endCodeWait(arrived) {
  const free = mayMoveFocus();
  codeWait = null;
  renderList();
  if (!arrived) {
    // Nothing new came. An older code may still be the one wanted.
    const older = list.querySelector('.has-code .code-copy');
    if (older && free) older.focus({ preventScroll: false });
    narrateCode(t('code.noneNew'));
    return;
  }
  const sender = arrived.senderName || arrived.sender || '';
  const li = arrivalRow(rowKey(arrived));
  if (!li) {
    // Kept off the page by a filter or by the threads view.
    const hidden = filtersActive();
    narrateCode(arrived.verificationCode
      ? fill(hidden ? 'code.arrivedHidden' : 'code.arrived', { sender })
      : t(hidden ? 'code.unreadHidden' : 'code.unread'));
    return;
  }
  if (free) {
    owedFocus = null;
    li.scrollIntoView({ block: 'center' });
    (li.querySelector('.code-copy') || li.querySelector('.who')).focus({ preventScroll: true });
  } else oweFocus({ key: rowKey(arrived) });
  narrateCode(arrived.verificationCode ? fill('code.arrived', { sender }) : t('code.unread'));
}

// ---- Theme: a two-state switch, the half-filled disc naming the destination theme. ----
const THEMES = ['light', 'dark'];
function readTheme() {
  try {
    const stored = localStorage.getItem('theme');
    return THEMES.includes(stored) ? stored : 'light';
  } catch (e) { return 'light'; }
}
function applyTheme(choice) {
  const root = document.documentElement;
  root.dataset.theme = choice;
  // iOS samples theme-color when a home-screen app opens, but the safe-area
  // backing above is live CSS. Keep both native status-bar text style and
  // browser chrome metadata in sync with the active palette.
  const meta = document.querySelector('meta[name=theme-color]');
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
  const appleStatus = document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]');
  if (appleStatus) appleStatus.setAttribute('content', choice === 'dark' ? 'black-translucent' : 'default');
  const button = document.querySelector('#theme');
  if (button) {
    // Named for what it does, so the label never reads as the current state.
    const label = t(choice === 'dark' ? 'theme.toLight' : 'theme.toDark');
    button.title = label;
    button.setAttribute('aria-label', label);
  }
}
$('#theme').onclick = (event) => {
  const next = readTheme() === 'dark' ? 'light' : 'dark';
  const apply = () => {
    try { localStorage.setItem('theme', next); } catch (e) {}
    applyTheme(next);
    themeChanged();
  };
  // Where the browser can, the other theme spreads out from the switch that
  // asked for it. Elsewhere, and for anyone who prefers no motion, it just is.
  if (!document.startViewTransition || reduceMotion()) { apply(); return; }
  const r = event.currentTarget.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.startViewTransition(apply).ready.then(() => {
    document.documentElement.animate(
      { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'] },
      { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
};

// ---- Language: reword the page in place from the last answers. ----
function renderAll() {
  renderLede();
  renderStatus();
  renderTokens();
  renderList();
  drawDigest(true);
  renderPane(true);
  renderBars();
}
function applyLanguage(next) {
  lang = next;
  document.documentElement.lang = next;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll('[data-i18n-label]')) n.setAttribute('aria-label', t(n.dataset.i18nLabel));
  for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  filters.q.placeholder = t('search.short');
  for (const o of filters.category.options) if (o.value) o.text = word('category.', o.value);
  const button = $('#lang');
  button.textContent = t('lang.face');
  button.setAttribute('aria-label', t('lang.label'));
  const refresh = $('#refresh');
  if (refresh && !refresh.disabled) { refresh.setAttribute('aria-label', t('refresh.label')); refresh.title = t('refresh.label'); }
  if (connectionProblem) setNetworkIssue(true);
  applyTheme(readTheme());
  renderAll();
  if (healthSheet.open) redrawHealth();
  languageChanged();
}
$('#lang').onclick = () => {
  const next = LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length];
  storeLanguage(next);
  applyLanguage(next);
};

// ---- Install: a line in the list on a phone. A desk browser offers its own. ----
let pendingInstall = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installable = !standalone && appleMobile;
function installDismissed() { return Number(readStorage('installDismissed') || 0) > Date.now(); }
function updateInstallUi() {
  if (lastMail || lastThreads) renderList();
}
updateInstallUi();
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  pendingInstall = event;
  installable = !standalone;
  updateInstallUi();
});
async function promptInstall() {
  if (pendingInstall) {
    const promptEvent = pendingInstall;
    pendingInstall = null;
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch (e) {}
    installable = false;
    updateInstallUi();
  } else if (appleMobile && !standalone) {
    openSheet(installHelp, {});
  }
}
window.addEventListener('appinstalled', () => { pendingInstall = null; installable = false; updateInstallUi(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---- Checking now: the server runs a real poll, the status line narrates it. ----
// A click during a scheduled poll joins it, so double-clicking does not open a
// second IMAP session.
const refreshButton = $('#refresh');
async function pollNow() {
  if (!refreshButton || refreshButton.disabled) return;
  refreshButton.disabled = true;
  refreshButton.classList.add('running');
  refreshButton.setAttribute('aria-label', t('refresh.running'));
  refreshButton.title = t('refresh.running');
  const mailboxes = lastSummary && Array.isArray(lastSummary.accounts) ? lastSummary.accounts.length : 1;
  narrate(mailboxes === 1 ? t('status.checking1') : fill('status.checking', { count: mailboxes }), false, 0);
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    if (response.status === 401) { location.reload(); return; }
    if (response.status === 429) { narrate(null); toast(t('refresh.tooOften'), false); return; }
    if (!response.ok) { narrate(null); toast(t('refresh.failed'), true); return; }
    const stats = await response.json();
    await refresh();
    await chrome();
    // What a code wait found is what the reader came for; a poll finishing
    // at the same moment does not talk over it.
    if (pollNarration && pollNarration.text === codeSaid) return;
    if (stats.accountsFailed > 0) {
      // Name the mailbox that did not answer, read from the summary the poll just updated.
      const missed = lastSummary && Array.isArray(lastSummary.mailboxes)
        ? lastSummary.mailboxes.filter((m) => m.consecutiveFailures > 0) : [];
      narrate(missed.length === 1 ? fill('status.partialNamed', { name: missed[0].name }) : t('status.partial'), true, 6000);
    } else if (stats.fresh > 0) narrate(fill('status.new', { count: stats.fresh }), false, 6000);
    else narrate(t('status.none'), false, 6000);
  } catch (e) {
    narrate(null);
    toast(t('refresh.failed'), true);
    setNetworkIssue(true);
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove('running');
    refreshButton.setAttribute('aria-label', t('refresh.label'));
    refreshButton.title = t('refresh.label');
  }
}
if (refreshButton) refreshButton.addEventListener('click', pollNow);

`;
}
