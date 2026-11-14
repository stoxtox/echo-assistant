// Small DOM helpers every view uses (split out of public/app.js).

/** @param {string} id */
export const $ = (id) => document.getElementById(id);
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const el = (tag, props = {}, text = '') => Object.assign(document.createElement(tag), props, text ? { textContent: text } : {});
export const button = (label, cls, onclick) => Object.assign(el('button', { className: cls, type: 'button' }, label), { onclick });
/** A button that shows it's working and can't be double-clicked while `fn` runs. */
export function actionButton(label, cls, fn) {
  const b = button(label, cls, async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await fn(); } finally { b.disabled = false; }
  });
  return b;
}

// A row of one-character boxes that fills like a single field: typing moves on, Backspace moves
// back, arrows move, and pasting spreads the characters across the boxes.
export function segmentedInput(length, onChange) {
  const wrap = el('div', { className: 'segs', role: 'group' });
  const boxes = Array.from({ length }, (_, i) => {
    const b = el('input', { className: 'seg', maxLength: 1, autocomplete: 'off', spellcheck: false, inputMode: 'text' });
    b.setAttribute('autocapitalize', 'characters');
    b.setAttribute('aria-label', `Character ${i + 1} of ${length}`);
    return b;
  });
  const clean = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (from, text) => {
    let i = from;
    for (const ch of clean(text)) { if (i >= length) break; boxes[i++].value = ch; }
    boxes.forEach((b) => b.classList.toggle('filled', !!b.value));
    boxes[Math.min(i, length - 1)].focus();
    onChange(value());
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      const v = clean(b.value);
      b.value = '';
      if (v) fill(i, v);
      else { b.classList.remove('filled'); onChange(value()); }
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && i > 0) { e.preventDefault(); boxes[i - 1].value = ''; boxes[i - 1].classList.remove('filled'); boxes[i - 1].focus(); onChange(value()); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
      else if (e.key === 'ArrowRight' && i < length - 1) { e.preventDefault(); boxes[i + 1].focus(); }
    });
    b.addEventListener('paste', (e) => { e.preventDefault(); fill(i, e.clipboardData?.getData('text') || ''); });
    b.addEventListener('focus', () => b.select());
  });
  wrap.append(...boxes);
  return { el: wrap, value, focus: () => boxes[Math.min(value().length, length - 1)].focus() };
}

export function step(n, title, bodyNodes) {
  const node = el('section', { className: 'step' });
  node.append(el('span', { className: 'step-num' }, String(n)), el('div', { className: 'step-title' }, title), el('div', { className: 'step-body' }));
  node.querySelector('.step-body').append(...bodyNodes);
  return node;
}

/** POST JSON to one of the server's routes; throws its error message when it refuses. */
export async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/** A short note at the bottom of the window for a few seconds. */
let toastTimer = null;
export function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 2600);
}
