// @ts-nocheck: page code, run in the browser on whatever elements a page has (loosely typed by design).
// Runs inside the page (chrome.scripting.executeScript with func): the snapshot of interactive
// elements with refs, and reading one back. lib/browser.js runs these same functions over Chrome's
// DevTools protocol (SNAPSHOT_FN / READBACK_FN are made from them), so the two never drift.
//
// Each function is self-contained (Chrome sends only its source to the page): no imports, no
// helpers from outside it.
//
// Frames: rich-text editors often live in an iframe (eBay's description box, TinyMCE, CKEditor:
// an about:blank or same-site document in design mode). Every function here looks into the
// page's same-origin iframes as well as the page, with boxes in the top page's coordinates, so a
// real click lands on them. A cross-origin iframe can't be read from here (the extension reads it
// on its own, with allFrames: focusInFrame and textInFrame below).

/** Interactive elements on screen, each tagged data-echo-ref="<snapshot>:<ref>". */
export function snapshotPage() {
  const snap = 's' + Date.now().toString(36);
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=textbox],[role=combobox],[role=searchbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  // The page and its same-origin iframes, each with where its viewport sits in the top page.
  const docs = [{ doc: document, dx: 0, dy: 0, frame: null }];
  for (let i = 0; i < docs.length && docs.length < 25; i++) {
    for (const f of docs[i].doc.getElementsByTagName('iframe')) {
      let d = null;
      try { d = f.contentDocument; } catch {}
      if (!d || !d.documentElement) continue;
      const fr = f.getBoundingClientRect();
      if (fr.width < 2 || fr.height < 2) continue;
      docs.push({ doc: d, dx: docs[i].dx + fr.left + f.clientLeft, dy: docs[i].dy + fr.top + f.clientTop, frame: f });
    }
  }
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r === 'search' ? 'searchbox' : r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea' || el.isContentEditable || (t === 'body' && el.ownerDocument.designMode === 'on')) return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image', 'file'].includes(ty)) return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      if (ty === 'search') return 'searchbox';
      return 'textbox';
    }
    return 'other';
  };
  const byId = (doc, ids) => ids.split(/\s+/).map((i) => doc.getElementById(i)?.textContent || '').join(' ');
  const attrName = (el) => el && (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && byId(el.ownerDocument, el.getAttribute('aria-labelledby'))) ||
    (el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '');
  // An editor that is the whole document of an iframe goes by the iframe's name.
  const frameName = (f) => (f ? attrName(f) || f.getAttribute('name') || f.id || '' : '').replace(/[_-]+/g, ' ');
  const nameOf = (el, frame) => {
    const own = attrName(el);
    const isDoc = el.tagName === 'BODY' || el.tagName === 'HTML';
    const text = isDoc ? '' : el.tagName === 'INPUT' ? (['button', 'submit'].includes(el.type) ? el.value : '') : el.innerText;
    // An empty editor has no text to go by: its frame's name, or what it is.
    const editor = (isDoc || el.isContentEditable) && !own ? frameName(frame) || (frame ? 'Rich text editor' : '') : '';
    return (own || (isDoc ? editor : text || editor) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  };
  const out = [];
  let n = 0;
  for (const { doc, dx, dy, frame } of docs) {
    const els = [...doc.querySelectorAll(sel)];
    // A document in design mode (or a contenteditable body) is one big field.
    const body = doc.body;
    if (frame && body && (doc.designMode === 'on' || body.isContentEditable) && !els.includes(body)) els.unshift(body);
    const view = doc.defaultView || window;
    for (const el of els) {
      // Inside an editor, its own links and buttons aren't separate things to act on.
      if (el !== body && el.parentElement && el.parentElement.isContentEditable && !el.matches('input,textarea,select')) continue;
      const b = el.getBoundingClientRect();
      const r = { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
      if (r.width < 2 || r.height < 2 || r.y + r.height < 0 || r.x + r.width < 0 || r.y > innerHeight || r.x > innerWidth) continue;
      const cs = view.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const ref = 'e' + ++n;
      el.setAttribute('data-echo-ref', snap + ':' + ref);
      const designed = el === body && (doc.designMode === 'on' || body.isContentEditable);
      const secret = el.type === 'password' || /one-time-code|cc-number|cc-csc/.test(el.autocomplete || '');
      const editable = designed || el.isContentEditable || (['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.readOnly && !['button', 'submit', 'checkbox', 'radio', 'range', 'file', 'image', 'reset'].includes(el.type));
      const value = secret ? '' : designed || el.isContentEditable ? el.innerText : 'value' in el && typeof el.value === 'string' && el.tagName !== 'BUTTON' ? el.value : '';
      out.push({
        ref, role: roleOf(el), name: nameOf(el, frame), value: String(value || '').slice(0, 200), editable, secret,
        checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
        expanded: el.getAttribute('aria-expanded') === 'true' ? true : el.getAttribute('aria-expanded') === 'false' ? false : undefined,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true', focused: doc.activeElement === el && (doc === document || doc.hasFocus()),
        file: el.type === 'file' || undefined,
        ...(frame ? { frame: true } : {}),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      });
      if (n >= 600) break;
    }
    if (n >= 600) break;
  }
  return { snapshot: snap, url: location.href, title: document.title, elements: out };
}

/** One element read back after acting, plus page-level signs of change. Never a password's value. */
export function readBack(key) {
  let el = document.querySelector('[data-echo-ref="' + key + '"]');
  const docs = [document];
  for (let i = 0; !el && i < docs.length && docs.length < 25; i++) {
    for (const f of docs[i].getElementsByTagName('iframe')) {
      let d = null;
      try { d = f.contentDocument; } catch {}
      if (!d) continue;
      docs.push(d);
      el = el || d.querySelector('[data-echo-ref="' + key + '"]');
    }
  }
  const doc = el ? el.ownerDocument : document;
  const secret = el && el.type === 'password';
  const editor = el && (el.isContentEditable || (el.tagName === 'BODY' && doc.designMode === 'on'));
  return {
    exists: Boolean(el), value: el && !secret ? (editor ? el.innerText : el.value ?? '') : '',
    focused: el ? (doc.activeElement === el || el.contains(doc.activeElement)) && (doc === document || doc.hasFocus()) : false,
    expanded: el ? el.getAttribute('aria-expanded') || '' : '', files: el && el.files ? el.files.length : 0,
    url: location.href, title: document.title, nodes: document.getElementsByTagName('*').length,
  };
}

/** Scrolls it into view and says where its centre is (top-page viewport pixels, through frames). */
export function locate(key) {
  let el = document.querySelector('[data-echo-ref="' + key + '"]');
  const docs = [document];
  for (let i = 0; !el && i < docs.length && docs.length < 25; i++) {
    for (const f of docs[i].getElementsByTagName('iframe')) {
      let d = null;
      try { d = f.contentDocument; } catch {}
      if (!d) continue;
      docs.push(d);
      el = el || d.querySelector('[data-echo-ref="' + key + '"]');
    }
  }
  if (!el) return null;
  // The iframes it sits in, innermost first: each is scrolled into view in its own page too.
  const chain = [];
  for (let w = el.ownerDocument.defaultView; w && w !== window && w.frameElement; w = w.frameElement.ownerDocument.defaultView) chain.push(w.frameElement);
  // A whole-document editor: aim at its top-left part, where the text starts (never the middle of a long page).
  const whole = el.tagName === 'BODY' || el.tagName === 'HTML';
  if (!whole) el.scrollIntoView({ block: 'center', inline: 'center' });
  for (const f of chain) f.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  let x = whole ? Math.min(r.x + 24, r.x + r.width / 2) : r.x + r.width / 2;
  let y = whole ? Math.min(r.y + 16, r.y + r.height / 2) : r.y + r.height / 2;
  for (const f of chain) {
    const fr = f.getBoundingClientRect();
    x += fr.left + f.clientLeft;
    y += fr.top + f.clientTop;
  }
  return { x, y, secret: el.type === 'password', frame: chain.length > 0 };
}

/** Puts the caret in it and selects everything it holds (replace mode), in its own document. */
export function selectAllIn(key) {
  let el = document.querySelector('[data-echo-ref="' + key + '"]');
  const docs = [document];
  for (let i = 0; !el && i < docs.length && docs.length < 25; i++) {
    for (const f of docs[i].getElementsByTagName('iframe')) {
      let d = null;
      try { d = f.contentDocument; } catch {}
      if (!d) continue;
      docs.push(d);
      el = el || d.querySelector('[data-echo-ref="' + key + '"]');
    }
  }
  if (!el) return false;
  el.focus?.();
  if (el.select) el.select();
  else el.ownerDocument.execCommand('selectAll');
  return true;
}

/** Without the debugger (DevTools open, or it was declined): the page's own events. */
export function actInPage(key, verb, text, commit) {
  let el = document.querySelector('[data-echo-ref="' + key + '"]');
  const docs = [document];
  for (let i = 0; !el && i < docs.length && docs.length < 25; i++) {
    for (const f of docs[i].getElementsByTagName('iframe')) {
      let d = null;
      try { d = f.contentDocument; } catch {}
      if (!d) continue;
      docs.push(d);
      el = el || d.querySelector('[data-echo-ref="' + key + '"]');
    }
  }
  if (!el) return false;
  if (el.type === 'password') return false;
  const doc = el.ownerDocument;
  const view = doc.defaultView || window;
  const fire = (type, Ctor = view.MouseEvent) => el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view }));
  if (verb === 'click' || verb === 'focus') {
    fire('pointerdown', view.PointerEvent);
    fire('mousedown');
    el.focus?.();
    fire('pointerup', view.PointerEvent);
    fire('mouseup');
    if (verb === 'click') el.click();
  } else if (verb === 'hover') {
    fire('pointerover', view.PointerEvent);
    fire('mouseover');
    fire('mouseenter');
  } else if (verb === 'right_click') {
    fire('contextmenu');
  }
  if (verb === 'fill' || verb === 'replace') {
    el.focus();
    if (verb === 'replace') {
      if (el.select) el.select();
      else doc.execCommand('selectAll');
    }
    if (!doc.execCommand('insertText', false, text)) {
      const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, verb === 'replace' ? text : (el.value || '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  if (commit) {
    const key2 = { enter: 'Enter', tab: 'Tab', comma: ',' }[commit];
    if (key2) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: key2, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: key2, bubbles: true }));
    }
  }
  return true;
}

/**
 * Where the keyboard is in this frame (run in every frame, allFrames): only the frame that has the
 * focus answers with something. Through same-origin iframes it follows the focus down itself.
 * Never says what a password field holds; says only that it is one.
 */
export function focusInFrame() {
  if (!document.hasFocus()) return null;
  let doc = document;
  let el = doc.activeElement;
  let depth = 0;
  while (el && el.tagName === 'IFRAME' && depth++ < 10) {
    let d = null;
    try { d = el.contentDocument; } catch {}
    // A cross-origin frame has the focus: that frame answers for itself.
    if (!d) return { into: 'frame' };
    doc = d;
    el = d.activeElement;
  }
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const designed = (tag === 'body' || tag === 'html') && (doc.designMode === 'on' || el.isContentEditable);
  const secret = el.type === 'password' || /one-time-code|cc-number|cc-csc/.test(el.autocomplete || '');
  const field = ['input', 'textarea'].includes(tag) && !el.readOnly && !['button', 'submit', 'checkbox', 'radio', 'range', 'file', 'image', 'reset'].includes(el.type);
  const editable = designed || el.isContentEditable || field;
  const kind = designed ? 'design_mode' : el.isContentEditable ? 'contenteditable' : field ? tag : tag === 'body' || tag === 'html' ? 'page' : tag;
  const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { editable, secret, kind, name, inFrame: doc !== document || window !== window.top };
}

/**
 * Is this text in an editable place in this frame (or its same-origin iframes)? Run in every
 * frame (allFrames) to check typing or a paste landed where Echo can't read it otherwise.
 * Answers only yes or no and where: never what the page holds.
 */
export function textInFrame(text) {
  const squeeze = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = squeeze(text);
  if (!want) return null;
  const docs = [document];
  for (let i = 0; i < docs.length && docs.length < 25; i++) {
    for (const f of docs[i].getElementsByTagName('iframe')) {
      let d = null;
      try { d = f.contentDocument; } catch {}
      if (d) docs.push(d);
    }
  }
  for (const doc of docs) {
    const places = [...doc.querySelectorAll('textarea,input:not([type=password]):not([type=hidden]),[contenteditable=""],[contenteditable=true]')];
    if (doc.body && (doc.designMode === 'on' || doc.body.isContentEditable)) places.unshift(doc.body);
    for (const el of places) {
      const v = el.isContentEditable || el === doc.body ? el.innerText : el.value;
      if (squeeze(v).includes(want)) return { found: true, kind: el === doc.body ? 'design_mode' : el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase(), inFrame: doc !== document || window !== window.top };
    }
  }
  return { found: false };
}
