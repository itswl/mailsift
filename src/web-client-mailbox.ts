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
// plain: its own name alone, where the parent is shown beside it already (the folder panel).
function folderName(account, path, plain) {
  if (!path) return t('live.defaultFolders');
  const info = folderInfo(account, path);
  const role = info ? info.role : (String(path).toUpperCase() === 'INBOX' ? 'inbox' : null);
  if (role && STRINGS[lang]['folder.' + role]) return t('folder.' + role);
  if (!info) return String(path);
  if (plain) return info.name;
  // Two folders of the same name (Projects/2026, Travel/2026) are told apart by what they are in.
  const known = (folderLists.get(account) || {}).folders || [];
  const twin = info.parent && known.some((f) => f.path !== info.path && String(f.name).toLowerCase() === String(info.name).toLowerCase());
  return twin ? String(info.parent).split(info.delimiter || '/').pop() + ' / ' + info.name : info.name;
}
function folderRoleOf(account, path) {
  const info = folderInfo(account, path);
  return info ? info.role : (String(path || '').toUpperCase() === 'INBOX' ? 'inbox' : null);
}
// What the page knows about a message listed live, in the shape of a row of
// the triaged list. It is known by its handle, one per message and place:
// two messages that share a Message-ID are two rows. One that mailsift stored
// carries the stored record's key as storedKey, for what is the queue's
// (done, later, the judgement), which the server matched to this very message.
function liveRow(item, account) {
  const s = item.stored || {};
  return {
    dedupKey: item.handle, handle: item.handle, storedKey: item.key || null, live: true, stored: Boolean(item.key),
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
  // Opened from the address (a reload, a shared link, the installed app coming back): the history is
  // made as if it had been opened from the triaged view, so Back and closing a sheet stay in mailsift.
  // A reload, or the installed app restored, finds its entry already holding this view: nothing is added.
  if (how === 'boot' && history.state && history.state.live && sameLive(history.state.live, view)) how = 'restore';
  if (how === 'boot') {
    const p = new URLSearchParams(location.search);
    for (const name of ['in', 'folder', 'mq']) p.delete(name);
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : ''));
    how = 'push';
  }
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
  else { syncUrl(); renderTokens(); updateAsk(); renderList(); }
  wordPlaceholders();
}
$('#live-back').onclick = () => exitLive(false);

// gone: what the owner's own batch took out of the folder (a move still under way when it answered). Only
// for those does a reader on a desk move on to the next message. Any other reading of the list from the top
// (the refresh, the same search again, a page read again) keeps the open message open, with its bar.
async function liveLoad(reset, gone) {
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
  if (view.mode === 'search') { p.set('q', view.q); p.set('tab', tabId()); }
  if (!reset && view.next) p.set('before', view.next);
  p.set('limit', String(LIVE_PAGE));
  // What was listed before the list was read again from the top, and the message open in the reader then.
  let listedBefore = null, keep = [];
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
    if (reset) {
      listedBefore = visibleKeys();
      keep = [selectedKey, openKey].filter((k, i, all) => k && all.indexOf(k) === i && liveRows.has(k)).map((k) => [k, liveRows.get(k)]);
      liveRows.clear();
      view.items = [];
    }
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
      // The open message, when the list read again does not reach it (it was past the first page, say), stays open,
      // as one opened from a link does, until the server says it moved. Unless the owner's own batch took it out:
      // then on to the next, as when that is known at once (see dropLive).
      const out = new Set(gone ? Array.from(gone).filter((k) => !liveRows.has(k)) : []);
      for (const [k, row] of keep) if (!liveRows.has(k) && !out.has(k)) extraRows.set(k, row);
      if (listedBefore && out.size) moveOnFrom(listedBefore, out);
      renderPane();
      renderBars();
    }
  }
}

// This tab's name, so a newer search takes the place only of this tab's own.
function tabId() {
  try {
    let id = sessionStorage.getItem('tab');
    if (!id) { id = 't' + Math.random().toString(36).slice(2, 12); sessionStorage.setItem('tab', id); }
    return id;
  } catch (e) { return 'page'; }
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
  if (view.limited) {
    // One folder searched (a folder's own search, or Gmail's All Mail) is said as one.
    const one = Boolean(view.folder) || (Array.isArray(view.folders) && view.folders.length === 1);
    note.appendChild(el('p', 'live-limit', fill(one ? 'live.limitedOne' : 'live.limited', { count: Number(view.limited.scanned || 0).toLocaleString(lang) })));
  }
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
  // A search that could read only recent subjects and senders does not say that nothing matches.
  // The line above already says how little was read; this says only that none of it matched.
  box.appendChild(el('p', null, t(view.mode === 'search' ? (view.limited ? 'live.noneFoundLimited' : 'live.noneFound') : 'live.emptyFolder')));
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
      : cached('live-empty', [lang, view.mode, view.failed ? view.failed.code || 'net' : '', view.limited ? view.limited.scanned : ''].join('|'), liveEmpty));
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
// After an action took messages out of the folder on show (moved, archived,
// binned), they leave the list. One open on a desk gives the reader to the
// next message still listed, or the reader is emptied.
function dropLive(keys) {
  if (!liveView) return;
  const gone = new Set(Array.isArray(keys) ? keys : [keys]);
  const before = visibleKeys();
  for (const key of gone) {
    const row = liveRows.get(key);
    liveRows.delete(key);
    // The open message held on to over a reading of the list it was not on (see liveLoad) goes too.
    if (extraRows.has(key) && extraRows.get(key).live) extraRows.delete(key);
    if (row && typeof liveView.total === 'number') liveView.total = Math.max(0, liveView.total - 1);
  }
  liveView.items = liveView.items.filter((m) => !gone.has(rowKey(m)));
  renderLiveHead();
  moveOnFrom(before, gone);
}
// The message open on a desk is no longer listed: the reader goes to the next one that is (or the
// one before, at the end), or is emptied, and its bar with it. before: the keys listed until now.
function moveOnFrom(before, gone) {
  const left = (key) => !(gone && gone.has(key)) && Boolean(findItem(key));
  if (!isWide() || !selectedKey || left(selectedKey)) return;
  const at = before.indexOf(selectedKey);
  const after = (at === -1 ? [] : before.slice(at + 1).concat(before.slice(0, at).reverse())).find(left);
  if (after) openDetail(after); else clearSelection();
}
// A row of the live view on show: listed, or the open message held on to over a reading of the list it was not on.
function liveShown(key) {
  if (!liveView) return null;
  const held = extraRows.get(key);
  return liveRows.get(key) || (held && held.live ? held : null);
}
// A message the server says is no longer where its folder listed it (moved or deleted elsewhere): put down,
// never swapped for another one the owner did not choose, and the folder listed again.
function forgetStale(key) {
  liveRows.delete(key);
  extraRows.delete(key);
  if (selectedKey === key || openKey === key) {
    if (sheet.open) closeSheet(sheet, false);
    clearSelection();
  }
  liveLoad(true);
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
  if (folderSheet.parentNode !== document.body) document.body.appendChild(folderSheet);
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
  $('#folder-title').textContent = t(folderPick.move ? 'folders.moveTitle' : 'folders.title');
  const accounts = summaryAccounts();
  // A move stays in its mailbox: no other mailbox is offered.
  if (accounts.length > 1 && !folderPick.move) {
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
  const move = folderPick.move;
  const named = (f) => folderName(account, f.path).toLowerCase().indexOf(q) !== -1 || f.path.toLowerCase().indexOf(q) !== -1;
  // Asked where to move to, the folder it is in is not a choice, and the ones moved to lately come first.
  let shown = (q ? folders.filter((f) => f.selectable && named(f)) : folders).filter((f) => !move || f.path !== move.current);
  if (move && !q) {
    const lately = recentMoves(account).map((path) => shown.find((f) => f.path === path && f.selectable)).filter(Boolean);
    if (lately.length) {
      box.appendChild(el('div', 'folder-group', t('folders.recent')));
      for (const f of lately) box.appendChild(folderChoice(account, f, null, true));
      box.appendChild(el('div', 'folder-group', t('folders.all')));
    }
  }
  if (!shown.length) box.appendChild(el('p', 'inline-status', t('folders.none')));
  const current = !move && liveView && liveView.mode === 'folder' && liveView.account === account ? liveView.folder : null;
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
    box.appendChild(folderChoice(account, f, current, Boolean(q)));
  }
  placePopover(folderSheet);
}
// One folder of the panel: its name, its count, and what choosing it does (open it, or move there).
function folderChoice(account, f, current, flat) {
  const b = el('button', 'choice folder-choice' + (f.path === current ? ' on' : ''));
  b.type = 'button';
  b.setAttribute('role', 'listitem');
  if (f.path === current) b.setAttribute('aria-current', 'true');
  if (!flat) b.style.setProperty('--depth', String(f.role ? 0 : Math.min(f.depth, 4)));
  // The panel shows where a folder is (indented under its parent, or with it in small type), so its own name is enough here.
  const name = el('span', 'folder-name', folderName(account, f.path, true));
  if (flat && f.depth && !f.role) name.appendChild(el('small', null, f.parent || ''));
  b.appendChild(name);
  const count = f.unseen ? fill('folders.unread', { count: f.unseen.toLocaleString(lang) })
    : f.messages ? f.messages.toLocaleString(lang) : '';
  if (count && !folderPick.move) b.appendChild(el('span', 'choice-when' + (f.unseen ? ' unseen' : ''), count));
  b.onclick = () => {
    const move = folderPick.move;
    if (!move) { pickFolder(account, f.path); return; }
    closePopover(folderSheet, false);
    rememberMove(account, f.path);
    move.run(f.path);
  };
  return b;
}
function pickFolder(account, path) {
  closePopover(folderSheet, false);
  // A panel that took a step of the history gives it back before the folder takes one of its own.
  afterBack(() => openLive({ mode: 'folder', account, folder: path }, liveView ? 'replace' : 'push'));
}

// ---- Searching the mailbox itself ----
// Under the search field, while there is a query: the store searched as
// before, and a quiet offer to ask the mailbox, for mail mailsift never kept.
// The offer at the end of what the store found: drawn with the list, so it
// moves nothing as the query is typed, and found where a search runs out.
function mailboxOffer() {
  const q = filters.q.value.trim();
  const accounts = summaryAccounts();
  const chosen = filters.account.value ? accounts.filter((a) => a.address === filters.account.value) : accounts;
  if (liveView || q.length < 2 || !chosen.length) return null;
  return cached('mailbox-offer', [lang, q, chosen.map((a) => a.address).join()].join('|'), () => {
    const box = el('div', 'mailbox-search');
    const go = (address) => openLive({ mode: 'search', account: address, folder: null, q }, 'push');
    if (chosen.length === 1) {
      const b = el('button', 'text-btn mailbox-search-go');
      b.type = 'button';
      b.dataset.focus = 'mailbox-search';
      b.appendChild(icon('i-search'));
      b.appendChild(el('span', null, t('live.searchMailbox')));
      b.onclick = () => go(chosen[0].address);
      box.appendChild(b);
      return box;
    }
    box.appendChild(el('span', 'mailbox-search-label', t('live.searchMailboxIn')));
    for (const a of chosen) {
      const b = el('button', 'text-btn mailbox-search-go', a.name);
      b.type = 'button';
      b.dataset.focus = 'mailbox-search-' + a.address;
      b.onclick = () => go(a.address);
      box.appendChild(b);
    }
    return box;
  });
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

// ---- Many messages at once ----
// What is picked, by key, in any list: the triaged one, a folder, a search.
// On a desk a box appears beside a row under the pointer or the keyboard,
// and Shift picks the rows between; on a phone a long press starts picking,
// and taps then pick. A bar takes the controls' place while anything is.
const picked = new Set();
let pickAnchor = null, bulkBusy = false;
// The keys between two rows of a list, both included, in the list's order: what Shift picks.
function pickRange(keys, from, to) {
  const a = keys.indexOf(from), b = keys.indexOf(to);
  if (a === -1 || b === -1) return [to];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}
function togglePick(key, range) {
  const on = !picked.has(key);
  const keys = range && pickAnchor ? pickRange(visibleKeys(), pickAnchor, key) : [key];
  for (const k of keys) { if (on) picked.add(k); else picked.delete(k); }
  pickAnchor = key;
  pickChanged();
}
function clearPicks(viaHistory) {
  if (!picked.size) return;
  picked.clear();
  pickAnchor = null;
  if (!viaHistory && history.state && history.state.picking) oweBack();
  pickChanged();
}
function pickChanged() {
  const was = document.body.classList.contains('picking');
  const on = picked.size > 0;
  // On a phone Back puts the selection down before it leaves anything else.
  if (on && !was && !isWide()) history.pushState(Object.assign({ picking: true, depth: sheetStack.length }, liveView ? { live: liveState() } : {}), '', location.href);
  document.body.classList.toggle('picking', on);
  if (!on && popovers.has(bulkSheet)) closePopover(bulkSheet, false);
  markPicked();
  renderPickBar();
}
// The boxes of the rows on the page, as what is picked says; a picked row no longer listed is let go.
function markPicked() {
  const shown = new Set();
  for (const li of document.querySelectorAll('#queue li.row, #list li.row')) {
    const on = picked.has(li.dataset.key);
    shown.add(li.dataset.key);
    li.classList.toggle('picked', on);
    const box = li.querySelector('.pick-box');
    if (box) box.setAttribute('aria-checked', String(on));
  }
  for (const key of Array.from(picked)) if (!shown.has(key)) picked.delete(key);
  if (!picked.size && document.body.classList.contains('picking')) { document.body.classList.remove('picking'); renderPickBar(); }
}
function pickBox(key, name) {
  const box = el('button', 'pick-box');
  box.type = 'button';
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', String(picked.has(key)));
  box.setAttribute('aria-label', fill('pick.one', { name }));
  box.appendChild(icon('i-check'));
  box.onclick = (e) => { e.preventDefault(); e.stopPropagation(); togglePick(key, e.shiftKey); };
  return box;
}
// A long press on a phone starts picking; the lift that ends it is not a tap.
function enablePick(li, key) {
  let timer = null, x0 = 0, y0 = 0, touched = false;
  const stop = () => { clearTimeout(timer); timer = null; };
  li.addEventListener('pointerdown', (e) => {
    touched = e.pointerType !== 'mouse';
    if (e.pointerType === 'mouse' || isWide() || picked.size || e.target.closest('.code-copy, .ring, .mark')) return;
    x0 = e.clientX; y0 = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      if (navigator.vibrate) navigator.vibrate(10);
      const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };
      li.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => li.removeEventListener('click', swallow, { capture: true }), 600);
      togglePick(key, false);
    }, 480);
  });
  li.addEventListener('pointermove', (e) => { if (timer && (Math.abs(e.clientX - x0) > 8 || Math.abs(e.clientY - y0) > 8)) stop(); });
  li.addEventListener('pointerup', stop);
  li.addEventListener('pointercancel', stop);
  // A long press is the way in to picking; a right click is still a right click.
  li.addEventListener('contextmenu', (e) => { if (touched && !isWide()) e.preventDefault(); });
}
// Whether every row has its star, as the page last heard.
function allStarred(rows) {
  return rows.length > 0 && rows.every((m) => Boolean((flagsByKey.get(rowKey(m)) || m.flags || {}).flagged));
}
// The rows picked, as the page knows them.
function pickedRows() {
  return Array.from(picked).map((key) => rowByKey(key) || (findItem(key) && rowOfItem(findItem(key)))).filter(Boolean);
}
// What applies to what is picked: only what at least one of them can take.
function bulkChoices(rows) {
  const stored = rows.filter((m) => !m.live || m.stored);
  const out = [];
  if (stored.length) out.push(stored.every((m) => m.handledAt) ? 'not_done' : 'done');
  if (!rows.every((m) => liveIn(m, 'archive') || liveIn(m, 'all'))) out.push('archive');
  if (!rows.every((m) => liveIn(m, 'trash'))) out.push('trash');
  out.push('mark_read', 'mark_unread', 'star', 'unstar');
  if (new Set(rows.map((m) => m.account)).size === 1) out.push('move');
  // One's own mail is not spam: what is in Sent or Drafts is not offered it.
  if (rows.some((m) => !m.inSpam && !liveIn(m, 'sent') && !liveIn(m, 'drafts'))) out.push('spam');
  if (rows.some((m) => m.inSpam)) out.push('not_spam');
  if (stored.some((m) => !m.handledAt)) out.push('snooze');
  return out;
}
const BULK_GLYPHS = {
  done: 'i-check', not_done: 'i-check', archive: 'i-archive', trash: 'i-trash', mark_read: 'i-read', mark_unread: 'i-read',
  star: 'i-star', unstar: 'i-star', move: 'i-folder', spam: 'i-alert', not_spam: 'i-inbox', snooze: 'i-clock',
};
const BULK_WORDS = {
  done: 'act.done', not_done: 'act.undone', archive: 'act.archive', trash: 'act.trash', mark_read: 'act.markRead',
  mark_unread: 'act.markUnread', star: 'act.star', unstar: 'act.unstar', move: 'act.moveTo', spam: 'act.spam',
  not_spam: 'act.notSpam', snooze: 'act.snooze',
};
// Shown in the bar itself; the rest are under "more".
const BULK_IN_BAR = ['done', 'not_done', 'archive', 'trash'];
function renderPickBar() {
  const bar = $('#pick-bar');
  bar.hidden = !picked.size;
  if (!picked.size) return;
  const rows = pickedRows();
  $('#pick-count').textContent = fill('pick.count', { count: picked.size });
  const all = $('#pick-all');
  all.hidden = visibleKeys().every((key) => picked.has(key));
  const actions = $('#pick-actions');
  actions.replaceChildren();
  const choices = bulkChoices(rows);
  for (const action of choices.filter((a) => BULK_IN_BAR.includes(a))) {
    const b = barButton(BULK_GLYPHS[action], t(BULK_WORDS[action]), () => bulkAction(action), (action === 'done' ? 'primary' : 'icon-only') + (action === 'not_done' ? ' on' : ''));
    b.dataset.act = 'bulk-' + action;
    b.disabled = bulkBusy;
    actions.appendChild(b);
  }
  const more = barButton('i-more', t('act.more'), () => openBulkMenu(more), 'icon-only');
  more.dataset.act = 'bulk-more';
  more.disabled = bulkBusy;
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-expanded', String(bulkSheet.open));
  actions.appendChild(more);
  for (const p of popovers.values()) anchorOf(p);
}
$('#pick-clear').onclick = () => clearPicks(false);
$('#pick-all').onclick = () => { for (const key of visibleKeys()) picked.add(key); pickChanged(); };
function openBulkMenu(anchor) {
  if (bulkSheet.open) { closePopover(bulkSheet, false); return; }
  const body = bulkSheet.querySelector('.sheet-body');
  body.replaceChildren();
  // On a phone there is no room for Select all in the bar: it is the first thing here.
  if (!isWide() && !visibleKeys().every((key) => picked.has(key))) {
    const all = el('button', 'menu-item');
    all.type = 'button';
    all.appendChild(icon('i-check'));
    all.appendChild(el('span', null, t('pick.all')));
    all.onclick = () => { closePopover(bulkSheet, false); for (const key of visibleKeys()) picked.add(key); pickChanged(); };
    body.appendChild(all);
  }
  for (const action of bulkChoices(pickedRows()).filter((a) => !BULK_IN_BAR.includes(a))) {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.dataset.focus = 'bulk-' + action;
    b.appendChild(icon(BULK_GLYPHS[action]));
    b.appendChild(el('span', null, t(BULK_WORDS[action])));
    b.onclick = () => {
      closePopover(bulkSheet, false);
      const where = $('#pick-actions [data-act="bulk-more"]') || anchor;
      if (action === 'move') afterBack(() => moveBulk(where));
      else if (action === 'snooze') afterBack(() => openBulkSnooze(where));
      else bulkAction(action);
    };
    body.appendChild(b);
  }
  openPopover(bulkSheet, anchor, { width: 260, fixed: true, history: !isWide() });
}
function moveBulk(anchor) {
  const rows = pickedRows();
  const accounts = new Set(rows.map((m) => m.account));
  if (accounts.size !== 1) { toast(t('bulk.oneMailbox'), true); return; }
  const folders = new Set(rows.map((m) => m.folder));
  openMovePicker(rows[0].account, folders.size === 1 ? rows[0].folder : null, anchor, (path) => bulkAction('move', { destination: path }));
}
function openBulkSnooze(anchor) {
  if (session.canMark === false) { requireWrite(); return; }
  snoozeKey = null;
  drawSnooze(null, (at) => bulkAction('snooze', { until: at === 'now' ? 'now' : at.toISOString() }));
  if (snoozeSheet.parentNode !== document.body) document.body.appendChild(snoozeSheet);
  openPopover(snoozeSheet, anchor, { width: 320, fixed: true, history: !isWide() });
}
// A name for one press, so that a second press of the same button, or the
// same request sent again, does what the first did and no more.
function bulkId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'b' + Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
}
async function bulkAction(action, extra) {
  const queue = action === 'done' || action === 'not_done' || action === 'snooze';
  if (queue ? session.canMark === false : !session.writable) { requireWrite(); return; }
  if (bulkBusy || !picked.size) return;
  const rows = pickedRows();
  if (!rows.length) return;
  // The queue's books are kept by the stored record a row is; the mailbox is reached where each was listed.
  const refs = new Map(rows.map((m) => [queue ? queueKey(m) : mailRef(m), rowKey(m)]));
  const pressed = new Set(rows.map(rowKey));
  // Where each was listed, before anything the answer says moves it.
  const listedIn = new Map(rows.map((m) => [rowKey(m), m.folder]));
  // What each had, by the name it is sent under, for an Undo that puts back exactly that.
  const before = new Map(rows.map((m) => [queue ? queueKey(m) : mailRef(m), { handledAt: m.handledAt || null, snoozedUntil: m.snoozedUntil || null }]));
  bulkBusy = true;
  renderPickBar();
  const r = await post('/api/bulk', Object.assign({ items: Array.from(refs.keys()), action, id: bulkId() }, extra || {}));
  bulkBusy = false;
  if (!r.ok) { if (picked.size) renderPickBar(); toast(r.data && (r.data.code || r.data.error) ? failure(r.data) : t('act.failed'), true); return; }
  // done: the rows the press changed; doneRefs: the names they were sent under, which an Undo sends back.
  const done = [], doneRefs = [], dropped = [];
  for (const result of r.data.results || []) {
    const key = refs.get(result.key);
    if (!key) continue;
    if (result.row) applyRow(result.row);
    if (result.status !== 'done') continue;
    done.push(key);
    doneRefs.push(result.key);
    liveData.delete(key);
    const flags = Object.assign({}, flagsByKey.get(key) || {});
    if (action === 'star' || action === 'unstar') flags.flagged = action === 'star';
    if (action === 'mark_read' || action === 'mark_unread') flags.seen = action === 'mark_read';
    flagsByKey.set(key, flags);
    const shown = liveShown(key);
    if (shown) {
      shown.flags = Object.assign({}, shown.flags || {}, flags);
      if (result.moved && result.moved.folder !== listedIn.get(key)) dropped.push(key);
    }
  }
  if (dropped.length) dropLive(dropped);
  if (typeof r.data.attention === 'number') attentionCount = r.data.attention;
  // What this press acted on is put down; anything picked since stays picked.
  let changed = false;
  for (const key of pressed) if (picked.delete(key)) changed = true;
  if (changed) {
    if (!picked.size) { pickAnchor = null; if (history.state && history.state.picking) oweBack(); }
    pickChanged();
  } else if (picked.size) renderPickBar();
  if (queue) loadAttention();
  renderList();
  renderLede();
  renderBars();
  updateBadge();
  // Some were still under way when the answer came: the list is read again once they will have landed.
  // Those this press moved are gone from it by the owner's own doing (see liveLoad).
  if (r.data.pending) {
    const moving = ['archive', 'trash', 'move', 'spam', 'not_spam', 'inbox'].includes(action);
    const underWay = new Set((r.data.results || []).filter((result) => moving && result.status === 'pending' && refs.has(result.key)).map((result) => refs.get(result.key)));
    setTimeout(() => { if (liveView) liveLoad(true, underWay); else refresh(); }, 5000);
  }
  // What happened, in one line, with the one way back where a single message has one.
  const said = [];
  if (done.length) {
    said.push(fill('bulk.' + action, {
      count: done.length, folder: extra && extra.destination ? folderName(rows[0].account, extra.destination) : '',
      when: action === 'snooze' && extra && extra.until && extra.until !== 'now' ? whenLabel(new Date(extra.until), new Date(), true) : '',
    }));
  }
  if (r.data.skipped) said.push(fill('bulk.skipped', { count: r.data.skipped }));
  if (r.data.pending) said.push(fill('bulk.pending', { count: r.data.pending }));
  const failures = (r.data.results || []).filter((result) => result.status === 'failed');
  if (failures.length) {
    // Nothing went, and all for one reason: that reason, in the page's own words.
    const one = failures.every((f) => f.code && f.code === failures[0].code) ? failures[0] : null;
    said.push(!done.length && one && STRINGS[lang]['error.' + one.code] ? failure({ code: one.code }) : fill('bulk.failed', { count: failures.length }));
  }
  const muted = mutedLine(r.data.muted);
  if (muted) said.push(muted);
  let undo = null;
  if (doneRefs.length && action === 'done') undo = { label: t('undo'), run: () => bulkUndo('not_done', doneRefs) };
  if (doneRefs.length && action === 'snooze') undo = { label: t('undo'), run: () => undoBulkSnooze(doneRefs, before) };
  toast(said.join(DOT), Boolean(!done.length && failures.length), undo);
}
// Senders a vote just made low priority, said in a line that stays short: one or two by name, more by how many.
function mutedLine(muted) {
  if (!Array.isArray(muted) || !muted.length) return '';
  if (muted.length > 2) return fill('fb.ruleNeverSome', { count: muted.length.toLocaleString(lang) });
  return fill('fb.ruleNever', { sender: muted.join(t('list.and')) });
}
// Undo: what the press did, sent back the other way under the names it was sent by. Nothing is
// looked up again, so it undoes the whole batch whatever the page has loaded, or left, since.
async function bulkUndo(action, items, extra) {
  const r = await post('/api/bulk', Object.assign({ items, action, id: bulkId() }, extra || {}));
  if (!r.ok) { toast(r.data && (r.data.code || r.data.error) ? failure(r.data) : t('act.failed'), true); return; }
  for (const result of r.data.results || []) if (result.row) applyRow(result.row);
  if (typeof r.data.attention === 'number') attentionCount = r.data.attention;
  loadAttention();
  renderList();
  renderLede();
  renderBars();
  updateBadge();
}
// Each message back to the reminder it had: none, the time it had while that is to come, or back now.
async function undoBulkSnooze(refs, before) {
  const groups = new Map();
  for (const ref of refs) {
    const to = snoozeUndoTo((before.get(ref) || {}).snoozedUntil || null);
    const until = to === null ? null : to === 'now' ? 'now' : to.toISOString();
    const group = groups.get(String(until)) || { until, refs: [] };
    group.refs.push(ref);
    groups.set(String(until), group);
  }
  for (const group of groups.values()) await bulkUndo('snooze', group.refs, { until: group.until });
}

// ---- Moving to any folder ----
// The folder panel, asked where to: the folders moved to lately first, the
// one the message is in left out, and the rest as the mailbox lists them.
function recentMoves(account) {
  try { const list = JSON.parse(readStorage('movedTo:' + account) || '[]'); return Array.isArray(list) ? list : []; } catch (e) { return []; }
}
function rememberMove(account, path) {
  writeStorage('movedTo:' + account, JSON.stringify([path].concat(recentMoves(account).filter((p) => p !== path)).slice(0, 5)));
}
function openMovePicker(account, current, anchor, run) {
  if (folderSheet.open) closePopover(folderSheet, false);
  if (!anchor) return;
  folderPick = { account, filter: '', move: { current, run } };
  // Inside the reader on a phone, whose sheet is modal and would leave anything outside it unreachable.
  const host = anchor.closest('dialog.sheet:not(.popover)') || document.body;
  if (folderSheet.parentNode !== host) host.appendChild(folderSheet);
  drawFolders();
  const r = anchor.getBoundingClientRect();
  openPopover(folderSheet, anchor, {
    width: 320, flip: true, history: !isWide(), fixed: Boolean(anchor.closest('#sheet, #pane, .app-header, .controls')),
    align: r.left + r.width / 2 < document.documentElement.clientWidth / 2 ? 'start' : 'end',
  });
  loadFolders(account);
}
`;
}
