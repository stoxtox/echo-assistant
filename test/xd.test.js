// The bridge to Adobe XD (lib/xd.js, integrations/xd-bridge). A design canvas gives Echo nothing to
// name, so Echo works through a panel plugin in XD over /ws/xd. Whether XD lets that plugin EDIT
// because a network message said so, or only around a real click, can only be found out in XD: so
// here the plugin's real main.js runs against a pretend XD that can be set to each possible rule,
// and against the real bridge over a real socket. Nothing touches Adobe XD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { WebSocket, WebSocketServer } from 'ws';
import { sandbox, until, wait, serverSource } from './helpers.js';

const dirs = sandbox('xd');
const { XdBridge, xdToken, xdTokenFile, xdRefusal, cleanEdit, cleanReport, probeVerdict, EDIT_OPS } = await import('../lib/xd.js');
const { XD_TOOL_NAMES } = await import('../lib/tools/xd.js');
const { Dispatcher, READ_ONLY_TOOLS } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings } = await import('../lib/settings.js');

const PLUGIN = path.join(import.meta.dirname, '..', 'integrations', 'xd-bridge');
const TOKEN = xdToken();

/** The server's side of /ws/xd, wired as server.js wires it. */
async function listen(bridge = new XdBridge({ timeoutMs: 1500 })) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => bridge.attach(ws));
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const refusal = xdRefusal({ origin: req.headers.origin, url: req.url }, TOKEN);
    if (refusal) {
      bridge.refused(refusal);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  const close = () => {
    for (const c of wss.clients) c.terminate();
    server.close();
  };
  return { bridge, port, close, url: (token = TOKEN) => `ws://127.0.0.1:${port}/ws/xd?token=${token}` };
}

/** An error with this code (and, if given, these words). */
const coded = (code, words = /(?:)/) => (/** @type {any} */ e) => e.code === code && words.test(e.message);

/**
 * A fake plugin socket: connects, and answers requests with `answer(msg)`.
 * @param {string} url @param {(m: any) => any} [answer] @param {object} [opts]
 */
async function fakePlugin(url, answer = (m) => ({ id: m.id, ok: true, result: { kind: m.kind } }), opts = {}) {
  const ws = new WebSocket(url, opts);
  const got = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    got.push(m);
    const a = m.id ? answer(m) : null;
    if (a) ws.send(JSON.stringify(a));
  });
  const opened = await new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
  });
  return { ws, got, opened };
}

/* ---------- a pretend XD for the plugin's real main.js ---------- */

const REFUSED = 'Panel plugin edits must be initiated from a supported UI event';
const BACKGROUND = 'Plugin is not permitted to make changes from the background.';
/** The plugin's timers run ten times faster, so its 5-second wait takes half a second. */
const FAST = 10;

/**
 * @param {{ policy: 'always' | 'held' | 'after' | 'after_short' | 'click_only' | 'never', port: number, token?: string }} o
 * always: an edit may start any time. held: only inside a click, and it may be held open.
 * after / after_short: inside a click and for a while after it (long / 250 ms), never held open.
 * click_only: only inside a click, never held open. never: no edit at all.
 */
function pretendXd({ policy, port, token = TOKEN }) {
  const xd = { inClick: false, clickAt: 0, editing: 0, edits: 0 };
  const guard = () => {
    if (!xd.editing) throw new Error(BACKGROUND);
  };
  class Node {
    constructor(name, box = [0, 0, 10, 10], kids = []) {
      this.guid = `id-${name.toLowerCase().replace(/\W+/g, '-')}`;
      this._name = name;
      this._box = { x: box[0], y: box[1], width: box[2], height: box[3] };
      this._kids = kids;
    }
    get name() { return this._name; }
    set name(v) { guard(); this._name = v; }
    get globalBounds() { return { ...this._box }; }
    get boundsInParent() { return { ...this._box }; }
    get localBounds() { return { x: 0, y: 0, width: this._box.width, height: this._box.height }; }
    get children() {
      const kids = this._kids;
      return { length: kids.length, at: (i) => kids[i], forEach: (fn) => kids.forEach(fn) };
    }
    moveInParentCoordinates(dx, dy) { guard(); this._box.x += dx; this._box.y += dy; }
    resize(w, h) { guard(); this._box.width = w; this._box.height = h; }
  }
  class Color {
    constructor(hex) { this.value = hex; this.a = 255; }
    toHex() { return this.value; }
  }
  class Filled extends Node {
    constructor(name, box, fill) { super(name, box); this._fill = fill ? new Color(fill) : null; this.fillEnabled = true; }
    get fill() { return this._fill; }
    set fill(v) { guard(); this._fill = v; }
  }
  class Rectangle extends Filled {}
  class Text extends Filled {
    constructor(name, box, fill, text) { super(name, box, fill); this._text = text; }
    get text() { return this._text; }
    set text(v) { guard(); this._text = v; }
  }
  class Group extends Node {}
  class Artboard extends Node {}
  class RootNode extends Node {}
  const card = new Rectangle('Card', [40, 60, 200, 120], '#ffcc00');
  const title = new Text('Title', [50, 70, 100, 20], '#111111', 'Quarterly plan');
  const deep = new Rectangle('Too deep', [0, 0, 5, 5], '#000000');
  const inner = new Group('Inner', [0, 0, 5, 5], [deep]);
  const group = new Group('Footer', [0, 500, 375, 60], [inner]);
  const home = new Artboard('Home', [0, 0, 375, 667], [card, title, group]);
  const root = new RootNode('', [0, 0, 0, 0], [home, new Artboard('Settings', [500, 0, 375, 667])]);
  const selection = { items: [card], focusedArtboard: home };
  const windowMs = policy === 'after' ? 60000 : policy === 'after_short' ? 250 : 0;
  const application = {
    version: '57.1.12',
    activeDocument: { name: 'Pretend doc' },
    editDocument(options, fn) {
      const work = typeof options === 'function' ? options : fn;
      const allowed = policy === 'always' || (policy !== 'never' && (xd.inClick || Date.now() - xd.clickAt < windowMs));
      if (!allowed) throw new Error(REFUSED);
      xd.edits++;
      xd.editing++;
      let r;
      try {
        r = work();
      } catch (e) {
        xd.editing--;
        return Promise.reject(e);
      }
      // Only some rules let an edit stay open while its function waits.
      if (r && typeof r.then === 'function' && (policy === 'always' || policy === 'held')) return r.then(() => { xd.editing--; }, (e) => { xd.editing--; throw e; });
      xd.editing--;
      return Promise.resolve(r).then(() => undefined);
    },
  };
  const commands = { alignLeft() { guard(); for (const n of selection.items) n._box.x = 0; } };
  const files = new Map(token ? [['echo-bridge.json', JSON.stringify({ token, port })]] : []);
  const folder = {
    getEntry: async (name) => {
      if (!files.has(name)) throw new Error('no such file');
      return { read: async () => files.get(name) };
    },
    createFile: async (name) => ({ write: async (text) => void files.set(name, text) }),
  };
  const modules = { scenegraph: { selection, root, Color }, application, commands, uxp: { storage: { localFileSystem: { getDataFolder: async () => folder } } } };
  const made = [];
  const document = {
    createElement(tag) {
      const handlers = [];
      const el = {
        tag, style: {}, attrs: {}, kids: [], textContent: '', value: '', parentNode: null,
        setAttribute(k, v) { el.attrs[k] = v; },
        appendChild(c) { el.kids.push(c); c.parentNode = el; },
        addEventListener(type, fn) { if (type === 'click') handlers.push(fn); },
        // A real click: XD allows edits started inside it.
        click() {
          xd.inClick = true;
          xd.clickAt = Date.now();
          try {
            for (const h of handlers) h();
          } finally {
            xd.inClick = false;
          }
        },
      };
      made.push(el);
      return el;
    },
  };
  const module = { exports: /** @type {any} */ ({}) };
  const timers = new Set();
  const sockets = new Set();
  let over = false;
  // The plugin's sockets are real ones (no Origin, as from XD); kept so the test can close them.
  class Socket extends WebSocket {
    constructor(url) {
      if (over) throw new Error('XD has quit');
      super(url);
      sockets.add(this);
    }
  }
  const context = {
    module,
    document,
    WebSocket: Socket,
    console,
    require: (name) => {
      if (!modules[name]) throw new Error(`Cannot find module '${name}'`);
      return modules[name];
    },
    setTimeout: (fn, ms) => {
      if (over) return undefined;
      const t = setTimeout(fn, ms / FAST);
      timers.add(t);
      return t;
    },
    clearTimeout,
    setInterval: (fn, ms) => {
      if (over) return undefined;
      const t = setInterval(fn, ms);
      timers.add(t);
      return t;
    },
    clearInterval,
  };
  vm.runInNewContext(fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8'), context, { filename: 'main.js' });
  const panelNode = document.createElement('panel');
  module.exports.panels.echoBridge.show({ node: panelNode });
  const byText = (t) => made.find((e) => e.textContent === t);
  return {
    xd, root, home, card, title, selection, files, made, byText,
    status: () => panelNode.kids[0].kids[0].textContent,
    note: () => String(panelNode.kids[0].kids.at(-1).textContent),
    letEdit: () => /** @type {any} */ (byText('Let Echo edit')),
    buttonShown: () => byText('Let Echo edit')?.style.display !== 'none',
    /** XD quits: its timers stop and its line drops. */
    quit() {
      over = true;
      for (const t of timers) clearTimeout(t);
      for (const ws of sockets) ws.terminate();
    },
  };
}

/** The real plugin in a pretend XD, connected to the real bridge. */
async function plugged(policy) {
  const s = await listen();
  const p = pretendXd({ policy, port: s.port });
  await until(() => s.bridge.connected && /Connected to Echo/.test(p.status()), 3000, 'the plugin to connect');
  return { ...s, p, done: () => { p.quit(); s.close(); } };
}

/* ---------- getting in ---------- */

test('the token is made once, kept private, and only it (and no web page) gets in', async () => {
  assert.match(TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(xdToken(), TOKEN, 'kept, so a panel that has it reconnects after a restart');
  assert.equal(fs.statSync(xdTokenFile()).mode & 0o777, 0o600);
  assert.equal(path.relative(dirs.data, xdTokenFile()), path.join('self', 'xd-token'));
  assert.equal(xdRefusal({ url: `/ws/xd?token=${TOKEN}` }, TOKEN), '');
  assert.equal(xdRefusal({ url: '/ws/xd' }, TOKEN), 'token');
  assert.equal(xdRefusal({ url: `/ws/xd?token=${'0'.repeat(64)}` }, TOKEN), 'token');
  // A page in a browser always sends an Origin: refused even with the right token.
  assert.equal(xdRefusal({ origin: 'http://localhost:4777', url: `/ws/xd?token=${TOKEN}` }, TOKEN), 'origin');

  const s = await listen();
  try {
    assert.equal((await fakePlugin(s.url('nope'))).opened, 403);
    assert.equal(s.bridge.connected, false);
    assert.match(s.bridge.explain(), /wrong token/);
    assert.equal((await fakePlugin(s.url(), undefined, { origin: 'https://example.com' })).opened, 403);
    assert.equal(s.bridge.status().lastRefused, 'origin');
    const ok = await fakePlugin(s.url());
    assert.equal(ok.opened, true);
    await until(() => ok.got.some((m) => m.type === 'welcome'), 2000, 'welcome');
    assert.equal(s.bridge.connected, true);
  } finally {
    s.close();
  }
  // server.js wires the path the same way: refused before the upgrade, attached after.
  const src = serverSource();
  assert.match(src, /pathname === '\/ws\/xd'[\s\S]{0,300}xdRefusal\(\{ origin: req\.headers\.origin, url: req\.url \}, xdToken\(\)\)[\s\S]{0,200}403 Forbidden/);
  assert.match(src, /xdWss\.on\('connection', \(ws\) => dispatcher\.xd\.attach\(ws\)\)/);
});

test('requests are answered by id, time out, and fail when the panel goes; one connection only', async () => {
  const s = await listen(new XdBridge({ timeoutMs: 150 }));
  try {
    await assert.rejects(s.bridge.request('describe'), coded('no_xd', /not connected/));
    const statuses = [];
    s.bridge.on('status', (st) => statuses.push(st.connected));
    const a = await fakePlugin(s.url(), (m) => (m.kind === 'describe' ? { id: m.id, ok: true, result: { from: 'a', params: m.params } } : m.kind === 'edit' ? { id: m.id, ok: false, error: 'XD said: locked', code: 'needs_click' } : null));
    await until(() => s.bridge.connected);
    a.ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', xd: '57.1' }));
    assert.deepEqual(await s.bridge.request('describe', { x: 1 }), { from: 'a', params: { x: 1 } });
    assert.equal(s.bridge.status().xd, '57.1');
    await assert.rejects(s.bridge.request('edit'), coded('needs_click', /^XD said: locked$/));
    // No answer: a timeout, not a hang.
    await assert.rejects(s.bridge.request('probe_edit', {}, { timeoutMs: 80 }), coded('timeout'));
    // The plugin's keep-alive and its pokes are answered at once.
    a.ws.send(JSON.stringify({ type: 'ping' }));
    a.ws.send(JSON.stringify({ type: 'poke', n: 7 }));
    await until(() => a.got.some((m) => m.type === 'pong') && a.got.some((m) => m.type === 'poke' && m.n === 7), 2000, 'pong and poke');
    // A second panel replaces the first.
    const b = await fakePlugin(s.url(), (m) => ({ id: m.id, ok: true, result: { from: 'b' } }));
    await until(() => a.ws.readyState === 3, 2000, 'the older line to close');
    assert.deepEqual(await s.bridge.request('describe'), { from: 'b' });
    // The panel goes while a request is out: it fails, and the bridge says disconnected.
    const hanging = fakePlugin(s.url(), () => null).then(async (c) => {
      await until(() => b.ws.readyState === 3);
      const p = s.bridge.request('describe', {}, { timeoutMs: 5000 });
      c.ws.terminate();
      return p;
    });
    await assert.rejects(hanging, coded('disconnected'));
    await until(() => !s.bridge.connected);
    assert.equal(statuses.at(-1), false);
    assert.ok(statuses.includes(true));
  } finally {
    s.close();
  }
});

test('a panel that has gone quiet stops looking connected', async () => {
  const s = await listen(new XdBridge({ quietMs: 150 }));
  try {
    const a = await fakePlugin(s.url());
    await until(() => s.bridge.connected);
    await until(() => !s.bridge.connected, 2000, 'the quiet line to be dropped');
    await until(() => a.ws.readyState === 3, 2000, 'its socket to close');
  } finally {
    s.close();
  }
});

/* ---------- what is sent, and what a probe means ---------- */

test('an edit is checked before it is sent: known operations, sane numbers, a real colour', () => {
  assert.deepEqual(EDIT_OPS, ['move', 'resize', 'fill', 'text', 'rename', 'align']);
  assert.deepEqual(cleanEdit({ op: 'move', dx: 10 }), { op: 'move', target: 'selection', dx: 10, dy: 0 });
  assert.deepEqual(cleanEdit({ op: 'move', target: 'id-1', x: 5, y: 0 }), { op: 'move', target: 'id-1', x: 5, y: 0 });
  assert.match(/** @type {any} */ (cleanEdit({ op: 'move' })).error, /dx and dy/);
  assert.match(/** @type {any} */ (cleanEdit({ op: 'move', dx: 1, x: 2 })).error, /not both/);
  assert.match(/** @type {any} */ (cleanEdit({ op: 'move', dx: Infinity })).error, /dx and dy/);
  assert.deepEqual(cleanEdit({ op: 'resize', width: 100 }), { op: 'resize', target: 'selection', width: 100 });
  assert.match(/** @type {any} */ (cleanEdit({ op: 'resize', width: 0 })).error, /larger than 0/);
  assert.deepEqual(cleanEdit({ op: 'fill', color: 'F80' }), { op: 'fill', target: 'selection', color: '#ff8800' });
  assert.match(/** @type {any} */ (cleanEdit({ op: 'fill', color: 'red; drop' })).error, /hex/);
  assert.deepEqual(cleanEdit({ op: 'text', text: '' }), { op: 'text', target: 'selection', text: '' });
  assert.match(/** @type {any} */ (cleanEdit({ op: 'text', text: 'x'.repeat(2001) })).error, /2000/);
  assert.deepEqual(cleanEdit({ op: 'rename', name: ' Hero ' }), { op: 'rename', target: 'selection', name: 'Hero' });
  assert.deepEqual(cleanEdit({ op: 'align', how: 'left' }), { op: 'align', target: 'selection', how: 'left' });
  assert.match(/** @type {any} */ (cleanEdit({ op: 'align', how: 'left', target: 'id-1' })).error, /selection only/);
  assert.match(/** @type {any} */ (cleanEdit({ op: 'delete' })).error, /Unknown edit/);
  assert.match(/** @type {any} */ (cleanEdit(null)).error, /Unknown edit/);
  // Nothing the caller added rides along.
  assert.deepEqual(Object.keys(cleanEdit({ op: 'rename', name: 'A', script: 'x', mode: 'direct' })), ['op', 'target', 'name']);
});

test('what a probe report means: full control, control after a click, or read-only', () => {
  const yes = { ok: true }, no = { ok: false, threw: REFUSED };
  const v = (steps, more = {}) => probeVerdict({ target: { type: 'Rectangle' }, waitingForClick: false, steps, ...more });
  assert.equal(probeVerdict({ target: null, steps: {} }).outcome, 'no_target');
  assert.deepEqual([v({ message: yes }).outcome, v({ message: yes }).mode], ['full', 'direct']);
  assert.equal(v({ message: no, message_label: yes }).outcome, 'full', 'with a label counts');
  assert.equal(v({ message: no, message_label: no }, { waitingForClick: true }).outcome, 'waiting_for_click');
  assert.deepEqual([v({ message: no, click: yes, held: yes, after_0: no, after_5000: no }).outcome, v({ click: yes, held: yes }).mode], ['click', 'held']);
  assert.equal(v({ click: yes, held: no, after_0: yes, after_5000: no }).mode, 'after');
  assert.match(v({ click: yes, held: no, after_0: yes, after_5000: no }).means, /only just after a click/);
  // Still open 5 s after the click: nothing needs holding, even when holding works too.
  assert.equal(v({ click: yes, held: yes, after_0: yes, after_5000: yes }).mode, 'after');
  assert.equal(v({ click: yes, held: no, after_0: no, after_5000: no }).outcome, 'read_only');
  assert.match(v({ click: yes }).means, /only inside the user's own click/);
  assert.match(v({ click: no }).means, /no edit from the plugin at all/);
  // A report is cut to what is worth keeping: the kind of thing tried on, never its name.
  const cleaned = cleanReport({ target: { type: 'Text', name: 'Secret plan' }, waitingForClick: true, extra: 'x', steps: { message: { ok: false, ran: false, threw: REFUSED, ms: 1.6, name: 'Secret plan', value: { changed: true, restored: true, name: 'Secret plan' } } } });
  assert.deepEqual(cleaned, { target: { type: 'Text' }, waitingForClick: true, steps: { message: { ok: false, ran: false, threw: REFUSED, ms: 2, value: { changed: true, restored: true } } } });
});

/* ---------- the real plugin in a pretend XD ---------- */

test('describe: the selection and the tree to depth 3, compact, read from XD', async () => {
  const t = await plugged('always');
  try {
    assert.equal(t.bridge.status().xd, '57.1.12');
    const d = await t.bridge.describe();
    assert.equal(d.document, 'Pretend doc');
    assert.deepEqual(d.selection, [{ id: 'id-card', type: 'Rectangle', name: 'Card', box: [40, 60, 200, 120], fill: '#ffcc00' }]);
    assert.equal(d.tree.type, 'RootNode');
    assert.deepEqual(d.tree.children.map((a) => [a.type, a.name, a.box]), [['Artboard', 'Home', [0, 0, 375, 667]], ['Artboard', 'Settings', [500, 0, 375, 667]]]);
    const [card, title, footer] = d.tree.children[0].children;
    assert.equal(card.fill, '#ffcc00');
    assert.deepEqual([title.type, title.text, title.fill], ['Text', 'Quarterly plan', '#111111']);
    // Depth 3 is the footer's own children; what is below them is only counted.
    assert.deepEqual(footer.children, [{ id: 'id-inner', type: 'Group', name: 'Inner', box: [0, 0, 5, 5], childCount: 1 }]);
    assert.doesNotMatch(JSON.stringify(d), /Too deep/);
    assert.equal(t.p.xd.edits, 0, 'describing edits nothing');
  } finally {
    t.done();
  }
});

test('XD allows edits from a message: the probe says full control at once, and edits work', async () => {
  const t = await plugged('always');
  try {
    const r = await t.bridge.probe();
    assert.deepEqual([r.outcome, r.mode, r.tried_on], ['full', 'direct', 'Rectangle']);
    assert.deepEqual(r.steps.message, { ok: true, ran: true, returned: 'promise', ms: r.steps.message.ms, value: { changed: true, restored: true } });
    assert.equal(r.steps.message_label.ok, true);
    assert.equal(t.p.card.name, 'Card', 'the probe leaves the name as it was');
    assert.equal(t.p.buttonShown(), false, 'no click asked for');
    assert.equal(t.bridge.status().probe, 'full');

    const moved = await t.bridge.edit({ op: 'move', dx: 10, dy: -5 });
    assert.deepEqual(moved.nodes.map((n) => [n.before.box, n.after.box]), [[[40, 60, 200, 120], [50, 55, 200, 120]]]);
    await t.bridge.edit({ op: 'move', x: 0 });
    assert.deepEqual(t.p.card.boundsInParent, { x: 0, y: 55, width: 200, height: 120 });
    await t.bridge.edit({ op: 'resize', width: 300 });
    assert.deepEqual([t.p.card.localBounds.width, t.p.card.localBounds.height], [300, 120]);
    const filled = await t.bridge.edit({ op: 'fill', color: '#1E90FF' });
    assert.deepEqual([filled.nodes[0].before.fill, filled.nodes[0].after.fill], ['#ffcc00', '#1e90ff']);
    // By the id describe gave, or by exact name.
    const texted = await t.bridge.edit({ op: 'text', target: 'id-title', text: 'New plan' });
    assert.deepEqual([texted.nodes[0].before.text, texted.nodes[0].after.text, t.p.title.text], ['Quarterly plan', 'New plan', 'New plan']);
    await t.bridge.edit({ op: 'rename', target: 'Home', name: 'Start' });
    assert.equal(t.p.home.name, 'Start');
    await t.bridge.edit({ op: 'move', x: 80 });
    const aligned = await t.bridge.edit({ op: 'align', how: 'left' });
    assert.deepEqual([aligned.nodes[0].before.box[0], aligned.nodes[0].after.box[0]], [80, 0]);

    // What cannot be done is said in XD's or the plugin's own words, and nothing changes.
    await assert.rejects(t.bridge.edit({ op: 'text', text: 'x' }), /A Rectangle holds no text/);
    await assert.rejects(t.bridge.edit({ op: 'rename', target: 'id-nothing', name: 'x' }), /no node with that id or name/);
    await assert.rejects(t.bridge.edit({ op: 'align', how: 'right' }), /no command "alignRight"/);
    t.p.selection.items = [];
    await assert.rejects(t.bridge.edit({ op: 'move', dx: 1 }), /Nothing is selected in XD/);
    // A bad edit never reaches XD.
    const before = t.p.xd.edits;
    await assert.rejects(t.bridge.edit({ op: 'explode' }), coded('bad_edit'));
    assert.equal(t.p.xd.edits, before);
  } finally {
    t.done();
  }
});

test('XD wants a click and lets its edit be held open: one click finishes the probe, and arms edits', async () => {
  const t = await plugged('held');
  try {
    const lines = [];
    t.bridge.on('probe', (line) => lines.push(line));
    const first = await t.bridge.probe();
    assert.equal(first.outcome, 'waiting_for_click');
    assert.deepEqual([first.steps.message.ok, first.steps.message.ran, first.steps.message.threw], [false, false, REFUSED], 'what XD said, word for word');
    assert.equal(first.steps.message_label.threw, REFUSED);
    assert.equal(t.p.buttonShown(), true);
    // Editing before the click: sent nowhere near XD's document.
    await assert.rejects(t.bridge.edit({ op: 'move', dx: 5 }), coded('needs_probe', /click "Let Echo edit"/));

    t.p.letEdit().click();
    await until(() => lines.length === 1, 4000, 'the result after the click');
    const r = t.bridge.probeResult();
    assert.deepEqual([r?.outcome, r?.mode], ['click', 'held']);
    assert.deepEqual([r?.steps.click.ok, r?.steps.held.ok, r?.steps.after_0.ok, r?.steps.after_5000.ok], [true, true, false, false]);
    assert.equal(r?.steps.after_0.threw, REFUSED);
    assert.match(lines[0], /^\[XD probe\] The user clicked "Let Echo edit"\. Result: click\./);
    assert.doesNotMatch(lines[0] + JSON.stringify(r), /Card|Quarterly/, 'nothing from the document in the result');
    assert.equal(t.p.card.name, 'Card');
    assert.equal(t.p.buttonShown(), false);

    // An edit now: XD needs a click first, the panel shows the button, and after the click it works.
    await assert.rejects(t.bridge.edit({ op: 'move', dx: 5 }), coded('needs_click'));
    assert.equal(t.p.buttonShown(), true);
    assert.equal(t.p.card.boundsInParent.x, 40);
    t.p.letEdit().click();
    assert.match(t.p.note(), /Echo may edit for the next 30 seconds/);
    await t.bridge.edit({ op: 'move', dx: 5 });
    await t.bridge.edit({ op: 'rename', name: 'Hero card' });
    assert.deepEqual([t.p.card.boundsInParent.x, t.p.card.name], [45, 'Hero card'], 'several edits inside the one held-open edit');
  } finally {
    t.done();
  }
});

test('XD allows edits for a while after a click: the probe says so, and an edit works after one', async () => {
  const t = await plugged('after');
  try {
    assert.equal((await t.bridge.probe()).outcome, 'waiting_for_click');
    t.p.letEdit().click();
    await until(() => t.bridge.probeResult()?.outcome === 'click', 4000, 'the result after the click');
    const r = t.bridge.probeResult();
    assert.equal(r?.mode, 'after');
    // The click's own edit worked; a change made later inside it, when a message came, did not.
    assert.deepEqual([r?.steps.click.ok, r?.steps.held.ok, r?.steps.held.workError, r?.steps.after_0.ok, r?.steps.after_5000.ok], [true, false, BACKGROUND, true, true]);
    await t.bridge.edit({ op: 'rename', name: 'After' });
    assert.equal(t.p.card.name, 'After');
  } finally {
    t.done();
  }
  const short = await plugged('after_short');
  try {
    await short.bridge.probe();
    short.p.letEdit().click();
    await until(() => short.bridge.probeResult()?.outcome === 'click', 4000, 'the result after the click');
    const r = short.bridge.probeResult();
    assert.deepEqual([r?.mode, r?.steps.after_0.ok, r?.steps.after_5000.ok], ['after', true, false]);
    assert.match(String(r?.means), /only just after a click/);
  } finally {
    short.done();
  }
});

test('XD allows edits only inside a click, or not at all: read-only, and xd_edit says so without trying', async () => {
  for (const [policy, clickOk, means] of /** @type {const} */ ([['click_only', true, /only inside the user's own click/], ['never', false, /no edit from the plugin at all/]])) {
    const t = await plugged(policy);
    try {
      await t.bridge.probe();
      t.p.letEdit().click();
      await until(() => t.bridge.probeResult()?.outcome === 'read_only', 4000, `the ${policy} result`);
      const r = t.bridge.probeResult();
      assert.equal(r?.steps.click.ok, clickOk);
      assert.match(String(r?.means), means);
      if (policy === 'never') assert.equal(r?.steps.click_edit.threw, REFUSED);
      const edits = t.p.xd.edits;
      await assert.rejects(t.bridge.edit({ op: 'move', dx: 5 }), coded('read_only'));
      assert.equal(t.p.xd.edits, edits, 'not even tried');
      // Reading still works.
      assert.equal((await t.bridge.describe()).selection[0].name, 'Card');
    } finally {
      t.done();
    }
  }
});

test('with nothing to try an edit on, the probe says what to open', async () => {
  const t = await plugged('always');
  try {
    t.p.selection.items = [];
    t.p.selection.focusedArtboard = /** @type {any} */ (null);
    t.p.root._kids.length = 0;
    const r = await t.bridge.probe();
    assert.equal(r.outcome, 'no_target');
    assert.match(r.means, /select one object/);
  } finally {
    t.done();
  }
});

test('the token is pasted into the panel once and kept in the plugin\'s own folder', async () => {
  const s = await listen();
  const p = pretendXd({ policy: 'always', port: s.port, token: '' });
  try {
    await wait(50);
    assert.match(p.status(), /Paste the token and click Connect/);
    assert.equal(s.bridge.connected, false);
    const [tokenBox, portBox] = p.made.filter((e) => e.tag === 'input');
    assert.equal(tokenBox.attrs.type, 'password', 'the token is not shown on screen');
    tokenBox.value = 'not a token';
    p.byText('Connect').click();
    assert.match(p.note(), /That is not the token/);
    tokenBox.value = ` ${TOKEN}\n`;
    portBox.value = String(s.port);
    p.byText('Connect').click();
    await until(() => s.bridge.connected && /Connected to Echo/.test(p.status()), 3000, 'the plugin to connect');
    assert.equal(tokenBox.value, '');
    await until(() => p.files.has('echo-bridge.json'));
    assert.deepEqual(JSON.parse(p.files.get('echo-bridge.json')), { token: TOKEN, port: s.port });
  } finally {
    p.quit();
    s.close();
  }
});

/* ---------- the assistant's tools ---------- */

test('the three XD tools are offered only while the panel is connected', async () => {
  saveSettings({ computerUse: true });
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const names = () => d.toolList().map((t) => t.name);
  assert.deepEqual(XD_TOOL_NAMES, ['xd_describe', 'xd_probe', 'xd_edit']);
  for (const n of XD_TOOL_NAMES) assert.ok(!names().includes(n), `${n} is not offered without XD`);
  const s = await listen(d.xd);
  try {
    let answer = (m) => /** @type {any} */ ({ id: m.id, ok: true, result: m.kind === 'describe' ? { document: 'Doc', selection: [] } : { target: { type: 'Rectangle' }, waitingForClick: true, steps: { message: { ok: false, threw: REFUSED } } } });
    const plugin = await fakePlugin(s.url(), (m) => answer(m));
    await until(() => d.xd.connected);
    for (const n of XD_TOOL_NAMES) assert.ok(names().includes(n), `${n} is offered with XD`);
    // Editing a document is acting: not offered with computer use off. Reading is.
    saveSettings({ computerUse: false });
    assert.deepEqual(XD_TOOL_NAMES.filter((n) => names().includes(n)), ['xd_describe', 'xd_probe']);
    saveSettings({ computerUse: true });
    assert.ok(READ_ONLY_TOOLS.has('xd_describe'));

    const tools = Object.fromEntries(d.toolList().map((t) => [t.name, /** @type {any} */ (t)]));
    assert.match(tools.xd_probe.description, /run the XD probe/);
    assert.deepEqual(JSON.parse((await tools.xd_describe.handler({}, {})).content[0].text), { document: 'Doc', selection: [] });
    const probed = JSON.parse((await tools.xd_probe.handler({}, {})).content[0].text);
    assert.equal(probed.outcome, 'waiting_for_click');
    assert.match(probed.means, /click "Let Echo edit"/);
    assert.equal(JSON.parse((await tools.xd_probe.handler({ result: true }, {})).content[0].text).outcome, 'waiting_for_click');
    // The click's half arrives as an event for the assistant.
    const events = [];
    d.notify = /** @type {any} */ ((line) => events.push(line));
    plugin.ws.send(JSON.stringify({ type: 'probe_result', report: { target: { type: 'Rectangle' }, steps: { click: { ok: true }, held: { ok: true } } } }));
    await until(() => events.length === 1);
    assert.match(events[0], /Result: click\./);
    // XD refuses an edit until the user clicks: the assistant is told what to ask for.
    answer = (m) => ({ id: m.id, ok: false, error: 'XD did not accept the edit', code: 'needs_click' });
    const refused = await tools.xd_edit.handler({ op: 'move', dx: 1 }, {});
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Ask them to click "Let Echo edit" in the Echo panel in XD/);
    const bad = await tools.xd_edit.handler({ op: 'move' }, {});
    assert.match(bad.content[0].text, /dx and dy/);
  } finally {
    s.close();
  }
  await until(() => !d.xd.connected);
  assert.ok(!names().includes('xd_describe'));
});

test('the session picks up the XD tools when the panel connects, once nothing is running', async () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  let reloads = 0;
  d.reload = () => void reloads++;
  // No session yet: nothing to restart.
  d.xd.emit('status', {});
  assert.equal(reloads, 0);
  d.input = /** @type {any} */ ({ size: 0 });
  d.toolList();
  // Same as what the session has: nothing to do.
  d.refreshTools();
  assert.equal(reloads, 0);
  d.xd.ws = { readyState: 1 };
  // Mid-turn: it waits.
  d.busy = true;
  d.xd.emit('status', {});
  assert.equal(reloads, 0);
  d.busy = false;
  d.refreshTools();
  assert.equal(reloads, 1);
  clearTimeout(d.toolsTimer);
});
