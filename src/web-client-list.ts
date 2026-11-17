/**
 * The list part of the page script: rows, the queue of what needs the reader,
 * the stream of everything else, and how both are kept current.
 *
 * Two ideas shape it.
 *
 * The queue. A message that was judged to matter stays at the top, in a
 * section of its own, until the reader says it is dealt with: a tap on its
 * ring, a swipe to the right, or any action that files it away. The mark that
 * shows a row's importance is the control that completes it, so there is no
 * second button to find.
 *
 * Keeping place. The page hears of new mail the moment it is judged, so the
 * list changes while it is being read. It is therefore patched, not rebuilt:
 * a row whose content did not change is the same element as before, in the
 * same place, and what arrives is inserted around it. A swipe in progress, a
 * focused control and the reader's scroll position all survive an update.
 *
 * String.raw, so the script below is written as it runs: a backslash here is
 * a backslash in the browser. It must still hold no backtick and no dollar
 * sign followed by a brace.
 */
export function listPart(): string {
  return String.raw`
// ---- Deadlines, worded by how near they are ----
function dueInfo(deadline, now) {
  if (!deadline) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(deadline));
  // Not a date the page can count from: shown as the model wrote it.
  if (!m) return { text: t('detail.deadline') + ' ' + deadline, days: null, late: false };
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((day - today) / 86400000);
  let text;
  if (days === 0) text = t('due.today');
  else if (days === 1) text = t('due.tomorrow');
  else if (days === -1) text = t('due.overdue1');
  else if (days < 0) text = fill('due.overdue', { n: -days });
  else if (days <= 14) text = fill('due.in', { n: days });
  else {
    let label = m[0];
    try { label = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(day); } catch (e) {}
    text = fill('due.on', { date: label });
  }
  return { text, days, late: days <= 0 };
}

// ---- Later: when a message that is put off comes back ----
// Put off and still to come. One marked done after it was put off will not
// come back, so it does not count, and neither does one whose time is here.
function isSnoozed(m) {
  return Boolean(m && m.snoozedUntil && !m.handledAt && Date.parse(m.snoozedUntil) > Date.now());
}
// A reminder's time as the reader says it: the clock alone today, then
// tomorrow, then a weekday within the week, then the date. Within a sentence
// or a row's details English lowers "Tomorrow".
function whenLabel(d, now, inSentence) {
  const time = hhmm(d);
  if (dayKey(d) === dayKey(now)) return fill('when.today', { time });
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (dayKey(d) === dayKey(tomorrow)) return fill(inSentence ? 'when.tomorrowIn' : 'when.tomorrow', { time });
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - tomorrow) / 86400000) + 1;
  const near = days > 0 && days < 7;
  const options = near ? { weekday: 'short' } : { day: 'numeric', month: 'short' };
  // A weekday within the coming six days is plain without a year, even across
  // New Year ("2027 Mon" reads as a puzzle); a date in another year needs one.
  if (!near && d.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  let day = dayKey(d);
  try { day = new Intl.DateTimeFormat(lang, options).format(d); } catch (e) {}
  return fill('when.day', { day, time });
}
// The times a message can be put off until, from this moment on this
// device's clock, soonest first: three hours on to the next quarter hour,
// while the evening is still ahead and unless that is still night; seven in
// the evening, until five; nine in the morning; and nine on Monday, unless
// that is the morning already offered.
// Until five the night is not over, and the morning anyone means is the one
// to come: nine today, called this morning, rather than a day and a half on.
// A reminder before seven would wake the owner for something they put off.
function snoozeChoices(now) {
  const at = (days, hours) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hours, 0, 0, 0);
  const quarter = 15 * 60000;
  const later = new Date(Math.ceil((now.getTime() + 3 * 3600000) / quarter) * quarter);
  const evening = at(0, 19);
  const out = [];
  const minutes = now.getHours() * 60 + now.getMinutes();
  const offerEvening = minutes < 17 * 60;
  const smallHours = now.getHours() < 5;
  // Three hours on would be no sooner than the evening that is also offered.
  if (minutes < 20 * 60 && later.getHours() >= 7 && !(offerEvening && later >= evening)) out.push({ key: 'snooze.laterToday', at: later });
  if (offerEvening) out.push({ key: 'snooze.evening', at: evening });
  const morning = at(smallHours ? 0 : 1, 9);
  out.push({ key: smallHours ? 'snooze.morning' : 'snooze.tomorrow', at: morning });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = at(toMonday, 9);
  if (monday.getTime() !== morning.getTime()) out.push({ key: 'snooze.nextWeek', at: monday });
  return out.sort((a, b) => a.at - b.at);
}
// A moment as a datetime-local field holds it: this device's own time, to the minute.
function localInput(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ---- Rows ----
// What the reader searched for, marked where it occurs.
function highlightInto(node, value) {
  const s = String(value);
  const q = filters.q.value.trim().toLowerCase();
  const lower = s.toLowerCase();
  if (q.length < 2 || lower.length !== s.length || lower.indexOf(q) === -1) { node.textContent = s; return node; }
  let at = 0, i;
  while ((i = lower.indexOf(q, at)) !== -1) {
    if (i > at) node.appendChild(textNode(s.slice(at, i)));
    node.appendChild(el('mark', null, s.slice(i, i + q.length)));
    at = i + q.length;
  }
  if (at < s.length) node.appendChild(textNode(s.slice(at)));
  return node;
}
const needsYou = (m) => attentionSet.has(queueKey(m)) && !m.handledAt && !isSnoozed(m);
function metaLine(m, thread, now) {
  const meta = el('div', 'meta');
  const add = (value, cls) => {
    if (meta.childNodes.length) meta.appendChild(textNode(DOT));
    meta.appendChild(cls ? el('span', cls, value) : textNode(value));
  };
  if (thread) {
    // The reader's own messages count in the thread, and say so when theirs is the latest word.
    const total = thread.messageCount + (thread.sentCount || 0);
    if (total > 1) add(fill('thread.short', { count: total }), 'rescued');
    if (thread.lastWordYours) add(t('thread.youLast'));
    else if (thread.sentCount) add(fill('thread.yours', { count: thread.sentCount }));
  }
  if (level(m) !== 'info') add(word('level.', m.importance), 'lvl ' + level(m));
  if (m.category) add(word('category.', m.category));
  if (m.verificationCode) add(t('code.tag'));
  if (m.inSpam && !m.live) add(m.pushed ? t('row.rescued') : t('spam'), m.pushed ? 'rescued' : null);
  else if (m.pushed) add(t('notified'));
  else if (m.withheld) add(t('row.withheld'));
  const due = dueInfo(m.deadline, now);
  // A deadline on something already dealt with is a fact, not a call to act.
  if (due) add(due.text, m.handledAt ? null : (due.late ? 'due late' : 'due'));
  // Listed live: what the mailbox says of it.
  if (m.live && m.flags && m.flags.flagged) add(t('live.starred'));
  if (m.live && m.flags && m.flags.answered) add(t('live.answered'));
  if (m.live && m.attachments) add(t('live.files'));
  // When it comes back, wherever a message that is put off is shown; and in
  // the queue, why a message that was not judged to matter is there.
  if (isSnoozed(m)) add(fill('snooze.meta', { when: whenLabel(new Date(m.snoozedUntil), now, true) }), 'whole');
  else if (m.snoozedUntil && needsYou(m)) add(t('snooze.woke'));
  return meta;
}
function ringButton(m) {
  const b = el('button', 'ring ' + level(m));
  b.type = 'button';
  b.title = t('queue.done');
  b.setAttribute('aria-label', t('queue.done'));
  b.appendChild(icon('i-check'));
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); complete(queueKey(m), b.closest('li.row')); };
  return b;
}
// The check on a row that was dealt with is the way back: pressing it says
// the message is not done after all.
function doneButton(m) {
  const b = el('button', 'mark done');
  b.type = 'button';
  b.title = t('queue.undone');
  b.setAttribute('aria-label', t('queue.undone'));
  b.setAttribute('aria-pressed', 'true');
  b.appendChild(icon('i-check'));
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); complete(queueKey(m), b.closest('li.row'), true); };
  return b;
}
// A message that is put off carries a clock where its ring was, here and in
// the list. Pressing it opens the times again, with a way to bring it back now.
function laterButton(m) {
  const b = el('button', 'mark later');
  b.type = 'button';
  b.dataset.act = 'snooze';
  b.title = t('act.snooze');
  b.setAttribute('aria-label', t('act.snooze'));
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-expanded', 'false');
  b.appendChild(icon('i-clock'));
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openSnooze(queueKey(m), b); };
  return b;
}
// A row of the queue is not under a day's heading, so its time says the day
// when that is not today.
function whenQueued(m, now) {
  const d = dateOf(m);
  if (isNaN(d) || dayKey(d) === dayKey(now)) return when(m, now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return t('day.yesterday');
  try { return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(d); } catch (e) { return hhmm(d); }
}
function rowOf(item, now, queued) {
  const thread = isThread(item) ? item : null;
  const m = rowOfItem(item);
  const key = keyOf(item);
  const li = el('li', 'row ' + level(m));
  li.dataset.key = key;
  if (needsYou(m)) {
    li.classList.add('needs');
    li.appendChild(ringButton(m));
    enableSwipe(li, queueKey(m));
  } else if (m.handledAt) {
    li.classList.add('handled');
    li.appendChild(doneButton(m));
  } else if (isSnoozed(m)) {
    li.classList.add('later');
    li.appendChild(laterButton(m));
  } else if (m.live) {
    // Listed live, the mark says whether it was read, as a mail client's does.
    const unseen = !(m.flags && m.flags.seen);
    li.appendChild(el('span', 'mark ' + (unseen ? 'unseen' : 'seen')));
  } else li.appendChild(el('span', 'mark ' + level(m)));
  if (m.live) li.classList.add('live');
  if (m.live && !(m.flags && m.flags.seen)) li.classList.add('unseen');
  const who = highlightInto(el('a', 'who'), m.senderName || m.sender || t('unknownSender'));
  who.href = '#m=' + encodeURIComponent(key);
  // While picking on a phone, a tap picks; on a desk a row still opens, and its box picks.
  who.onclick = (e) => { e.preventDefault(); if (picked.size && !isWide()) togglePick(key, false); else openDetail(key); };
  li.appendChild(pickBox(key, m.senderName || m.sender || t('unknownSender')));
  if (picked.has(key)) li.classList.add('picked');
  enablePick(li, key);
  if (key === selectedKey) { li.classList.add('selected'); who.setAttribute('aria-current', 'true'); }
  li.appendChild(who);
  li.appendChild(el('span', 'when', queued ? whenQueued(m, now) : when(m, now)));
  if (m.verificationCode) {
    li.classList.add('has-code');
    if (now - dateOf(m) > STALE_CODE_MS) li.classList.add('stale');
    li.appendChild(codeButton(m, 'code-copy'));
  } else {
    // A live row is the mailbox's: its subject, as a mail client shows it.
    const said = thread || m.live ? (m.subject || m.summary || t('noSubject')) : (m.summary || m.subject || t('noSubject'));
    li.appendChild(m.live ? el('div', 'sum', said) : highlightInto(el('div', 'sum'), said));
  }
  li.appendChild(metaLine(m, thread, now));
  if (m.reason) li.appendChild(el('div', 'why', m.reason));
  return li;
}
// Everything a row's look depends on. Two builds with the same signature
// would draw the same element, so the one already on the page is kept.
function rowSignature(item, now, queued) {
  const m = rowOfItem(item);
  return [
    lang, keyOf(item) === selectedKey ? 1 : 0, queued ? whenQueued(m, now) : when(m, now), m.handledAt || '', needsYou(m) ? 1 : 0,
    m.importance, m.pushed ? 1 : 0, m.withheld ? 1 : 0, m.inSpam ? 1 : 0, m.summary, m.subject, m.senderName, m.sender, m.category,
    m.reason, m.verificationCode || '', m.verificationCode && now - dateOf(m) > STALE_CODE_MS ? 1 : 0,
    m.deadline || '', m.deadline ? dayKey(now) : '', isThread(item) ? item.messageCount : 0, filters.q.value.trim(),
    isThread(item) ? (item.sentCount || 0) + ':' + (item.lastWordYours ? 1 : 0) : '',
    m.snoozedUntil || '', isSnoozed(m) ? dayKey(now) : '',
    m.live ? [m.flags && m.flags.seen ? 1 : 0, m.flags && m.flags.flagged ? 1 : 0, m.flags && m.flags.answered ? 1 : 0, m.attachments ? 1 : 0].join('') : '',
  ].join('\u0001');
}
function markSelected() {
  for (const li of document.querySelectorAll('#queue li.row, #list li.row')) {
    const on = li.dataset.key === selectedKey;
    li.classList.toggle('selected', on);
    const who = li.querySelector('.who');
    if (who) { if (on) who.setAttribute('aria-current', 'true'); else who.removeAttribute('aria-current'); }
  }
}

// ---- Dealing with a message: the ring, the swipe, and the way back ----
// Every copy of a row the page holds, wherever it is listed.
function eachCopy(key, touch) {
  const one = (m) => { if (m && rowKey(m) === key) touch(m); };
  for (const m of lastMail || []) one(m);
  for (const m of attention || []) one(m);
  for (const m of doneRecent) one(m);
  for (const m of snoozedRows) one(m);
  for (const th of lastThreads || []) { one(th.latest); for (const m of th.messages || []) one(m); }
  one(extraRows.get(key));
  // The same message listed live, or opened from a link by its handle, when the server matched it to this record: that row follows too.
  for (const m of liveRows.values()) if (m.storedKey === key || rowKey(m) === key) touch(m);
  for (const m of extraRows.values()) if (m.storedKey === key && rowKey(m) !== key) touch(m);
}
function markHandledLocal(key, at) {
  eachCopy(key, (m) => { m.handledAt = at; });
}
async function post(path, body, options) {
  try {
    const r = await fetch(path, Object.assign({
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }, options || {}));
    if (r.status === 401) { location.reload(); return { ok: false, status: 401, data: {} }; }
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: {} };
  }
}
// Optimistic: the row leaves at once and the server is told after. If it
// refuses, the row comes back and the page says so.
// Rows completed a moment ago, so that undoing puts one back at once even if
// the server's fresher queue, which no longer lists it, arrived in between.
const completed = new Map();
// What the server has been told and has not answered yet, by key: the time a
// row was marked done, or null for one being put back. A list fetched before
// the answer still shows the old state, and must not put it back on the page.
const pendingHandled = new Map();
function holdPending() {
  for (const [key, at] of pendingHandled) markHandledLocal(key, at);
}
// A row that is put back must not keep the look of one that is leaving: its
// fade ends at nothing, and the same element would be reused as it is.
function unfade(key) {
  for (const zone of ['q:', 's:', 'd:', 'z:']) nodeCache.delete(zone + key);
  for (const row of document.querySelectorAll('li.row.completing, li.row.leaving')) row.classList.remove('completing', 'leaving');
}
// Whether the reader is showing this message: by its own key, or as the
// latest message of the thread that is open.
function isOpenRow(key) {
  if (!openKey) return false;
  if (openKey === key) return true;
  const item = findItem(openKey);
  // Done and later name a live row by its stored record's key: that is the open row too.
  const row = item && rowOfItem(item);
  return Boolean(row && (rowKey(row) === key || queueKey(row) === key));
}
async function complete(key, li, undo) {
  // Where the server keeps this for the write session, say so before the row moves.
  if (session.canMark === false) { requireWrite(); return; }
  const handled = !undo;
  // A row completed a moment ago may be in no list any more (the queue was
  // fetched again without it); what was kept of it still says it is done.
  const wasHandled = Boolean((rowByKey(key) || completed.get(key) || {}).handledAt);
  if (handled === wasHandled) return;
  if (handled && attentionSet.has(key)) completed.set(key, queueCopy(rowByKey(key)));
  if (!handled && completed.has(key) && !attentionSet.has(key)) {
    attention = [completed.get(key)].concat(attention || []);
    attentionSet.add(key);
  }
  // One that was dealt with before this page was opened: the server said
  // whether it belongs in the queue, and that is where it goes back to.
  const earlier = doneRecent.find((m) => rowKey(m) === key);
  if (!handled && earlier && earlier.queued && !attentionSet.has(key)) {
    attention = [earlier].concat(attention || []);
    attentionSet.add(key);
  }
  // What is done now leads the list of what was dealt with lately.
  if (handled && !earlier) {
    const row = queueCopy(rowByKey(key));
    if (row) { row.queued = attentionSet.has(key); doneRecent = [row].concat(doneRecent); }
  }
  // Counted by what it does to the queue, which a row that is put off is not in either way.
  const inQueue = () => {
    const m = rowByKey(key) || completed.get(key);
    return Boolean(m && attentionSet.has(key) && !m.handledAt && !isSnoozed(m));
  };
  const apply = (on) => {
    const at = on ? new Date().toISOString() : null;
    const was = inQueue();
    markHandledLocal(key, at);
    const kept = completed.get(key);
    if (kept) kept.handledAt = at;
    attentionCount = Math.max(0, attentionCount + (inQueue() ? 1 : 0) - (was ? 1 : 0));
    if (!on) unfade(key);
    return at;
  };
  const asked = apply(handled);
  pendingHandled.set(key, asked);
  if (handled && li && !reduceMotion()) {
    // The ring fills, the row lets go, and only then does the list close up.
    li.classList.add('completing');
    setTimeout(renderList, 380);
  } else renderList();
  renderLede();
  renderBars();
  updateBadge();
  if (handled) {
    if (navigator.vibrate) navigator.vibrate(8);
    toast(t('done.toast'), false, { label: t('undo'), run: () => complete(key, null, true) });
    if (sheet.open && isOpenRow(key)) closeSheet(sheet, false);
  }
  const r = await post('/api/handled', { key, handled });
  // Only if nothing newer was asked of this row while the answer was on its way.
  if (pendingHandled.get(key) === asked) pendingHandled.delete(key);
  if (r.ok) {
    if (typeof r.data.attention === 'number') attentionCount = r.data.attention;
    renderLede();
    updateBadge();
    saveSnapshot();
    // A row put back is in the queue again only if the server says so.
    if (!handled) loadAttention();
    return;
  }
  apply(!handled);
  renderList();
  renderLede();
  renderBars();
  updateBadge();
  toast(t('act.failed'), true);
}
// A swipe to the right completes the row, on a touch screen. It starts only
// once the finger has clearly gone sideways, so scrolling is never taken for
// it, and not from the screen's edge, which belongs to the system's back.
function enableSwipe(li, key) {
  let x0 = 0, y0 = 0, dx = 0, tracking = false, swiping = false;
  li.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.clientX < 24 || picked.size || e.target.closest('.code-copy')) return;
    tracking = true; swiping = false; x0 = e.clientX; y0 = e.clientY; dx = 0;
  });
  li.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!swiping) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) > Math.abs(mx) || mx < 0) { tracking = false; return; }
      swiping = true;
      try { li.setPointerCapture(e.pointerId); } catch (err) {}
      li.classList.add('swiping');
    }
    dx = Math.max(0, mx);
    li.style.setProperty('--swipe', dx + 'px');
    li.classList.toggle('armed', dx > 88);
  });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!swiping) return;
    swiping = false;
    const armed = dx > 88;
    li.classList.remove('swiping', 'armed');
    li.style.removeProperty('--swipe');
    // The lift that ends a swipe is not a tap on the row.
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    li.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => li.removeEventListener('click', swallow, { capture: true }), 350);
    if (armed) complete(key, li);
  };
  li.addEventListener('pointerup', end);
  li.addEventListener('pointercancel', end);
}

// ---- Putting a message off: the times, and the way back ----
// The keys being put off or brought back that the server has not answered
// yet, each with what was asked of it, the time the page shows meanwhile,
// and whether it was brought back now. A list fetched before the answer
// still has the old time, and must not undo what was asked.
const pendingSnooze = new Map();
// Every copy of the row takes the new time. One brought back now is a
// reminder that has come, and is in the queue whatever it was judged, so it
// joins the queue here even before the server's list says so.
function snoozeLocal(key, until, woken) {
  eachCopy(key, (m) => { m.snoozedUntil = until; });
  const row = queueCopy(rowByKey(key));
  snoozedRows = snoozedRows.filter((m) => rowKey(m) !== key);
  if (!row) return;
  if (isSnoozed(row)) snoozedRows = snoozedRows.concat([row]);
  if (woken && attention && !attentionSet.has(key)) {
    attention = [row].concat(attention);
    attentionSet.add(key);
  }
}
function holdSnoozes() {
  for (const [key, asked] of pendingSnooze) snoozeLocal(key, asked.local, asked.woken);
}
// The panel of times, under the control that asked for it. It opens where
// that control is: inside the reader on a phone, whose sheet is modal and
// would leave anything outside it unreachable, and in the page elsewhere.
let snoozeKey = null;
function openSnooze(key, anchor) {
  if (session.canMark === false) { requireWrite(); return; }
  const row = rowByKey(key) || (findItem(key) && rowOfItem(findItem(key)));
  if (!row || !anchor) return;
  if (snoozeSheet.open) {
    const again = snoozeKey === key && popovers.has(snoozeSheet) && anchorOf(popovers.get(snoozeSheet)) === anchor;
    closePopover(snoozeSheet, false);
    if (again) return;
  }
  // A panel just closed by this same press still owes its step back, and a
  // panel that takes an entry of its own must open after it, or the step
  // back lands on the new entry and closes it at once.
  if ((backsOwed || backPending) && !isWide()) {
    afterBack(() => { if (anchor.isConnected && !snoozeSheet.open) showSnooze(row, anchor); });
    return;
  }
  showSnooze(row, anchor);
}
function showSnooze(row, anchor) {
  snoozeKey = rowKey(row);
  drawSnooze(row);
  const host = anchor.closest('dialog.sheet:not(.popover)') || document.body;
  if (snoozeSheet.parentNode !== host) host.appendChild(snoozeSheet);
  const r = anchor.getBoundingClientRect();
  openPopover(snoozeSheet, anchor, {
    width: 320, flip: true, history: !isWide(),
    fixed: Boolean(anchor.closest('#sheet, #pane, .app-header')),
    align: r.left + r.width / 2 < document.documentElement.clientWidth / 2 ? 'start' : 'end',
  });
}
// run: what a choice does, for the times offered to several messages at once (no row then).
function drawSnooze(row, run) {
  const body = snoozeSheet.querySelector('.sheet-body');
  const key = row ? rowKey(row) : null;
  const go = run || ((at) => snooze(key, at));
  const now = new Date();
  body.replaceChildren();
  // Put off already: when, and a way to have it back now.
  if (row && isSnoozed(row)) body.appendChild(el('p', 'sheet-text quiet snooze-now', fill('snooze.toast', { when: whenLabel(new Date(row.snoozedUntil), now, true) })));
  const choices = el('div', 'choices');
  const choice = (label, at, run) => {
    const b = el('button', 'choice');
    b.type = 'button';
    b.appendChild(el('span', null, label));
    if (at) b.appendChild(el('span', 'choice-when', whenLabel(at, now)));
    b.onclick = run;
    choices.appendChild(b);
    return b;
  };
  if (row && isSnoozed(row)) choice(t('snooze.now'), null, () => go('now'));
  for (const c of snoozeChoices(now)) choice(t(c.key), c.at, () => go(c.at));
  // Any other moment, on this device's own clock, still to come and within a year.
  const form = el('form', 'snooze-pick');
  form.hidden = true;
  form.noValidate = true;
  const input = el('input');
  input.type = 'datetime-local';
  input.required = true;
  input.setAttribute('aria-label', t('snooze.pick'));
  const latest = new Date(now.getTime() + 365 * 86400000);
  input.min = localInput(new Date(now.getTime() + 60000));
  input.max = localInput(latest);
  // The same morning the choices above call the next one: before five, the one to come today.
  input.value = localInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() < 5 ? 0 : 1), 9, 0, 0, 0));
  const set = el('button', 'text-btn strong', t('snooze.set'));
  set.type = 'submit';
  const note = el('p', 'snooze-note');
  note.setAttribute('role', 'status');
  form.appendChild(input);
  form.appendChild(set);
  form.appendChild(note);
  form.onsubmit = (e) => {
    e.preventDefault();
    const at = new Date(input.value);
    note.textContent = isNaN(at) || at <= new Date() ? t('snooze.past') : at > latest ? t('snooze.far') : '';
    if (!note.textContent) { if (run && popovers.has(snoozeSheet)) closePopover(snoozeSheet, false); go(at); }
  };
  const pick = choice(t('snooze.pick'), null, () => {
    pick.hidden = true;
    form.hidden = false;
    input.focus();
    placePopover(snoozeSheet);
  });
  body.appendChild(choices);
  body.appendChild(form);
}
// Where Undo takes a message whose reminder was just changed, from the time
// it had before: back to that time while it is still to come, and to no
// reminder if it had none. A time that has come, before or since, was a
// reminder that came (or would be one by now), and the way back to that is
// to bring the message back now: taking the reminder away instead would
// leave out of the queue a message that was there only because of it.
function snoozeUndoTo(before) {
  if (!before) return null;
  return Date.parse(before) > Date.now() + 1000 ? new Date(before) : 'now';
}
// After a choice in the panel: its control if it is still there, or the one
// drawn in its place; else the row, where it is still listed in the same
// list; else, when it has left that list, the row that took its place.
function refocusAfterSnooze(key, back, find) {
  const rowIn = (list, k) => (list && list.isConnected ? list.querySelector('li.row[data-key="' + CSS.escape(k) + '"]') : null);
  const li = document.querySelector('#queue li.row[data-key="' + CSS.escape(key) + '"], #list li.row[data-key="' + CSS.escape(key) + '"]');
  const list = li ? li.parentElement : null;
  const near = li && (li.nextElementSibling || li.previousElementSibling);
  const nearKey = near && near.dataset ? near.dataset.key : null;
  // Only in the list the row was in, or outside any list (the reader's bar):
  // the same message's copy in another list may be a screen away.
  const here = (node) => {
    const row = node && node.closest('li.row');
    return !row || !list || row.parentElement === list;
  };
  // Lost, or left by whatever closed on a copy of this message in another list.
  const lost = () => {
    const a = document.activeElement;
    if (!a || a === document.body) return true;
    const row = a.closest && a.closest('li.row');
    return Boolean(row && row.dataset.key === key && !here(a));
  };
  const land = () => {
    if (!lost()) return;
    let control = back && back.isConnected ? back : (find ? find() : null);
    if (control && control.matches('li')) control = control.querySelector('.mark, .who');
    const same = rowIn(list, key), next = nearKey && rowIn(list, nearKey);
    // The first that takes the focus: one in a sheet that has closed does not.
    for (const target of [control && here(control) ? control : null, same && same.querySelector('.mark, .who'), next && next.querySelector('.who')]) {
      if (!target) continue;
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
  };
  land();
  setTimeout(land, 420);
}
// The way a message is put off, from the panel, the key and the list alike.
// Optimistic, as marking done is: it leaves the queue at once, and comes
// back if the server refuses. 'at' is a time; 'now', to bring the message
// back now as a reminder that has come; or null, to take the reminder away,
// which only Undo asks for, of a message that had none. Undoing is quiet.
async function snooze(key, at, undoing) {
  if (session.canMark === false) { requireWrite(); return; }
  // Chosen from the panel: the focus goes back near where it was, not to the top of the page.
  const fromPanel = popovers.has(snoozeSheet) && snoozeSheet.contains(document.activeElement);
  const panel = popovers.get(snoozeSheet);
  const back = panel ? anchorOf(panel) : null;
  if (panel) closePopover(snoozeSheet, false);
  const row = rowByKey(key) || (findItem(key) && rowOfItem(findItem(key)));
  if (!row) return;
  if (fromPanel) refocusAfterSnooze(key, back, panel && panel.find);
  const before = row.snoozedUntil || null;
  const woken = at === 'now';
  const until = woken ? 'now' : at ? at.toISOString() : null;
  const asked = { until, local: woken ? new Date().toISOString() : until, woken };
  const queued = () => attentionSet.has(key) && needsYou(rowByKey(key) || row);
  const was = queued();
  const apply = (value, wake) => {
    const inQueue = queued();
    snoozeLocal(key, value, wake);
    attentionCount = Math.max(0, attentionCount + (queued() ? 1 : 0) - (inQueue ? 1 : 0));
    // Back in the queue, or no longer put off: it must not keep the look of a row leaving.
    if (!(value && Date.parse(value) > Date.now())) unfade(key);
  };
  apply(asked.local, woken);
  pendingSnooze.set(key, asked);
  const li = was && at && !woken ? document.querySelector('#queue li.row[data-key="' + CSS.escape(key) + '"]') : null;
  if (li && !reduceMotion()) {
    // It lets go the way a row marked done does, without the ring filling.
    li.classList.add('leaving');
    setTimeout(renderList, 380);
  } else renderList();
  renderLede();
  renderBars();
  updateBadge();
  // Undoing says nothing more, as for Done: the row moving back is the answer.
  const undo = { label: t('undo'), run: () => snooze(key, snoozeUndoTo(before), true) };
  if (!undoing && woken) toast(t('snooze.back'), false, isSnoozed({ snoozedUntil: before }) ? undo : null);
  else if (!undoing && at) {
    toast(fill('snooze.toast', { when: whenLabel(at, new Date(), true) }), false, undo);
    if (sheet.open && isOpenRow(key)) closeSheet(sheet, false);
  }
  const r = await post('/api/snooze', { key, until });
  if (pendingSnooze.get(key) === asked) pendingSnooze.delete(key);
  if (r.ok) {
    if (typeof r.data.attention === 'number') attentionCount = r.data.attention;
    if (r.data.row) applyRow(r.data.row);
    renderLede();
    updateBadge();
    saveSnapshot();
    // Back, or with no reminder, where it stands in the queue is the server's to say.
    if (!at || woken) loadAttention();
    return;
  }
  apply(before, false);
  renderList();
  renderLede();
  renderBars();
  updateBadge();
  toast(r.data && r.data.code ? failure(r.data) : t('act.failed'), true);
}

// ---- The queue: what needs the reader, most pressing first ----
const QUEUE_SHOWN = 6;
let queueExpanded = false;
function queueItems(now) {
  if (!attention || filtersActive() || filters.view.value !== 'mail') return [];
  // Soonest deadline first when one is close; then a reminder that came in
  // the last day, at the moment the owner chose for it; then what was judged
  // critical; then other deadlines this week; then the rest, newest first.
  const urgency = (m) => {
    const due = dueInfo(m.deadline, now);
    const days = due && due.days !== null ? due.days : null;
    if (days !== null && days <= 3) return days;
    const woke = m.snoozedUntil ? now - Date.parse(m.snoozedUntil) : NaN;
    if (woke >= 0 && woke < 86400000) return 5;
    if (level(m) === 'critical') return 10;
    if (days !== null && days <= 7) return 20 + days;
    return 100;
  };
  return attention.filter((m) => !m.handledAt && !isSnoozed(m))
    .map((m, index) => ({ m, index, u: urgency(m) }))
    .sort((a, b) => a.u - b.u || a.index - b.index)
    .map((entry) => entry.m);
}

// ---- Patching: the same element for the same content ----
const nodeCache = new Map();
let usedNodes = new Set();
function cached(id, signature, build) {
  usedNodes.add(id);
  const have = nodeCache.get(id);
  if (have && have.signature === signature) return have.node;
  const node = build();
  // The element that replaces a focused or selected one inherits nothing by
  // itself; the caller restores focus by key.
  nodeCache.set(id, { signature, node });
  return node;
}
function patchChildren(parent, desired) {
  let cursor = parent.firstChild;
  for (const node of desired) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}
function rowNode(zone, item, now, arriving) {
  const id = zone + keyOf(item);
  const fresh = !nodeCache.has(id);
  // Under a day's heading a row says the hour; in the queue and among what was done, the day too.
  const dated = zone !== 's:';
  const node = cached(id, rowSignature(item, now, dated), () => rowOf(item, now, dated));
  if (fresh && arriving) {
    node.classList.add('arrived');
    node.addEventListener('animationend', () => node.classList.remove('arrived'), { once: true });
  }
  return node;
}
function dayHead(id, label, count) {
  return cached(id, lang + '|' + label + '|' + count, () => {
    const head = el('h2', 'day');
    head.appendChild(el('span', null, label));
    head.appendChild(el('span', 'count', String(count)));
    return head;
  });
}
// Browsers that anchor scrolling keep the reader's place when rows are
// inserted above it. Where they do not, the page does it by hand.
function keepPlace(run) {
  if (window.scrollY < 8 || (window.CSS && CSS.supports && CSS.supports('overflow-anchor', 'auto'))) { run(); return; }
  let anchor = null, top = 0;
  for (const li of document.querySelectorAll('#queue li.row, #list li.row')) {
    const r = li.getBoundingClientRect();
    if (r.bottom > 64) { anchor = li.dataset.key; top = r.top; break; }
  }
  run();
  if (!anchor) return;
  const again = document.querySelector('li.row[data-key="' + CSS.escape(anchor) + '"]');
  if (!again) return;
  const delta = again.getBoundingClientRect().top - top;
  if (Math.abs(delta) > 1) window.scrollBy(0, delta);
}

function skeleton() {
  return cached('skeleton', lang, () => {
    const box = el('div', 'skeleton');
    box.setAttribute('aria-hidden', 'true');
    for (let n = 0; n < 5; n += 1) {
      const row = el('div', 'skeleton-row');
      row.appendChild(el('span', 'bone short'));
      row.appendChild(el('span', 'bone'));
      row.appendChild(el('span', 'bone mid'));
      box.appendChild(row);
    }
    return box;
  });
}
// What was dealt with lately, as the plain view shows it under the queue.
function doneItems() {
  if (filtersActive() || filters.view.value !== 'mail') return [];
  return doneRecent.filter((m) => m.handledAt)
    .map((m, index) => ({ m, index, at: Date.parse(m.handledAt) || 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.m);
}
// What is put off and still to come, soonest first, beside it.
function laterItems() {
  if (filtersActive() || filters.view.value !== 'mail') return [];
  return snoozedRows.filter(isSnoozed)
    .sort((a, b) => (Date.parse(a.snoozedUntil) || 0) - (Date.parse(b.snoozedUntil) || 0));
}
// One quiet line where the rows went, which opens to show them. Only one of
// the two opens at a time, so what is shown under it is never in doubt.
function footToggle(id, label, open, toggle) {
  return cached(id, [lang, label, open].join('|'), () => {
    const b = el('button', 'text-btn quiet foot-toggle ' + id, label);
    b.type = 'button';
    b.dataset.focus = id;
    b.setAttribute('aria-expanded', String(open));
    b.onclick = toggle;
    return b;
  });
}
function renderQueue(items, done, later, now, arriving) {
  queue.hidden = !items.length && !done.length && !later.length;
  if (queue.hidden) { queue.replaceChildren(); return; }
  const desired = [];
  if (items.length) {
    const shown = queueExpanded ? items : items.slice(0, QUEUE_SHOWN);
    const group = cached('queue-group', 'q', () => el('ul', 'group'));
    patchChildren(group, shown.map((m) => rowNode('q:', m, now, arriving)));
    desired.push(dayHead('queue-head', t('queue.title'), items.length), group);
    if (items.length > shown.length) {
      desired.push(cached('queue-more', lang + '|' + (items.length - shown.length), () => {
        const more = el('button', 'text-btn load-more', fill('queue.more', { count: items.length - shown.length }));
        more.type = 'button';
        more.dataset.focus = 'queue-more';
        more.onclick = () => { queueExpanded = true; renderList(); };
        return more;
      }));
    }
  }
  if (later.length || done.length) {
    const foot = cached('queue-foot', 'f', () => el('div', 'queue-foot'));
    const toggles = [];
    if (later.length) {
      toggles.push(footToggle('later-toggle', fill('snooze.later', { count: later.length + laterExtra }), laterExpanded, () => {
        laterExpanded = !laterExpanded;
        if (laterExpanded) doneExpanded = false;
        renderList();
      }));
    }
    if (done.length) {
      toggles.push(footToggle('done-toggle', fill('done.recent', { count: done.length + doneExtra }), doneExpanded, () => {
        doneExpanded = !doneExpanded;
        if (doneExpanded) laterExpanded = false;
        renderList();
      }));
    }
    patchChildren(foot, toggles);
    desired.push(foot);
    if (laterExpanded && later.length) {
      const group = cached('later-group', 'z', () => el('ul', 'group later-group'));
      patchChildren(group, later.map((m) => rowNode('z:', m, now, false)));
      desired.push(group);
    }
    if (doneExpanded && done.length) {
      const group = cached('done-group', 'd', () => el('ul', 'group done-group'));
      patchChildren(group, done.map((m) => rowNode('d:', m, now, false)));
      desired.push(group);
    }
  }
  patchChildren(queue, desired);
}
function buildList() {
  const now = new Date();
  const threads = filters.view.value === 'threads';
  const items = threads ? lastThreads : lastMail;
  usedNodes = new Set();
  // Taken here and spent whatever this draw turns out to be: left set by a
  // draw of an empty list, it would tint every row of the next one.
  const arriving = washNext;
  washNext = false;
  // A folder or a search of the mailbox, live, takes the list's place.
  if (liveView) { buildLiveList(now); return; }
  if (!items) {
    lane.hidden = true;
    lane.replaceChildren();
    renderQueue([], [], [], now, false);
    // Before the first answer: the shape of a list, not an empty page.
    patchChildren(list, loadFailed ? [] : [skeleton()]);
    forgetUnused();
    return;
  }
  const laneKey = renderLane(items, now);
  const queued = queueItems(now);
  const done = doneItems();
  const later = laterItems();
  renderQueue(queued, done, later, now, arriving);
  const elsewhere = new Set(queued.map(rowKey));
  // Opened, the list of what was done or put off shows these rows; they are not drawn twice.
  if (doneExpanded) for (const m of done) elsewhere.add(rowKey(m));
  if (laterExpanded) for (const m of later) elsewhere.add(rowKey(m));
  if (laneKey) elsewhere.add(laneKey);
  // Newest first by the date each row shows, so a day appears once even when a
  // backfill filed old mail late. The loaded order is kept for paging.
  const visible = items.filter((item) => !elsewhere.has(keyOf(item)))
    .map((item, index) => ({ item, index, at: dateOf(rowOfItem(item)).getTime() || 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.item);
  const desired = [];
  if (!visible.length && !laneKey && !queued.length && !done.length && !later.length) {
    const down = failingMailboxes().map((m) => m.address).join();
    const polled = lastSummary && lastSummary.lastPollAt ? hhmm(new Date(lastSummary.lastPollAt)) : '';
    desired.push(cached('empty', [lang, filtersActive(), filters.hours.value, filters.codesOnly.checked, down, polled].join('|'), emptyBlock));
    const offer = mailboxOffer();
    if (offer) desired.push(offer);
    patchChildren(list, desired);
    forgetUnused();
    announceShown(0);
    return;
  }

  // The since-you-last-looked line is drawn only when the new rows lead the list.
  const isNew = (item) => sinceAt > 0 && Date.parse(rowOfItem(item).createdAt) > sinceAt;
  const firstOld = visible.findIndex((item) => !isNew(item));
  const divide = firstOld > 0 && !visible.slice(firstOld).some(isNew);
  const wantInstall = installable && !standalone && !isWide() && !installDismissed();
  const since = (tag) => cached('since-' + tag, lang + '|' + firstOld, () => sinceLine(tag, firstOld));
  const install = () => cached('install', lang, installLine);
  // Days first, so each header knows its count before it is drawn.
  const days = [];
  visible.forEach((item, index) => {
    const d = dateOf(rowOfItem(item));
    const k = dayKey(d);
    let day = days[days.length - 1];
    if (!day || day.key !== k) { day = { key: k, date: d, rows: [], divideBefore: false }; days.push(day); }
    if (divide && index === firstOld) {
      // Where new and older mail meet at a day boundary, the line sits between
      // the days rather than under the older day's header.
      if (!day.rows.length) day.divideBefore = true;
      else day.rows.push(since('li'));
    }
    day.rows.push(rowNode('s:', item, now, arriving));
  });
  days.forEach((day, n) => {
    if (n === 1 && wantInstall) desired.push(install());
    if (day.divideBefore) desired.push(since('div'));
    desired.push(dayHead('day-' + day.key, dayLabel(day.date, now), day.rows.filter((node) => node.classList.contains('row')).length));
    const group = cached('group-' + day.key, 'g', () => el('ul', 'group'));
    patchChildren(group, day.rows);
    desired.push(group);
  });
  if (days.length === 1 && wantInstall) desired.push(install());
  if (!threads && nextCursor) desired.push(loadMoreButton());
  // Not found here? The mailbox itself, for mail mailsift never kept.
  const offer = mailboxOffer();
  if (offer) desired.push(offer);
  patchChildren(list, desired);
  forgetUnused();
  watchForMore();
  renderedKeys.clear();
  for (const item of items) renderedKeys.add(keyOf(item));
  announceShown(visible.length + queued.length);
}
function forgetUnused() {
  for (const id of Array.from(nodeCache.keys())) if (!usedNodes.has(id)) nodeCache.delete(id);
}
// Older mail loads as the end of the list comes into view; the button stays
// for a keyboard and for when that load fails.
let moreWatcher = null;
function watchForMore() {
  if (!window.IntersectionObserver) return;
  if (!moreWatcher) {
    moreWatcher = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (liveView) { if (liveView.next && !liveView.loading && !liveView.moreFailed) liveLoad(false); return; }
      if (nextCursor && !loadingMail && !loadMoreFailed) load(false);
    }, { rootMargin: '600px 0px' });
  }
  moreWatcher.disconnect();
  const more = list.querySelector('.load-more');
  if (more) moreWatcher.observe(more);
}

// ---- New mail while the reader is further down ----
const freshPill = $('#fresh-pill');
let freshCount = 0;
function noteArrivals(count) {
  if (count <= 0 || liveView || window.scrollY < 320 || document.querySelector('dialog[open]')) return;
  freshCount += count;
  freshPill.textContent = freshCount === 1 ? t('fresh.pill1') : fill('fresh.pill', { count: freshCount });
  freshPill.hidden = false;
}
function clearArrivals() { freshCount = 0; freshPill.hidden = true; }
freshPill.onclick = () => {
  clearArrivals();
  window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
};

// ---- The app's badge: how many need the reader ----
function updateBadge() {
  if (!navigator.setAppBadge) return;
  try {
    if (attentionCount > 0) navigator.setAppBadge(attentionCount).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  } catch (e) {}
}

// ---- Loading ----
let timer;
function onFiltersChanged() {
  // In a live view the field is the mailbox's search, asked on Enter (see runLiveQuery).
  if (liveView) { syncUrl(); updateAsk(); return; }
  announceNextList = true;
  markSegs();
  renderTokens();
  syncUrl();
  updateAsk();
  loadMoreFailed = false;
  queueExpanded = false;
  doneExpanded = false;
  laterExpanded = false;
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
    holdPending();
    holdSnoozes();
    lastFetchAt = new Date();
    fromSnapshot = false;
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
      saveSnapshot();
      if (!firstLoadDone && !loadFailed) { firstLoadDone = true; afterFirstLoad(); }
    }
  }
}

// The refresh, on the live line's word or on the minute: fold the newest page
// into what is shown, and tint the rows that were not there before.
async function refresh() {
  if (loadingMail) return;
  if (filters.view.value === 'threads') { washNext = true; return load(true); }
  if (!lastMail || fromSnapshot) return load(true);
  const requestId = ++mailRequestId;
  const previousCursor = nextCursor;
  const known = new Set(lastMail.map(rowKey));
  const p = query();
  p.set('limit', String(MAIL_PAGE_SIZE));
  loadingMail = true;
  let arrived = 0;
  try {
    const r = await fetch(dataPath() + '?' + p.toString());
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error('http ' + r.status);
    const data = await r.json();
    if (requestId !== mailRequestId) return;
    const page = Array.isArray(data.mail) ? data.mail : [];
    arrived = page.filter((m) => !known.has(rowKey(m))).length;
    // A page left open for days only ever gained rows. What has aged out of
    // the window the list is showing goes, so the list agrees with its count.
    const oldest = Date.now() - Number(filters.hours.value || 24) * 3600 * 1000;
    lastMail = mergeMail(lastMail || [], page).filter((m) => !(Date.parse(m.createdAt) < oldest));
    holdPending();
    holdSnoozes();
    nextCursor = previousCursor;
    lastFetchAt = new Date();
    setNetworkIssue(false);
  } catch (e) {
    if (requestId === mailRequestId) setNetworkIssue(true);
  } finally {
    if (requestId === mailRequestId) {
      loadingMail = false;
      washNext = true;
      renderList();
      renderPane();
      noteArrivals(arrived);
      saveSnapshot();
    }
  }
}

function setAttention(rows, count, done, later, laterCount, doneCount) {
  attention = Array.isArray(rows) ? rows : [];
  // A server that does not say (an older one, during an upgrade) leaves what is known.
  if (Array.isArray(done)) {
    doneRecent = done;
    doneExtra = typeof doneCount === 'number' ? Math.max(0, doneCount - done.length) : 0;
  }
  if (Array.isArray(later)) {
    snoozedRows = later;
    laterExtra = typeof laterCount === 'number' ? Math.max(0, laterCount - later.length) : 0;
  }
  attentionCount = typeof count === 'number' ? count : attention.length;
  attentionSet = new Set(attention.map(rowKey));
  // The queue as the server had it before it heard of a row just completed,
  // put off, or brought back.
  for (const [key, at] of pendingHandled) {
    if (at && attention.some((m) => rowKey(m) === key && !m.handledAt)) attentionCount = Math.max(0, attentionCount - 1);
  }
  for (const [key, asked] of pendingSnooze) {
    if (pendingHandled.get(key)) continue;
    const listed = attention.some((m) => rowKey(m) === key && !m.handledAt && !isSnoozed(m));
    if (asked.until && !asked.woken && listed) attentionCount = Math.max(0, attentionCount - 1);
    else if (asked.woken && !listed) attentionCount += 1;
  }
  holdPending();
  holdSnoozes();
  renderLede();
  if (lastMail || lastThreads) renderList();
  renderBars();
  updateBadge();
}
async function loadAttention() {
  try {
    const r = await fetch('/api/attention');
    if (!r.ok) return;
    const d = await r.json();
    setAttention(d.mail, d.count, d.done, d.snoozed, d.snoozedCount, d.doneCount);
  } catch (e) {}
}

async function chrome() {
  try {
    const p = new URLSearchParams();
    p.set('hours', filters.hours.value);
    const [summaryAnswer, digestAnswer] = await Promise.all([
      fetch('/api/summary?' + p.toString()), fetch('/api/digest'), loadAttention(),
    ]);
    if (summaryAnswer.status === 401) { location.reload(); return; }
    // An error page that happens to be JSON (a proxy's) is not a summary.
    if (!summaryAnswer.ok) throw new Error('http ' + summaryAnswer.status);
    const s = await summaryAnswer.json();
    const hadSummary = Boolean(lastSummary);
    const downBefore = failingMailboxes().map((m) => m.address).join();
    lastSummary = s;
    if (s.session) { session = Object.assign({}, session, s.session); sessionChanged(); }
    askForPoll();
    // An empty list picks its words from the summary, which usually lands
    // after the list: "quiet" is not to be said while a mailbox is unread.
    if (list.querySelector('.empty') && (!hadSummary || failingMailboxes().map((m) => m.address).join() !== downBefore)) renderList();
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
    if (digestAnswer.ok) lastDigest = await digestAnswer.json();
    renderLede();
    renderStatus();
    renderTokens();
    drawDigest();
    if (healthSheet.open) redrawHealth();
    saveSnapshot();
  } catch (e) {
    setNetworkIssue(true);
  }
}

// ---- The last view, kept so the next opening is not an empty page ----
// An installed app is opened for a glance. What was there the last time is
// drawn at once from this copy and replaced as soon as the server answers;
// with no network it stays, under a line that says when it is from. Only the
// plain first page is kept, never a filtered one, and never a verification
// code: a code is of no use an hour later and has no business at rest.
const SNAPSHOT_KEY = 'snapshot';
const SNAPSHOT_MAX_AGE = 7 * 24 * 3600 * 1000;
let snapshotTimer, fromSnapshot = false;
function saveSnapshot() {
  // A live view is not the last view of the triaged mail, and its field is not the triaged one's query.
  if (fromSnapshot || liveView || !lastMail || !lastSummary || filtersActive()) return;
  if (filters.view.value !== 'mail' || filters.hours.value !== '24') return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    const plain = (m) => { const copy = Object.assign({}, m); delete copy.verificationCode; return copy; };
    try {
      writeStorage(SNAPSHOT_KEY, JSON.stringify({
        at: (lastFetchAt || new Date()).toISOString(),
        mail: lastMail.slice(0, 60).map(plain),
        attention: (attention || []).slice(0, 40).map(plain),
        done: doneRecent.slice(0, 20).map(plain),
        doneExtra: doneRecent.filter((m) => m.handledAt).length + doneExtra - doneRecent.slice(0, 20).filter((m) => m.handledAt).length,
        later: snoozedRows.slice(0, 20).map(plain),
        // The ones not kept here, which nothing on this device can list.
        laterExtra: snoozedRows.filter(isSnoozed).length + laterExtra - snoozedRows.slice(0, 20).filter(isSnoozed).length,
        attentionCount, summary: lastSummary, digest: lastDigest,
      }));
    } catch (e) {}
  }, 500);
}
function restoreSnapshot() {
  // A view the address asks for is not the plain one that was kept.
  if (filtersActive() || filters.view.value !== 'mail' || filters.hours.value !== '24') return false;
  try {
    const snap = JSON.parse(readStorage(SNAPSHOT_KEY) || 'null');
    if (!snap || !Array.isArray(snap.mail) || !(Date.now() - Date.parse(snap.at) < SNAPSHOT_MAX_AGE)) return false;
    lastMail = snap.mail;
    lastSummary = snap.summary || null;
    lastDigest = snap.digest || null;
    attention = Array.isArray(snap.attention) ? snap.attention : [];
    doneRecent = Array.isArray(snap.done) ? snap.done : [];
    doneExtra = Math.max(0, Number(snap.doneExtra) || 0);
    snoozedRows = Array.isArray(snap.later) ? snap.later : [];
    laterExtra = Math.max(0, Number(snap.laterExtra) || 0);
    attentionCount = Number(snap.attentionCount) || 0;
    attentionSet = new Set(attention.map(rowKey));
    lastFetchAt = new Date(snap.at);
    if (lastSummary && lastSummary.session) session = Object.assign({}, session, lastSummary.session);
    fromSnapshot = true;
    return true;
  } catch (e) {
    return false;
  }
}
function forgetLocal() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === SNAPSHOT_KEY || key === 'seenAt' || key === 'digestSeen' || key === 'imagesFrom' || key.indexOf('draft:') === 0) localStorage.removeItem(key);
    }
  } catch (e) {}
}

// What a reload or a home-screen shortcut asked for, once the list is here.
let bootKey = keyFromHash(location.hash);
const bootParams = new URLSearchParams(location.search);
const wantsCode = bootParams.get('focus') === 'code';
stripStaleEntry();
// Stripped even when it does not decode, so a broken link does not survive a reload.
// So is the mark of a sheet, a popover or a selection that was open when the
// page was reloaded: it is gone, and an entry that still claims it would
// swallow the next Back. The folder or search on show is kept, so the entry
// is still that view's and opening it again adds nothing to the history.
function stripStaleEntry() {
  const state = history.state;
  if (location.hash.indexOf('#m=') !== 0 && !(state && (state.sheet || state.popover || state.picking))) return;
  history.replaceState(state && state.live ? { live: state.live } : null, '', location.pathname + location.search);
}
function focusCode() {
  const target = lane.querySelector('.lane-copy');
  if (target) { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
  else if (!codeWait) startCodeWait();
}
function afterFirstLoad() {
  if (bootKey) {
    const key = bootKey;
    bootKey = null;
    openFromLink(key, false);
  }
  if (wantsCode) focusCode();
  syncUrl();
}
`;
}
