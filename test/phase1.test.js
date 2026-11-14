// Phase 1 of the computer-use plan: the browser adapter (the Echo Chrome extension and Chrome's
// DevTools protocol), the element-ref executor (observe → act by ref → verify), Set-of-Marks and
// the grid, step batching, the local intent router, the local judge, and fast-model routing.
// Fake browsers, a fake Mac app and a fake DevTools endpoint answer; nothing real is driven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { sandbox, wait } from './helpers.js';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const dirs = sandbox('phase1');
const { rotor, findByLabel, extensionAllowed, extensionRefusal, pairingCode, ExtensionBrowser, CdpBrowser, judgeBrowserAct } = await import('../lib/browser.js');
const { Executor, BrowserHub } = await import('../lib/executor.js');
const { ComputerUse, gridCell } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, getSettings, setFixedForTest } = await import('../lib/settings.js');
const { localIntent, runLocalIntent, turnWeight } = await import('../lib/intent.js');
const { parseDirected, settle, localDirected } = await import('../lib/localmodel.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const on = () => (setFixedForTest({ screenAware: false }), saveSettings({ computerUse: true, pointer: true }));

const PAGE = {
  snapshot: 's1', url: 'https://mail.google.com/mail/u/0/#inbox?compose=new', title: 'Inbox - Gmail',
  elements: [
    { ref: 'e1', role: 'button', name: 'Compose' },
    { ref: 'e2', role: 'combobox', name: 'To recipients', value: '', editable: true },
    { ref: 'e3', role: 'textbox', name: 'Subject', value: '', editable: true },
    { ref: 'e4', role: 'textbox', name: 'Message Body', value: '', editable: true },
    { ref: 'e5', role: 'button', name: 'Send ‪(⌘Enter)‬' },
    { ref: 'e6', role: 'textbox', name: 'Password', value: '', editable: true, secret: true },
  ],
};

/** A browser adapter whose page holds values; act fills them, like the extension. */
function fakeBrowser() {
  const values = new Map();
  let snap = 's1';
  const calls = [];
  return {
    calls,
    connected: true,
    async snapshot() {
      return { ...PAGE, snapshot: snap, elements: PAGE.elements.map((e) => ({ ...e, value: values.get(e.ref) ?? e.value })) };
    },
    async act(a) {
      calls.push(a);
      if (a.snapshot !== snap) throw Object.assign(new Error('stale'), { code: 'stale' });
      const before = { exists: true, value: values.get(a.ref) || '', url: PAGE.url, nodes: 10 };
      if (a.verb === 'fill') values.set(a.ref, (values.get(a.ref) || '') + a.text);
      if (a.verb === 'replace') values.set(a.ref, a.text);
      const nodes = a.verb === 'click' && a.ref === 'e5' ? 5 : 10;
      return { before, after: { exists: true, value: values.get(a.ref) || '', url: PAGE.url, nodes }, via: 'debugger' };
    },
  };
}

test('the rotor view: grouped by role, refs, values, secrets blacked out; labels find elements', () => {
  const secret = ['sk-', 'ant-', 'api03-', 'C'.repeat(40)].join('');
  const text = rotor({ ...PAGE, elements: [...PAGE.elements, { ref: 'e9', role: 'textbox', name: 'Notes', value: `key ${secret}`, editable: true }] });
  assert.match(text, /^Page: Inbox - Gmail/);
  assert.match(text, /\[e2\] combobox "To recipients"/);
  assert.match(text, /\[e5\] button "Send/);
  assert.ok(text.indexOf('[e3] textbox') < text.indexOf('[e2] combobox'), 'text boxes first, then combo boxes, then buttons');
  assert.ok(!text.includes(secret));
  assert.equal(findByLabel(PAGE.elements, 'To', { wantsField: true })?.ref, 'e2', 'typing into To: the To box');
  assert.equal(findByLabel(PAGE.elements, 'Send')?.ref, 'e5');
  assert.equal(findByLabel(PAGE.elements, 'Nothing like it'), null);
});

test('the extension: only a Chrome extension with the pairing code gets in', () => {
  const code = pairingCode();
  assert.equal(pairingCode(), code, 'made once, kept');
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  assert.equal(extensionAllowed({ origin: ext, url: `/ws/browser?code=${code}` }, code), true);
  assert.equal(extensionAllowed({ origin: ext, url: '/ws/browser?code=wrong' }, code), false);
  assert.equal(extensionAllowed({ origin: 'https://evil.example', url: `/ws/browser?code=${code}` }, code), false, 'never a web page');
  assert.equal(extensionAllowed({ origin: '', url: `/ws/browser?code=${code}` }, code), false);
});

test('the extension connection: requests out, answers back, errors and disconnects', async () => {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); }, close() {} });
  const b = new ExtensionBrowser({ timeoutMs: 200 });
  assert.equal(b.connected, false);
  await assert.rejects(b.snapshot(), /hasn't connected since Echo started/);
  b.attach(ws);
  assert.deepEqual(ws.sent.shift(), { type: 'welcome' }, 'Echo says it accepted the socket (the extension only shows connected after this)');
  ws.emit('message', JSON.stringify({ type: 'hello', version: '1.0.0', browser: 'Chrome/140' }));
  const st = b.status();
  assert.equal(st.connected, true);
  assert.equal(st.version, '1.0.0');
  assert.equal(st.browser, 'Chrome/140');
  const p = b.snapshot();
  const req = ws.sent[0];
  assert.equal(req.cmd, 'snapshot');
  ws.emit('message', JSON.stringify({ id: req.id, ok: true, result: PAGE }));
  assert.equal((await p).title, 'Inbox - Gmail');
  const q = b.act({ ref: 'e1', verb: 'click' });
  ws.emit('message', JSON.stringify({ id: ws.sent[1].id, ok: false, error: 'e1 is gone', code: 'stale' }));
  await assert.rejects(q, (e) => /** @type {any} */ (e).code === 'stale');
  const r = b.tabs();
  ws.emit('close');
  await assert.rejects(r, /disconnected/);
  assert.equal(b.connected, false);
  assert.ok(b.status().lastDisconnect, 'not connected says when it went');
  await assert.rejects(b.snapshot(), /disconnected .* ago/);
});

test('the extension connection stays honest: keep-alive answered, a silent socket is dropped, a wrong code is remembered', async () => {
  const code = 'abcdefghijklmnop';
  const ext = 'chrome-extension://hcdlbgkecbalaocdcohhbjigebdipjeb';
  assert.equal(extensionRefusal({ origin: ext, url: `/ws/browser?code=${code}` }, code), '');
  assert.equal(extensionRefusal({ origin: ext, url: '/ws/browser?code=nope' }, code), 'code');
  assert.equal(extensionRefusal({ origin: 'https://mail.google.com', url: `/ws/browser?code=${code}` }, code), 'origin');

  const b = new ExtensionBrowser({ timeoutMs: 200, heartbeatMs: 20 });
  b.refused('code');
  assert.equal(b.status().lastRefused?.why, 'code');
  await assert.rejects(b.snapshot(), (/** @type {any} */ e) => e.code === 'no_browser' && /wrong pairing code/.test(e.message));

  // A socket that answers Echo's pings stays; the extension's own ping gets a pong.
  let answers = true;
  /** @type {any} */
  const alive = Object.assign(new EventEmitter(), { readyState: 1, sent: [], pings: 0,
    send(d) { this.sent.push(JSON.parse(d)); }, close() {}, terminate() { this.readyState = 3; },
    ping() { this.pings++; if (answers) setImmediate(() => alive.emit('pong')); } });
  b.attach(alive);
  assert.equal(b.status().lastRefused, undefined, 'connected: no stale refusal');
  alive.emit('message', JSON.stringify({ type: 'ping' }));
  assert.deepEqual(alive.sent.at(-1), { type: 'pong' });
  await wait(120);
  assert.ok(alive.pings >= 2, 'Echo pings it');
  assert.equal(b.connected, true, 'answering: still connected');

  // Chrome stopped the service worker: no answers. It's dropped, and says so.
  answers = false;
  await wait(120);
  assert.equal(b.connected, false, 'a socket that stopped answering is not connected');
  assert.equal(alive.readyState, 3, 'and is closed');
  assert.match(b.explain(), /stopped answering/);

  // A second socket replaces the first (the first is told why).
  /** @type {any} */
  const one = Object.assign(new EventEmitter(), { readyState: 1, send() {}, closed: '', close(_c, why) { this.closed = why; }, ping() { setImmediate(() => one.emit('pong')); } });
  /** @type {any} */
  const two = Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() {}, ping() { setImmediate(() => two.emit('pong')); } });
  b.attach(one);
  b.attach(two);
  assert.equal(one.closed, 'replaced');
  one.emit('close', 1000, 'replaced');
  assert.equal(b.connected, true, "the old socket closing doesn't disconnect the new one");
  two.emit('close', 1001, '');
  assert.equal(b.connected, false);
});

test('observe says the same thing the extension does: no_browser explains, no_page is connected', async () => {
  on();
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 300 });
  bridge.nativeClients = () => 1;
  const c = new ComputerUse({ bridge, logFile });
  const ext = new ExtensionBrowser({ timeoutMs: 200 });
  const cdp = /** @type {any} */ ({ available: async () => false });
  const ex = new Executor({ computer: c, browser: new BrowserHub({ extension: ext, cdp }) });
  ext.refused('code');
  const none = await ex.observe({ source: 'browser' });
  assert.equal(none.error, 'no_browser');
  assert.equal(none.connected, false);
  assert.match(none.message, /wrong pairing code/, 'says why, from what the server saw');
  // Connected, but the front tab is the extension's own options page.
  const noPage = new ExtensionBrowser();
  noPage.request = async () => { throw Object.assign(new Error("The extension is connected, but the front tab is the Echo extension's own page, not a web page."), { code: 'no_page' }); };
  Object.defineProperty(noPage, 'connected', { get: () => true });
  const ex2 = new Executor({ computer: c, browser: new BrowserHub({ extension: noPage, cdp }) });
  const r = await ex2.observe({ source: 'browser' });
  assert.equal(r.error, 'no_page');
  assert.equal(r.connected, true, 'no_page means connected');
  const hub = await new BrowserHub({ extension: ext, cdp }).status();
  assert.equal(hub.extension, false);
  assert.match(hub.detail, /wrong pairing code/, 'Settings shows the same reason');
});

test('the Chrome extension: one socket, a keep-alive and an alarm, connected only after Echo says welcome', () => {
  const bg = fs.readFileSync(path.join(APP_ROOT, 'extension', 'background.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('alarms'), 'the alarm that wakes a stopped worker');
  assert.match(bg, /if \(ws && \(ws\.readyState === WebSocket\.CONNECTING \|\| ws\.readyState === WebSocket\.OPEN\)\) return;/, 'never a second socket');
  assert.match(bg, /m\.type === 'welcome'[\s\S]{0,80}setStatus\('connected'\)/, 'connected only after welcome');
  assert.doesNotMatch(bg.slice(bg.indexOf('sock.onopen'), bg.indexOf('sock.onmessage')), /setStatus\('connected'\)/, 'not merely because the socket opened');
  assert.match(bg, /type: 'ping'/, 'keep-alive');
  assert.match(bg, /chrome\.alarms\.create\('echo-connect'/);
  assert.match(bg, /if \(ws !== sock\) return;/, 'an old socket closing never clobbers the new one');
  assert.match(bg, /area === 'local' && \('code' in changes \|\| 'port' in changes\)/, 'its own status updates never restart it');
  const opts = fs.readFileSync(path.join(APP_ROOT, 'extension', 'options.js'), 'utf8');
  assert.doesNotMatch(opts, /getTitle/, 'the options page reads the real state, not the toolbar title');
  assert.match(opts, /echoStatus/);
});

test("Chrome's DevTools protocol: finds the page tab, snapshots, clicks with real events, types with insertText", async () => {
  const sent = [];
  class FakeWS extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      setImmediate(() => this.emit('open'));
    }
    send(d) {
      const m = JSON.parse(d);
      sent.push(m);
      let result = {};
      if (m.method === 'Runtime.evaluate') {
        const e = m.params.expression;
        if (e.includes('data-echo-ref') && e.includes('location.href') && !e.includes('querySelectorAll')) result = { result: { value: { exists: true, value: sent.some((x) => x.method === 'Input.insertText') ? 'hello' : '', url: 'https://x.test', nodes: 5 } } };
        else if (e.includes('getBoundingClientRect') && e.includes('scrollIntoView')) result = { result: { value: { x: 50, y: 20 } } };
        else result = { result: { value: PAGE } };
      }
      setImmediate(() => this.emit('message', JSON.stringify({ id: m.id, result })));
    }
    close() {}
  }
  const fetchImpl = /** @type {any} */ (async () => ({ json: async () => [{ id: 'T1', type: 'page', url: 'https://x.test', title: 'X', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1' }] }));
  const cdp = new CdpBrowser({ fetchImpl, WebSocketImpl: FakeWS, timeoutMs: 500 });
  assert.equal(await cdp.available(), true);
  assert.equal((await cdp.snapshot()).title, 'Inbox - Gmail');
  const r = await cdp.act({ snapshot: 's1', ref: 'e3', verb: 'fill', text: 'hello' });
  const methods = sent.map((m) => m.method);
  assert.ok(methods.includes('Input.dispatchMouseEvent'), 'a real click to focus');
  assert.ok(methods.includes('Input.insertText'), 'typed through the input pipeline');
  assert.equal(judgeBrowserAct('fill', r, { text: 'hello' }).verified, true);
  const none = new CdpBrowser({ fetchImpl: /** @type {any} */ (async () => { throw new Error('refused'); }) });
  assert.equal(await none.available(), false);
});

test('judging a page action: filled text, a changed page, or not', () => {
  assert.equal(judgeBrowserAct('fill', { before: { value: '' }, after: { value: 'sam@example.com' } }, { text: 'sam@example.com' }).verified, true);
  assert.equal(judgeBrowserAct('replace', { before: { value: 'old' }, after: { value: 'oldnew' } }, { text: 'new' }).verified, false, 'replace means only the new text');
  assert.equal(judgeBrowserAct('click', { before: { url: 'a', nodes: 3 }, after: { url: 'a', nodes: 3 } }).verified, false);
  assert.equal(judgeBrowserAct('click', { before: { url: 'a', nodes: 3 }, after: { url: 'a', nodes: 9 } }).verified, true);
  assert.equal(judgeBrowserAct('upload', { before: {}, after: { files: 1 } }).verified, true);
});

test('the executor on a page: observe, act by ref (checked), stale refs refused, passwords refused, Send asks first', async (t) => {
  on();
  // Every address is read back, dictated or not: the rule with "ask by what an action does" off
  // (with it on, only what the user dictated is: test/policy.test.ts).
  process.env.ECHO_FLAG_POLICY = '0';
  t.after(() => delete process.env.ECHO_FLAG_POLICY);
  const browser = fakeBrowser();
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 300 });
  bridge.nativeClients = () => 1;
  const c = new ComputerUse({ bridge, logFile });
  const ex = new Executor({ computer: c, browser: new BrowserHub({ extension: /** @type {any} */ (browser) }) });
  const seen = await ex.observe({ app: 'Google Chrome' });
  assert.equal(seen.source, 'browser');
  assert.match(seen.page, /\[e2\] combobox "To recipients"/);
  // The address is read back first (lib/readback.js), and typed after the user's yes.
  assert.equal((await ex.act({ ref: 'e2', verb: 'fill', text: 'sam@example.com', commit: 'tab' })).needsReadBack, true);
  assert.equal(browser.calls.length, 0);
  c.noteSaid("That's s-a-m at example dot com, right?");
  c.newTurn('yes');
  const to = await ex.act({ ref: 'e2', verb: 'fill', text: 'sam@example.com', commit: 'tab' });
  assert.equal(to.done, true);
  assert.equal(browser.calls[0].commit, 'tab', 'the chip commit goes with it');
  assert.equal((await ex.act({ ref: 'e2', verb: 'fill', text: 'x', snapshot: 's0' })).error, 'stale');
  assert.equal((await ex.act({ ref: 'e99', verb: 'click' })).error, 'no_ref');
  const pw = await ex.act({ ref: 'e6', verb: 'fill', text: 'hunter2' });
  assert.equal(pw.refused, true, 'never into a password field');
  const send = await ex.act({ ref: 'e5', verb: 'click', payload: { kind: 'email', to: 'sam@example.com', subject: 'Hi' } });
  assert.equal(send.waitingForConfirmation, true);
  assert.equal(browser.calls.filter((x) => x.ref === 'e5').length, 0, 'nothing sent before the yes');
  c.newTurn();
  const allowed = await c.confirm(send.confirmId, true, 'voice');
  assert.equal(allowed.done, true, 'the confirmed click goes through the page and is checked');
  assert.equal(browser.calls.filter((x) => x.ref === 'e5').length, 1);
  c.end('done');
});

test('the executor on the Mac app: observe gives n-refs, act by ref goes to exactly that element', async () => {
  on();
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 300 });
  bridge.nativeClients = () => 1;
  const reqs = [];
  bridge.on('request', (r) => {
    reqs.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'observe') out = { ok: true, snapshot: 'nabc', app: 'Finder', title: 'Desktop', elements: [{ ref: 'n1', role: 'row', name: 'Budget.xlsx' }, { ref: 'n2', role: 'searchbox', name: 'Search', editable: true }] };
    else if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: 't1', label: 'Budget.xlsx', role: 'AXRow', app: 'Finder', window: 'Desktop' };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: 'Finder', verified: true, changes: ['target_state'] };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const c = new ComputerUse({ bridge, logFile });
  const ex = new Executor({ computer: c, browser: null });
  const seen = await ex.observe({ app: 'Finder' });
  assert.equal(seen.source, 'native');
  assert.match(seen.page, /\[n1\] row "Budget\.xlsx"/);
  const r = await ex.act({ ref: 'n1', verb: 'right_click' });
  assert.equal(r.done, true);
  const resolve = reqs.find((x) => x.kind === 'act' && x.params.step === 'resolve');
  assert.equal(resolve.params.ref, 'n1');
  assert.equal(resolve.params.snapshot, 'nabc');
  assert.equal(reqs.find((x) => x.params.step === 'do').params.button, 'right');
  c.end('done');
});

test('batching: steps run in order, each checked, and it stops at the first that did not work', async () => {
  on();
  const browser = fakeBrowser();
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 300 });
  bridge.nativeClients = () => 1;
  const c = new ComputerUse({ bridge, logFile });
  const ex = new Executor({ computer: c, browser: new BrowserHub({ extension: /** @type {any} */ (browser) }) });
  await ex.observe({ app: 'Google Chrome' });
  c.noteSaid('Sam at example dot com, subject Lunch. Right?');
  c.newTurn('yes');
  const ok = await ex.batch([{ ref: 'e2', verb: 'fill', text: 'sam@example.com', commit: 'tab' }, { ref: 'e3', verb: 'replace', text: 'Lunch' }, { ref: 'e4', verb: 'fill', text: 'Noon?' }]);
  assert.equal(ok.done, true);
  assert.equal(ok.completed, 3);
  const stopped = await ex.batch([{ ref: 'e3', verb: 'replace', text: 'x' }, { ref: 'e1', verb: 'click' }, { ref: 'e4', verb: 'fill', text: 'never' }]);
  assert.equal(stopped.done, false);
  assert.equal(stopped.completed, 1, 'the click changed nothing, so it stopped there');
  assert.ok(!browser.calls.some((x) => x.text === 'never'), 'the step after it was not done');
  c.end('done');
});

test('the grid: a cell is the centre of its box in the picture', () => {
  assert.deepEqual(gridCell(1, { cols: 8, width: 1600, height: 1000 }), { x: 100, y: 100 });
  assert.deepEqual(gridCell(9, { cols: 8, width: 1600, height: 1000 }), { x: 100, y: 300 });
  assert.equal(gridCell(0, { cols: 8, width: 1600, height: 1000 }), null);
  assert.equal(gridCell(99, { cols: 8, width: 1600, height: 1000 }), null);
});

test('the local intent router: only the whole, unambiguous command', () => {
  assert.deepEqual(localIntent('Pause'), { kind: 'media', action: 'pause' });
  assert.deepEqual(localIntent('Echo, next song please'), { kind: 'media', action: 'next' });
  assert.deepEqual(localIntent('volume up'), { kind: 'volume', action: 'up' });
  assert.deepEqual(localIntent('set the volume to 30'), { kind: 'volume', action: 'set', level: 30 });
  assert.deepEqual(localIntent('mute'), { kind: 'volume', action: 'mute' });
  assert.deepEqual(localIntent("what's the time"), { kind: 'time' });
  assert.equal(localIntent('scroll down'), null, 'only while driving');
  assert.deepEqual(localIntent('scroll down a bit', { driving: true }), { kind: 'scroll', direction: 'down' });
  assert.deepEqual(localIntent('go back', { driving: true }), { kind: 'back' });
  for (const t of ['pause the video and open Spotify', 'what time is my meeting', 'play Taylor Swift', 'next, open my email', 'mute the Slack channel'])
    assert.equal(localIntent(t), null, t);
});

test('instant commands run without a model and say so briefly', async () => {
  const osa = [];
  const quick = { osa: async (s) => { osa.push(s); return 'Spotify'; }, mediaControl: async (a) => ({ app: a.app, did: a.action }) };
  const computer = /** @type {any} */ ({ driving: false, run: null, act: async () => ({ done: true }) });
  const r = await runLocalIntent({ kind: 'media', action: 'pause' }, { quick, computer });
  assert.deepEqual(r, { ok: true, say: 'Paused.', did: 'Spotify pause' });
  const v = await runLocalIntent({ kind: 'volume', action: 'set', level: 30 }, { quick, computer });
  assert.equal(v.say, 'Volume 30.');
  assert.match(osa.at(-1), /set volume output volume 30/);
  const t = await runLocalIntent({ kind: 'time' }, { quick, computer, now: () => 'Tuesday, September 29, 2026 at 2:05 PM EDT' });
  assert.equal(t.say, "It's 2:05 PM.");
  const bad = await runLocalIntent({ kind: 'media', action: 'next' }, { quick: { osa: async () => '', mediaControl: async () => { throw new Error('Spotify is not running.'); } }, computer });
  assert.equal(bad.ok, false);
  assert.match(bad.say, /not running/);
});

test('turn weight and fast-model routing: Haiku by default for quick turns, straight back for real work', async () => {
  assert.equal(turnWeight('how are you doing'), 'quick');
  assert.equal(turnWeight('what is the capital of France'), 'quick');
  assert.equal(turnWeight('email Sam about lunch'), 'full');
  assert.equal(turnWeight('how are you', { driving: true }), 'full');
  const { Dispatcher } = await import('../lib/dispatcher.js');
  const { TaskManager } = await import('../lib/tasks.js');
  const { fastModelId, DEFAULT_FAST_MODEL } = await import('../lib/settings.js');
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const set = [];
  d.q = /** @type {any} */ ({ setModel: async (m) => set.push(m) });
  assert.equal(DEFAULT_FAST_MODEL, 'claude-haiku-4-5');
  assert.equal(fastModelId(getSettings()), DEFAULT_FAST_MODEL, 'on by default');
  assert.equal(fastModelId({ fastModel: '' }), DEFAULT_FAST_MODEL, "an older settings file's '' reads as the default");
  assert.equal(d.routeModel('quick'), true);
  assert.deepEqual(set, [DEFAULT_FAST_MODEL], 'the first quick turn goes to the fast model');
  d.routeModel('quick');
  assert.equal(set.length, 1, 'already there: no switch');
  assert.equal(d.routeModel('full'), false);
  assert.deepEqual(set, [DEFAULT_FAST_MODEL, undefined], 'back to the main model');
  // The fast model hands a turn over: the rest of it runs on the main model.
  d.routeModel('quick');
  d.turn = /** @type {any} */ ({ handoff: false });
  assert.match(await d.handOff(), /main model/);
  assert.deepEqual(set.slice(-2), [DEFAULT_FAST_MODEL, undefined]);
  assert.equal(d.turn?.handoff, true);
  // Too much context for the fast model: stays on the main one.
  d.ctxTokens = 180_000;
  assert.equal(d.routeModel('quick'), false);
  d.ctxTokens = 0;
  setFixedForTest({ fastModel: 'claude-sonnet-5' });
  d.routeModel('quick');
  assert.equal(set.at(-1), 'claude-sonnet-5', 'another fast model can be chosen');
  setFixedForTest({ fastModel: 'off' });
  assert.equal(d.routeModel('quick'), false);
  assert.equal(set.at(-1), undefined, 'switched off mid-session: back to the main model');
  const n = set.length;
  assert.equal(d.routeModel('full'), false);
  assert.equal(d.routeModel('quick'), false);
  assert.equal(set.length, n, 'off: never switches again');
  setFixedForTest({ fastModel: 'auto' });
  assert.equal(saveSettings({ fastModel: 'off' }).fastModel, 'auto', 'not a setting any more: a saved value is ignored');
  assert.equal(saveSettings({ driveMode: 'nope' }).driveMode, 'do');
  assert.equal(getSettings().backgroundCursor, false);
  // Instant commands never reach the model.
  assert.deepEqual(d.localIntentFor('volume down'), { kind: 'volume', action: 'down' });
});

test('the local judge: settles the unsure band only when confident; Apple first, then Ollama, else nothing', async () => {
  assert.equal(parseDirected('{"directed": 0.92}'), 0.92);
  assert.equal(parseDirected('directed: .1'), 0.1);
  assert.equal(parseDirected('yes'), null);
  const ask = { decision: 'ask', confidence: 0.6, why: 'direct_unsure' };
  assert.equal(settle(ask, { directed: 0.9 }).decision, 'accept');
  assert.equal(settle(ask, { directed: 0.1 }).decision, 'ignore');
  assert.equal(settle(ask, { directed: 0.5 }).decision, 'ask');
  assert.equal(settle({ decision: 'ignore', confidence: 0.1, why: 'x' }, { directed: 0.99 }).decision, 'ignore', 'never overrides a clear decision');
  const bridge = { native: true, request: async () => ({ ok: true, text: '{"directed":0.9}' }) };
  assert.deepEqual(await localDirected({ text: 'can you open it' }, { bridge, url: '' }), { directed: 0.9, via: 'apple' });
  const fetchImpl = /** @type {any} */ (async () => ({ json: async () => ({ response: '{"directed": 0.05}' }) }));
  assert.deepEqual(await localDirected({ text: 'the game last night' }, { bridge: { native: true, request: async () => ({ ok: false, error: 'unavailable' }) }, url: 'http://127.0.0.1:11434', fetchImpl }), { directed: 0.05, via: 'ollama' });
  assert.equal(await localDirected({ text: 'x' }, { bridge: null, url: '' }), null);
  const slow = { native: true, request: () => new Promise((r) => setTimeout(() => r({ ok: true, text: '{"directed":1}' }), 500)) };
  assert.equal(await localDirected({ text: 'x' }, { bridge: slow, url: '', timeoutMs: 50 }), null, 'too slow: the rules decide');
});

test('eval harness: Phase 1 targets on the 60-task suite', async () => {
  on();
  const { runSuite, ALL_TASKS } = await import('../lib/evalsuite.js');
  assert.equal(ALL_TASKS.length, 60);
  const v1 = await runSuite('v1', { logFile, tasks: ALL_TASKS });
  assert.ok(v1.metrics.successRate >= 0.85, `success ${v1.metrics.successRate}`);
  assert.ok(v1.metrics.falseSuccessRate < 0.01, `false success ${v1.metrics.falseSuccessRate}`);
  assert.ok(v1.metrics.medianSteps <= 4);
  assert.ok(v1.metrics.medianSeconds <= 20);
  assert.ok(Number(v1.metrics.commandSeconds) < 0.8, `instant commands ${v1.metrics.commandSeconds} s`);
});
