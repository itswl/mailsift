/**
 * The mailbox part of the page script: any folder, and a search of the
 * mailbox, read live from IMAP.
 *
 * Everything else on the page is what mailsift fetched and judged. This is
 * the rest of the mailbox, listed when it is asked for: the folders of each
 * mailbox in a small panel under the control that opened it, the messages of
 * one folder a page at a time, and the results of a search the provider
 * runs. Such a list is marked as live from the mailbox, not triaged, and the
 * way back to the triaged views is the first control on its line.
 *
 * A message listed here is named by its live handle, which the server checks
 * against the mailbox every time it is used. One that mailsift stored also
 * carries its key, and is the same row as in the triaged list: it can be
 * marked done, put off, and shows how it was judged.
 *
 * String.raw: the script below is written as it runs. It must hold no
 * backtick and no dollar sign followed by a brace.
 */
export function mailboxPart(): string {
  return String.raw`
// ---- The whole mailbox: a folder or a search, live ----
// What the list shows when it is not the triaged mail: { mode: 'folder' or
// 'search', account, folder (null: the inbox and the archive), q, items,
// next, total, limited, loading, failed }.
let liveView = null;
// The rows of the live list by key, for the reader and the actions to find.
const liveRows = new Map();
// Each mailbox's folders as last listed: { at, folders, loading, error }.
const folderLists = new Map();
let liveSeq = 0, liveAbort = null;
// The triaged view's own query, put back when the live view is left.
let triagedQuery = '';
const LIVE_PAGE = 50;

function summaryAccounts() {
  return lastSummary && Array.isArray(lastSummary.accounts) ? lastSummary.accounts : [];
}
function folderInfo(account, path) {
  const known = folderLists.get(account);
  return known && Array.isArray(known.folders) ? known.folders.find((f) => f.path === path) || null : null;
}
// A folder as the page calls it: the ones every mailbox has by what they
// are for, in the page's words; the owner's own as they named them.
function folderName(account, path) {
  if (!path) return t('live.defaultFolders');
  const info = folderInfo(account, path);
  const role = info ? info.role : (String(path).toUpperCase() === 'INBOX' ? 'inbox' : null);
  if (role && STRINGS[lang]['folder.' + role]) return t('folder.' + role);
  return info ? info.name : String(path);
}
function folderRoleOf(account, path) {
  const info = folderInfo(account, path);
  return info ? info.role : (String(path || '').toUpperCase() === 'INBOX' ? 'inbox' : null);
}
// What the page knows about a message listed live, in the shape of a row of
// the triaged list. A stored one keeps its key, so it is the same row there.
function liveRow(item, account) {
  const s = item.stored || {};
  return {
    dedupKey: item.key || item.handle, handle: item.handle, live: true, stored: Boolean(item.key),
    messageId: item.messageId || null, account, accountLabel: accountName(account), folder: item.folder,
    subject: item.subject || '', sender: (item.from && item.from.address) || '', senderName: (item.from && item.from.name) || '',
    mailDate: item.date || null, createdAt: item.date || '', importance: s.importance || null, category: s.category || null,
    summary: s.summary || null, deadline: s.deadline || null, pushed: Boolean(s.pushed), withheld: Boolean(s.withheld),
    handledAt: s.handledAt || null, snoozedUntil: s.snoozedUntil || null, inSpam: folderRoleOf(account, item.folder) === 'junk',
    flags: item.flags || {}, attachments: Boolean(item.attachments), size: item.size,
    link: item.link || null, provider: item.provider || '',
  };
}
// What the history and the address keep of a live view.
function liveState(view) {
  const v = view || liveView;
  return v ? { mode: v.mode, account: v.account, folder: v.folder || null, q: v.q || '' } : null;
}
function sameLive(a, b) {
  return Boolean(a && b) && a.mode === b.mode && a.account === b.account && (a.folder || null) === (b.folder || null) && (a.q || '') === (b.q || '');
}

// Open a folder or a search. how: 'push' from the triaged view, so Back
// returns to it; 'replace' from another live view; 'restore' from the
// history or the address, which already hold it.
function openLive(view, how) {
  if (!view || !view.account) return;
  if (!liveView) triagedQuery = filters.q.value;
  if (liveAbort) liveAbort.abort();
  liveView = Object.assign({ items: [], next: null, total: null, limited: null, loading: false, failed: null, moreFailed: false },
    { mode: view.mode === 'search' ? 'search' : 'folder', account: view.account, folder: view.folder || null, q: view.q || '' });
  liveRows.clear();
  filters.q.value = liveView.mode === 'search' ? liveView.q : '';
  document.body.classList.add('live-mode');
  if (selectedKey || openKey) clearSelection();
  if (how === 'push') history.pushState({ live: liveState() }, '', location.pathname + location.search);
  else if (how === 'replace') history.replaceState(Object.assign({}, history.state, { live: liveState() }), '', location.pathname + location.search);
  syncUrl();
  renderLiveHead();
  renderTokens();
  renderMailboxSearch();
  updateAsk();
  wordPlaceholders();
  renderList();
  liveLoad(true);
  // The folders' names and what each is for, for the line above the list.
  loadFolders(liveView.account);
  window.scrollTo(0, 0);
}
// Back to the triaged view, with its own query as it was.
function exitLive(viaHistory) {
  if (!liveView) return;
  if (liveAbort) liveAbort.abort();
  liveView = null;
  liveRows.clear();
  document.body.classList.remove('live-mode');
  if (selectedKey || openKey) clearSelection();
  if (!viaHistory && history.state && history.state.live) oweBack();
  const query = triagedQuery;
  triagedQuery = '';
  renderLiveHead();
  if (filters.q.value !== query) { filters.q.value = query; onFiltersChanged(); }
  else { syncUrl(); renderTokens(); renderMailboxSearch(); updateAsk(); renderList(); }
  wordPlaceholders();
}
$('#live-back').onclick = () => exitLive(false);

async function liveLoad(reset) {
  const view = liveView;
  if (!view) return;
  if (!reset && (!view.next || view.loading)) return;
  const seq = ++liveSeq;
  // A newer search takes the place of the one before: the page stops waiting for it, and the server stops it.
  if (liveAbort) liveAbort.abort();
  const abort = window.AbortController ? new AbortController() : null;
  liveAbort = abort;
  view.loading = true;
  view.moreFailed = false;
  if (reset) view.failed = null;
  renderList();
  const p = new URLSearchParams();
  p.set('account', view.account);
  if (view.folder) p.set('folder', view.folder);
  if (view.mode === 'search') p.set('q', view.q);
  if (!reset && view.next) p.set('before', view.next);
  p.set('limit', String(LIVE_PAGE));
  try {
    const r = await fetch((view.mode === 'search' ? '/api/search?' : '/api/folder?') + p.toString(), abort ? { signal: abort.signal } : {});
    if (r.status === 401) { location.reload(); return; }
    const d = await r.json().catch(() => ({}));
    if (seq !== liveSeq || view !== liveView) return;
    if (!r.ok) {
      // The folder changed under the pages already shown: start it again from the top.
      if (d.code === 'liveCursor' && !reset) { view.loading = false; liveLoad(true); return; }
      if (reset) view.failed = d; else view.moreFailed = true;
      return;
    }
    const rows = (Array.isArray(d.items) ? d.items : []).map((item) => liveRow(item, view.account));
    if (reset) { liveRows.clear(); view.items = []; }
    for (const row of rows) {
      if (liveRows.has(rowKey(row))) continue;
      liveRows.set(rowKey(row), row);
      view.items.push(row);
      flagsByKey.set(rowKey(row), Object.assign({}, row.flags));
    }
    view.next = d.next || null;
    if (reset) {
      view.total = typeof d.total === 'number' ? d.total : null;
      view.limited = d.limited || null;
      view.folders = Array.isArray(d.folders) ? d.folders : null;
    }
    holdPending();
    holdSnoozes();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (seq !== liveSeq || view !== liveView) return;
    if (reset) view.failed = {}; else view.moreFailed = true;
  } finally {
    if (seq === liveSeq && view === liveView) {
      view.loading = false;
      renderList();
      renderLiveHead();
      renderPane();
    }
  }
}

// ---- The line above a live list: where it is from, and that it is live ----
function liveTitle() {
  if (!liveView) return '';
  // A search of the default folders names the ones the server searched, once it has said.
  const where = !liveView.folder && Array.isArray(liveView.folders) && liveView.folders.length
    ? liveView.folders.map((path) => folderName(liveView.account, path)).join(lang === 'zh-CN' ? '、' : ', ')
    : folderName(liveView.account, liveView.folder);
  return accountName(liveView.account) + DOT + where;
}
function renderLiveHead() {
  const head = $('#live-head'), note = $('#live-note');
  const view = liveView;
  head.hidden = !view;
  note.hidden = !view;
  if (!view) { note.replaceChildren(); return; }
  $('#live-where-name').textContent = liveTitle();
  const where = $('#live-where');
  where.title = t('folders.title');
  const parts = [];
  if (view.mode === 'search') {
    parts.push(fill('live.searchFor', { q: view.q }));
    if (typeof view.total === 'number') parts.push(view.total === 1 ? t('live.found1') : fill('live.found', { count: view.total.toLocaleString(lang) }));
  } else if (typeof view.total === 'number') {
    parts.push(view.total === 1 ? t('live.count1') : fill('live.count', { count: view.total.toLocaleString(lang) }));
    const info = folderInfo(view.account, view.folder);
    if (info && info.unseen) parts.push(fill('live.unseen', { count: info.unseen.toLocaleString(lang) }));
  }
  const said = [lang, view.mode, parts.join('|'), view.limited ? view.limited.reason + view.limited.scanned : ''].join('/');
  if (note.dataset.said === said) return;
  note.dataset.said = said;
  note.replaceChildren();
  const line = el('p', 'live-line');
  line.appendChild(el('span', 'live-mark', t('live.mark')));
  for (const part of parts) line.appendChild(textNode(DOT + part));
  note.appendChild(line);
  // A search the server could not be trusted with says what it covered, every time.
  if (view.limited) note.appendChild(el('p', 'live-limit', fill('live.limited', { count: Number(view.limited.scanned || 0).toLocaleString(lang) })));
}
$('#live-where').onclick = () => openFolders($('#live-where'));

// ---- The list itself ----
function liveEmpty() {
  const box = el('div', 'empty');
  const view = liveView;
  if (view.failed) {
    box.appendChild(el('p', null, view.failed.code ? failure(view.failed) : t('detail.networkFailed')));
    const retry = el('button', 'text-btn', t('network.retry'));
    retry.type = 'button';
    retry.dataset.focus = 'live-retry';
    retry.onclick = () => liveLoad(true);
    box.appendChild(retry);
    return box;
  }
  box.appendChild(el('p', null, t(view.mode === 'search' ? 'live.noneFound' : 'live.emptyFolder')));
  return box;
}
function liveMoreButton() {
  const view = liveView;
  const more = el('button', 'text-btn load-more');
  more.type = 'button';
  if (view.loading) { more.textContent = t('loadingMore'); more.disabled = true; }
  else if (view.moreFailed) { more.textContent = t('loadMore.failed') + DOT + t('network.retry'); more.classList.add('failed'); }
  else more.textContent = t('loadMore');
  more.onclick = () => liveLoad(false);
  return more;
}
// The live list, grouped by day as the mailbox has the messages in order.
function buildLiveList(now) {
  const view = liveView;
  lane.hidden = true;
  lane.replaceChildren();
  renderQueue([], [], [], now, false);
  const desired = [];
  if (!view.items.length) {
    desired.push(view.loading ? skeleton()
      : cached('live-empty', [lang, view.mode, view.failed ? view.failed.code || 'net' : ''].join('|'), liveEmpty));
    patchChildren(list, desired);
    forgetUnused();
    if (!view.loading) announceShown(0);
    return;
  }
  let day = null, run = 0;
  for (const row of view.items) {
    const d = dateOf(row);
    const k = isNaN(d) ? 'unknown' : dayKey(d);
    if (!day || day.key !== k) {
      run += 1;
      day = { key: k, date: d, rows: [], id: 'live-' + run + '-' + k };
      desired.push(day);
    }
    day.rows.push(cached('v:' + rowKey(row), rowSignature(row, now, false), () => rowOf(row, now, false)));
  }
  const nodes = [];
  for (const group of desired) {
    nodes.push(dayHead(group.id + '-head', isNaN(group.date) ? '' : dayLabel(group.date, now), group.rows.length));
    const ul = cached(group.id, 'g', () => el('ul', 'group'));
    patchChildren(ul, group.rows);
    nodes.push(ul);
  }
  if (view.next || view.moreFailed) nodes.push(liveMoreButton());
  patchChildren(list, nodes);
  forgetUnused();
  watchForMore();
  announceShown(view.items.length);
}
// After an action took a message out of the folder on show (moved, archived, binned), it leaves the list.
function dropLive(key) {
  if (!liveView) return;
  const row = liveRows.get(key);
  liveRows.delete(key);
  liveView.items = liveView.items.filter((m) => rowKey(m) !== key);
  if (row && typeof liveView.total === 'number') liveView.total = Math.max(0, liveView.total - 1);
  renderLiveHead();
}
// Whether a message is in the folder an action would move it to.
function liveIn(row, role) {
  return Boolean(row && row.live) && folderRoleOf(row.account, row.folder) === role;
}

// ---- The folders of a mailbox, under the control that asked for them ----
let folderPick = { account: null, filter: '' };
function openFolders(anchor) {
  if (folderSheet.open) { closePopover(folderSheet, false); return; }
  const accounts = summaryAccounts();
  if (!accounts.length || !anchor) return;
  const asked = (liveView && liveView.account) || filters.account.value || accounts[0].address;
  folderPick = { account: accounts.some((a) => a.address === asked) ? asked : accounts[0].address, filter: '' };
  drawFolders();
  openPopover(folderSheet, anchor, { width: 340, align: 'start', history: !isWide() });
  loadFolders(folderPick.account);
  const filter = folderSheet.querySelector('.folder-filter');
  if (filter && isWide()) filter.focus({ preventScroll: true });
}
$('#folders-open').onclick = () => openFolders($('#folders-open'));
$('#folder-done').onclick = () => closePopover(folderSheet, false);
async function loadFolders(account, force) {
  const known = folderLists.get(account);
  if (known && known.loading) return;
  if (!force && known && Date.now() - known.at < 120000) return;
  folderLists.set(account, Object.assign({}, known || { at: 0 }, { loading: true, error: null }));
  if (folderSheet.open && folderPick.account === account) drawFolderList();
  let next;
  try {
    const r = await fetch('/api/folders?account=' + encodeURIComponent(account));
    if (r.status === 401) { location.reload(); return; }
    const d = await r.json().catch(() => ({}));
    next = r.ok ? { at: Date.now(), folders: Array.isArray(d.folders) ? d.folders : [] }
      : { at: 0, folders: known && known.folders, error: d };
  } catch (e) {
    next = { at: 0, folders: known && known.folders, error: {} };
  }
  folderLists.set(account, next);
  if (folderSheet.open && folderPick.account === account) drawFolderList();
  if (liveView && liveView.account === account) {
    renderLiveHead();
    // A message in the spam folder offers "Not spam", which the folder list tells.
    for (const row of liveView.items) row.inSpam = folderRoleOf(account, row.folder) === 'junk';
  }
}
function drawFolders() {
  const body = folderSheet.querySelector('.sheet-body');
  body.replaceChildren();
  const accounts = summaryAccounts();
  if (accounts.length > 1) {
    const set = el('div', 'segset folder-accounts');
    set.setAttribute('role', 'radiogroup');
    set.setAttribute('aria-label', t('filter.mailbox'));
    for (const a of accounts) {
      const b = el('button', 'seg' + (a.address === folderPick.account ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(a.address === folderPick.account));
      b.appendChild(el('span', null, a.name));
      b.onclick = () => { folderPick = { account: a.address, filter: '' }; drawFolders(); loadFolders(a.address); };
      set.appendChild(b);
    }
    body.appendChild(set);
  }
  const filter = el('input', 'folder-filter');
  filter.type = 'search';
  filter.placeholder = t('folders.filter');
  filter.setAttribute('aria-label', t('folders.filter'));
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  filter.value = folderPick.filter;
  filter.oninput = () => { folderPick.filter = filter.value; drawFolderList(); };
  filter.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); const first = body.querySelector('.folder-choice'); if (first) first.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); const first = body.querySelector('.folder-choice'); if (first) first.click(); }
  };
  body.appendChild(filter);
  const box = el('div', 'choices folder-list');
  box.setAttribute('role', 'list');
  box.onkeydown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = Array.from(box.querySelectorAll('.folder-choice'));
    const at = all.indexOf(document.activeElement);
    if (at === -1) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && at === 0) { filter.focus(); return; }
    const next = all[Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) next.focus();
  };
  body.appendChild(box);
  drawFolderList();
}
// The list part alone, so typing in the filter keeps its place and caret.
function drawFolderList() {
  const body = folderSheet.querySelector('.sheet-body');
  const box = body.querySelector('.folder-list');
  const filter = body.querySelector('.folder-filter');
  if (!box) return;
  const account = folderPick.account;
  const known = folderLists.get(account) || {};
  const folders = Array.isArray(known.folders) ? known.folders : [];
  box.replaceChildren();
  // A short list needs no filter box.
  if (filter) filter.hidden = folders.length <= 8 && !folderPick.filter;
  if (!folders.length) {
    if (known.error) {
      box.appendChild(el('p', 'inline-error', known.error.code ? failure(known.error) : t('detail.networkFailed')));
      const retry = el('button', 'text-btn', t('network.retry'));
      retry.type = 'button';
      retry.onclick = () => loadFolders(account, true);
      box.appendChild(retry);
    } else box.appendChild(el('p', 'inline-status reading', t('folders.loading')));
    placePopover(folderSheet);
    return;
  }
  const q = folderPick.filter.trim().toLowerCase();
  const shown = q ? folders.filter((f) => f.selectable && (folderName(account, f.path).toLowerCase().indexOf(q) !== -1 || f.path.toLowerCase().indexOf(q) !== -1)) : folders;
  if (!shown.length) box.appendChild(el('p', 'inline-status', t('folders.none')));
  const current = liveView && liveView.mode === 'folder' && liveView.account === account ? liveView.folder : null;
  // The folders every mailbox has stand at the top, unindented, wherever the server keeps them.
  const depth = (f) => (f.role ? 0 : Math.min(f.depth, 4));
  for (const f of shown) {
    if (!f.selectable) {
      // A folder that holds only folders: its name, so what is under it reads as under it; none
      // when all it holds are the ones at the top (Gmail's [Gmail]).
      const prefix = f.path + (f.delimiter || '/');
      if (!folders.some((other) => !other.role && other.path.indexOf(prefix) === 0)) continue;
      const label = el('div', 'folder-group', f.name);
      label.style.setProperty('--depth', String(depth(f)));
      box.appendChild(label);
      continue;
    }
    const b = el('button', 'choice folder-choice' + (f.path === current ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    if (f.path === current) b.setAttribute('aria-current', 'true');
    if (!q) b.style.setProperty('--depth', String(depth(f)));
    const name = el('span', 'folder-name', folderName(account, f.path));
    if (q && f.depth && !f.role) name.appendChild(el('small', null, f.parent || ''));
    b.appendChild(name);
    const count = f.unseen ? fill('folders.unread', { count: f.unseen.toLocaleString(lang) })
      : f.messages ? f.messages.toLocaleString(lang) : '';
    if (count) b.appendChild(el('span', 'choice-when' + (f.unseen ? ' unseen' : ''), count));
    b.onclick = () => pickFolder(account, f.path);
    box.appendChild(b);
  }
  placePopover(folderSheet);
}
function pickFolder(account, path) {
  closePopover(folderSheet, false);
  // A panel that took a step of the history gives it back before the folder takes one of its own.
  afterBack(() => openLive({ mode: 'folder', account, folder: path }, liveView ? 'replace' : 'push'));
}

// ---- Searching the mailbox itself ----
// Under the search field, while there is a query: the store searched as
// before, and a quiet offer to ask the mailbox, for mail mailsift never kept.
function renderMailboxSearch() {
  const box = $('#mailbox-search');
  const q = filters.q.value.trim();
  const accounts = summaryAccounts();
  const chosen = filters.account.value ? accounts.filter((a) => a.address === filters.account.value) : accounts;
  const show = !liveView && q.length >= 2 && chosen.length > 0;
  box.hidden = !show;
  if (!show) { box.replaceChildren(); box.dataset.said = ''; return; }
  const said = [lang, q, chosen.map((a) => a.address).join()].join('|');
  if (box.dataset.said === said) return;
  box.dataset.said = said;
  box.replaceChildren();
  const go = (address) => openLive({ mode: 'search', account: address, folder: null, q }, 'push');
  if (chosen.length === 1) {
    const b = el('button', 'text-btn mailbox-search-go');
    b.type = 'button';
    b.dataset.focus = 'mailbox-search';
    b.appendChild(icon('i-search'));
    b.appendChild(el('span', null, fill('live.searchMailbox', { name: chosen[0].name })));
    b.onclick = () => go(chosen[0].address);
    box.appendChild(b);
    return;
  }
  box.appendChild(el('span', 'mailbox-search-label', t('live.searchMailboxIn')));
  for (const a of chosen) {
    const b = el('button', 'text-btn mailbox-search-go', a.name);
    b.type = 'button';
    b.dataset.focus = 'mailbox-search-' + a.address;
    b.onclick = () => go(a.address);
    box.appendChild(b);
  }
}
// The field's Enter in a live view: a search of that folder, or of the same
// place again with other words; nothing at all goes back to the folder.
function runLiveQuery(value) {
  if (!liveView) return;
  const q = String(value || '').trim();
  const view = liveView;
  if (!q) {
    if (view.mode === 'search' && view.folder) openLive({ mode: 'folder', account: view.account, folder: view.folder }, 'replace');
    else if (view.mode === 'search') exitLive(false);
    return;
  }
  if (view.mode === 'search' && view.q === q) { liveLoad(true); return; }
  openLive({ mode: 'search', account: view.account, folder: view.folder, q }, 'replace');
}

// ---- The address and the history ----
// Read from the address once the rest of the page has started.
let bootLive = null;
function readLiveUrl(p) {
  const account = p.get('in');
  if (!account) return;
  const q = p.get('mq') || '';
  bootLive = { mode: q ? 'search' : 'folder', account, folder: p.get('folder') || (q ? null : 'INBOX'), q };
}
function writeLiveUrl(p) {
  if (!liveView) return;
  p.delete('q');
  p.set('in', liveView.account);
  if (liveView.folder) p.set('folder', liveView.folder);
  if (liveView.mode === 'search') p.set('mq', liveView.q);
}
// Back from a live view lands on the triaged one; forward onto a live view opens it again.
function liveFromHistory() {
  const wanted = history.state && history.state.live;
  if (!wanted && liveView) exitLive(true);
  else if (wanted && !sameLive(wanted, liveState())) openLive(wanted, 'restore');
}
`;
}
