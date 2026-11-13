/**
 * The composer part of the page script: answering a message, passing one on,
 * or writing one.
 *
 * It is the first thing in this page that speaks to the outside world under
 * the owner's name, so it is built to be hard to regret:
 *
 * - Nothing leaves at the tap. "Send" starts a five-second count with a way
 *   back, the same pause the big mail clients settled on, and only then is
 *   the message handed to the server.
 * - Nothing is lost. What is being written is kept on this device as it is
 *   typed, per message, and is still there after a closed sheet, a refused
 *   send or a reload. Files are the exception, and the page says so: their
 *   bytes stay in this page until the letter leaves, and a draft keeps only
 *   their names, so that what is restored can say what to add again.
 * - The model drafts, the person sends. A draft arrives in the text field,
 *   to be read and changed; there is no path from the model to the mail
 *   server that does not pass through the send button.
 * - What is shown is what is sent. The signature under the text, the files
 *   as chips, the quote or the forwarded message under them: the letter is
 *   put together from exactly these, in this order, when it leaves.
 *
 * String.raw: the script below is written as it runs. It must hold no
 * backtick and no dollar sign followed by a brace.
 */
export function composePart(): string {
  return String.raw`
// ---- Writing: a reply, a forward, or a new message ----
const composeForm = $('#compose-form');
const composeNote = $('#compose-note');
const composeSend = $('#compose-send');
const composeQuoted = $('#compose-quoted');
const composeSig = $('#compose-sig');
const composeFiles = $('#compose-files');
const composePictures = $('#compose-pictures');
const composeLost = $('#compose-lost');
const filePicker = $('#compose-file');
// What is being written: { mode ('reply', 'replyAll', 'forward' or 'new'),
// key, account, accountName, titleKey, references, quoted (an answer's
// quote, or the forwarded message), canSend, signature (as shown, and so as
// sent), noSignature, files (added here), lost (the names of files a
// restored draft had, still to be added again), originals (all of a
// forward's own files, by reference), originalsUnlisted (they could not be
// listed), choice (which of those were put on or taken off by hand),
// forwardFailed (why the message to forward could not be read), warned
// (what Send last said the letter would go without) }.
let composing = null;
// A letter's draft lives under the message it answers or forwards, or under
// "new". Once it has been sent off it moves to a name of its own (see
// sendCompose), so a message begun in the meantime has its own draft and
// neither removes the other's. A forward and an answer to the same message
// are two letters, with a draft each.
const homeId = (state) => 'draft:' + (state && state.mode === 'forward' ? 'fwd:' : '') + (state && state.key ? state.key : 'new');
const draftId = (state) => (state && state.draftKey) || homeId(state);
// Files added to a letter, by the name its draft is kept under (draftId), for
// as long as this page is open. A draft on this device keeps only their
// names; the files themselves can be held only here, so a letter closed and
// opened again still has them, and only a new page has to ask for them
// again. They move with the draft: a letter sent off takes its files to its
// own name, and they go back to the message's only with its words, so a
// letter begun in the meantime never gets another letter's files.
const heldFiles = new Map();
const isAnswer = (state) => Boolean(state) && (state.mode === 'reply' || state.mode === 'replyAll');
// A new message and a forward choose the mailbox they leave from; an answer
// leaves from the one that was written to.
const choosesFrom = (state) => Boolean(state) && (state.mode === 'new' || state.mode === 'forward');
const fromOf = (state) => (choosesFrom(state) && composeForm.account ? composeForm.account.value : state.account) || '';
function composeSay(text, failed) {
  composeNote.textContent = text || '';
  composeNote.classList.toggle('failed', Boolean(failed));
}
// A second thing to say, beside a restored draft's line and its Discard
// button rather than instead of them.
function composeAdd(text, failed) {
  if (!composeNote.textContent) { composeSay(text, failed); return; }
  composeNote.appendChild(el('span', 'compose-why' + (failed ? ' failed' : ''), ' ' + text));
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
// What one letter may carry, as the server holds it to: the summary says.
function letterLimits() {
  const l = (lastSummary && lastSummary.limits) || {};
  return {
    bytes: Number(l.attachmentBytes) > 0 ? Number(l.attachmentBytes) : 20 * 1024 * 1024,
    files: Number(l.attachmentFiles) > 0 ? Number(l.attachmentFiles) : 20,
    signature: Number(l.signatureChars) > 0 ? Number(l.signatureChars) : 2000,
  };
}

// ---- The letter as it leaves ----
// What was written, then the signature under the standard delimiter (two
// dashes and a space on a line of their own, which mail clients know to set
// apart), then what the letter carries along: the original quoted, for an
// answer, or the forwarded message. The server puts MCP's letters together
// the same way. A forward may say nothing of its own, and then starts with
// the signature rather than with blank lines.
function letterText(body, signature, carried) {
  let out = String(body || '').replace(/\s+$/, '');
  if (signature && signature.trim()) out += (out ? '\n\n' : '') + '-- \n' + signature;
  if (carried) out += (out ? '\n\n' : '') + carried;
  return out;
}
// What a letter is, for telling whether it changed since it was last sent
// off: everything it says, and its files by what identifies them (their bytes
// are read only when it leaves). Taking one off, adding one, or changing a
// word makes it another letter, with another name.
function letterKey(payload, files) {
  return JSON.stringify([payload, (files || []).map((f) => [f.name, f.type, f.size, f.at])]);
}

// ---- Drafts ----
function saveDraft() {
  if (!composing) return;
  const added = composing.files || [];
  // The files themselves stay with this page, under the letter's draft; a
  // letter with none left (taken off, or the draft discarded) holds none.
  if (added.length) heldFiles.set(draftId(composing), { files: added });
  else heldFiles.delete(draftId(composing));
  const fields = {
    to: composeForm.to.value, cc: composeForm.cc.value, bcc: composeForm.bcc.value,
    subject: composeForm.subject.value, text: composeForm.text.value,
    // Which mailbox a new message or a forward leaves from is part of the letter.
    account: composeForm.account ? composeForm.account.value : '',
    // Files are not kept on this device: only their names, to say what to add
    // again. Those a restored draft is still owed are kept named until they
    // are added, however often it is saved in between.
    files: added.map((f) => f.name).concat(composing.lost || []),
    at: Date.now(),
  };
  if (composing.noSignature) fields.noSignature = true;
  // A forward's own files are references; what was put on or taken off by hand stays so.
  if (composing.mode === 'forward') fields.choice = composing.choice || {};
  if (fields.account) composing.from = fields.account;
  // An empty letter is not a draft worth keeping. A forward that names whom
  // it is for already says something, even with no words of its own, and so
  // does a letter something was attached to.
  const worth = fields.text.trim() || fields.files.length
    || (composing.mode === 'new' && (fields.to.trim() || fields.subject.trim()))
    || (composing.mode === 'forward' && fields.to.trim());
  if (!worth) {
    try { localStorage.removeItem(draftId(composing)); } catch (e) {}
    return;
  }
  writeStorage(draftId(composing), JSON.stringify(fields));
}
// Files the letter was meant to carry and does not have: those a restored
// draft had, which this page does not, and a forward's own when they could
// not be listed. Said in a line of its own under the files, so that nothing
// else said in the composer (an undo, a refused send) takes it away, until
// every one of them is attached again.
// Sentences in a row: a space between them in English, none in Chinese,
// whose full stop already ends the sentence.
function sentenceGap() { return lang === 'zh-CN' ? '' : ' '; }
function drawLost() {
  const owed = composing ? composing.lost || [] : [];
  const words = [];
  if (owed.length) words.push(fill('compose.filesNotKept', { list: owed.join(', ') }));
  if (composing && composing.mode === 'forward' && composing.originalsUnlisted) words.push(t('compose.forwardFilesUnavailable'));
  const containers = composing && composing.mode === 'forward' ? composing.notForwardable || [] : [];
  if (containers.length) words.push(fill('compose.cannotForward', { list: containers.join(', ') }));
  composeLost.hidden = !words.length;
  composeLost.textContent = words.join(sentenceGap());
}
// What a letter would go without that it was meant to carry, in words, or
// ''. The first press of Send says it and sends nothing; a second press,
// with nothing changed, sends the letter without them. A forward through
// MCP is refused the same way until it is told to go without its files.
function missingWords(state) {
  const owed = state.lost || [];
  const words = [];
  if (owed.length) words.push(fill('compose.sendWithoutFiles', { list: owed.join(', ') }));
  if (state.mode === 'forward' && state.originalsUnlisted) words.push(t('compose.sendWithoutOriginals'));
  if (state.mode === 'forward' && (state.notForwardable || []).length) {
    words.push(fill('compose.sendWithoutContainers', { list: state.notForwardable.join(', ') }));
  }
  return words.length ? words.concat(t('compose.sendAnyway')).join(sentenceGap()) : '';
}
function readDraft(state) {
  try { return JSON.parse(readStorage(draftId(state)) || 'null'); } catch (e) { return null; }
}
let draftTimer;
composeForm.addEventListener('input', (e) => {
  if (e.target === composeForm.text) growText();
  // The model's instruction and the signature being edited are not the letter.
  if (e.target === composeForm.instruction || composeSig.contains(e.target)) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
});
composeForm.addEventListener('submit', (e) => e.preventDefault());

// ---- Cc and Bcc: one switch for both ----
function showCopies() {
  $('#compose-cc-row').hidden = false;
  $('#compose-bcc-row').hidden = false;
  $('#compose-cc-toggle').hidden = true;
}

// ---- The signature: one per mailbox, kept on the server ----
// Saved here a moment ago: a summary that was already on its way when the
// signature was saved still carries the old one, and must not bring it back.
const savedSignatures = new Map();
function signatureOf(address) {
  const saved = savedSignatures.get(address);
  if (saved && Date.now() - saved.at < 60000) return saved.text;
  const a = ((lastSummary && lastSummary.accounts) || []).find((entry) => entry.address === address);
  return a && typeof a.signature === 'string' ? a.signature : '';
}
function rememberSignature(address, text) {
  const a = ((lastSummary && lastSummary.accounts) || []).find((entry) => entry.address === address);
  if (a) a.signature = text;
}
// Under the body, what goes under it: the signature of the mailbox the
// letter leaves from, which can be changed here for every letter from that
// mailbox, or left out of this one.
function drawSignature() {
  const state = composing;
  const editing = composeSig.querySelector('textarea');
  // Redrawn while being edited (another language): what was typed stays.
  const typed = editing ? editing.value : null;
  composeSig.replaceChildren();
  const from = state ? fromOf(state) : '';
  composeSig.hidden = !from;
  if (!from) return;
  const text = state.signature || '';
  const line = el('div', 'sig-line');
  const button = (key, run, strong) => {
    const b = el('button', 'text-btn small' + (strong ? '' : ' quiet'), t(key));
    b.type = 'button';
    b.onclick = run;
    line.appendChild(b);
    return b;
  };
  if (state.editingSignature) {
    const area = document.createElement('textarea');
    area.rows = 3;
    area.value = typed !== null ? typed : text;
    area.setAttribute('aria-label', fill('compose.sigFor', { account: from }));
    area.spellcheck = false;
    const said = el('span', 'sig-said');
    said.setAttribute('role', 'status');
    const save = button('compose.sigSave', () => storeSignature(state, from, area, said, [save, cancel]), true);
    const cancel = button('compose.sigCancel', () => closeSignatureEditor(state));
    line.appendChild(said);
    area.addEventListener('keydown', (e) => {
      // Inside the editor these keys are the editor's: saving it, or leaving
      // it, never sending the letter or closing the sheet.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); save.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSignatureEditor(state); }
    });
    composeSig.appendChild(area);
    composeSig.appendChild(el('p', 'sig-hint', fill('compose.sigHint', { account: from })));
    composeSig.appendChild(line);
    composeSig.classList.add('editing');
    return;
  }
  composeSig.classList.remove('editing');
  if (!text) button('compose.sigAdd', () => openSignatureEditor(state));
  else if (state.noSignature) {
    line.appendChild(el('span', 'sig-off', t('compose.sigOmitted')));
    button('compose.sigPutBack', () => { state.noSignature = false; drawSignature(); saveDraft(); focusSignature(); });
  } else {
    composeSig.appendChild(el('pre', 'sig-text', '-- \n' + text));
    button('compose.sigEdit', () => openSignatureEditor(state));
    button('compose.sigOmit', () => { state.noSignature = true; drawSignature(); saveDraft(); focusSignature(); });
  }
  composeSig.appendChild(line);
}
// After a press that redrew the block, the focus goes to its first button
// rather than to the top of the page.
function focusSignature() {
  const target = composeSig.querySelector('button');
  if (target) target.focus({ preventScroll: true });
}
function openSignatureEditor(state) {
  if (composing !== state) return;
  state.editingSignature = true;
  drawSignature();
  const area = composeSig.querySelector('textarea');
  if (area) { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }
}
function closeSignatureEditor(state) {
  state.editingSignature = false;
  if (composing !== state) return;
  drawSignature();
  focusSignature();
}
async function storeSignature(state, from, area, said, buttons) {
  const text = area.value;
  const most = letterLimits().signature;
  // Characters as a person counts them, as the server does.
  if (Array.from(text.trim()).length > most) { said.textContent = fill('error.signature_too_long', { maxChars: most }); return; }
  for (const b of buttons) b.disabled = true;
  said.textContent = '';
  const r = await post('/api/signature', { account: from, text });
  for (const b of buttons) b.disabled = false;
  if (!r.ok) { said.textContent = r.data && (r.data.code || r.data.error) ? failure(r.data) : t('detail.networkFailed'); return; }
  const kept = String(r.data.signature || '');
  savedSignatures.set(from, { text: kept, at: Date.now() });
  rememberSignature(from, kept);
  announce(t('compose.sigSaved'));
  // Every letter from that mailbox signs with it from now on, this one
  // included, unless this one was moved to another mailbox while the save
  // was on its way: then it keeps that mailbox's signature, and whatever is
  // open under the letter now is left as it is.
  const now = composing === state ? fromOf(state) : (choosesFrom(state) && state.from) || state.account;
  if (now !== from) return;
  state.signature = kept;
  state.noSignature = false;
  closeSignatureEditor(state);
}

// ---- Files: added here, or a forward's own ----
// Added files are held in this page until the letter leaves, and read then.
// A forward's are the original's: the server reads them from the mailbox
// when it sends, and they never come to the browser.
let fileSeq = 0;
// Whether one of a forward's own files goes with it. Each goes unless taken
// off, except the pictures of the original's body (logos, icons, a
// signature's portrait), which a plain-text forward would otherwise carry by
// the dozen as files nobody attached: those go only when asked for. The
// server says which they are (inline: an image its markup shows), so that a
// PDF sent inline, as Apple Mail sends one, is a file like any other.
function isOn(state, a) {
  const chosen = (state.choice || {})[a.partId];
  return typeof chosen === 'boolean' ? chosen : !a.inline;
}
const sentOriginals = (state) => (state.originals || []).filter((a) => isOn(state, a));
const attachedCount = (state) => (state.files || []).length + sentOriginals(state).length;
// A forward's sizes are the mailbox's estimate, said a little over.
const attachedBytes = (state) => (state.files || []).reduce((sum, f) => sum + f.size, 0)
  + sentOriginals(state).reduce((sum, a) => sum + (Number(a.size) || 0), 0);
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// The name a file goes out under, as the server will make it: the last part
// of the name only, without control characters or the invisible ones that
// turn text around, and no longer than a mail client shows, shortened before
// its extension.
function cleanFileName(value) {
  const base = String(typeof value === 'string' ? value : '').split(/[\/\\]/).pop() || '';
  const name = base.normalize('NFC').replace(UNSHOWABLE, '').trim();
  if (!name || name === '.' || name === '..') return 'attachment';
  const chars = Array.from(name);
  if (chars.length <= 180) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? Array.from(name.slice(dot)) : [];
  const kept = extension.length > 1 && extension.length <= 16 ? extension : [];
  return chars.slice(0, 180 - kept.length).join('').replace(/\s+$/, '') + kept.join('');
}
const IMAGE_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/svg+xml': 'svg',
};
// What a browser calls every picture it takes from the clipboard.
const GENERIC_IMAGE = /^image\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?)$/i;
// A pasted picture has no name of its own, so each is numbered by the
// letter's pictures so far and named by its type: image-1.png, image-2.jpg.
function pastedName(taken, type) {
  const known = IMAGE_EXTENSIONS[String(type || '').toLowerCase()];
  const sub = /^image\/([a-z0-9]+)$/i.exec(String(type || ''));
  const extension = known || (sub ? sub[1].toLowerCase() : 'png');
  const used = new Set();
  for (const name of taken) {
    const n = /^image-(\d+)\./.exec(name);
    if (n) used.add(Number(n[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return 'image-' + n + '.' + extension;
}
// Whatever stops these files from going, in words, or ''.
function fileProblem(state) {
  const limits = letterLimits();
  if (attachedCount(state) > limits.files) return fill('compose.tooManyFiles', { n: limits.files });
  if (attachedBytes(state) > limits.bytes) return fill('compose.tooLargeAll', { maxBytes: sizeLabel(limits.bytes) });
  return '';
}
function addFiles(list, pasted) {
  const state = composing;
  const given = Array.from(list || []);
  if (!state || !given.length) return;
  // What Send was going to ask about may have changed with the files: ask afresh.
  state.warned = '';
  const limits = letterLimits();
  state.files = state.files || [];
  let refused = '';
  const added = [];
  for (const file of given) {
    if (attachedCount(state) >= limits.files) { refused = fill('compose.tooManyFiles', { n: limits.files }); break; }
    const unnamed = !file.name || (pasted && GENERIC_IMAGE.test(file.name));
    const name = unnamed && /^image\//i.test(file.type || '')
      ? pastedName(state.files.map((f) => f.name), file.type) : cleanFileName(file.name);
    // One that would not fit is refused on its own; a smaller one after it may still go.
    if (attachedBytes(state) + file.size > limits.bytes) {
      refused = fill('compose.tooLarge', { file: name, maxBytes: sizeLabel(limits.bytes) });
      continue;
    }
    fileSeq += 1;
    state.files.push({ id: fileSeq, name, type: file.type || '', size: file.size, at: file.lastModified || 0, file });
    added.push(name);
  }
  // Each file a restored draft is owed is crossed off as it is added again.
  if (state.lost && state.lost.length) {
    const names = state.files.map((f) => f.name);
    state.lost = state.lost.filter((n) => names.indexOf(cleanFileName(n)) === -1);
  }
  drawFiles();
  drawLost();
  saveDraft();
  // The last word about files is the newest: a refusal, or none any more.
  if (refused) { composeSay(refused, true); state.saidFiles = true; }
  else if (state.saidFiles) { composeSay(''); state.saidFiles = false; }
  if (added.length) announce(fill('compose.attachedFile', { name: added.join(', ') }));
}
// A forward's own file put on or taken off by hand, which the draft remembers.
function chooseOriginal(state, partId, on) {
  state.choice = Object.assign({}, state.choice || {});
  state.choice[partId] = on;
}
function removeFile(state, item, at) {
  if (item.partId) chooseOriginal(state, item.partId, false);
  else state.files = (state.files || []).filter((f) => f !== item);
  filesChanged(state);
  announce(fill('compose.removedFile', { name: item.partId ? item.filename : item.name }));
  // The focus stays in the list, on the chip that took this one's place, or goes back to Attach.
  const buttons = composeFiles.querySelectorAll('.file-remove, .file-back');
  const next = buttons[Math.min(at, buttons.length - 1)];
  (next || $('#compose-attach')).focus({ preventScroll: true });
}
function putBack(state, item) {
  chooseOriginal(state, item.partId, true);
  filesChanged(state);
  announce(fill('compose.attachedFile', { name: item.filename }));
  // The file put back moves to where the files that go are listed: the focus
  // follows it there, to its own Remove, rather than staying at the place it
  // left, where another file's Remove now is.
  const buttons = composeFiles.querySelectorAll('.file-remove, .file-back');
  const next = buttons[fileItems(state).indexOf(item)];
  if (next) next.focus({ preventScroll: true });
}
// After a file went on or came off: what is shown, what is kept, and whether
// the letter can still go is said again.
function filesChanged(state) {
  const problem = fileProblem(state);
  if (problem) { composeSay(problem, true); state.saidFiles = true; }
  else if (state.saidFiles) { composeSay(''); state.saidFiles = false; }
  drawFiles();
  saveDraft();
}
// The chips, in order: a forward's own files that are going, then those
// taken off (still there to be put back), then the ones added here. Pictures
// of the original's body that are not going are one line under them, not a
// chip each.
function fileItems(state) {
  const originals = state ? state.originals || [] : [];
  return originals.filter((a) => isOn(state, a))
    .concat(originals.filter((a) => !a.inline && !isOn(state, a)))
    .concat(state ? state.files || [] : []);
}
function drawFiles() {
  composeFiles.replaceChildren();
  composePictures.replaceChildren();
  const state = composing;
  const originals = state ? state.originals || [] : [];
  const items = fileItems(state);
  composeFiles.hidden = !items.length;
  items.forEach((item, at) => {
    const name = item.partId ? item.filename : item.name;
    const off = Boolean(item.partId) && !isOn(state, item);
    const chip = el('li', 'compose-file' + (off ? ' off' : ''));
    chip.title = name;
    chip.appendChild(icon('i-clip'));
    chip.appendChild(el('span', 'name', name));
    const size = sizeLabel(item.size);
    if (size) chip.appendChild(el('span', 'size', size));
    const button = el('button', off ? 'file-back text-btn small' : 'file-remove', off ? t('compose.putBack') : null);
    button.type = 'button';
    const label = fill(off ? 'compose.putBackFile' : 'compose.removeFile', { name });
    button.setAttribute('aria-label', label);
    button.title = label;
    if (!off) button.appendChild(icon('i-x'));
    button.onclick = () => (off ? putBack(state, item) : removeFile(state, item, at));
    chip.appendChild(button);
    composeFiles.appendChild(chip);
  });
  const pictures = originals.filter((a) => a.inline && !isOn(state, a));
  composePictures.hidden = !pictures.length;
  if (!pictures.length) return;
  const one = pictures.length === 1;
  composePictures.appendChild(el('span', null, fill(one ? 'compose.picturesOff1' : 'compose.picturesOff', { n: pictures.length })));
  const include = el('button', 'text-btn quiet small', t(one ? 'compose.includePicture' : 'compose.includePictures'));
  include.type = 'button';
  include.onclick = () => {
    for (const a of pictures) chooseOriginal(state, a.partId, true);
    filesChanged(state);
    announce(fill('compose.attachedFile', { name: pictures.map((a) => a.filename).join(', ') }));
    const first = composeFiles.querySelector('.file-remove');
    if (first) first.focus({ preventScroll: true });
  };
  composePictures.appendChild(include);
}
$('#compose-attach').onclick = () => { if (composing) filePicker.click(); };
filePicker.addEventListener('change', () => {
  addFiles(filePicker.files, false);
  filePicker.value = '';
});
// Files and pictures pasted into the letter are attached. A paste that
// carries words as well (a copy from a document, which may bring a picture
// of itself along) pastes the words; one whose only words are the files' own
// names (a copy in the file manager) attaches the files.
composeForm.text.addEventListener('paste', (e) => {
  const data = e.clipboardData;
  const files = data && data.files ? Array.from(data.files) : [];
  if (!files.length) return;
  const words = (data.getData('text/plain') || '').trim();
  if (words && !files.every((f) => f.name && words.indexOf(f.name) !== -1)) return;
  e.preventDefault();
  addFiles(files, true);
});
// Files dropped on the composer are attached. Dropped anywhere else they
// would replace the page with the file, so a file is never dropped there.
const carriesFiles = (e) => Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
let dropTimer;
window.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  const here = composeSheet.open && Boolean(composing);
  e.dataTransfer.dropEffect = here ? 'copy' : 'none';
  if (!here) return;
  // Lit while a file is held over it: dragover repeats while it is.
  composeSheet.classList.add('dropping');
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => composeSheet.classList.remove('dropping'), 160);
});
window.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  clearTimeout(dropTimer);
  composeSheet.classList.remove('dropping');
  if (composeSheet.open && composing) addFiles(e.dataTransfer.files, false);
});

// ---- Opening the composer ----
function drawChips() {
  const box = $('#compose-chips');
  box.replaceChildren();
  // Offered only for an answer: each is an instruction for the draft.
  if (!isAnswer(composing)) return;
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
  // Named for what it is, and reworded with the page.
  const summary = composeQuoted.querySelector('summary');
  summary.dataset.i18n = state.mode === 'forward' ? 'compose.forwarded' : 'compose.quoted';
  summary.textContent = t(summary.dataset.i18n);
  composeQuoted.querySelector('pre').textContent = has ? state.quoted : '';
}
function openCompose(state) {
  composing = state;
  composeForm.reset();
  $('#compose-title').textContent = t(state.titleKey);
  composeSay('');
  // Back after an undo or a refusal, the letter is asked about again before
  // it goes without what it lacks: what was said then is no longer on show.
  state.warned = '';
  composeSend.disabled = false;
  const from = $('#compose-from'), value = $('#compose-from-value');
  value.replaceChildren();
  const kept = readDraft(state);
  if (choosesFrom(state)) {
    const select = document.createElement('select');
    select.name = 'account';
    select.setAttribute('aria-label', t('compose.from'));
    const sendable = ((lastSummary && lastSummary.accounts) || []).filter((a) => a.canSend);
    for (const a of sendable) select.appendChild(new Option(a.name + ' <' + a.address + '>', a.address));
    value.appendChild(select);
    // The mailbox chosen before an undo, a failed send or a closed draft is
    // still the one chosen; a forward starts from the one the original reached.
    const chosen = state.from || (kept && kept.account) || (state.mode === 'forward' ? state.account : '') || '';
    if (chosen && sendable.some((a) => a.address === chosen)) select.value = chosen;
    select.onchange = () => {
      state.from = select.value;
      // Each mailbox signs as its own.
      state.signature = signatureOf(select.value);
      state.editingSignature = false;
      drawSignature();
    };
    if (!sendable.length) {
      const off = ((lastSummary && lastSummary.accounts) || []).some((a) => a.sendReason === 'disabled');
      composeSay(t(off ? 'compose.sendingOff' : 'compose.cantSend'), true);
      composeSend.disabled = true;
    }
  } else value.textContent = state.accountName ? state.accountName + ' <' + state.account + '>' : state.account;
  from.hidden = false;
  $('#compose-cc-row').hidden = true;
  $('#compose-bcc-row').hidden = true;
  $('#compose-cc-toggle').hidden = false;
  $('#compose-ai').hidden = !session.assistant;
  $('#compose-draft').textContent = t('compose.draft');
  drawChips();
  showQuoted(state);
  // Files are held only by the page that added them. A letter closed and
  // begun again takes them back from where this page holds them, under its
  // draft's name; in a new page they are gone, and the draft's names say
  // which to add again. Only a letter opened for the first time takes them:
  // one reopened after an undo or a refused send still has its own. What it
  // took is its own from then on, so a file taken off, or a draft discarded,
  // is not offered again the next time it is opened.
  const held = heldFiles.get(draftId(state));
  if (!state.opened && !(state.files && state.files.length) && held && held.files.length) {
    state.files = held.files.slice();
    heldFiles.set(draftId(state), { files: state.files });
  }
  state.opened = true;
  let lost = [];
  if (kept) {
    composeForm.text.value = kept.text || '';
    if (kept.to) composeForm.to.value = kept.to;
    if (kept.cc) composeForm.cc.value = kept.cc;
    if (kept.bcc) composeForm.bcc.value = kept.bcc;
    if (kept.cc || kept.bcc) showCopies();
    if (kept.subject) composeForm.subject.value = kept.subject;
    if (kept.noSignature) state.noSignature = true;
    if (kept.choice && typeof kept.choice === 'object' && !state.choice) {
      state.choice = {};
      for (const part of Object.keys(kept.choice)) {
        if (/^\d+(\.\d+)*$/.test(part) && typeof kept.choice[part] === 'boolean') state.choice[part] = kept.choice[part];
      }
    }
    const have = (state.files || []).map((f) => f.name);
    if (Array.isArray(kept.files)) lost = kept.files.filter((n) => typeof n === 'string' && have.indexOf(n) === -1);
    // Something of the person's own came back, which they may not want: words, or files to find again.
    if ((kept.text || '').trim() || lost.length) {
      composeSay(t('compose.restored'));
      const discard = el('button', 'text-btn quiet small', t('compose.discard'));
      discard.type = 'button';
      // What was restored goes, files and all; whom it is for stays.
      discard.onclick = () => {
        composeForm.text.value = '';
        state.files = [];
        state.lost = [];
        drawFiles();
        drawLost();
        saveDraft();
        composeSay('');
        growText();
        composeForm.text.focus();
      };
      composeNote.appendChild(discard);
    }
  }
  // Said until every one of them is attached again.
  state.lost = lost;
  drawLost();
  if (typeof state.signature !== 'string') state.signature = signatureOf(fromOf(state));
  state.editingSignature = false;
  drawSignature();
  drawFiles();
  if (!composeSheet.open) openSheet(composeSheet, {});
  growText();
  setTimeout(() => {
    if (!composeSheet.open) return;
    (choosesFrom(state) && !composeForm.to.value ? composeForm.to : composeForm.text).focus();
  }, 80);
}
// What the server says about the mailbox an answer or a forward leaves from.
function cannotSend(d) {
  composeSay(d.reason === 'oauth_scope' ? fill('compose.cantSendScope', { account: d.account || '' })
    : d.reason === 'disabled' ? t('compose.sendingOff') : t('compose.cantSend'), true);
  composeSend.disabled = true;
}
// The signature the server just read for that mailbox is the freshest there
// is: shown, unless it is being edited or the letter has left that mailbox.
function takeSignature(state, d) {
  if (typeof d.signature !== 'string') return;
  const address = d.account || state.account;
  if (!savedSignatures.has(address)) rememberSignature(address, d.signature);
  if (composing === state && !state.editingSignature && fromOf(state) === address) {
    state.signature = signatureOf(address);
    drawSignature();
  }
}
// The answer's envelope, worked out by the server from the message itself.
function fillCompose(d) {
  if (!composing) return;
  const state = composing;
  state.references = d.references || [];
  state.quoted = d.quoted || '';
  state.canSend = d.canSend !== false;
  if (!composeForm.to.value) composeForm.to.value = (d.to || []).join(', ');
  // A message that names nobody to answer: the person chooses, and is told why the line is empty.
  if (!composeForm.to.value && d.addressedTo === 'recipients') {
    composeAdd(t('compose.noAddressee'));
    // Into To, unless the person has started on the body meanwhile.
    const letter = state, body = composeForm.text.value;
    setTimeout(() => {
      if (!composeSheet.open || composing !== letter || composeForm.to.value) return;
      if (composeForm.text.value !== body) return;
      if (document.activeElement && document.activeElement !== composeForm.text && document.activeElement !== document.body) return;
      composeForm.to.focus();
    }, 120);
  }
  if (!composeForm.cc.value && d.cc && d.cc.length) {
    composeForm.cc.value = d.cc.join(', ');
    showCopies();
  }
  if (!composeForm.subject.value) composeForm.subject.value = d.subject || '';
  showQuoted(state);
  takeSignature(state, d);
  if (!state.canSend) cannotSend(d);
}
// A forward's start: its subject, the forwarded message, and the original's
// files, offered to be sent on (each can be taken off, and put back).
function fillForward(d) {
  if (!composing) return;
  const state = composing;
  state.quoted = d.forwarded || '';
  state.originals = (Array.isArray(d.attachments) ? d.attachments : [])
    .filter((a) => a && typeof a.partId === 'string')
    .map((a) => ({ partId: a.partId, filename: cleanFileName(a.filename), contentType: a.contentType || '', size: a.size, inline: Boolean(a.inline) }));
  if (!composeForm.subject.value) composeForm.subject.value = d.subject || '';
  showQuoted(state);
  drawFiles();
  takeSignature(state, d);
  // Files that could not be listed are said under the files, where an undo
  // or a refused send does not take the line away, and asked about at Send.
  state.originalsUnlisted = Boolean(d.attachmentsUnavailable);
  // A file that holds other parts (Apple Mail's AppleDouble) cannot go on as
  // one file. Said under the files, and asked about at Send, like the above.
  state.notForwardable = (Array.isArray(d.notForwardable) ? d.notForwardable : [])
    .map((a) => cleanFileName(a && a.filename)).filter(Boolean);
  drawLost();
  const problem = fileProblem(state);
  if (problem) { composeAdd(problem, true); state.saidFiles = true; }
}
async function startReply(key, mode) {
  if (!requireWrite()) return;
  const row = rowByKey(key);
  if (!row) return;
  const state = {
    mode, key, account: row.account, accountName: row.accountLabel || '',
    titleKey: mode === 'replyAll' ? 'act.replyAll' : 'act.reply',
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
// Passing a message on: nobody is filled in, since a forward goes to someone
// the original never named.
async function startForward(key) {
  if (!requireWrite()) return;
  const row = rowByKey(key);
  if (!row) return;
  const state = {
    mode: 'forward', key, account: row.account, accountName: row.accountLabel || '', titleKey: 'act.forward',
    files: [], originals: [],
  };
  openCompose(state);
  // Why the message could not be read is kept, to be said again if Send is
  // pressed: nothing is still on its way that waiting would bring.
  const failed = (why) => { state.forwardFailed = why; if (composing === state) composeSay(why, true); };
  try {
    // The forwarded message's header lines in the page's language.
    const r = await fetch('/api/forward?key=' + encodeURIComponent(key) + '&language=' + encodeURIComponent(lang));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { failed(failure(d)); return; }
    if (composing !== state) return;
    fillForward(d);
  } catch (e) {
    failed(t('detail.networkFailed'));
  }
}
function startCompose() {
  if (!requireWrite()) return;
  openCompose({ mode: 'new', key: '', titleKey: 'compose.new', files: [] });
}
$('#compose-open').onclick = startCompose;
$('#compose-cancel').onclick = () => { saveDraft(); closeSheet(composeSheet, false); };
$('#compose-cc-toggle').onclick = () => {
  showCopies();
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
  // A forward's note is a new letter about the message, not an answer to its sender.
  const r = await post('/api/draft', {
    key: isAnswer(state) ? state.key : '', instruction: composeForm.instruction.value, subject: composeForm.subject.value,
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
// message, words and files together, unless another letter was begun there
// in the meantime: then it keeps the name it was sent off under, and so do
// its files, and the other letter keeps its own.
function reclaimDraft(state) {
  const own = state.draftKey;
  if (!own) return;
  state.draftKey = null;
  const home = draftId(state);
  try {
    const kept = localStorage.getItem(own);
    if (localStorage.getItem(home) !== null || heldFiles.has(home)) { state.draftKey = own; return; }
    if (kept !== null) { localStorage.setItem(home, kept); localStorage.removeItem(own); }
  } catch (e) {
    state.draftKey = own;
    return;
  }
  const held = heldFiles.get(own);
  if (held) { heldFiles.delete(own); heldFiles.set(home, held); }
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
  const to = addresses(composeForm.to.value), cc = addresses(composeForm.cc.value), bcc = addresses(composeForm.bcc.value);
  const body = composeForm.text.value.replace(/\s+$/, '');
  const forward = state.mode === 'forward';
  if (!to.length) { composeSay(t('compose.needTo'), true); composeForm.to.focus(); return; }
  // A forward may go without a word of its own: the message it carries is the point.
  if (!body.trim() && !forward) { composeSay(t('compose.needBody'), true); composeForm.text.focus(); return; }
  if (forward && !state.quoted) {
    // Read and refused, it will not come by waiting; still on its way, it may.
    composeSay(state.forwardFailed ? fill('compose.forwardUnreadable', { reason: state.forwardFailed }) : t('compose.forwardMissing'), true);
    return;
  }
  // The signature on show is the one in the editor, not the one the letter
  // would carry: it is saved, or put away, before the letter can go.
  if (state.editingSignature) {
    composeSay(t('compose.sigUnsaved'), true);
    const area = composeSig.querySelector('textarea');
    if (area) area.focus();
    return;
  }
  const problem = fileProblem(state);
  if (problem) { composeSay(problem, true); state.saidFiles = true; return; }
  // Going without something it was meant to carry ("see attached" with
  // nothing attached) is asked about once; the same press again sends it.
  const missing = missingWords(state);
  // The confirming press counts only once the question has been on show for
  // a moment: a double click or a doubled Ctrl+Enter must not answer it unread.
  if (missing && (state.warned !== missing || Date.now() - (state.warnedAt || 0) < 700)) {
    if (state.warned !== missing) { state.warned = missing; state.warnedAt = Date.now(); composeSay(missing, true); }
    return;
  }
  const from = fromOf(state);
  const payload = {
    account: from, to, cc, bcc, subject: composeForm.subject.value.trim(),
    // Put together as it is shown: the text, the signature, then the quote or the forwarded message.
    text: letterText(body, state.noSignature ? '' : state.signature, state.quoted || ''),
  };
  if (forward) {
    payload.forwardOf = state.key;
    // The original's files by reference: the server reads them from the mailbox.
    payload.forwardAttachments = sentOriginals(state).map((a) => a.partId);
  } else if (state.key) { payload.replyTo = state.key; payload.references = state.references || []; }
  const files = (state.files || []).slice();
  // Each letter has a name. If the server does not confirm in time and the
  // same letter is sent again unchanged, the server recognises it and says
  // what became of the first attempt instead of sending a second copy. A
  // letter that was edited since, or carries other files, is a different letter.
  const written = letterKey(payload, files);
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
  // Its files go with it, and come back with it if it is taken back.
  const held = heldFiles.get(draftId(state));
  if (held && draftId(state) !== own) { heldFiles.delete(draftId(state)); heldFiles.set(own, held); }
  state.draftKey = own;
  // Another letter still counting leaves now: there is one way back on show at a time.
  if (pendingSend) { clearInterval(pendingSend.timer); deliver(pendingSend); }
  closeSheet(composeSheet, false);
  const job = { payload, files, state, left: SEND_DELAY, timer: null };
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
// A file as base64, read only as the letter leaves: holding the bytes through
// the count would cost memory for a letter that may yet be taken back.
function base64Of(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      resolve(comma === -1 ? '' : url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}
async function readFiles(files) {
  const out = [];
  for (const f of files) {
    try { out.push({ name: f.name, type: f.type, data: await base64Of(f.file) }); }
    catch (e) { return { failed: f.name }; }
  }
  return { attachments: out };
}
// Why a send was refused, naming the file when the server named one. An
// answer that is not mailsift's own came from something in front of it: a
// proxy that refuses a request of this size before mailsift sees it, or one
// that stopped waiting (504; 524 from Cloudflare) while the letter may still
// have been on its way, which is not the mail server being out of reach.
function sendFailure(d, status) {
  if (!d || !(d.code || d.error)) {
    if (status === 413) return fill('compose.proxyTooLarge', { maxBytes: sizeLabel(letterLimits().bytes) });
    if (status === 504 || status === 524) return t('error.send_timeout');
    // The letter took longer to upload than the server waits for one: it
    // never arrived whole, so nothing was sent, and the mail server was not
    // asked anything.
    if (status === 408) return t('compose.uploadTooSlow');
    return t('error.send_connection');
  }
  if (d.code === 'send_too_large' && d.file) return fill('compose.tooLarge', { file: d.file, maxBytes: sizeLabel(d.maxBytes) });
  if (d.code === 'forward_attachment_unavailable' && d.file) return fill('compose.forwardFileUnavailable', { file: d.file });
  return failure(d);
}
// Back to the letter, with the reason, and everything that was written.
function backToLetter(job, said) {
  hideToast();
  reclaimDraft(job.state);
  openCompose(job.state);
  composeSay(said, true);
}
async function deliver(job) {
  if (pendingSend === job) pendingSend = null;
  hideSending();
  toast(t('compose.sendingNow'), false, null, 0);
  let payload = job.payload;
  if (job.files.length) {
    const read = await readFiles(job.files);
    // A file moved or deleted since it was added: nothing leaves without it.
    if (read.failed) { backToLetter(job, fill('compose.fileUnreadable', { file: read.failed })); return; }
    payload = Object.assign({}, job.payload, { attachments: read.attachments });
  }
  // Sent from a page that is being put away, the request is marked to outlive it.
  const leaving = document.hidden && bytesOf(JSON.stringify(payload)) < KEEPALIVE_BYTES;
  const r = await post('/api/send', payload, leaving ? { keepalive: true } : {});
  if (!r.ok) { backToLetter(job, sendFailure(r.data, r.status)); return; }
  try { localStorage.removeItem(draftId(job.state)); } catch (e) {}
  // Gone with the letter: nothing to attach again.
  heldFiles.delete(draftId(job.state));
  const refused = Array.isArray(r.data.rejected) ? r.data.rejected : [];
  toast(refused.length ? fill('compose.partial', { list: refused.join(', ') }) : t(r.data.savedCopy === false ? 'compose.sentNoCopy' : 'compose.sent'),
    refused.length > 0);
  if (job.state.key) {
    // The message as the mailbox now has it is read afresh next time.
    liveData.delete(job.state.key);
    // An answered or forwarded message is dealt with, when the server says
    // so: a forward to nobody but the owner's own mailboxes is not.
    if (r.data.handled === true) {
      const counted = attentionSet.has(job.state.key) && !(rowByKey(job.state.key) || {}).handledAt;
      markHandledLocal(job.state.key, new Date().toISOString());
      if (counted) attentionCount = Math.max(0, attentionCount - 1);
    }
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
// to, and otherwise goes back to being the draft of its message. One with
// files added from this device stays a draft too: they are read as it
// leaves, and a page that is closing cannot wait for that. A forward's own
// files are only named in the request, and the server reads them, so a
// forward that is small enough goes with them.
window.addEventListener('pagehide', () => {
  const job = pendingSend;
  if (!job) return;
  clearInterval(job.timer);
  pendingSend = null;
  const body = JSON.stringify(job.payload);
  if (job.files.length || bytesOf(body) >= KEEPALIVE_BYTES) { reclaimDraft(job.state); return; }
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
