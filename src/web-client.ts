/**
 * The browser code of the web view, as a string the shell inlines.
 *
 * Every value that came from a message is written with textContent and never
 * as markup: subjects, sender names and summaries are attacker-controlled, and
 * this is the one place in the service that renders them into a document.
 * Written without backticks of its own, so the server's template literal
 * interpolates only at its own marks.
 *
 * Shape of the page it drives: a sentence and a status line over one list of
 * judgements grouped by day; a fresh verification code lifted above the list;
 * a message opening in a bottom sheet on a phone and in a pane beside the list
 * on a desk. Filters live in the form under their names, so the query sent to
 * the server is still built from the form, and they are mirrored to the URL so
 * a reload, a shared link or a home-screen shortcut restores the view.
 */
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

export function clientScript(): string {
  return `
const $ = (s) => document.querySelector(s);
const SVG_NS = 'http://www.w3.org/2000/svg';
const list = $('#list'), filters = $('#filters'), lane = $('#lane'), header = $('.app-header');
const sheet = $('#sheet'), pane = $('#pane'), filterSheet = $('#filter-sheet'), installHelp = $('#install-help');
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

// ---- Sheets: one controller for the detail, the filters and the install steps. ----
// Opening pushes a history entry so the system back gesture closes the sheet
// rather than the app; closing by any other means pops that entry again.
let sheetReturnFocus = null;
// With here set, the current history entry becomes the sheet's instead of a new one:
// the entry already exists when a link or the forward button brought us to it.
function openSheet(dialog, state, here) {
  if (dialog.open) return;
  sheetReturnFocus = document.activeElement;
  dialog.classList.remove('closing');
  dialog.showModal();
  dialog.classList.add('opening');
  dialog.addEventListener('animationend', () => dialog.classList.remove('opening'), { once: true });
  const url = location.pathname + location.search + (state && state.hash ? state.hash : '');
  const entry = Object.assign({ sheet: dialog.id }, state || {});
  if (here) history.replaceState(entry, '', url);
  else history.pushState(entry, '', url);
}
function closeSheet(dialog, viaHistory) {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  const ours = history.state && history.state.sheet === dialog.id;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.classList.remove('closing');
    dialog.style.transform = '';
    dialog.close();
    if (dialog === filterSheet) filtersOpen.setAttribute('aria-expanded', 'false');
    const back = sheetReturnFocus;
    sheetReturnFocus = null;
    if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
  };
  if (reduceMotion()) finish();
  else {
    dialog.classList.add('closing');
    dialog.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 320);
  }
  if (!viaHistory && ours) history.back();
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
for (const dialog of [sheet, filterSheet, installHelp]) {
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dialog === filterSheet && dialog.classList.contains('popover')) closeFilters();
    else closeSheet(dialog, false);
  });
  // A click on the dialog itself is a click on the backdrop: the content fills the box.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog || dialog.classList.contains('popover')) return;
    closeSheet(dialog, false);
  });
  enableDrag(dialog);
}
$('#sheet-done').onclick = () => closeSheet(sheet, false);
$('#install-close').onclick = () => closeSheet(installHelp, false);
$('#install-done').onclick = () => closeSheet(installHelp, false);
window.addEventListener('popstate', () => {
  const open = document.querySelector('dialog[open]');
  if (open && open.classList.contains('popover')) closeFilters();
  else if (open) closeSheet(open, true);
  else {
    // A #m= link followed while the page is open, or the forward button back
    // onto a message: show it, on the entry we are already on.
    const key = keyFromHash(location.hash);
    if (key) openFromLink(key, true);
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

// ---- The filter sheet: a sheet on a phone, a popover on a desk. ----
const filtersOpen = $('#filters-open');
// In document coordinates, through custom properties only the popover style
// reads: it scrolls with the page under its button, and the bottom sheet the
// same dialog becomes on a phone keeps its own place.
function positionPopover() {
  const r = filtersOpen.getBoundingClientRect();
  const width = 320;
  const left = Math.max(12, Math.min(r.right - width, document.documentElement.clientWidth - width - 12));
  filterSheet.style.setProperty('--pop-left', (left + window.scrollX) + 'px');
  filterSheet.style.setProperty('--pop-top', (r.bottom + 6 + window.scrollY) + 'px');
}
function outsideClose(e) {
  if (!filterSheet.open) { document.removeEventListener('pointerdown', outsideClose, true); return; }
  if (!filterSheet.contains(e.target) && !filtersOpen.contains(e.target)) closeFilters();
}
function openFilters() {
  if (isWide()) {
    filterSheet.classList.add('popover');
    positionPopover();
    filterSheet.show();
    document.addEventListener('pointerdown', outsideClose, true);
  } else {
    filterSheet.classList.remove('popover');
    openSheet(filterSheet, {});
  }
  filtersOpen.setAttribute('aria-expanded', 'true');
}
function closeFilters() {
  if (!filterSheet.open) return;
  if (filterSheet.classList.contains('popover')) {
    filterSheet.close();
    document.removeEventListener('pointerdown', outsideClose, true);
    filtersOpen.setAttribute('aria-expanded', 'false');
  } else closeSheet(filterSheet, false);
}
filtersOpen.onclick = () => (filterSheet.open ? closeFilters() : openFilters());
$('#filter-done').onclick = closeFilters;
$('#filter-clear').onclick = () => { clearFilters(); setFilters({ view: 'mail' }); };
// A popover is not modal, so the browser sends it no cancel: Escape is ours to handle.
filterSheet.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !filterSheet.classList.contains('popover')) return;
  e.preventDefault();
  closeFilters();
  filtersOpen.focus();
});
window.addEventListener('resize', () => {
  if (filterSheet.open && filterSheet.classList.contains('popover')) positionPopover();
});

// ---- Status and announcements ----
let connectionProblem = !navigator.onLine;
let lastFetchAt = null;
let pollNarration = null, narrationTimer;
let pullText = null;
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
function announce(text) {
  const region = $('#announce');
  region.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { region.textContent = text; }, 50);
}
let toastTimer;
function toast(text, failed) {
  const node = $('#toast');
  announce(text);
  node.textContent = text;
  node.classList.toggle('failed', Boolean(failed));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

// ---- Data ----
// The last answers are kept so a language switch can reword the page from
// them instead of asking the server again.
let lastMail = null, lastThreads = null, lastSummary = null, lastDigest = null, loadFailed = false;
let nextCursor = null, loadingMail = false, loadMoreFailed = false, mailRequestId = 0;
let selectedKey = null, openKey = null;
let washNext = false;
const renderedKeys = new Set();
const extraRows = new Map();
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
function renderLede() {
  const node = $('#lede');
  const before = node.textContent;
  const fresh = el('p');
  const s = lastSummary;
  node.classList.toggle('pending', !s);
  if (!s) fresh.textContent = t('lede.loading');
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
  // A sentence that changed fades in; one that did not is left alone.
  if (before && before !== node.textContent && !reduceMotion()) {
    node.style.transition = 'none';
    node.style.opacity = '0';
    void node.offsetWidth;
    node.style.transition = '';
    node.style.opacity = '';
  }
}
function renderStatus() {
  const [text, warn] = statusLine();
  const node = $('#status');
  node.classList.toggle('warn', warn);
  // Writing the same words again would have the live region say them again.
  if (node.textContent !== text) node.textContent = text;
}
function statusLine() {
  if (pullText) return [pullText, false];
  if (connectionProblem) return [lastFetchAt ? fill('status.offline', { time: hhmm(lastFetchAt) }) : '', true];
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
function metaLine(m, thread) {
  const meta = el('div', 'meta');
  const add = (value, cls) => {
    if (meta.childNodes.length) meta.appendChild(textNode(' \\u00b7 '));
    meta.appendChild(cls ? el('span', cls, value) : textNode(value));
  };
  if (thread && thread.messageCount > 1) add(fill('thread.short', { count: thread.messageCount }), 'rescued');
  if (level(m) !== 'info') add(word('level.', m.importance), 'lvl ' + level(m));
  if (m.category) add(word('category.', m.category));
  if (m.verificationCode) add(t('code.tag'));
  if (m.inSpam) add(m.pushed ? t('row.rescued') : t('spam'), m.pushed ? 'rescued' : null);
  else if (m.pushed) add(t('notified'));
  if (m.deadline) add(t('detail.deadline') + ' ' + m.deadline, 'due');
  return meta;
}
function rowOf(item, now) {
  const thread = isThread(item) ? item : null;
  const m = rowOfItem(item);
  const key = keyOf(item);
  const li = el('li', 'row ' + level(m));
  li.dataset.key = key;
  li.appendChild(el('span', 'mark ' + level(m)));
  const who = el('a', 'who', m.senderName || m.sender || t('unknownSender'));
  who.href = '#m=' + encodeURIComponent(key);
  who.onclick = (e) => { e.preventDefault(); openDetail(key); };
  if (key === selectedKey) { li.classList.add('selected'); who.setAttribute('aria-current', 'true'); }
  li.appendChild(who);
  li.appendChild(el('span', 'when', when(m, now)));
  if (m.verificationCode) {
    li.classList.add('has-code');
    if (now - dateOf(m) > STALE_CODE_MS) li.classList.add('stale');
    li.appendChild(codeButton(m, 'code-copy'));
  } else {
    li.appendChild(el('div', 'sum', thread ? (m.subject || m.summary || t('noSubject')) : (m.summary || m.subject || t('noSubject'))));
  }
  li.appendChild(metaLine(m, thread));
  if (m.reason) li.appendChild(el('div', 'why', m.reason));
  return li;
}
function markSelected() {
  for (const li of list.querySelectorAll('li.row')) {
    const on = li.dataset.key === selectedKey;
    li.classList.toggle('selected', on);
    const who = li.querySelector('.who');
    if (who) { if (on) who.setAttribute('aria-current', 'true'); else who.removeAttribute('aria-current'); }
  }
}

// ---- The lane: the newest code, when it is fresh ----
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
  const fresh = filters.view.value === 'threads' ? null : freshCode(rows, now);
  lane.replaceChildren();
  lane.hidden = !fresh;
  if (!fresh) return null;
  const b = codeButton(fresh, 'lane-copy');
  if (washNext && !renderedKeys.has(rowKey(fresh))) b.classList.add('arrived');
  b.prepend(el('span', 'eyebrow', [t('code.fresh'), fresh.senderName || fresh.sender || '', ago(now - dateOf(fresh))].filter(Boolean).join(' \\u00b7 ')));
  lane.appendChild(b);
  return rowKey(fresh);
}

// ---- The list ----
function emptyBlock() {
  const box = el('div', 'empty');
  if (filtersActive()) {
    box.appendChild(el('p', null, t('empty')));
    const clear = el('button', 'text-btn', t('filter.clearAll'));
    clear.type = 'button';
    clear.onclick = clearFilters;
    box.appendChild(clear);
    return box;
  }
  box.appendChild(envelope());
  box.appendChild(el('h3', null, t('empty.quiet')));
  const at = lastSummary && lastSummary.lastPollAt ? new Date(lastSummary.lastPollAt) : null;
  box.appendChild(el('p', null, at && !isNaN(at) ? fill('empty.quietHint', { time: hhmm(at) }) : t('empty.quietHintPlain')));
  if (Number(filters.hours.value) <= 72) {
    const widen = el('button', 'text-btn', t('empty.widen'));
    widen.type = 'button';
    widen.onclick = () => setFilters({ hours: '168' });
    box.appendChild(widen);
  }
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
  if (!list.contains(a)) return null;
  const li = a.closest('li.row');
  if (li) return { key: li.dataset.key, code: a.classList.contains('code-copy') };
  return a.classList.contains('load-more') ? { more: true } : null;
}
function restoreFocus(f) {
  if (!f) return;
  let target = null;
  if (f.lane) target = lane.querySelector('.lane-copy');
  else if (f.more) target = list.querySelector('.load-more');
  else {
    const li = list.querySelector('li.row[data-key="' + CSS.escape(f.key) + '"]');
    if (li) target = (f.code && li.querySelector('.code-copy')) || li.querySelector('.who');
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
  buildList();
  restoreFocus(focus);
}
function buildList() {
  const now = new Date();
  const threads = filters.view.value === 'threads';
  const items = threads ? lastThreads : lastMail;
  list.replaceChildren();
  if (!items) { lane.hidden = true; lane.replaceChildren(); return; }
  const laneKey = renderLane(items, now);
  // Newest first by the date each row shows, so a day appears once even when a
  // backfill filed old mail late. The loaded order is kept for paging.
  const visible = items.filter((item) => keyOf(item) !== laneKey)
    .map((item, index) => ({ item, index, at: dateOf(rowOfItem(item)).getTime() || 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.item);
  if (!visible.length && !laneKey) { list.appendChild(emptyBlock()); announceShown(0); return; }

  // The since-you-last-looked line is drawn only when the new rows lead the list.
  const isNew = (item) => sinceAt > 0 && Date.parse(rowOfItem(item).createdAt) > sinceAt;
  const firstOld = visible.findIndex((item) => !isNew(item));
  const divide = firstOld > 0 && !visible.slice(firstOld).some(isNew);
  const frag = document.createDocumentFragment();
  let group = null, groupKey = null, countNode = null, count = 0, groups = 0;
  const wantInstall = installable && !standalone && !isWide() && !installDismissed();
  visible.forEach((item, index) => {
    const m = rowOfItem(item);
    const d = dateOf(m);
    const k = dayKey(d);
    const dividerHere = divide && index === firstOld;
    if (k !== groupKey) {
      if (countNode) countNode.textContent = String(count);
      if (groups === 1 && wantInstall) frag.appendChild(installLine());
      // Where new and older mail meet at a day boundary, the line sits between
      // the days rather than under the older day's header.
      if (dividerHere) frag.appendChild(sinceLine('div', firstOld));
      const head = el('h2', 'day');
      head.appendChild(el('span', null, dayLabel(d, now)));
      countNode = el('span', 'count');
      head.appendChild(countNode);
      frag.appendChild(head);
      group = el('ul', 'group');
      frag.appendChild(group);
      groupKey = k; count = 0; groups += 1;
    } else if (dividerHere) group.appendChild(sinceLine('li', firstOld));
    const li = rowOf(item, now);
    if (washNext && !renderedKeys.has(keyOf(item))) li.classList.add('arrived');
    group.appendChild(li);
    count += 1;
  });
  if (countNode) countNode.textContent = String(count);
  if (groups === 1 && wantInstall) frag.appendChild(installLine());
  list.appendChild(frag);
  if (!threads && nextCursor) list.appendChild(loadMoreButton());
  renderedKeys.clear();
  for (const item of items) renderedKeys.add(keyOf(item));
  washNext = false;
  announceShown(visible.length);
}

// ---- Detail: the same content in the sheet and in the pane ----
function linkLabel(row) {
  const name = STRINGS[lang]['provider.' + row.provider];
  return name ? fill(row.link.exact ? 'link.openIn' : 'link.open', { name }) : row.link.label;
}
function failure(d) {
  return STRINGS[lang]['error.' + d.code]
    ? fill('error.' + d.code, { detail: d.detail || '', maxBytes: d.maxBytes ? sizeLabel(d.maxBytes) : '' })
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
function attachmentSection(box, row) {
  const manifest = row.attachmentManifest;
  if (manifest && Array.isArray(manifest.items) && !manifest.items.length && !manifest.truncated) return;
  const known = manifest && Array.isArray(manifest.items);
  const label = known ? t('detail.attachments') + ' \\u00b7 ' + manifest.items.length : t('detail.attachments');
  disclosure(box, label, (body) => {
    if (manifest) { renderAttachmentManifest(body, manifest, row); return; }
    fetching(body, '/api/attachments?id=' + encodeURIComponent(row.dedupKey || row.messageId), t('detail.loadingAttachments'),
      (target, result) => renderAttachmentManifest(target, result, row));
  });
}
function safetySection(box, row) {
  if (!row.messageId) return;
  disclosure(box, t('safety.title'), (body) => {
    fetching(body, '/api/safety?id=' + encodeURIComponent(row.dedupKey || row.messageId), t('safety.checking'), renderSafetyReport);
  });
}
function detail(row) {
  const box = el('div', 'detail');
  const now = new Date();
  const d = dateOf(row);
  // A verification code is the reason the message exists, so it comes before
  // everything and can be copied in one tap.
  if (row.verificationCode) {
    const band = codeButton(row, 'code-band');
    band.appendChild(el('span', 'caption', [t('detail.code'), row.senderName || row.sender || '', hhmm(d)].filter(Boolean).join(' \\u00b7 ')));
    box.appendChild(band);
  }
  const title = el('h3', null, row.subject || t('noSubject'));
  title.tabIndex = -1;
  box.appendChild(title);
  const from = row.sender ? (row.senderName ? row.senderName + ' ' : '') + '<' + row.sender + '>' : (row.senderName || '');
  const where = [row.accountLabel || row.account, row.folder].filter(Boolean).join(' \\u00b7 ');
  box.appendChild(el('p', 'byline', [from, where, dayLabel(d, now) + '\\u00a0' + hhmm(d)].filter(Boolean).join(' \\u00b7 ')));

  const judgement = el('div', 'judgement');
  const line = el('div', 'line');
  line.appendChild(el('span', 'mark ' + level(row)));
  const by = word('by.', row.decidedBy);
  let judged = by ? fill('detail.judgedAs', { level: word('level.', row.importance), by }) : word('level.', row.importance);
  if (row.pushed) judged += ' \\u00b7 ' + fill('detail.notifiedAt', { time: hhmm(new Date(row.createdAt)) });
  line.appendChild(textNode(judged));
  judgement.appendChild(line);
  const dl = el('dl');
  const add = (k, v, cls) => { if (!v) return; dl.appendChild(el('dt', null, t(k))); dl.appendChild(el('dd', cls, v)); };
  add('detail.why', row.reason);
  add('detail.deadline', row.deadline, 'due');
  if (row.inSpam) {
    const folder = row.folder || t('spam');
    add('detail.mailbox', fill(row.pushed ? 'detail.rescued' : 'detail.foundIn', { folder }), row.pushed ? 'due' : null);
  }
  if (dl.childNodes.length) judgement.appendChild(dl);
  box.appendChild(judgement);
  if (row.summary) box.appendChild(el('p', 'summary', row.summary));

  const actions = el('div', 'actions');
  if (row.link && row.link.url && row.link.exact) {
    const a = el('a', null, linkLabel(row));
    a.href = row.link.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.appendChild(icon('i-arrow'));
    actions.appendChild(a);
  }
  const full = el('button', 'text-btn', t('detail.load'));
  full.type = 'button';
  const bodySection = el('section', 'body');
  bodySection.hidden = true;
  bodySection.appendChild(el('h4', 'section-label', t('detail.body')));
  const liveBody = el('pre', 'live-body');
  liveBody.setAttribute('aria-live', 'polite');
  bodySection.appendChild(liveBody);
  let slowTimer;
  full.onclick = async () => {
    full.disabled = true; full.textContent = t('detail.loading');
    bodySection.hidden = false;
    liveBody.className = 'live-body pending';
    liveBody.textContent = t('detail.loading');
    // A mailbox with poor search can take a while; say so rather than looking stuck.
    slowTimer = setTimeout(() => { if (liveBody.classList.contains('pending')) liveBody.textContent = t('detail.loading') + ' ' + t('detail.slow'); }, 8000);
    try {
      const r = await fetch('/api/message?live=true&id=' + encodeURIComponent(row.messageId || row.dedupKey));
      const d = await r.json();
      clearTimeout(slowTimer);
      if (r.ok) {
        liveBody.className = 'live-body';
        liveBody.textContent = d.body || t('detail.noBody');
        full.remove();
      } else {
        liveBody.className = 'live-body inline-error';
        liveBody.textContent = failure(d);
        full.disabled = false; full.textContent = t('detail.retry');
      }
    } catch (e) {
      clearTimeout(slowTimer);
      liveBody.className = 'live-body inline-error';
      liveBody.textContent = t('detail.networkFailed');
      full.disabled = false; full.textContent = t('detail.load');
    }
  };
  actions.appendChild(full);
  box.appendChild(actions);
  box.appendChild(bodySection);
  attachmentSection(box, row);
  safetySection(box, row);
  return box;
}
function threadDetail(thread) {
  const box = detail(thread.latest);
  const older = (thread.messages || []).slice(1);
  if (!older.length) return box;
  const now = new Date();
  const history = el('section', 'thread-history');
  history.appendChild(el('h4', 'section-label', t('thread.earlier') + ' \\u00b7 ' + older.length));
  const ul = el('ul', 'timeline');
  for (const message of older) {
    const li = el('li');
    const d = dateOf(message);
    li.appendChild(el('div', 'tl-head', (message.senderName || message.sender || t('unknownSender')) + ' \\u00b7 ' + dayLabel(d, now) + '\\u00a0' + hhmm(d)));
    if (message.subject && message.subject !== thread.latest.subject) li.appendChild(el('div', 'tl-subject', message.subject));
    if (message.summary) li.appendChild(el('div', 'tl-sum', message.summary));
    ul.appendChild(li);
  }
  history.appendChild(ul);
  box.appendChild(history);
  return box;
}
const detailFor = (item) => (isThread(item) ? threadDetail(item) : detail(item));

// ---- Opening a message: a sheet on a phone, the pane on a desk ----
function openDetail(key, here) {
  const item = findItem(key);
  if (!item) return;
  openKey = key;
  if (isWide()) {
    selectedKey = key;
    markSelected();
    renderPane();
    history.replaceState(history.state, '', location.pathname + location.search + '#m=' + encodeURIComponent(key));
    return;
  }
  const body = sheet.querySelector('.sheet-body');
  const content = detailFor(item);
  const title = content.querySelector('h3');
  if (title) title.id = 'sheet-title';
  body.replaceChildren(content);
  body.scrollTop = 0;
  openSheet(sheet, { key, hash: '#m=' + encodeURIComponent(key) }, here);
  if (title) title.focus({ preventScroll: true });
}
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
  // The minute refresh must not throw away a body the reader loaded or a
  // section they opened, so the pane is rebuilt only when its subject changes.
  if (!force && key === paneKey && body.childNodes.length) return;
  paneKey = key;
  body.replaceChildren();
  $('#pane-close').hidden = !item;
  if (!item) {
    const empty = el('div', 'pane-empty');
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
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
}
$('#pane-close').onclick = clearSelection;
matchMedia(WIDE).addEventListener('change', () => {
  if (isWide()) {
    if (sheet.open) { closeSheet(sheet, false); selectedKey = openKey; }
    if (filterSheet.open) closeFilters();
    controlLine.hidden = false;
  } else {
    if (filterSheet.open && filterSheet.classList.contains('popover')) closeFilters();
    // On a phone the search line replaces the controls, so never show both; a
    // query in progress stays as a token the controls can clear.
    searchLine.hidden = true;
    controlLine.hidden = false;
  }
  markSelected();
  renderTokens();
  renderPane(true);
});

// ---- Digest ----
const LEVEL_RANK = { critical: 3, warning: 2, info: 1 };
function digestItem(item) {
  const line = el('p', 'digest-item');
  line.appendChild(el('b', null, item.fromName || item.from || t('unknownSender')));
  line.appendChild(textNode(' \\u2014 '));
  line.appendChild(el('span', 'gist', item.summary || item.subject || ''));
  if (item.threadCount > 1) line.appendChild(textNode(' \\u00d7' + item.threadCount));
  if (item.deadline) { line.appendChild(textNode(' \\u00b7 ')); line.appendChild(el('span', 'due', t('detail.deadline') + ' ' + item.deadline)); }
  return line;
}
function renderDigest() {
  const section = $('#digest');
  section.replaceChildren();
  const g = lastDigest;
  if (!g || !g.pending || g.enabled === false) { section.hidden = true; return; }
  section.hidden = false;
  section.appendChild(el('h2', null, t('digest.title')));
  // When it goes out, worked out by the server that sends it and shown in this
  // device's own clock.
  const next = g.nextAt ? new Date(g.nextAt) : null;
  if (next && !isNaN(next)) {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const whenWord = dayKey(next) === dayKey(tomorrow) ? t('digest.tomorrow') : dayLabel(next, now);
    const key = g.pending === 1 ? 'digest.meta1' : 'digest.meta';
    section.appendChild(el('p', 'digest-meta', fill(key, { when: whenWord, time: hhmm(next), count: g.pending })));
  }
  const items = Array.isArray(g.items) ? g.items : null;
  if (!items) {
    // An older server: the rendered text, minus its markdown marks.
    section.appendChild(el('p', 'digest-fallback', String(g.preview || '').replace(/\\*\\*/g, '').replace(/^- /gm, '')));
    return;
  }
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
  const limit = isWide() ? Infinity : 6;
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
  section.appendChild(wrap);
  if (hidden) {
    const more = el('button', 'text-btn', fill('digest.more', { count: hidden }));
    more.type = 'button';
    more.onclick = () => { for (const line of overflow) line.hidden = false; more.remove(); };
    section.appendChild(more);
  }
}

// ---- Loading ----
let timer;
function onFiltersChanged() {
  announceNextList = true;
  markSegs();
  renderTokens();
  syncUrl();
  loadMoreFailed = false;
  clearTimeout(timer);
  timer = setTimeout(() => { load(); chrome(); }, 250);
}
filters.addEventListener('input', onFiltersChanged);

async function load(reset = true) {
  if (loadingMail && !reset) return;
  const cursor = reset ? null : nextCursor;
  if (!reset && !cursor) return;
  const requestId = ++mailRequestId;
  const p = query();
  p.set('limit', String(MAIL_PAGE_SIZE));
  if (cursor) p.set('cursor', cursor);
  loadingMail = true;
  if (!reset) renderList();
  try {
    const r = await fetch(dataPath() + '?' + p.toString());
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error('http ' + r.status);
    const data = await r.json();
    if (requestId !== mailRequestId) return;
    if (filters.view.value === 'threads') {
      lastThreads = Array.isArray(data.threads) ? data.threads : [];
      lastMail = null;
      nextCursor = null;
    } else {
      const page = Array.isArray(data.mail) ? data.mail : [];
      lastMail = reset ? page : mergeMail(lastMail || [], page);
      lastThreads = null;
      nextCursor = data.nextCursor || null;
    }
    lastFetchAt = new Date();
    loadFailed = false;
    loadMoreFailed = false;
    setNetworkIssue(false);
  } catch (e) {
    if (requestId === mailRequestId) {
      if (reset) { loadFailed = true; setNetworkIssue(true); } else loadMoreFailed = true;
    }
  } finally {
    if (requestId === mailRequestId) {
      loadingMail = false;
      renderList();
      renderPane();
      if (!firstLoadDone && !loadFailed) { firstLoadDone = true; afterFirstLoad(); }
    }
  }
}

// The minute refresh: fold the newest page into what is shown, and tint the
// rows that were not there before.
async function refresh() {
  if (loadingMail) return;
  if (filters.view.value === 'threads') { washNext = true; return load(true); }
  if (!lastMail) return load(true);
  const requestId = ++mailRequestId;
  const previousCursor = nextCursor;
  const p = query();
  p.set('limit', String(MAIL_PAGE_SIZE));
  loadingMail = true;
  try {
    const r = await fetch(dataPath() + '?' + p.toString());
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error('http ' + r.status);
    const data = await r.json();
    if (requestId !== mailRequestId) return;
    lastMail = mergeMail(lastMail || [], Array.isArray(data.mail) ? data.mail : []);
    nextCursor = previousCursor;
    lastFetchAt = new Date();
    setNetworkIssue(false);
  } catch (e) {
    if (requestId === mailRequestId) setNetworkIssue(true);
  } finally {
    if (requestId === mailRequestId) { loadingMail = false; washNext = true; renderList(); renderPane(); }
  }
}

async function chrome() {
  try {
    const p = new URLSearchParams();
    p.set('hours', filters.hours.value);
    const s = await (await fetch('/api/summary?' + p.toString())).json();
    lastSummary = s;
    if (!filters.category.dataset.filled) {
      for (const c of s.categories || []) filters.category.appendChild(new Option(word('category.', c), c));
      for (const a of s.accounts || []) filters.account.appendChild(new Option(a.name, a.address));
      filters.category.dataset.filled = '1';
      // Values a reload or a shortcut asked for before the options existed.
      // The first query already carried them; one that no option offers is
      // dropped, and the list asked for again without it.
      let dropped = false;
      for (const name in pendingPicks) {
        const select = filters.elements.namedItem(name);
        if (select && Array.from(select.options).some((o) => o.value === pendingPicks[name])) select.value = pendingPicks[name];
        else dropped = true;
      }
      pendingPicks = {};
      syncUrl();
      if (dropped) load();
    }
    lastDigest = await (await fetch('/api/digest')).json();
    renderLede();
    renderStatus();
    renderTokens();
    renderDigest();
  } catch (e) {
    setNetworkIssue(true);
  }
}

// What a reload or a home-screen shortcut asked for, once the list is here.
let bootKey = keyFromHash(location.hash);
const bootParams = new URLSearchParams(location.search);
const wantsCode = bootParams.get('focus') === 'code';
// Stripped even when it does not decode, so a broken link does not survive a reload.
if (location.hash.indexOf('#m=') === 0) history.replaceState(null, '', location.pathname + location.search);
function afterFirstLoad() {
  if (bootKey) {
    const key = bootKey;
    bootKey = null;
    openFromLink(key, false);
  }
  if (wantsCode) {
    const target = lane.hidden ? list.querySelector('.has-code .code-copy') : lane.querySelector('.lane-copy');
    if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
    else narrate(t('code.none'), false, 6000);
  }
  syncUrl();
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
$('#theme').onclick = () => {
  const next = readTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch (e) {}
  applyTheme(next);
};

// ---- Language: reword the page in place from the last answers. ----
function renderAll() {
  renderLede();
  renderStatus();
  renderTokens();
  renderList();
  renderDigest();
  renderPane(true);
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
  if (sheet.open && openKey) {
    const item = findItem(openKey);
    if (item) {
      const content = detailFor(item);
      const title = content.querySelector('h3');
      if (title) title.id = 'sheet-title';
      sheet.querySelector('.sheet-body').replaceChildren(content);
    }
  }
}
$('#lang').onclick = () => {
  const next = LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length];
  storeLanguage(next);
  applyLanguage(next);
};

// ---- Install: a word in the header on a desk, a line in the list on a phone. ----
const installButton = $('#install');
let pendingInstall = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installable = !standalone && appleMobile;
function installDismissed() { return Number(readStorage('installDismissed') || 0) > Date.now(); }
function updateInstallUi() {
  installButton.hidden = !installable;
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
installButton.addEventListener('click', promptInstall);
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
    if (stats.accountsFailed > 0) narrate(t('status.partial'), true, 6000);
    else if (stats.fresh > 0) narrate(fill('status.new', { count: stats.fresh }), false, 6000);
    else narrate(t('status.none'), false, 6000);
    await refresh();
    chrome();
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

// Pull to check, only where the browser's own pull is gone: the installed app.
if (standalone && refreshButton && matchMedia('(pointer: coarse)').matches) {
  const title = $('.title');
  let startY = null, pulling = false, pulled = 0;
  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || document.querySelector('dialog[open]')) { startY = null; return; }
    startY = e.touches[0].clientY; pulled = 0; pulling = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 12) return;
    pulling = true;
    pulled = Math.min(36, dy / 2);
    title.style.transition = 'none';
    title.style.transform = 'translateY(' + pulled + 'px)';
    pullText = t(dy > 64 ? 'pull.release' : 'pull.hint');
    renderStatus();
  }, { passive: true });
  const release = () => {
    if (!pulling) { startY = null; return; }
    const go = pulled >= 32;
    title.style.transition = 'transform .2s cubic-bezier(.2,.7,.2,1)';
    title.style.transform = '';
    startY = null; pulling = false; pullText = null;
    renderStatus();
    if (go) pollNow();
  };
  document.addEventListener('touchend', release, { passive: true });
  document.addEventListener('touchcancel', release, { passive: true });
}

// ---- Keyboard, where there is one ----
if (matchMedia('(pointer: fine)').matches) {
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    const editable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (editable) return;
    if (document.querySelector('dialog[open]')) return;
    const keys = Array.from(list.querySelectorAll('li.row')).map((li) => li.dataset.key);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
      if (!keys.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
      const index = Math.min(keys.length - 1, Math.max(0, keys.indexOf(selectedKey) + step));
      const key = keys[index];
      if (isWide()) openDetail(key);
      else { selectedKey = key; markSelected(); }
      const li = list.querySelector('li.row[data-key="' + CSS.escape(key) + '"]');
      if (li) li.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && selectedKey) {
      e.preventDefault();
      openDetail(selectedKey);
    } else if (e.key === '/') {
      e.preventDefault();
      showSearch();
    } else if (e.key === 'c') {
      const button = lane.hidden ? list.querySelector('.has-code .code-copy') : lane.querySelector('.lane-copy');
      if (button) button.click();
    } else if (e.key === 'Escape' && selectedKey) {
      clearSelection();
    }
  });
}

// ---- Ambient ----
window.addEventListener('scroll', () => header.classList.toggle('scrolled', window.scrollY > 4), { passive: true });
window.addEventListener('offline', () => setNetworkIssue(true));
window.addEventListener('online', () => { setNetworkIssue(false); load(); chrome(); });
// The since-you-last-looked line is drawn from the moment the page was last put away.
function rememberSeen() { writeStorage('seenAt', new Date().toISOString()); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { rememberSeen(); return; }
  sinceAt = Date.parse(readStorage('seenAt') || '') || sinceAt;
  refresh(); chrome();
});
window.addEventListener('pagehide', rememberSeen);
setInterval(() => { if (!document.hidden) { refresh(); chrome(); } }, 60000);
setInterval(renderStatus, 30000);

readUrl();
markSegs();
applyTheme(readTheme());
if (connectionProblem) setNetworkIssue(true);
renderAll();
load();
chrome();
`;
}
