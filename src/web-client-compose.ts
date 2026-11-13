/**
 * The composer part of the page script: answering a message, or writing one.
 *
 * It is the first thing in this page that speaks to the outside world under
 * the owner's name, so it is built to be hard to regret:
 *
 * - Nothing leaves at the tap. "Send" starts a five-second count with a way
 *   back, the same pause the big mail clients settled on, and only then is
 *   the message handed to the server.
 * - Nothing is lost. What is being written is kept on this device as it is
 *   typed, per message, and is still there after a closed sheet, a refused
 *   send or a reload.
 * - The model drafts, the person sends. A draft arrives in the text field,
 *   to be read and changed; there is no path from the model to the mail
 *   server that does not pass through the send button.
 *
 * String.raw: the script below is written as it runs. It must hold no
 * backtick and no dollar sign followed by a brace.
 */
export function composePart(): string {
  return String.raw`
// ---- Writing: a reply, or a new message ----
const composeForm = $('#compose-form');
const composeNote = $('#compose-note');
const composeSend = $('#compose-send');
const composeQuoted = $('#compose-quoted');
// What is being written: { mode, key, account, accountName, title, references, quoted, canSend }.
let composing = null;
// A letter's draft lives under the message it answers, or under "new". Once
// it has been sent off it moves to a name of its own (see sendCompose), so a
// message begun in the meantime has its own draft and neither removes the other's.
const draftId = (state) => (state && state.draftKey) || 'draft:' + (state && state.key ? state.key : 'new');
function composeSay(text, failed) {
  composeNote.textContent = text || '';
  composeNote.classList.toggle('failed', Boolean(failed));
}
// "Ann <ann@x.org>, bo@y.org" → the addresses alone; the server checks each one.
// A comma inside a quoted name ("Doe, John" <john@x.org>) is part of the name.
function addresses(value) {
  const out = [];
  let part = '', quoted = false, angled = false;
  const take = () => {
    const angle = /<([^<>]+)>/.exec(part);
    const address = (angle ? angle[1] : part.replace(/"[^"]*"/g, '')).trim();
    if (address) out.push(address);
    part = '';
  };
  for (const ch of String(value || '')) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angled = true;
    else if (!quoted && ch === '>') angled = false;
    if (!quoted && !angled && (ch === ',' || ch === ';' || ch === '\n')) { take(); continue; }
    part += ch;
  }
  take();
  return out;
}
function growText() {
  const area = composeForm.text;
  area.style.height = 'auto';
  area.style.height = Math.min(Math.max(area.scrollHeight, 160), Math.round(innerHeight * 0.5)) + 'px';
}
function saveDraft() {
  if (!composing) return;
  const fields = {
    to: composeForm.to.value, cc: composeForm.cc.value, subject: composeForm.subject.value, text: composeForm.text.value,
    // Which mailbox a new message leaves from is part of the letter.
    account: composeForm.account ? composeForm.account.value : '', at: Date.now(),
  };
  if (fields.account) composing.from = fields.account;
  // An empty letter is not a draft worth keeping.
  if (!fields.text.trim() && (composing.mode !== 'new' || (!fields.to.trim() && !fields.subject.trim()))) {
    try { localStorage.removeItem(draftId(composing)); } catch (e) {}
    return;
  }
  writeStorage(draftId(composing), JSON.stringify(fields));
}
function readDraft(state) {
  try { return JSON.parse(readStorage(draftId(state)) || 'null'); } catch (e) { return null; }
}
let draftTimer;
composeForm.addEventListener('input', (e) => {
  if (e.target === composeForm.text) growText();
  if (e.target === composeForm.instruction) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
});
composeForm.addEventListener('submit', (e) => e.preventDefault());

function drawChips() {
  const box = $('#compose-chips');
  box.replaceChildren();
  // Offered only for an answer: each is an instruction for the draft.
  if (!composing || composing.mode === 'new') return;
  for (const key of ['chip.accept', 'chip.decline', 'chip.later', 'chip.thanks']) {
    const chip = el('button', 'chip', t(key));
    chip.type = 'button';
    chip.onclick = () => { composeForm.instruction.value = t(key); aiDraft(); };
    box.appendChild(chip);
  }
}
function showQuoted(state) {
  const has = Boolean(state.quoted);
  composeQuoted.hidden = !has;
  composeQuoted.open = false;
  composeQuoted.querySelector('pre').textContent = has ? state.quoted : '';
}
function openCompose(state) {
  composing = state;
  composeForm.reset();
  $('#compose-title').textContent = state.title;
  composeSay('');
  composeSend.disabled = false;
  const from = $('#compose-from'), value = $('#compose-from-value');
  value.replaceChildren();
  if (state.mode === 'new') {
    // A new message chooses its mailbox; an answer leaves from the one that was written to.
    const select = document.createElement('select');
    select.name = 'account';
    select.setAttribute('aria-label', t('compose.from'));
    const sendable = ((lastSummary && lastSummary.accounts) || []).filter((a) => a.canSend);
    for (const a of sendable) select.appendChild(new Option(a.name + ' <' + a.address + '>', a.address));
    value.appendChild(select);
    // The mailbox chosen before an undo, a failed send or a closed draft is still the one chosen.
    const kept = readDraft(state);
    const chosen = state.from || (kept && kept.account) || '';
    if (chosen && sendable.some((a) => a.address === chosen)) select.value = chosen;
    select.onchange = () => { state.from = select.value; };
    if (!sendable.length) { composeSay(t('compose.cantSend'), true); composeSend.disabled = true; }
  } else value.textContent = state.accountName ? state.accountName + ' <' + state.account + '>' : state.account;
  from.hidden = false;
  $('#compose-cc-row').hidden = true;
  $('#compose-cc-toggle').hidden = false;
  $('#compose-ai').hidden = !session.assistant;
  $('#compose-draft').textContent = t('compose.draft');
  drawChips();
  showQuoted(state);
  const kept = readDraft(state);
  if (kept) {
    composeForm.text.value = kept.text || '';
    if (kept.to) composeForm.to.value = kept.to;
    if (kept.cc) { composeForm.cc.value = kept.cc; $('#compose-cc-row').hidden = false; $('#compose-cc-toggle').hidden = true; }
    if (kept.subject) composeForm.subject.value = kept.subject;
    if ((kept.text || '').trim()) {
      composeSay(t('compose.restored'));
      const discard = el('button', 'text-btn quiet small', t('compose.discard'));
      discard.type = 'button';
      discard.onclick = () => { composeForm.text.value = ''; saveDraft(); composeSay(''); growText(); composeForm.text.focus(); };
      composeNote.appendChild(discard);
    }
  }
  if (!composeSheet.open) openSheet(composeSheet, {});
  growText();
  setTimeout(() => {
    if (!composeSheet.open) return;
    (state.mode === 'new' && !composeForm.to.value ? composeForm.to : composeForm.text).focus();
  }, 80);
}
// The answer's envelope, worked out by the server from the message itself.
function fillCompose(d) {
  if (!composing) return;
  composing.references = d.references || [];
  composing.quoted = d.quoted || '';
  composing.canSend = d.canSend !== false;
  if (!composeForm.to.value) composeForm.to.value = (d.to || []).join(', ');
  if (!composeForm.cc.value && d.cc && d.cc.length) {
    composeForm.cc.value = d.cc.join(', ');
    $('#compose-cc-row').hidden = false;
    $('#compose-cc-toggle').hidden = true;
  }
  if (!composeForm.subject.value) composeForm.subject.value = d.subject || '';
  showQuoted(composing);
  if (!composing.canSend) {
    composeSay(d.reason === 'oauth_scope' ? fill('compose.cantSendScope', { account: d.account || '' }) : t('compose.cantSend'), true);
    composeSend.disabled = true;
  }
}
async function startReply(key, mode) {
  if (!requireWrite()) return;
  const row = rowByKey(key);
  if (!row) return;
  const state = {
    mode, key, account: row.account, accountName: row.accountLabel || '',
    title: t(mode === 'replyAll' ? 'act.replyAll' : 'act.reply'),
  };
  openCompose(state);
  try {
    const r = await fetch('/api/reply?mode=' + mode + '&key=' + encodeURIComponent(key));
    const d = await r.json().catch(() => ({}));
    // This very letter, not another one to the same message opened since:
    // a reply must not be filled in with a reply-all's recipients.
    if (composing !== state) return;
    if (!r.ok) { composeSay(failure(d), true); return; }
    fillCompose(d);
  } catch (e) {
    if (composing === state) composeSay(t('detail.networkFailed'), true);
  }
}
function startCompose() {
  if (!requireWrite()) return;
  openCompose({ mode: 'new', key: '', title: t('compose.new') });
}
$('#compose-open').onclick = startCompose;
$('#compose-cancel').onclick = () => { saveDraft(); closeSheet(composeSheet, false); };
$('#compose-cc-toggle').onclick = () => {
  $('#compose-cc-row').hidden = false;
  $('#compose-cc-toggle').hidden = true;
  composeForm.cc.focus();
};

// ---- A first version from the model ----
async function aiDraft() {
  const button = $('#compose-draft');
  if (!composing || button.disabled) return;
  const state = composing;
  button.disabled = true;
  button.textContent = t('compose.drafting');
  composeSay('');
  const r = await post('/api/draft', {
    key: state.key || '', instruction: composeForm.instruction.value, subject: composeForm.subject.value,
  });
  button.disabled = false;
  button.textContent = t('compose.redraft');
  if (composing !== state) return;
  if (!r.ok) { composeSay(r.data && (r.data.code || r.data.error) ? failure(r.data) : t('error.assistant_failed'), true); return; }
  writeIn(String(r.data.draft || ''));
}
// The draft is written into the field rather than dropped in, so it reads as
// something that is being offered, and is finished before anyone could tire of it.
function writeIn(text) {
  const area = composeForm.text;
  const finish = () => { area.value = text; growText(); saveDraft(); };
  if (reduceMotion() || !text) { finish(); return; }
  const started = performance.now();
  const total = Math.min(900, 240 + text.length * 2);
  const step = (now) => {
    if (!composeSheet.open) { finish(); return; }
    const part = Math.min(1, (now - started) / total);
    area.value = text.slice(0, Math.round(text.length * part));
    growText();
    if (part < 1) requestAnimationFrame(step); else finish();
  };
  requestAnimationFrame(step);
}
$('#compose-draft').onclick = aiDraft;
composeForm.instruction.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); aiDraft(); }
});

// ---- Sending: a count of five with a way back, then the server ----
const SEND_DELAY = 5;
function letterId() {
  const bytes = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
}
let pendingSend = null;
// The count has an element of its own. Sharing the toast meant that marking
// something done during the five seconds took the way back away with it.
const sendingNode = $('#sending');
function hideSending() {
  sendingNode.hidden = true;
  if (sendingNode.hidePopover) { try { sendingNode.hidePopover(); } catch (e) {} }
}
// A letter that did not leave after all goes back to being the draft of its
// message, unless another letter was begun there in the meantime.
function reclaimDraft(state) {
  const own = state.draftKey;
  if (!own) return;
  state.draftKey = null;
  const home = draftId(state);
  try {
    const kept = localStorage.getItem(own);
    if (kept === null) return;
    if (localStorage.getItem(home) === null) { localStorage.setItem(home, kept); localStorage.removeItem(own); }
    else state.draftKey = own;
  } catch (e) {}
}
function undoSend(job) {
  if (pendingSend !== job) return;
  clearInterval(job.timer);
  pendingSend = null;
  hideSending();
  reclaimDraft(job.state);
  openCompose(job.state);
  composeSay(t('compose.undone'));
}
function sendCompose() {
  if (!composing || composeSend.disabled) return;
  const state = composing;
  // A second press while this letter is already counting down (the sheet
  // takes a moment to close) is the same press, not a second letter.
  if (pendingSend && pendingSend.state === state) return;
  const to = addresses(composeForm.to.value), cc = addresses(composeForm.cc.value);
  const text = composeForm.text.value.replace(/\s+$/, '');
  if (!to.length) { composeSay(t('compose.needTo'), true); composeForm.to.focus(); return; }
  if (!text.trim()) { composeSay(t('compose.needBody'), true); composeForm.text.focus(); return; }
  const payload = {
    account: state.mode === 'new' ? (composeForm.account ? composeForm.account.value : '') : state.account,
    to, cc, subject: composeForm.subject.value.trim(),
    text: state.quoted ? text + '\n\n' + state.quoted : text,
  };
  if (state.key) { payload.replyTo = state.key; payload.references = state.references || []; }
  // Each letter has a name. If the server does not confirm in time and the
  // same letter is sent again unchanged, the server recognises it and says
  // what became of the first attempt instead of sending a second copy. A
  // letter that was edited since is a different letter.
  const written = JSON.stringify(payload);
  if (state.sentAs !== written) { state.sentAs = written; state.sendId = letterId(); }
  payload.id = state.sendId;
  clearTimeout(draftTimer);
  saveDraft();
  // On its way: the draft moves to a name of its own, so that a message begun
  // during the count starts empty and delivery removes only this letter.
  const own = 'draft:sending:' + state.sendId;
  try {
    const kept = localStorage.getItem(draftId(state));
    if (kept !== null && draftId(state) !== own) { localStorage.setItem(own, kept); localStorage.removeItem(draftId(state)); }
  } catch (e) {}
  state.draftKey = own;
  // Another letter still counting leaves now: there is one way back on show at a time.
  if (pendingSend) { clearInterval(pendingSend.timer); deliver(pendingSend); }
  closeSheet(composeSheet, false);
  const job = { payload, state, left: SEND_DELAY, timer: null };
  pendingSend = job;
  const words = () => fill('compose.sending', { n: job.left });
  const line = el('span', null, words());
  const undo = el('button', 'toast-action', t('undo'));
  undo.type = 'button';
  undo.onclick = () => undoSend(job);
  sendingNode.replaceChildren(line, undo);
  raiseToast(sendingNode);
  announce(words());
  job.timer = setInterval(() => {
    job.left -= 1;
    if (job.left > 0) { line.textContent = words(); return; }
    clearInterval(job.timer);
    deliver(job);
  }, 1000);
}
// How large a request is on the wire. A browser lets about 64 KB leave with a
// page that is going away, counted in bytes: Chinese text is three per character.
const bytesOf = (text) => { try { return new Blob([text]).size; } catch (e) { return text.length * 3; } };
const KEEPALIVE_BYTES = 60000;
async function deliver(job) {
  if (pendingSend === job) pendingSend = null;
  hideSending();
  toast(t('compose.sendingNow'), false, null, 0);
  // Sent from a page that is being put away, the request is marked to outlive it.
  const leaving = document.hidden && bytesOf(JSON.stringify(job.payload)) < KEEPALIVE_BYTES;
  const r = await post('/api/send', job.payload, leaving ? { keepalive: true } : {});
  if (!r.ok) {
    // Back to the letter, with the reason, and everything that was written.
    hideToast();
    reclaimDraft(job.state);
    openCompose(job.state);
    composeSay(r.data && (r.data.code || r.data.error) ? failure(r.data) : t('error.send_connection'), true);
    return;
  }
  try { localStorage.removeItem(draftId(job.state)); } catch (e) {}
  const refused = Array.isArray(r.data.rejected) ? r.data.rejected : [];
  toast(refused.length ? fill('compose.partial', { list: refused.join(', ') }) : t(r.data.savedCopy === false ? 'compose.sentNoCopy' : 'compose.sent'),
    refused.length > 0);
  if (job.state.key) {
    // An answered message is a dealt-with message.
    const counted = attentionSet.has(job.state.key) && !(rowByKey(job.state.key) || {}).handledAt;
    markHandledLocal(job.state.key, new Date().toISOString());
    if (counted) attentionCount = Math.max(0, attentionCount - 1);
    liveData.delete(job.state.key);
  }
  if (typeof r.data.attention === 'number') attentionCount = r.data.attention;
  renderList();
  renderLede();
  renderBars();
  updateBadge();
}
// Putting the page away during the count sends the letter rather than leaving
// it to a timer that may never run again: a phone that is locked, or an app
// that is switched away from, stops its timers and may be discarded.
document.addEventListener('visibilitychange', () => {
  const job = pendingSend;
  if (!document.hidden || !job) return;
  clearInterval(job.timer);
  deliver(job);
});
// Closing the page outright: the letter goes with it when it is small enough
// to, and otherwise stays a draft.
window.addEventListener('pagehide', () => {
  const job = pendingSend;
  if (!job) return;
  clearInterval(job.timer);
  pendingSend = null;
  const body = JSON.stringify(job.payload);
  if (bytesOf(body) >= KEEPALIVE_BYTES) return;
  try {
    fetch('/api/send', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body });
    localStorage.removeItem(draftId(job.state));
  } catch (e) {}
});
// Drafts of letters that were sent off and never heard of again (the page was
// closed mid-send) are not kept for ever.
try {
  for (const key of Object.keys(localStorage)) {
    if (key.indexOf('draft:sending:') !== 0) continue;
    let at = 0;
    try { at = Number((JSON.parse(localStorage.getItem(key) || '{}') || {}).at) || 0; } catch (e) {}
    if (Date.now() - at > 24 * 3600 * 1000) localStorage.removeItem(key);
  }
} catch (e) {}
composeSend.onclick = sendCompose;
composeForm.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendCompose(); }
});
`;
}
