/**
 * The last part of the page script: what keeps the page current and what
 * makes it quick to drive, and then the lines that start everything.
 *
 * - The live line: one long-lived request on which the server says "the mail
 *   changed" or "a poll finished". The page then asks for exactly that, so a
 *   message appears when it is judged rather than at the next minute. With no
 *   line (an old proxy, a full hub) the minute timer still runs.
 * - Notifications: asking the browser for a push subscription and telling
 *   the server about it, with what this device wants to hear.
 * - Asking: a question to the model about the mail that was judged, answered
 *   with the messages it drew on.
 * - The palette and the keyboard: every filter, action and message one
 *   shortcut away on a desk.
 *
 * String.raw: the script below is written as it runs. It must hold no
 * backtick and no dollar sign followed by a brace.
 */
export function livePart(): string {
  return String.raw`
// ---- The live line ----
let stream = null, liveSeen = null, liveTimer, liveRetry = 3000, liveAgain;
function liveRefresh() {
  // Several events in a breath are one refresh.
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { refresh(); chrome(); }, 150);
}
function closeStream() {
  clearTimeout(liveAgain);
  if (stream) stream.close();
  stream = null;
  if (live) { live = false; renderStatus(); }
}
function openStream() {
  if (stream || document.hidden || !window.EventSource || !navigator.onLine) return;
  const source = new EventSource('/api/events');
  stream = source;
  source.addEventListener('hello', (e) => {
    let said = {};
    try { said = JSON.parse(e.data); } catch (err) {}
    // Back on the line after a gap: anything that changed meanwhile is fetched now.
    if (liveSeen && liveSeen.mail !== said.mail) liveRefresh();
    else if (liveSeen && liveSeen.poll !== said.poll) chrome();
    liveSeen = said;
    live = true;
    liveRetry = 3000;
    renderStatus();
  });
  source.addEventListener('mail', (e) => {
    try { if (liveSeen) liveSeen.mail = JSON.parse(e.data).sig; } catch (err) {}
    liveRefresh();
  });
  source.addEventListener('poll', (e) => {
    try { if (liveSeen) liveSeen.poll = JSON.parse(e.data).sig; } catch (err) {}
    chrome();
  });
  // The server has no room for another listener: the minute timer will do.
  source.addEventListener('full', () => { if (stream === source) closeStream(); });
  source.onerror = () => {
    if (stream !== source) return;
    if (live) { live = false; renderStatus(); }
    // Left to itself the browser asks again every three seconds for as long
    // as the server is away, or never again if it was refused outright. The
    // page does the asking instead: soon the first time, then less and less
    // often, while the minute timer keeps the list current.
    source.close();
    stream = null;
    clearTimeout(liveAgain);
    liveAgain = setTimeout(openStream, liveRetry);
    liveRetry = Math.min(liveRetry * 2, 120000);
  };
}

// ---- What this session may do ----
let sessionDrawn = '';
function sessionChanged() {
  const said = [session.writable, session.auth, session.assistant, session.push, lang].join('|');
  if (said === sessionDrawn) return;
  sessionDrawn = said;
  const line = $('#session-line');
  line.replaceChildren();
  if (session.auth) {
    if (!session.writable) line.appendChild(textNode(DOT + t('session.readonly')));
    line.appendChild(textNode(DOT));
    const out = el('button', 'link-btn', t('session.signout'));
    out.type = 'button';
    out.onclick = signOut;
    line.appendChild(out);
  }
  updateAsk();
  wordPlaceholders();
  if (composeSheet.open) $('#compose-ai').hidden = !session.assistant;
}
async function signOut() {
  // A device that is signed out stops being told about mail.
  let reg = null;
  try {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    }
  } catch (e) {}
  // Said, when it did not work: a page that reloads still signed in, with
  // nothing on it to say so, looks like signing out is broken.
  const out = await post('/auth/signout', {});
  if (!out.ok) { toast(t('session.signoutFailed'), true); return; }
  try { if (reg && reg.active) reg.active.postMessage({ type: 'signout' }); } catch (e) {}
  forgetLocal();
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  location.replace('/');
}

// ---- Notifications to this device ----
const bell = $('#bell');
function pushProblem() {
  if (!session.push) return 'disabledServer';
  if (!window.isSecureContext) return 'needHttps';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return appleMobile && !standalone ? 'needInstall' : 'unsupported';
  }
  return '';
}
function keyBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
async function currentPush() {
  if (pushProblem()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
let pushPrefs = { subscribed: false, level: 'warning', codes: true };
async function readPush() {
  try {
    const sub = await currentPush();
    if (!sub) { pushPrefs = { subscribed: false, level: 'warning', codes: true }; return null; }
    const r = await post('/api/push/state', { endpoint: sub.endpoint });
    pushPrefs = r.ok && r.data.subscribed
      ? { subscribed: true, level: r.data.level === 'critical' ? 'critical' : 'warning', codes: r.data.codes !== false }
      : { subscribed: false, level: 'warning', codes: true };
    return sub;
  } catch (e) {
    return null;
  } finally {
    bell.classList.toggle('on', pushPrefs.subscribed);
  }
}
// What this device is called in the list of devices: where it runs and in what.
function deviceLabel() {
  const ua = navigator.userAgent || '';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : (navigator.userAgentData && navigator.userAgentData.platform) || (/Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [system, browser].filter(Boolean).join(DOT);
}
function savePush(sub) {
  const j = sub.toJSON();
  return post('/api/push/subscribe', {
    endpoint: j.endpoint, keys: j.keys, level: pushPrefs.level, codes: pushPrefs.codes, label: deviceLabel(),
  });
}
// The other devices that are told about mail, so a lost phone can be cut off.
async function drawDevices(body, sub) {
  const r = await post('/api/push/devices', { endpoint: sub ? sub.endpoint : '' });
  if (!r.ok || !notifySheet.open || !body.isConnected) return;
  const others = (r.data.devices || []).filter((d) => !d.current);
  const old = body.querySelector('.devices-block');
  if (old) old.remove();
  if (!others.length) return;
  const block = el('div', 'devices-block');
  block.appendChild(el('h4', 'section-label', t('notify.devices')));
  const list = el('ul', 'devices');
  for (const d of others) {
    const li = el('li');
    const name = el('span', 'name', d.label || t('notify.unnamed'));
    let since = '';
    try { since = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d.since)); } catch (e) {}
    if (since) name.appendChild(el('small', null, fill('notify.since', { date: since })));
    li.appendChild(name);
    if (r.data.canRemove) {
      const gone = el('button', 'text-btn quiet small', t('notify.remove'));
      gone.type = 'button';
      gone.onclick = async () => {
        gone.disabled = true;
        const done = await post('/api/push/remove', { id: d.id });
        if (!done.ok) { gone.disabled = false; toast(failure(done.data), true); return; }
        toast(t('notify.removed'));
        drawDevices(body, sub);
      };
      li.appendChild(gone);
    }
    list.appendChild(li);
  }
  block.appendChild(list);
  body.appendChild(block);
}
async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const answer = await fetch('/api/push/key');
  if (!answer.ok) throw new Error('key');
  const key = (await answer.json()).publicKey;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key cannot be used by this one.
  if (sub && sub.options && sub.options.applicationServerKey) {
    const have = Array.from(new Uint8Array(sub.options.applicationServerKey)).join();
    if (have !== Array.from(keyBytes(key)).join()) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const r = await savePush(sub);
  if (!r.ok) { const refused = new Error('save'); refused.code = r.data && r.data.code; throw refused; }
  pushPrefs.subscribed = true;
  bell.classList.add('on');
  return true;
}
async function renderNotify() {
  const body = notifySheet.querySelector('.sheet-body');
  const say = (text, cls) => body.appendChild(el('p', cls || 'sheet-text', text));
  body.replaceChildren();
  say(t('notify.pitch'), 'sheet-text lead');
  const problem = pushProblem();
  // A browser that cannot be told itself can still cut off one that is.
  if (problem) { say(t('notify.' + problem)); if (session.push) drawDevices(body, null); return; }
  if (Notification.permission === 'denied') { say(t('notify.denied')); drawDevices(body, null); return; }
  const sub = await readPush();
  if (!notifySheet.open) return;
  body.replaceChildren();
  say(t('notify.pitch'), 'sheet-text lead');
  if (!sub || !pushPrefs.subscribed) {
    const on = el('button', 'primary-action', t('notify.enable'));
    on.type = 'button';
    on.onclick = async () => {
      on.disabled = true;
      try {
        if (!(await enablePush())) { renderNotify(); return; }
        renderNotify();
      } catch (e) {
        on.disabled = false;
        toast(e && e.code === 'pushFull' ? t('error.pushFull') : t('notify.failed'), true);
      }
    };
    body.appendChild(on);
    say(t('notify.private'), 'sheet-text quiet');
    drawDevices(body, null);
    return;
  }
  const state = el('p', 'notify-on');
  state.appendChild(icon('i-check'));
  state.appendChild(textNode(t('notify.on')));
  body.appendChild(state);
  const change = async () => { const r = await savePush(sub); if (!r.ok) toast(t('act.failed'), true); };
  const codes = el('label', 'switch');
  const codesWords = el('span');
  codesWords.appendChild(el('span', null, t('notify.codes')));
  codesWords.appendChild(el('small', null, t('notify.codesHint')));
  codes.appendChild(codesWords);
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('role', 'switch');
  box.checked = pushPrefs.codes;
  box.onchange = () => { pushPrefs.codes = box.checked; change(); };
  codes.appendChild(box);
  body.appendChild(codes);
  const field = el('div', 'field');
  field.appendChild(el('span', 'label', t('notify.level')));
  const set = el('div', 'segset');
  set.setAttribute('role', 'radiogroup');
  set.setAttribute('aria-label', t('notify.level'));
  for (const [value, key] of [['critical', 'notify.levelCritical'], ['warning', 'notify.levelWarning']]) {
    const option = el('button', 'seg' + (pushPrefs.level === value ? ' on' : ''));
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(pushPrefs.level === value));
    option.appendChild(el('span', null, t(key)));
    option.onclick = () => { pushPrefs.level = value; change(); renderNotify(); };
    set.appendChild(option);
  }
  field.appendChild(set);
  body.appendChild(field);
  const row = el('div', 'sheet-actions');
  const test = el('button', 'text-btn', t('notify.test'));
  test.type = 'button';
  test.dataset.focus = 'notify-test';
  test.onclick = async () => {
    test.disabled = true;
    const r = await post('/api/push/test', { endpoint: sub.endpoint });
    test.disabled = false;
    toast(t(r.ok && r.data.result === 'sent' ? 'notify.testSent' : 'notify.testFailed'), !(r.ok && r.data.result === 'sent'));
    if (r.ok && r.data.result === 'gone') renderNotify();
  };
  row.appendChild(test);
  const off = el('button', 'text-btn quiet', t('notify.disable'));
  off.type = 'button';
  off.onclick = async () => {
    await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
    try { await sub.unsubscribe(); } catch (e) {}
    pushPrefs.subscribed = false;
    bell.classList.remove('on');
    renderNotify();
  };
  row.appendChild(off);
  body.appendChild(row);
  say(t('notify.private'), 'sheet-text quiet');
  drawDevices(body, sub);
}
bell.onclick = () => {
  if (notifySheet.open) { closePopover(notifySheet, false); return; }
  // Under the bell, where the eye already is; the header is sticky, so it stays there.
  openPopover(notifySheet, bell, { width: 360, fixed: true, history: !isWide() });
  renderNotify();
};
// A tap on a notification lands here when the page is already open.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const said = event.data || {};
    if (said.type !== 'open') return;
    refresh();
    chrome();
    if (said.kind === 'code') { clearFilters(); setTimeout(focusCode, 400); }
    else if (said.key) openFromLink(said.key, false);
  });
}

// ---- Asking the mail a question ----
const askButton = $('#ask');
function updateAsk() {
  askButton.hidden = !session.assistant || !filters.q.value.trim();
}
function wordPlaceholders() {
  filters.q.placeholder = t(session.assistant ? 'ask.placeholder' : 'search.short');
  $('#palette-input').placeholder = t('palette.hint');
  composeForm.instruction.placeholder = t('compose.aiHint');
  composeForm.text.placeholder = t('compose.body');
}
let askSeq = 0, lastAnswer = null;
function drawAnswer() {
  answerBox.replaceChildren();
  answerBox.hidden = !lastAnswer;
  if (!lastAnswer) return;
  const a = lastAnswer;
  const head = el('div', 'answer-head');
  head.appendChild(icon('i-sparkle'));
  head.appendChild(el('span', 'answer-question', a.question));
  const close = el('button', 'icon-btn small');
  close.type = 'button';
  close.title = t('ask.close');
  close.setAttribute('aria-label', t('ask.close'));
  close.appendChild(icon('i-x'));
  close.onclick = () => { lastAnswer = null; askSeq += 1; drawAnswer(); };
  head.appendChild(close);
  answerBox.appendChild(head);
  if (a.pending) { answerBox.appendChild(el('p', 'answer-text reading', t('ask.thinking'))); return; }
  if (a.error) { answerBox.appendChild(el('p', 'answer-text inline-error', a.error)); return; }
  const open = (citation) => { extraRows.set(citation.key, citation.row); openDetail(citation.key); };
  const byNumber = new Map((a.citations || []).map((c) => [c.n, c]));
  const words = el('p', 'answer-text');
  words.setAttribute('aria-live', 'polite');
  // The answer's [n] marks become buttons that open the message they point at.
  const marks = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let at = 0, m;
  while ((m = marks.exec(a.answer))) {
    if (m.index > at) words.appendChild(textNode(a.answer.slice(at, m.index)));
    for (const n of m[1].split(',').map((part) => Number(part.trim()))) {
      const citation = byNumber.get(n);
      if (!citation) continue;
      const mark = el('button', 'cite', String(n));
      mark.type = 'button';
      mark.title = citation.row.subject || citation.row.senderName || '';
      mark.onclick = () => open(citation);
      words.appendChild(mark);
    }
    at = m.index + m[0].length;
  }
  if (at < a.answer.length) words.appendChild(textNode(a.answer.slice(at)));
  answerBox.appendChild(words);
  if (a.citations && a.citations.length) {
    const sources = el('ul', 'answer-sources');
    sources.setAttribute('aria-label', t('ask.sources'));
    for (const citation of a.citations) {
      const li = el('li');
      const b = el('button', 'source');
      b.type = 'button';
      b.appendChild(el('span', 'cite', String(citation.n)));
      const line = el('span', 'source-line');
      line.appendChild(el('b', null, citation.row.senderName || citation.row.sender || t('unknownSender')));
      line.appendChild(textNode(' — ' + (citation.row.summary || citation.row.subject || '')));
      b.appendChild(line);
      b.onclick = () => open(citation);
      li.appendChild(b);
      sources.appendChild(li);
    }
    answerBox.appendChild(sources);
  }
  if (a.considered) answerBox.appendChild(el('p', 'answer-foot', fill('ask.considered', { count: a.considered })));
}
async function ask(question) {
  const asked = String(question || '').trim();
  if (!asked || !session.assistant) return;
  const seq = ++askSeq;
  lastAnswer = { question: asked, pending: true };
  drawAnswer();
  answerBox.scrollIntoView({ block: 'nearest' });
  const r = await post('/api/ask', { question: asked });
  if (seq !== askSeq) return;
  lastAnswer = r.ok
    ? { question: asked, answer: String(r.data.answer || ''), citations: r.data.citations || [], considered: r.data.considered || 0 }
    : { question: asked, error: r.data && (r.data.code || r.data.error) ? failure(r.data) : t('error.assistant_failed') };
  drawAnswer();
}
askButton.onclick = () => ask(filters.q.value);

// ---- The palette: anything, by name ----
const palette = $('#palette'), paletteInput = $('#palette-input'), paletteList = $('#palette-list');
let paletteItems = [], paletteAt = 0, paletteSeq = 0, paletteMail = [];
function commands() {
  const out = [];
  const add = (section, glyph, label, run) => out.push({ section, glyph, label, run });
  if (attentionCount) add('goto', 'i-check', t('queue.title'), showQueue);
  add('goto', 'i-inbox', t('cmd.all'), () => { clearFilters(); setFilters({ view: 'mail' }); });
  add('goto', 'i-alert', t('lede.showCritical'), () => setFilters({ importance: 'critical' }));
  add('goto', 'i-bell', t('lede.showPushed'), () => setFilters({ pushedOnly: true }));
  add('goto', 'i-shield', t('filter.codesOnly'), () => setFilters({ codesOnly: true }));
  add('goto', 'i-trash', t('filter.spamOnly'), () => setFilters({ spamOnly: true }));
  add('goto', 'i-reply-all', t('cmd.threads'), () => setFilters({ view: 'threads' }));
  for (const [hours, key] of [['24', 'window.long.24h'], ['72', 'window.long.3d'], ['168', 'window.long.7d'], ['720', 'window.long.30d']]) {
    add('goto', 'i-chevron', fill('cmd.window', { window: t(key) }), () => setFilters({ hours }));
  }
  for (const a of (lastSummary && lastSummary.accounts) || []) add('goto', 'i-inbox', a.name, () => setFilters({ account: a.address }));
  for (const c of (lastSummary && lastSummary.categories) || []) add('goto', 'i-chevron', word('category.', c), () => setFilters({ category: c }));
  add('actions', 'i-compose', t('compose.new'), startCompose);
  if (refreshButton) add('actions', 'i-arrow', t('refresh.label'), pollNow);
  add('actions', 'i-check', t('cmd.copyCode'), copyNewestCode);
  add('actions', 'i-bell', t('notify.title'), () => bell.click());
  add('actions', 'i-inbox', t('mailboxes.title'), openHealth);
  add('actions', 'i-sparkle', t(readTheme() === 'dark' ? 'theme.toLight' : 'theme.toDark'), () => $('#theme').click());
  add('actions', 'i-chevron', t('lang.label'), () => $('#lang').click());
  add('actions', 'i-more', t('keys.title'), openKeys);
  if (session.auth) add('actions', 'i-x', t('session.signout'), signOut);
  return out;
}
// Every word of the query, in any order, somewhere in the label.
function matches(label, q) {
  const text = label.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((part) => text.indexOf(part) !== -1);
}
const QUESTION = /[?？]\s*$|^(what|when|who|whom|which|how|why|did|does|do|is|are|was|were|has|have|any)\b|什么|哪|谁|怎么|为什么|多少|是否|有没有|吗/i;
function drawPalette() {
  const q = paletteInput.value.trim();
  const items = [];
  const found = commands().filter((c) => !q || matches(c.label, q));
  const asks = q && session.assistant
    ? [{ section: 'ask', glyph: 'i-sparkle', label: fill('palette.ask', { q }), run: () => ask(q) }] : [];
  const mail = paletteMail.map((m) => ({
    section: 'messages', glyph: 'i-read', label: (m.senderName || m.sender || t('unknownSender')) + ' — ' + (m.summary || m.subject || ''),
    run: () => { extraRows.set(rowKey(m), m); openDetail(rowKey(m)); },
  }));
  const search = q ? [{ section: 'messages', glyph: 'i-search', label: fill('palette.search', { q }), run: () => { setFilters({ q }); showSearch(); } }] : [];
  // A question goes to the model first; a name goes to what it names.
  if (q && QUESTION.test(q)) items.push(...asks, ...mail, ...found, ...search);
  else items.push(...found.slice(0, q ? 8 : 40), ...mail, ...search, ...asks);
  paletteItems = items;
  if (paletteAt >= items.length) paletteAt = Math.max(0, items.length - 1);
  paletteList.replaceChildren();
  if (!items.length) { paletteList.appendChild(el('li', 'palette-none', t('palette.none'))); return; }
  let section = '';
  items.forEach((item, index) => {
    if (item.section !== section && item.section !== 'ask') {
      section = item.section;
      const head = el('li', 'palette-section', t('palette.' + section));
      head.setAttribute('role', 'presentation');
      paletteList.appendChild(head);
    }
    const li = el('li', 'palette-item' + (index === paletteAt ? ' on' : ''));
    li.id = 'palette-' + index;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === paletteAt));
    li.appendChild(icon(item.glyph));
    li.appendChild(el('span', null, item.label));
    li.onclick = () => runPalette(index);
    li.onpointermove = () => { if (paletteAt !== index) { paletteAt = index; markPalette(); } };
    paletteList.appendChild(li);
  });
  paletteInput.setAttribute('aria-activedescendant', 'palette-' + paletteAt);
}
function markPalette() {
  paletteList.querySelectorAll('.palette-item').forEach((li) => {
    const on = li.id === 'palette-' + paletteAt;
    li.classList.toggle('on', on);
    li.setAttribute('aria-selected', String(on));
    if (on) li.scrollIntoView({ block: 'nearest' });
  });
  paletteInput.setAttribute('aria-activedescendant', 'palette-' + paletteAt);
}
function runPalette(index) {
  const item = paletteItems[index];
  if (!item) return;
  palette.close();
  item.run();
}
let paletteTimer;
function searchPalette() {
  const q = paletteInput.value.trim();
  const seq = ++paletteSeq;
  clearTimeout(paletteTimer);
  if (q.length < 2) { paletteMail = []; return; }
  paletteTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/mail?hours=2160&limit=6&q=' + encodeURIComponent(q));
      if (!r.ok || seq !== paletteSeq) return;
      const d = await r.json();
      if (seq !== paletteSeq) return;
      paletteMail = Array.isArray(d.mail) ? d.mail : [];
      drawPalette();
    } catch (e) {}
  }, 180);
}
function openPalette() {
  if (palette.open) return;
  paletteInput.value = '';
  paletteMail = [];
  paletteAt = 0;
  // A search still on its way from the last time is not for this one.
  paletteSeq += 1;
  clearTimeout(paletteTimer);
  drawPalette();
  palette.showModal();
  rehomeToast();
  paletteInput.focus();
}
paletteInput.addEventListener('input', () => { paletteAt = 0; paletteMail = []; drawPalette(); searchPalette(); });
paletteInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!paletteItems.length) return;
    paletteAt = (paletteAt + (e.key === 'ArrowDown' ? 1 : paletteItems.length - 1)) % paletteItems.length;
    markPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPalette(paletteAt);
  }
});
palette.addEventListener('click', (e) => { if (e.target === palette) palette.close(); });
function copyNewestCode() {
  const button = lane.querySelector('.lane-copy') || document.querySelector('#queue .has-code .code-copy, #list .has-code .code-copy');
  if (button) button.click();
}

// ---- The keyboard, where there is one ----
const fineKeys = matchMedia('(pointer: fine)').matches;
const macKeys = /Mac|iPhone|iPad/.test(navigator.platform || '');
const KEY_LIST = [
  ['j k', 'keys.move'], ['⏎', 'keys.open'], ['e', 'keys.done'], ['r a', 'keys.reply'], ['f', 'keys.forward'], ['y', 'keys.archive'],
  ['s', 'keys.star'], ['#', 'keys.trash'], ['n', 'keys.compose'], ['c', 'keys.code'], ['/', 'keys.search'],
  [macKeys ? '⌘K' : 'Ctrl K', 'keys.palette'], ['.', 'keys.check'], ['esc', 'keys.close'], ['?', 'keys.help'],
];
function openKeys() {
  const body = keysSheet.querySelector('.sheet-body');
  const list = el('dl', 'keys-list');
  for (const [keys, label] of KEY_LIST) {
    const dt = el('dt');
    for (const key of keys.split(' ')) dt.appendChild(el('kbd', 'kbd', key));
    list.appendChild(dt);
    list.appendChild(el('dd', null, t(label)));
  }
  body.replaceChildren(list);
  openSheet(keysSheet, {});
}
if (fineKeys) {
  const hint = $('#palette-hint');
  hint.textContent = macKeys ? '⌘K' : 'Ctrl K';
  hint.hidden = false;
}
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.defaultPrevented) return;
  // The palette opens from anywhere, a field included.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (palette.open) palette.close(); else if (!document.querySelector('dialog[open]:not(.popover)')) openPalette();
    return;
  }
  if (!fineKeys || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target;
  const editable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  if (editable || document.querySelector('dialog[open]')) return;
  const keys = visibleKeys();
  const current = selectedKey;
  const onControl = target instanceof Element && target !== document.body && target.closest('button, a[href], summary, [role="button"]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
    if (!keys.length) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
    const key = keys[Math.min(keys.length - 1, Math.max(0, keys.indexOf(current) + step))];
    if (isWide()) openDetail(key);
    else { selectedKey = key; markSelected(); }
    const li = document.querySelector('li.row[data-key="' + CSS.escape(key) + '"]');
    if (li) li.scrollIntoView({ block: 'nearest' });
  } else if ((e.key === 'Enter' || e.key === 'o') && current && !onControl) {
    // Enter opens the selected message only from nowhere in particular; on
    // a button or link it does what that control does.
    e.preventDefault();
    openDetail(current);
  } else if (e.key === '/') {
    e.preventDefault();
    showSearch();
  } else if (e.key === '?') {
    e.preventDefault();
    openKeys();
  } else if (e.key === 'c') {
    copyNewestCode();
  } else if (e.key === 'n') {
    e.preventDefault();
    startCompose();
  } else if (e.key === '.') {
    if (refreshButton) pollNow();
  } else if (e.key === 'Escape' && current) {
    clearSelection();
  } else if (current) {
    // These act on the selected message from wherever the focus is: after a
    // click it rests on the row's own link, and that must not switch them off.
    if (e.repeat) return;
    const row = rowByKey(current) || (findItem(current) && rowOfItem(findItem(current)));
    if (!row) return;
    const key = rowKey(row);
    if (e.key === 'e') { e.preventDefault(); complete(key, document.querySelector('li.row[data-key="' + CSS.escape(current) + '"]'), Boolean(row.handledAt)); }
    else if (e.key === 'r') { e.preventDefault(); startReply(key, 'reply'); }
    else if (e.key === 'a') { e.preventDefault(); startReply(key, 'replyAll'); }
    else if (e.key === 'f') { e.preventDefault(); startForward(key); }
    else if (e.key === 'y') { e.preventDefault(); mailAction(key, 'archive'); }
    else if (e.key === 's') { e.preventDefault(); mailAction(key, (flagsByKey.get(key) || {}).flagged ? 'unstar' : 'star'); }
    else if (e.key === '#') { e.preventDefault(); mailAction(key, 'trash'); }
  }
});

// ---- When the theme or the language changes, every part follows ----
function themeChanged() { redrawMessages(); }
function languageChanged() {
  sessionDrawn = '';
  sessionChanged();
  drawAnswer();
  if (sheet.open && openKey) {
    const item = findItem(openKey);
    if (item) showInSheet(item, openKey);
  }
  if (notifySheet.open) renderNotify();
  if (keysSheet.open) { closeSheet(keysSheet, false); }
  if (composeSheet.open && composing) {
    $('#compose-title').textContent = t(composing.titleKey);
    drawChips();
    drawSignature();
    drawFiles();
    drawLost();
  }
  // The server words this device's notifications; tell it the language moved.
  if (pushPrefs.subscribed) currentPush().then((sub) => { if (sub) savePush(sub); }).catch(() => {});
}

// ---- Ambient ----
window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 4);
  if (window.scrollY < 200 && freshCount) clearArrivals();
}, { passive: true });
window.addEventListener('offline', () => { setNetworkIssue(true); closeStream(); });
window.addEventListener('online', () => { setNetworkIssue(false); load(); chrome(); openStream(); });
// The since-you-last-looked line is drawn from the moment the page was last put away.
function rememberSeen() { writeStorage('seenAt', new Date().toISOString()); }
document.addEventListener('visibilitychange', () => {
  // A hidden page holds no line open: a phone in a pocket should not keep a
  // connection, and a browser allows only so many per site.
  if (document.hidden) { rememberSeen(); closeStream(); return; }
  sinceAt = Date.parse(readStorage('seenAt') || '') || sinceAt;
  refresh();
  chrome();
  openStream();
});
window.addEventListener('pagehide', rememberSeen);
// The minute timer is the fallback: with the live line up it only keeps the
// relative times honest, and without one it is how new mail is found.
setInterval(() => {
  if (document.hidden) return;
  if (live) renderList(); else { refresh(); chrome(); }
}, 60000);
setInterval(renderStatus, 30000);

readUrl();
markSegs();
applyTheme(readTheme());
if (connectionProblem) setNetworkIssue(true);
// What was here last time is drawn at once; the server's answer replaces it.
restoreSnapshot();
wordPlaceholders();
renderAll();
sessionChanged();
load();
chrome();
openStream();
readPush();
`;
}
