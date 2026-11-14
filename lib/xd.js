// Adobe XD through its own plugin system, not clicks.
//
// A design canvas exposes nothing Echo can name: no labels, no fields, only pixels. So, as with
// spreadsheets (lib/sheets.js), Echo works through the app's own interface: a small panel plugin
// (integrations/xd-bridge) that stays loaded in XD and holds one WebSocket to this server on
// /ws/xd. Echo asks, the plugin answers:
//   describe      the selection and the document tree to depth 3 (names, types, bounds, text, fills)
//   probe_edit    may a panel plugin edit the document because a NETWORK message told it to, or only
//                 because the user clicked in the panel? (Only XD itself can answer; see docs/xd-bridge.md.)
//   edit          move, resize, fill, text, rename, align: used only once the probe says edits work
//
// Rules that keep this safe:
// - Only the plugin gets in: it presents the token from data/self/xd-token (made here, readable by
//   this user only), and anything that sends an Origin (a web page) is refused before the token is
//   even looked at. One connection: a newer one replaces the older.
// - Every request has a time limit, and comes back as a plain result or an Error with a `code`:
//   no_xd, timeout, disconnected, bad_edit, needs_probe, needs_click, read_only, failed.
// - An edit is checked HERE before it is sent (a known operation, sane numbers, a real colour), so
//   the plugin never runs anything Echo did not spell out.
// - Nothing here logs what the document holds: names and text go to the assistant only.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { writeFileAtomic } from './atomic.js';
import { tokenOk } from './bodylink.ts';

/** The longest one request may take. */
export const XD_TIMEOUT_MS = 8000;
/** The plugin says "ping" every 20 s; a line that has been silent this long is dropped. */
export const XD_QUIET_MS = 75000;
/** The most text one answer may carry to the assistant (a describe of a big document is cut by the plugin first). */
const ANSWER_MAX = 60000;
export const EDIT_OPS = ['move', 'resize', 'fill', 'text', 'rename', 'align'];
export const ALIGN_HOW = ['left', 'right', 'top', 'bottom', 'center_horizontal', 'center_vertical'];
const TEXT_MAX = 2000;
const COORD_MAX = 100000;

export const xdTokenFile = (dataDir = config.dataDir) => path.join(dataDir, 'self', 'xd-token');

/** The plugin's token, made on first use and kept (the owner pastes it into the panel once). */
export function xdToken(dataDir = config.dataDir) {
  const file = xdTokenFile(dataDir);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {}
  const t = randomBytes(32).toString('hex');
  writeFileAtomic(file, t + '\n', { mode: 0o600, backup: false });
  return t;
}

/**
 * Why a connection to /ws/xd is turned away, or '' when it may come in.
 * @param {{ origin?: string, url?: string }} req @param {string} token
 * @returns {'' | 'origin' | 'token'}
 */
export function xdRefusal({ origin = '', url = '' }, token) {
  // A web page always sends an Origin; XD's plugin runtime is not a page.
  if (origin) return 'origin';
  let given = '';
  try {
    given = new URL(url, 'http://localhost').searchParams.get('token') || '';
  } catch {
    return 'token';
  }
  return tokenOk(given, token) ? '' : 'token';
}

const coded = (message, code) => Object.assign(new Error(message), { code });
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD_MAX ? v : null);

/**
 * An edit as the plugin takes it, or why it is not one.
 * @param {any} p
 * @returns {{ error: string } | { op: string, target: string, [k: string]: any }}
 */
export function cleanEdit(p) {
  const op = String(p?.op || '');
  if (!EDIT_OPS.includes(op)) return { error: `Unknown edit "${op}". Use one of: ${EDIT_OPS.join(', ')}.` };
  // What to change: the selection, or one node by the id (or exact name) that describe gave.
  const target = String(p.target || 'selection').slice(0, 200);
  const out = { op, target };
  if (op === 'move') {
    const by = num(p.dx) !== null || num(p.dy) !== null;
    const to = num(p.x) !== null || num(p.y) !== null;
    if (by === to) return { error: 'move takes dx and dy (a distance) or x and y (a place in its parent), not both and not neither.' };
    return by ? { ...out, dx: num(p.dx) ?? 0, dy: num(p.dy) ?? 0 } : { ...out, ...(num(p.x) !== null ? { x: p.x } : {}), ...(num(p.y) !== null ? { y: p.y } : {}) };
  }
  if (op === 'resize') {
    const width = num(p.width), height = num(p.height);
    if ((width === null && height === null) || (width !== null && width <= 0) || (height !== null && height <= 0)) return { error: 'resize takes a width, a height or both, larger than 0.' };
    return { ...out, ...(width !== null ? { width } : {}), ...(height !== null ? { height } : {}) };
  }
  if (op === 'fill') {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(p.color || '').trim());
    if (!m) return { error: 'fill takes a colour as hex, e.g. "#1e90ff".' };
    const hex = /** @type {string} */ (m[1]).toLowerCase();
    return { ...out, color: `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}` };
  }
  if (op === 'text') {
    if (typeof p.text !== 'string' || p.text.length > TEXT_MAX) return { error: `text takes the new text (at most ${TEXT_MAX} characters).` };
    return { ...out, text: p.text };
  }
  if (op === 'rename') {
    const name = String(p.name ?? '').trim();
    if (!name || name.length > 200) return { error: 'rename takes a name (at most 200 characters).' };
    return { ...out, name };
  }
  // align: XD's own Align commands, which only ever act on the selection.
  if (!ALIGN_HOW.includes(p.how)) return { error: `align takes how: ${ALIGN_HOW.join(', ')}.` };
  if (target !== 'selection') return { error: 'align works on the selection only.' };
  return { ...out, how: p.how };
}

/** One probe step as the plugin reported it, cut to what is worth keeping (XD's own words, verbatim). */
function cleanStep(s) {
  if (!s || typeof s !== 'object') return undefined;
  const out = {};
  for (const k of ['ok', 'ran', 'timedOut']) if (typeof s[k] === 'boolean') out[k] = s[k];
  for (const k of ['returned', 'threw', 'rejected', 'workError', 'error']) if (s[k] !== undefined) out[k] = String(s[k]).slice(0, 400);
  if (typeof s.ms === 'number') out.ms = Math.round(s.ms);
  if (s.value && typeof s.value === 'object') out.value = { changed: s.value.changed === true, restored: s.value.restored === true };
  return out;
}

/** The plugin's probe report, cut down: what it tried on (a type, never a name) and each step. */
export function cleanReport(r) {
  const steps = {};
  for (const [k, v] of Object.entries(r?.steps && typeof r.steps === 'object' ? r.steps : {}).slice(0, 12)) {
    const step = cleanStep(v);
    if (step) steps[String(k).slice(0, 30)] = step;
  }
  return { target: r?.target ? { type: String(r.target.type || '').slice(0, 40) } : null, waitingForClick: r?.waitingForClick === true, steps };
}

/**
 * What a probe report means. The steps, in the order the plugin tries them:
 *   message, message_label   an edit triggered straight by a network message (bare, then with an editLabel)
 *   click                    an edit made inside the click on "Let Echo edit" itself (the control: edits work at all)
 *   held                     an edit made when a message arrived while the click's own edit was still held open
 *   after_0, after_5000      an edit triggered by a message that arrived right after the click, and 5 s after
 * @returns {{ outcome: 'full' | 'click' | 'read_only' | 'waiting_for_click' | 'no_target', mode: '' | 'direct' | 'held' | 'after', means: string }}
 */
export function probeVerdict(report) {
  const ok = (k) => report?.steps?.[k]?.ok === true;
  if (!report?.target) return { outcome: 'no_target', mode: '', means: 'There was nothing to try an edit on. Ask the user to open a document in XD and select one object (a rectangle or a text), then run the probe again.' };
  if (ok('message') || ok('message_label')) return { outcome: 'full', mode: 'direct', means: 'XD lets the plugin edit the document straight from a message. Echo can edit in XD with xd_edit, with no click needed.' };
  if (report.waitingForClick) return { outcome: 'waiting_for_click', mode: '', means: 'XD refused an edit triggered by a message alone. Ask the user to click "Let Echo edit" in the Echo panel in XD, once. The rest of the result arrives by itself after the click.' };
  // A message 5 s after the click still worked: the click unlocks edits for a while, nothing needs holding open.
  if (ok('after_5000')) return { outcome: 'click', mode: 'after', means: 'XD lets the plugin edit after the user has clicked "Let Echo edit" in the panel (it still worked 5 seconds after the click). Echo can edit with xd_edit once the user has clicked.' };
  if (ok('held')) return { outcome: 'click', mode: 'held', means: 'XD lets the plugin edit while an edit started by a click on "Let Echo edit" is held open. Echo can edit with xd_edit for about 30 seconds after each click.' };
  if (ok('after_0')) return { outcome: 'click', mode: 'after', means: 'XD lets the plugin edit only just after a click on "Let Echo edit" (5 seconds later it refused). Echo can edit with xd_edit right after a click.' };
  return { outcome: 'read_only', mode: '', means: ok('click')
    ? 'XD accepts an edit only inside the user\'s own click, never from a message. Echo can read the document (xd_describe) and point, but cannot edit it.'
    : 'XD accepted no edit from the plugin at all, not even inside a click (see the steps for what it said). Echo can read the document (xd_describe) and point, but cannot edit it.' };
}

/**
 * The plugin's connection: requests out, answers back by id.
 * Emits 'status' when it connects, drops or is refused, and 'probe' (a line for the assistant) when
 * the part of a probe that waited for the user's click has come in.
 */
export class XdBridge extends EventEmitter {
  constructor({ timeoutMs = XD_TIMEOUT_MS, quietMs = XD_QUIET_MS, now = Date.now } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.quietMs = quietMs;
    this.now = now;
    /** @type {any} */
    this.ws = null;
    this.pending = new Map();
    this.n = 0;
    this.info = /** @type {{ version?: string, xd?: string } | null} */ (null);
    this.lastSeen = 0;
    /** @type {{ at: number, why: string } | null} */
    this.lastRefused = null;
    /** @type {any} */
    this.watch = null;
    /** The last probe: the report as cleaned, and what it means. Kept while the server runs (XD's rule does not change). */
    this.report = /** @type {ReturnType<typeof cleanReport> | null} */ (null);
    this.verdict = /** @type {ReturnType<typeof probeVerdict> | null} */ (null);
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  /** A try the server turned away (server.js upgrade). @param {string} why 'origin' | 'token' */
  refused(why) {
    this.lastRefused = { at: this.now(), why };
    console.log(`[xd] refused a connection (${why})`);
    this.emit('status', this.status());
  }

  /** A new plugin connection (an older one is closed: there is one XD). @param {any} ws */
  attach(ws) {
    if (this.ws && this.ws !== ws) try { this.ws.close(1000, 'replaced'); } catch {}
    this.ws = ws;
    this.lastSeen = this.now();
    this.info = null;
    ws.on('message', (raw) => {
      this.lastSeen = this.now();
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      // The plugin's keep-alive, and the pokes its probe asks for: the probe needs a message from
      // the NETWORK to arrive at a moment it chooses, so it asks for one and Echo sends it straight back.
      if (m.type === 'ping' || m.type === 'poke') {
        try { ws.send(JSON.stringify(m.type === 'ping' ? { type: 'pong' } : { type: 'poke', n: Number(m.n) || 0 })); } catch {}
        return;
      }
      if (m.type === 'hello') {
        this.info = { version: String(m.version || '').slice(0, 20), xd: String(m.xd || '').slice(0, 40) };
        return;
      }
      if (m.type === 'probe_result') {
        this.noteProbe(m.report);
        this.emit('probe', `[XD probe] The user clicked "Let Echo edit". Result: ${this.verdict?.outcome}. ${this.verdict?.means} Tell the user the result in a sentence.`);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok === false) p.reject(coded(String(m.error || 'XD said no.').slice(0, 600), String(m.code || 'failed').slice(0, 40)));
      else p.resolve(m.result);
    });
    const gone = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.watch);
      this.watch = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(coded('The Echo panel in XD disconnected.', 'disconnected'));
        this.pending.delete(id);
      }
      console.log('[xd] the plugin disconnected');
      this.emit('status', this.status());
    };
    ws.on('close', gone);
    ws.on('error', () => {});
    // The panel shows "Connected" only once it has this: Echo accepted it.
    try { ws.send(JSON.stringify({ type: 'welcome' })); } catch {}
    // A panel that has gone quiet (XD quit without closing the line) must not look connected.
    clearInterval(this.watch);
    this.watch = setInterval(() => {
      if (this.ws !== ws || this.now() - this.lastSeen < this.quietMs) return;
      gone();
      try {
        if (ws.terminate) ws.terminate();
        else ws.close();
      } catch {}
    }, Math.max(50, Math.round(this.quietMs / 3)));
    this.watch.unref?.();
    console.log('[xd] the plugin connected');
    this.emit('status', this.status());
  }

  status() {
    return { connected: this.connected, ...(this.connected ? this.info || {} : {}), ...(this.verdict ? { probe: this.verdict.outcome } : {}), ...(!this.connected && this.lastRefused ? { lastRefused: this.lastRefused.why } : {}) };
  }

  /** Why it isn't connected, in a sentence for the assistant. */
  explain() {
    if (this.connected) return 'The Echo panel in XD is connected.';
    if (this.lastRefused) return this.lastRefused.why === 'token'
      ? 'The Echo panel in XD tried to connect with the wrong token. The user should paste the token again into the panel (integrations/xd-bridge/README.md).'
      : 'Something that is not the Echo panel in XD tried to connect and was refused.';
    return 'The Echo panel in XD is not connected. XD may be closed, or the Echo bridge plugin not loaded or not given its token.';
  }

  /**
   * @param {string} kind 'describe' | 'probe_edit' | 'edit'
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<any>}
   */
  request(kind, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.connected) return Promise.reject(coded(this.explain(), 'no_xd'));
    const id = `x${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(coded(`XD didn't answer (${kind}).`, 'timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, kind, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(coded(`Couldn't reach XD: ${e.message}`, 'disconnected'));
      }
    });
  }

  /** The selection and the document tree, as the plugin gives them (already compact and capped). */
  async describe() {
    const r = await this.request('describe');
    if (JSON.stringify(r ?? null).length > ANSWER_MAX) throw coded('The document is too big to describe in one answer. Ask the user to select the part they mean.', 'failed');
    return r;
  }

  noteProbe(raw) {
    this.report = cleanReport(raw);
    this.verdict = probeVerdict(this.report);
    return { ...this.verdict, tried_on: this.report.target?.type, steps: this.report.steps };
  }

  /**
   * Run the probe's first part: the edits a message alone triggers. If XD refuses those, the panel
   * shows "Let Echo edit", and the rest arrives as a 'probe' event after the user's click.
   */
  async probe() {
    this.report = this.verdict = null;
    return this.noteProbe(await this.request('probe_edit', {}, { timeoutMs: Math.max(this.timeoutMs, 15000) }));
  }

  /** The last probe's result, or null when none has run since the server started. */
  probeResult() {
    return this.verdict && this.report ? { ...this.verdict, tried_on: this.report.target?.type, steps: this.report.steps } : null;
  }

  /**
   * One edit, only when the probe says XD accepts edits. With no probe yet, its first part runs
   * first (it needs no click, and under full control that is the whole probe).
   * @param {any} params
   */
  async edit(params) {
    const clean = cleanEdit(params);
    if ('error' in clean) throw coded(clean.error, 'bad_edit');
    if (!this.connected) throw coded(this.explain(), 'no_xd');
    if (!this.verdict || this.verdict.outcome === 'no_target') await this.probe();
    const v = /** @type {NonNullable<typeof this.verdict>} */ (this.verdict);
    if (v.outcome === 'read_only') throw coded(v.means, 'read_only');
    if (v.outcome !== 'full' && v.outcome !== 'click') throw coded(`Editing in XD is not set up yet. ${v.means}`, 'needs_probe');
    // `mode` tells the plugin which way the probe found to work: straight from the message, inside
    // an edit a click holds open, or just after a click.
    return this.request('edit', { ...clean, mode: v.mode });
  }
}
