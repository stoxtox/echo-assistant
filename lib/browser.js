// The browser adapter: Echo reads and drives web pages through the page itself, not pixels.
//
// Two ways in, one interface (snapshot → act by ref → verify):
// - The Echo Chrome extension (extension/ in this folder). It connects to Echo at
//   ws://127.0.0.1:<port>/ws/browser with a pairing code the user copies once from Echo's
//   Settings. Only a Chrome extension (its Origin is chrome-extension://…) with the right code is
//   accepted; web pages can't connect. It returns a compact snapshot of the active tab's
//   interactive elements with refs (e1, e2…), and acts on a ref with real input (chrome.debugger:
//   Input.dispatchMouseEvent, Input.insertText; DOM.setFileInputFiles for attachments), then
//   reads the page back to check.
// - Chrome's own DevTools protocol (CDP), when Chrome was started with
//   --remote-debugging-port=9222 (CdpBrowser below). Same snapshot and actions, without the
//   extension.
//
// A ref is only good for the snapshot it came from (the Playwright MCP rule): acting on a ref from
// an older snapshot is refused ("stale"), and the assistant takes a new snapshot.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { config } from './config.js';
import { redactText } from './screen.js';
import { writeJson } from './atomic.js';
import { snapshotPage, readBack, locate, selectAllIn } from '../extension/page.js';

/** How long one request to the browser may take. */
export const BROWSER_TIMEOUT_MS = 8000;

/* ---------- the rotor-style snapshot ---------- */

/**
 * @typedef {{ ref: string, role: string, name: string, value?: string, editable?: boolean,
 *   checked?: boolean, expanded?: boolean, disabled?: boolean, focused?: boolean,
 *   rect?: { x: number, y: number, width: number, height: number } }} PageElement
 * @typedef {{ snapshot: string, url: string, title: string, tabId?: number, elements: PageElement[] }} PageSnapshot
 */

const ROLE_ORDER = ['textbox', 'combobox', 'searchbox', 'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch', 'slider', 'listitem', 'row', 'img', 'other'];

/**
 * A snapshot as the assistant reads it: grouped by role, one line each, `[e7] combobox "To
 * recipients" = "…"`, secrets blacked out, at most `max` lines.
 * @param {PageSnapshot} s @param {{ max?: number }} [o]
 */
export function rotor(s, { max = 120 } = {}) {
  const els = (s.elements || []).slice(0, 600);
  const byRole = new Map();
  for (const e of els) {
    const role = ROLE_ORDER.includes(e.role) ? e.role : 'other';
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(e);
  }
  const lines = [`Page: ${redactText(String(s.title || '')).text.slice(0, 120)} (${String(s.url || '').slice(0, 160)}) · snapshot ${s.snapshot}`];
  let n = 0;
  for (const role of ROLE_ORDER) {
    for (const e of byRole.get(role) || []) {
      if (n++ >= max) {
        lines.push(`… ${els.length - max} more (ask for a role, or scroll)`);
        return lines.join('\n');
      }
      const name = redactText(String(e.name || '').replace(/\s+/g, ' ').trim()).text.slice(0, 80);
      const value = e.value ? ` = "${redactText(String(e.value).replace(/\s+/g, ' ')).text.slice(0, 60)}"` : '';
      const flags = [e.focused && 'focused', e.checked && 'checked', e.expanded === true && 'expanded', e.disabled && 'disabled', e.editable && role !== 'textbox' && role !== 'combobox' && role !== 'searchbox' && 'editable'].filter(Boolean);
      lines.push(`[${e.ref}] ${role} "${name}"${value}${flags.length ? ` (${flags.join(', ')})` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * The best element for a label, like the Mac app's LabelMatch but over a page snapshot:
 * exact name, then name prefix, then a word in a short name; a field wins when typing.
 * @param {PageElement[]} els @param {string} label @param {{ wantsField?: boolean }} [o]
 */
export function findByLabel(els, label, { wantsField = false } = {}) {
  const norm = (x) => String(x || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const q = norm(label);
  if (!q) return null;
  let best = null;
  for (const e of els) {
    const n = norm(e.name);
    if (!n) continue;
    let s = n === q ? 100 : n.startsWith(q + ' ') ? 75 : ` ${n} `.includes(` ${q} `) && n.split(' ').length <= Math.max(4, q.split(' ').length * 3) ? 60 : 0;
    if (!s) continue;
    if (e.disabled) s -= 10;
    if (wantsField) s += e.editable ? 30 : -20;
    else if (['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option', 'switch'].includes(e.role)) s += 15;
    if (!best || s > best.s) best = { s, e };
  }
  return best && best.s >= 45 ? best.e : null;
}

/* ---------- the extension, over a WebSocket ---------- */

/** The pairing code the extension needs (made once, kept in the data folder). */
export function pairingCode(file = path.join(config.dataDir, 'browser-pairing.json')) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.code === 'string' && saved.code.length >= 16) return saved.code;
  } catch {}
  const code = randomBytes(12).toString('base64url');
  writeJson(file, { code, createdAt: new Date().toISOString() }, { mode: 0o600, backup: false });
  return code;
}

/**
 * Why this WebSocket isn't let in as the browser extension ('' when it is): only a Chrome
 * extension (never a web page: pages can't claim a chrome-extension:// origin) with the pairing code.
 * 'unpaired': the extension has no code yet (it knocks anyway, so Echo can ask for the pairing).
 * @param {{ origin?: string, url?: string }} req @param {string} code
 * @returns {'' | 'origin' | 'code' | 'unpaired'}
 */
export function extensionRefusal({ origin = '', url = '' }, code) {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(String(origin))) return 'origin';
  let given = '';
  try {
    given = new URL(url, 'http://localhost').searchParams.get('code') || '';
  } catch {
    return 'code';
  }
  if (!given) return 'unpaired';
  if (given.length !== code.length) return 'code';
  let diff = 0;
  for (let i = 0; i < code.length; i++) diff |= code.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? '' : 'code';
}

/**
 * Should this WebSocket be let in as the browser extension?
 * @param {{ origin?: string, url?: string }} req @param {string} code
 */
export function extensionAllowed(req, code) {
  return extensionRefusal(req, code) === '';
}

/** How often Echo checks the extension's socket is still alive (a WebSocket ping it must answer). */
export const EXTENSION_HEARTBEAT_MS = 25000;

/**
 * How long a browser step waits for the extension to come back when it was connected before
 * (Echo just restarted, or the socket dropped a moment ago): it reconnects within a few seconds.
 */
export const RECONNECT_WAIT_MS = 6000;
/** Within this long of Echo starting, or of the last disconnect, a paired extension is expected back. */
export const RECONNECT_WINDOW_MS = 90 * 1000;

/** What Echo remembers about the extension across restarts (never the pairing code itself). */
export function readLink(file = path.join(config.dataDir, 'browser-link.json')) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The extension's connection: requests out, answers back by id.
 *
 * Connected means Echo accepted the socket (right origin, right code) and it's still answering:
 * Echo sends `welcome` as soon as it attaches it (the extension only shows "connected" after
 * that), answers the extension's keep-alive `ping` (which also keeps Chrome's service worker
 * awake), and pings it every EXTENSION_HEARTBEAT_MS; a socket that doesn't answer is dropped, so
 * a sleeping or killed service worker never looks connected. Refused tries are remembered, so
 * "not connected" can say why (the code was wrong, or it never tried).
 */
export class ExtensionBrowser extends EventEmitter {
  /**
   * @param {{ timeoutMs?: number, heartbeatMs?: number, now?: () => number, linkFile?: string | null, reconnectWaitMs?: number }} [o]
   *   linkFile: where the last connection is remembered across restarts (null: nowhere)
   */
  constructor({ timeoutMs = BROWSER_TIMEOUT_MS, heartbeatMs = EXTENSION_HEARTBEAT_MS, now = Date.now, linkFile = path.join(config.dataDir, 'browser-link.json'), reconnectWaitMs = RECONNECT_WAIT_MS } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.now = now;
    this.linkFile = linkFile;
    this.reconnectWaitMs = reconnectWaitMs;
    this.startedAt = now();
    /** The last connection before this start (from the data folder): it was paired and working. */
    this.link = linkFile ? readLink(linkFile) : null;
    /** @type {any} */
    this.ws = null;
    this.pending = new Map();
    this.n = 0;
    this.info = /** @type {{ version?: string, browser?: string } | null} */ (null);
    /** When the current socket was accepted, and when it last said anything. */
    this.since = 0;
    this.lastSeen = 0;
    /** The last time a socket went away, and why. @type {{ at: number, why: string } | null} */
    this.lastDisconnect = null;
    /** The last refused try (wrong code, not an extension). @type {{ at: number, why: string } | null} */
    this.lastRefused = null;
    /** @type {any} */
    this.heartbeat = null;
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  /** A try the server turned away (server.js upgrade). @param {string} why 'code' | 'origin' | 'unpaired' */
  refused(why) {
    const first = !this.lastRefused || this.lastRefused.why !== why || (this.lastDisconnect?.at || 0) > this.lastRefused.at || this.since > this.lastRefused.at;
    this.lastRefused = { at: this.now(), why };
    // The extension knocks every few seconds while it can't get in: say so once, not every time.
    if (first) {
      this.emit('link', { event: 'refused', why });
      this.emit('status', this.status());
    }
  }

  /** It needs (re)pairing: it is knocking without a code, or with one Echo doesn't know. */
  get pairingNeeded() {
    return !this.connected && Boolean(this.lastRefused && ['code', 'unpaired'].includes(this.lastRefused.why) && (!this.lastDisconnect || this.lastRefused.at >= this.lastDisconnect.at) && this.now() - this.lastRefused.at < 120000);
  }

  /** Was it connected before (this run, or before Echo last restarted)? */
  get wasPaired() {
    return Boolean(this.since || this.link?.lastConnectedAt);
  }

  /**
   * Is it likely to be back in a moment? It was working (before this restart, or until a moment
   * ago), Echo started or lost it recently, and nothing says the pairing is wrong.
   */
  expectedBack() {
    if (this.connected || this.pairingNeeded || !this.wasPaired) return false;
    const since = Math.max(this.startedAt, this.lastDisconnect?.at || 0);
    return this.now() - since < RECONNECT_WINDOW_MS;
  }

  /**
   * Connected now, or within `ms` (resolves false if not). A browser step right after Echo
   * restarts waits for the extension to come back instead of falling to Chrome's toolbar.
   * @param {number} [ms]
   */
  waitForConnection(ms = this.reconnectWaitMs) {
    if (this.connected) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve(v);
      };
      const onStatus = () => this.connected && done(true);
      const timer = setTimeout(() => done(this.connected), ms);
      timer.unref?.();
      this.on('status', onStatus);
    });
  }

  /** Remembered in the data folder, so after a restart Echo knows it was paired and working. */
  remember() {
    this.link = { lastConnectedAt: new Date(this.now()).toISOString(), ...(this.info || {}) };
    if (!this.linkFile) return;
    try {
      writeJson(this.linkFile, this.link, { backup: false });
    } catch {}
  }

  /** A new extension connection (an older one is closed). @param {any} ws */
  attach(ws) {
    if (this.ws && this.ws !== ws) try { this.ws.close(1000, 'replaced'); } catch {}
    this.ws = ws;
    this.since = this.lastSeen = this.now();
    this.info = null;
    let alive = true;
    ws.on('pong', () => {
      alive = true;
      this.lastSeen = this.now();
    });
    ws.on('message', (raw) => {
      alive = true;
      this.lastSeen = this.now();
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        return;
      }
      if (m.type === 'hello') {
        this.info = { version: String(m.version || '').slice(0, 20), browser: String(m.browser || '').slice(0, 60) };
        this.remember();
        this.emit('status', this.status());
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok === false) p.reject(Object.assign(new Error(String(m.error || 'The browser said no.').slice(0, 300)), { code: m.code || 'failed' }));
      else p.resolve(m.result);
    });
    const gone = (why) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.lastDisconnect = { at: this.now(), why };
      this.emit('link', { event: 'disconnected', why });
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(Object.assign(new Error('The Echo extension disconnected.'), { code: 'disconnected' }));
        this.pending.delete(id);
      }
      this.emit('status', this.status());
    };
    ws.on('close', (code, reason) => gone(String(reason || '') || (code === 1001 ? 'Chrome closed it' : 'the connection closed')));
    ws.on('error', () => {});
    // The extension shows "connected" only once it has this: Echo accepted it.
    try { ws.send(JSON.stringify({ type: 'welcome' })); } catch {}
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.ws !== ws) return;
      if (!alive) {
        // No answer since the last ping: Chrome's service worker is gone. Drop it (the close
        // handler above marks it disconnected), so status never says connected when it isn't.
        gone('the extension stopped answering');
        try {
          if (ws.terminate) ws.terminate();
          else ws.close();
        } catch {}
        return;
      }
      alive = false;
      try { ws.ping?.(); } catch {}
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
    this.remember();
    this.emit('link', { event: 'connected' });
    this.emit('status', this.status());
  }

  status() {
    const iso = (t) => (t ? new Date(t).toISOString() : undefined);
    return {
      connected: this.connected,
      via: 'extension',
      ...(this.connected ? { ...(this.info || {}), since: iso(this.since), lastSeen: iso(this.lastSeen) } : {}),
      ...(!this.connected && this.lastDisconnect ? { lastDisconnect: { at: iso(this.lastDisconnect.at), why: this.lastDisconnect.why } } : {}),
      ...(!this.connected && this.lastRefused && (!this.lastDisconnect || this.lastRefused.at >= this.lastDisconnect.at) ? { lastRefused: { at: iso(this.lastRefused.at), why: this.lastRefused.why } } : {}),
      ...(!this.connected && this.pairingNeeded ? { pairingNeeded: true } : {}),
      ...(!this.connected && this.expectedBack() ? { reconnecting: true } : {}),
      ...(!this.connected && this.link?.lastConnectedAt ? { lastConnected: this.link.lastConnectedAt } : {}),
    };
  }

  /** Why it isn't connected, in a sentence for the assistant (and the user). */
  explain() {
    if (this.connected) return 'The Echo Chrome extension is connected.';
    const ago = (t) => {
      const s = Math.max(0, Math.round((this.now() - t) / 1000));
      return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
    };
    if (this.lastRefused && (!this.lastDisconnect || this.lastRefused.at >= this.lastDisconnect.at)) {
      if (this.lastRefused.why === 'unpaired') return `The Echo Chrome extension is running but isn't paired yet (it knocked ${ago(this.lastRefused.at)}). Echo's window is showing the pairing code: the user pastes it into the extension's options once.`;
      return this.lastRefused.why === 'code'
        ? `The Echo Chrome extension tried to connect ${ago(this.lastRefused.at)} with the wrong pairing code. Echo's window is showing the code: the user copies it into the extension's options once.`
        : `Something that isn't the Echo Chrome extension tried to connect ${ago(this.lastRefused.at)} and was refused.`;
    }
    if (this.lastDisconnect) return `The Echo Chrome extension disconnected ${ago(this.lastDisconnect.at)} (${this.lastDisconnect.why}); it reconnects by itself within a few seconds while Chrome is open.`;
    const last = this.link?.lastConnectedAt ? Date.parse(this.link.lastConnectedAt) : 0;
    if (last) {
      return `The Echo Chrome extension hasn't reconnected since Echo started ${ago(this.startedAt)} (it was last connected ${ago(last)}, so it is paired). It reconnects by itself within about 30 seconds while Chrome is open; if Chrome is open and it still doesn't, the extension may be turned off or need reloading in chrome://extensions.`;
    }
    return "The Echo Chrome extension hasn't connected since Echo started, and has never connected to this Echo. Chrome may be closed, or the extension not loaded yet (chrome://extensions, Load unpacked, the extension folder inside Echo's folder); once it's loaded, Echo's window asks for the pairing.";
  }

  /** @param {string} cmd @param {object} [args] @returns {Promise<any>} */
  request(cmd, args = {}) {
    if (!this.connected) return Promise.reject(Object.assign(new Error(this.explain()), { code: 'no_browser' }));
    const id = `b${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`The browser didn't answer (${cmd}).`), { code: 'timeout' }));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, cmd, args }));
    });
  }

  snapshot(args = {}) {
    return this.request('snapshot', args);
  }

  act(args) {
    return this.request('act', args);
  }

  tabs() {
    return this.request('tabs');
  }

  activateTab(tabId) {
    return this.request('activate_tab', { tabId });
  }

  navigate(url) {
    return this.request('navigate', { url });
  }

  /** Where the keyboard is in the front tab, through iframes: { editable, secret, kind, inFrame }. */
  focus() {
    return this.request('focus');
  }

  /** Is this text in a field or editor of the front tab (frames too)? { found } */
  findText(text) {
    return this.request('find_text', { text: String(text || '').slice(0, 200) });
  }
}

/* ---------- Chrome's DevTools protocol, directly ---------- */

/**
 * The snapshot the extension takes, as a page expression for Chrome's DevTools protocol: the same
 * function (extension/page.js), so both ways see the page (and its same-origin iframes) alike.
 */
export const SNAPSHOT_FN = `(${snapshotPage.toString()})()`;

/** Reads an element back after acting (its value, or whether the page changed). */
export const READBACK_FN = `(${readBack.toString()})`;

/** Scrolls an element into view and says where its centre is, through iframes. */
export const LOCATE_FN = `(${locate.toString()})`;

/** Selects everything in an element (replace mode), in its own document. */
export const SELECT_ALL_FN = `(${selectAllIn.toString()})`;

/** Chrome's DevTools protocol over its remote-debugging port, for the active page tab. */
export class CdpBrowser extends EventEmitter {
  /** @param {{ port?: number, host?: string, fetchImpl?: typeof fetch, WebSocketImpl?: any, timeoutMs?: number }} [o] */
  constructor({ port = 9222, host = '127.0.0.1', fetchImpl = fetch, WebSocketImpl = WebSocket, timeoutMs = BROWSER_TIMEOUT_MS } = {}) {
    super();
    this.base = `http://${host}:${port}`;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    /** @type {any} */
    this.ws = null;
    this.target = '';
    this.n = 0;
    this.pending = new Map();
  }

  /** The front page tab's debugger address, or null when Chrome isn't listening. */
  async pageTarget() {
    try {
      const res = await this.fetchImpl(`${this.base}/json/list`, { signal: AbortSignal.timeout(800) });
      const list = await res.json();
      return (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /^https?:/.test(t.url)) || null;
    } catch {
      return null;
    }
  }

  async available() {
    return Boolean(await this.pageTarget());
  }

  async connect() {
    const t = await this.pageTarget();
    if (!t?.webSocketDebuggerUrl) throw Object.assign(new Error("Chrome isn't open with remote debugging, and the Echo extension isn't connected."), { code: 'no_browser' });
    if (this.ws && this.target === t.id && this.ws.readyState === 1) return;
    try { this.ws?.close(); } catch {}
    this.target = t.id;
    const ws = new this.WebSocketImpl(t.webSocketDebuggerUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error.message || 'CDP error')));
      else p.resolve(m.result);
    });
  }

  /** @param {string} method @param {object} [params] @returns {Promise<any>} */
  send(method, params = {}) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Chrome didn't answer (${method}).`), { code: 'timeout' }));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.text || 'page error'));
    return r?.result?.value;
  }

  async snapshot() {
    await this.connect();
    return this.evaluate(SNAPSHOT_FN);
  }

  /**
   * Act on a ref with real input, then read it back.
   * @param {{ snapshot: string, ref: string, verb: string, text?: string, commit?: string, files?: string[] }} a
   */
  async act({ snapshot, ref, verb, text = '', commit = '', files = [] }) {
    await this.connect();
    const key = `${snapshot}:${ref}`;
    const read = () => this.evaluate(`${READBACK_FN}(${JSON.stringify(key)})`);
    const before = await read();
    if (!before?.exists) throw Object.assign(new Error(`${ref} is gone from the page (the snapshot is stale). Take a new snapshot.`), { code: 'stale' });
    const box = await this.evaluate(`${LOCATE_FN}(${JSON.stringify(key)})`);
    if (box?.secret && ['fill', 'replace'].includes(verb)) throw Object.assign(new Error('That is a password field. Echo never types passwords.'), { code: 'secure' });
    const mouse = async (type, button = 'left', clickCount = 1) => this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, clickCount });
    if (verb === 'click' || verb === 'focus' || verb === 'fill' || verb === 'replace') {
      await mouse('mouseMoved');
      await mouse('mousePressed');
      await mouse('mouseReleased');
    } else if (verb === 'right_click') {
      await mouse('mousePressed', 'right');
      await mouse('mouseReleased', 'right');
    } else if (verb === 'hover') {
      await mouse('mouseMoved');
    }
    if (verb === 'replace') await this.evaluate(`${SELECT_ALL_FN}(${JSON.stringify(key)})`);
    if ((verb === 'fill' || verb === 'replace') && text) await this.send('Input.insertText', { text });
    if (verb === 'upload') {
      const { root } = await this.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-echo-ref="${key}"]` });
      await this.send('DOM.setFileInputFiles', { nodeId, files });
      await this.evaluate(`document.querySelector('[data-echo-ref="${key}"]').dispatchEvent(new Event('change', { bubbles: true }))`);
    }
    // What the field holds after typing, before a commit turns it into a chip (and empties it).
    const filled = (verb === 'fill' || verb === 'replace') && commit ? await read().catch(() => null) : null;
    if (commit) {
      const k = { enter: ['Enter', 13, '\r'], tab: ['Tab', 9, ''], comma: [',', 188, ','] }[commit];
      if (k) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], windowsVirtualKeyCode: k[1], text: k[2] || undefined });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], windowsVirtualKeyCode: k[1] });
      }
    }
    await new Promise((r) => setTimeout(r, 250));
    const after = await read().catch(() => ({ exists: false }));
    return { before, after, ...(filled ? { filled } : {}) };
  }

  async tabs() {
    const res = await this.fetchImpl(`${this.base}/json/list`);
    const list = await res.json();
    return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, title: t.title, url: t.url }));
  }

  async navigate(url) {
    await this.connect();
    await this.send('Page.navigate', { url });
    return { navigated: url };
  }
}

/**
 * Did the browser action work? Pure: fill/replace hold the text; a click changed the page (the
 * URL, the element's state, its focus, or the page's size), or the element went away (a dialog
 * closing); an upload has files.
 * @param {string} verb @param {{ before: any, after: any, filled?: any }} r @param {{ text?: string }} [o]
 * @returns {{ verified: boolean, why?: string }}
 */
export function judgeBrowserAct(verb, { before = {}, after = {}, filled = null }, { text = '' } = {}) {
  const squeeze = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  if (verb === 'fill' || verb === 'replace') {
    // With a commit (a chip), what counts is what the field held just before it.
    const held = filled || after;
    const ok = squeeze(held.value).includes(squeeze(text)) && (verb === 'fill' || squeeze(held.value) === squeeze(text) || text.length > 40);
    return ok ? { verified: true } : { verified: false, why: `the field holds "${squeeze(held.value).slice(0, 80)}"` };
  }
  if (verb === 'upload') return after.files > 0 || after.value ? { verified: true } : { verified: false, why: 'no file is attached' };
  const changed = before.url !== after.url || before.expanded !== after.expanded || before.focused !== after.focused || before.nodes !== after.nodes || before.title !== after.title || before.exists !== after.exists || before.value !== after.value;
  return changed ? { verified: true } : { verified: false, why: 'the page did not change' };
}
