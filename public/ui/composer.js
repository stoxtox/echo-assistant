// The message box (split out of public/app.js): typing, Enter to send, and images by paste, drag
// and drop or the paperclip, shrunk in the page and uploaded before the message goes.
import { $, el, toast } from './dom.js';
import { send } from './socket.js';

/** What app.js does when a typed message goes (the send sound; a question is answered). */
let onTyped = () => {};
/** @param {() => void} fn */
export const setOnTyped = (fn) => void (onTyped = fn);
const els = { typeForm: $('typeForm'), typeInput: $('typeInput'), main: document.querySelector('main'), attachBtn: $('attachBtn'), fileInput: $('fileInput'), attachTray: $('attachTray'), dropVeil: $('dropVeil'), hero: $('hero'), sendBtn: $('sendBtn') };

// The message box grows with what you type (up to 40% of the window, then scrolls). Enter
// sends, Shift+Enter starts a new line. Images come in by paste, drag and drop or the paperclip;
// each is shrunk in the page (about 1600px, under 1.5MB), uploaded right away and sent with
// the message by reference.
const MAX_EDGE = 1600;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGES = 6;
/** @type {Array<{ key: number, preview: string, id: string | null, failed: boolean, ready: Promise<void>, node: HTMLElement }>} */
let attachments = [];
let attachKey = 0;

// Send is quiet until there's something to send.
export function syncSend() {
  els.sendBtn.disabled = !els.typeInput.value.trim() && !attachments.some((a) => !a.failed);
}
export function growInput() {
  const t = els.typeInput;
  t.style.height = 'auto';
  const max = Math.round(window.innerHeight * 0.4);
  t.style.height = `${Math.min(t.scrollHeight, max)}px`;
  t.classList.toggle('scrolls', t.scrollHeight > max);
}
els.typeInput.addEventListener('input', () => { syncSend(); growInput(); });
window.addEventListener('resize', growInput);
els.typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.typeForm.requestSubmit();
  }
});

/**
 * Shrink an image to fit MAX_EDGE and MAX_BYTES. Small PNG/WebP/GIF files that already fit are
 * kept as they are (screenshots stay crisp, GIFs keep moving); everything else becomes a JPEG.
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const fits = Math.max(bmp.width, bmp.height) <= MAX_EDGE && file.size <= MAX_BYTES;
  if (fits && /^image\/(png|webp|gif|jpeg)$/.test(file.type)) { bmp.close(); return file; }
  let scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // JPEG has no transparency
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.88, 0.8, 0.7]) {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) { bmp.close(); return blob; }
    }
    scale *= 0.8;
  }
  bmp.close();
  throw new Error('Image is too large');
}

async function uploadImage(blob) {
  const res = await fetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'Upload failed');
  return out;
}

/** @param {Iterable<File>} files */
function addImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return false;
  const room = MAX_IMAGES - attachments.length;
  if (images.length > room) toast(room > 0 ? `Only ${MAX_IMAGES} images per message; added the first ${room}.` : `Only ${MAX_IMAGES} images per message.`);
  for (const file of images.slice(0, Math.max(0, room))) {
    const key = ++attachKey;
    const preview = URL.createObjectURL(file);
    const node = el('div', { className: 'thumb busy' });
    const img = el('img', { src: preview, alt: file.name || 'Pasted image' });
    const rm = el('button', { type: 'button', className: 'rm', title: 'Remove' });
    rm.setAttribute('aria-label', `Remove ${file.name || 'image'}`);
    rm.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    rm.onclick = () => removeAttachment(key);
    node.append(img, rm);
    const item = { key, preview, id: null, failed: false, node, ready: null };
    item.ready = shrinkImage(file)
      .then(uploadImage)
      .then((out) => { item.id = out.id; node.classList.remove('busy'); })
      .catch((e) => {
        item.failed = true;
        node.classList.remove('busy');
        node.classList.add('failed');
        node.title = `Couldn't attach: ${e.message}`;
        toast(`Couldn't attach ${file.name || 'that image'}: ${e.message}`);
        syncSend();
      });
    attachments.push(item);
    els.attachTray.append(node);
  }
  els.attachTray.hidden = !attachments.length;
  syncSend();
  return true;
}
function removeAttachment(key) {
  const item = attachments.find((a) => a.key === key);
  if (!item) return;
  attachments = attachments.filter((a) => a !== item);
  item.node.remove();
  URL.revokeObjectURL(item.preview);
  els.attachTray.hidden = !attachments.length;
  syncSend();
  els.typeInput.focus();
}
function clearAttachments() {
  for (const a of attachments) { a.node.remove(); URL.revokeObjectURL(a.preview); }
  attachments = [];
  els.attachTray.hidden = true;
}

els.attachBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = () => { addImages(els.fileInput.files || []); els.fileInput.value = ''; els.typeInput.focus(); };
els.typeInput.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) {
    // Pasting a screenshot attaches it; any text in the clipboard still pastes as text.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addImages(files);
  }
});
// Drag images anywhere over the chat.
const convo = els.hero.parentElement;
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
convo.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; els.dropVeil.hidden = false; });
convo.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
convo.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropVeil.hidden = true; } });
convo.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropVeil.hidden = true;
  if (!addImages(e.dataTransfer.files)) toast('Only images can be attached.');
  els.typeInput.focus();
});

let sending = false;
els.typeForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = els.typeInput.value.trim();
  if (sending || (!text && !attachments.some((a) => !a.failed))) return;
  sending = true;
  try {
    await Promise.all(attachments.map((a) => a.ready));
    const images = attachments.filter((a) => a.id).map((a) => a.id);
    if (!text && !images.length) return;
    onTyped(); // the send sound; a question Echo asked is answered by typing
    send({ type: 'user_text', text, typed: true, ...(images.length ? { images } : {}) });
    els.typeInput.value = '';
    clearAttachments();
  } finally {
    sending = false;
    syncSend();
    growInput();
  }
};

/** Images in a chat bubble; each opens full size in a new tab. */
export function imageGrid(urls) {
  const grid = el('div', { className: `msg-images${urls.length === 1 ? ' one' : ''}` });
  grid.style.setProperty('--cols', String(Math.min(3, urls.length)));
  for (const url of urls) {
    const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
    a.append(el('img', { src: url, alt: 'Attached image' }));
    grid.append(a);
  }
  return grid;
}

/** Put text in the message box, ready to edit or send (never sent by itself). */
export function putInComposer(text) {
  if (els.main.dataset.view !== 'chat') document.querySelector('.tab[data-view="chat"]')?.dispatchEvent(new Event('click'));
  els.typeInput.value = text;
  syncSend();
  growInput();
  els.typeInput.focus();
  els.typeInput.setSelectionRange(text.length, text.length);
}
