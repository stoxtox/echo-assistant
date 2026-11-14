// Filling web forms in Chrome reliably (Oct 11, found filling an eBay listing's description):
// 1. The Echo extension reconnects by itself: the real extension worker (extension/background.js,
//    with a stand-in for Chrome's APIs) against the real server, across an Echo restart, with the
//    same pairing; an unpaired extension gets one clear prompt; a step right after a restart waits
//    for it instead of reading Chrome's toolbar.
// 2. Typing's paste fallback for rich-text editors (contenteditable, iframe editors): when the
//    Mac's focus guard refuses or typing isn't confirmed, the text is pasted where the page has the
//    caret and checked through the page or the screen.
// 3. A real Chrome (headless, its own throwaway profile; skipped if Chrome isn't installed) reads
//    and fills an iframe rich-text editor on a local page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { sandbox, until, wait } from './helpers.js';

const dirs = sandbox('chromeforms');
const srv = await import('../server.js');
const { pairingCode, readLink, ExtensionBrowser, CdpBrowser, judgeBrowserAct } = await import('../lib/browser.js');
const { BrowserHub } = await import('../lib/executor.js');
const { ComputerUse, pasteProbe } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { focusInFrame, textInFrame } = await import('../extension/page.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

/** The real extension worker in a thread, reporting each status it shows. */
function extensionWorker(port, code) {
  const w = new Worker(new URL('./fixtures/fake-chrome-worker.mjs', import.meta.url), { workerData: { port, code } });
  const statuses = [];
  w.on('message', (m) => m.status && statuses.push(m.status));
  w.on('error', (/** @type {any} */ e) => statuses.push({ state: 'crashed', detail: e?.message }));
  return { w, statuses, last: () => statuses.at(-1)?.state };
}

test('the extension stays paired across an Echo restart and reconnects by itself', async () => {
  const ext = srv.dispatcher.browser.extension;
  const code = pairingCode();
  let port = await srv.start({ port: 0, boot: false });
  const chrome = extensionWorker(port, code);
  try {
    await until(() => ext.connected && chrome.last() === 'connected', 5000, 'the first connection');
    assert.equal(readLink()?.version, '1.2.0', 'Echo remembers it was connected (not the code)');
    assert.doesNotMatch(fs.readFileSync(path.join(dirs.data, 'browser-link.json'), 'utf8'), new RegExp(code), 'the code is never in the link file');
    // A request through it, answered by the editor's frame (allFrames).
    const focus = await ext.focus();
    assert.equal(focus.editable, true);
    assert.equal(focus.kind, 'design_mode');

    // Echo restarts: the socket goes, the extension says it's reconnecting, then it's back by
    // itself on the same port with the same code: no pairing again.
    await srv.stop();
    await until(() => !ext.connected && chrome.last() !== 'connected', 5000, 'the drop');
    assert.ok(['connecting', 'offline'].includes(chrome.last()), `shows it is reconnecting (${chrome.last()})`);
    port = await srv.start({ port, boot: false });
    const t0 = Date.now();
    await until(() => ext.connected && chrome.last() === 'connected', 8000, 'the reconnection');
    assert.ok(Date.now() - t0 < 8000);
    assert.equal(pairingCode(), code, 'the same pairing code after the restart');
    assert.equal(chrome.statuses.filter((s) => s.state === 'refused' || s.state === 'unpaired').length, 0, 'never asked to pair again');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json())).browser.connected, true, 'health says it is connected');
  } finally {
    await chrome.w.terminate();
  }
  await until(() => !ext.connected, 3000, 'the worker gone');
  await srv.stop();
});

test('an unpaired extension knocks, and Echo shows one clear pairing prompt until it is paired', async () => {
  const ext = srv.dispatcher.browser.extension;
  const port = await srv.start({ port: 0, boot: false });
  const chrome = extensionWorker(port, '');
  const statuses = [];
  const onStatus = (s) => statuses.push(s);
  ext.on('status', onStatus);
  try {
    await until(() => ext.pairingNeeded, 5000, 'the knock');
    const st = ext.status();
    assert.equal(st.lastRefused.why, 'unpaired');
    assert.equal(st.pairingNeeded, true);
    assert.match(ext.explain(), /isn't paired yet[\s\S]*Echo's window is showing the pairing code/);
    assert.equal(chrome.last(), 'unpaired');
    // The window's prompt (public/app.js refreshChrome reads /api/browser on each status).
    const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(page, /pairingNeeded[\s\S]{0,400}chromePair/);
    assert.match(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /id="chromePair"[\s\S]*Echo for Chrome needs pairing/);
    // It keeps knocking every few seconds; the window hears about it once.
    await wait(1500);
    assert.ok(statuses.filter((s) => s.pairingNeeded).length <= 1, 'one prompt, not one per knock');
    // Paired: in at once, and the prompt goes.
    chrome.w.postMessage({ setCode: pairingCode() });
    await until(() => ext.connected, 5000, 'the pairing');
    assert.equal(ext.status().pairingNeeded, undefined);
  } finally {
    ext.off('status', onStatus);
    await chrome.w.terminate();
  }
  await until(() => !ext.connected, 3000, 'the worker gone');
  await srv.stop();
});

test('after a restart Echo knows the extension was paired, and a browser step waits for it a moment', async () => {
  const linkFile = path.join(dirs.root, 'link.json');
  const sock = () => Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() {}, ping() {} });
  const before = new ExtensionBrowser({ linkFile });
  const s1 = sock();
  before.attach(s1);
  s1.emit('message', JSON.stringify({ type: 'hello', version: '1.2.0', browser: 'Chrome/140' }));
  assert.ok(readLink(linkFile)?.lastConnectedAt);

  // Echo restarted: a new connection object, nothing connected yet.
  const after = new ExtensionBrowser({ linkFile, reconnectWaitMs: 2000 });
  assert.equal(after.connected, false);
  assert.equal(after.wasPaired, true);
  assert.equal(after.expectedBack(), true);
  assert.equal(after.status().reconnecting, true);
  assert.match(after.explain(), /hasn't reconnected since Echo started[\s\S]*so it is paired/);
  const hub = new BrowserHub({ extension: after, cdp: /** @type {any} */ ({ available: async () => false }) });
  const picking = hub.pick();
  setTimeout(() => after.attach(sock()), 100);
  assert.equal(await picking, after, 'the step waited for it instead of reading Chrome without it');

  // Never paired: nothing to wait for. A wrong code: no waiting either (it needs pairing).
  const never = new ExtensionBrowser({ linkFile: path.join(dirs.root, 'none.json'), reconnectWaitMs: 2000 });
  let t0 = Date.now();
  assert.equal(await new BrowserHub({ extension: never, cdp: /** @type {any} */ ({ available: async () => false }) }).pick(), null);
  assert.ok(Date.now() - t0 < 500);
  const wrong = new ExtensionBrowser({ linkFile, reconnectWaitMs: 2000 });
  wrong.refused('code');
  t0 = Date.now();
  assert.equal(await new BrowserHub({ extension: wrong, cdp: /** @type {any} */ ({ available: async () => false }) }).pick(), null);
  assert.ok(Date.now() - t0 < 500);
});

test('the extension worker never looks connected on a dead socket, and retries quickly', () => {
  const bg = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /Date\.now\(\) - lastHeard > KEEPALIVE_MS \* 2/, 'a socket Echo stopped answering is replaced');
  assert.match(bg, /CONNECT_TIMEOUT_MS/, 'a try that hangs is given up');
  assert.match(bg, /const RETRY_MAX_MS = 10000/, 'never more than 10 s between tries while awake');
  assert.match(bg, /chrome\.alarms\.create\('echo-connect'/, 'the alarm wakes a stopped worker');
});

/* ---------- typing's paste fallback ---------- */

const on = () => (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do' }));

/**
 * A fake Mac app: typing in Chrome is refused by the focus guard ("nothing focused", as on eBay)
 * or done but unreadable; paste_text pastes. `o` changes what it answers.
 */
function fakeMac(o = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') {
      out = p.action === 'paste_text' && o.oldApp ? { ok: false, error: 'no_target', message: 'Say what to act on.' } : { ok: true, found: true, token: `t${seen.length}`, label: p.target || '', role: 'AXGroup', app: 'Google Chrome', window: 'Complete your listing | eBay' };
    } else if (r.kind === 'act' && p.step === 'do') {
      if (p.action === 'paste_text') out = { ok: true, via: 'paste', app: 'Google Chrome', verified: false, unreadable: true, ...(o.paste?.(p) || {}) };
      else out = o.typing === 'unconfirmed' ? { ok: true, via: 'keys', app: 'Google Chrome', verified: false, unreadable: true } : { ok: false, error: 'focus_guard', focused: 'nothing', message: 'Nothing editable has the keyboard focus.' };
    } else if (r.kind === 'wait') out = { ok: true, found: Boolean(o.onScreen), via: 'screen' };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const pastes = () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do' && r.params.action === 'paste_text');
  return { bridge, seen, pastes };
}

/** A connected extension whose page has its focus in `focus`, and holds `texts`. */
function fakeHub(focus, texts = []) {
  const ext = { connected: true, asked: [], focus: async () => (ext.asked.push('focus'), focus), findText: async (t) => (ext.asked.push(`find:${t}`), { found: texts.some((x) => x.toLowerCase().includes(String(t).toLowerCase())) }) };
  return { extension: ext, connected: true };
}

const DESCRIPTION = 'Meet the Storybook Spire, a birdhouse that looks like it wandered out of a picture book.\n\nThe real charmer is the door.';

test('typing refused in an iframe editor ("nothing focused"): pasted where the page has the caret, checked on the page', async () => {
  on();
  fs.rmSync(logFile, { force: true });
  const mac = fakeMac({ paste: (p) => (hub.extension.findText = async () => ({ found: true }), {}) });
  const c = new ComputerUse({ bridge: mac.bridge, logFile });
  const hub = fakeHub({ editable: true, secret: false, kind: 'design_mode', inFrame: true });
  c.browser = hub;
  const r = await c.act('type_text', { text: DESCRIPTION, app: 'Google Chrome' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(r.verified, true);
  assert.equal(r.via, 'paste');
  assert.match(r.note, /pasted the text[\s\S]*clipboard was put back/);
  const [paste] = mac.pastes();
  assert.equal(paste.params.text, DESCRIPTION, 'the whole text, line breaks and all');
  assert.equal(paste.params.pageFocus, 'editable', "the extension's word that the focus is in an editor");
  assert.equal(paste.params.target, undefined, 'no second click: the caret is where the first step put it');
  assert.match(log(), /"via":"paste","fallback":"refused"/);
});

test('the paste fallback never pastes blind: not into a password, nor where nothing takes text, nor over a field (replace)', async () => {
  on();
  // A password field has the focus: refused, nothing pasted.
  let mac = fakeMac();
  let c = new ComputerUse({ bridge: mac.bridge, logFile });
  c.browser = fakeHub({ editable: true, secret: true, kind: 'input' });
  let r = await c.act('type_text', { text: 'hello there', app: 'Google Chrome' });
  assert.equal(r.refused, true);
  assert.equal(mac.pastes().length, 0);
  // The page's focus is on nothing that takes text: the guard's answer stands.
  mac = fakeMac();
  c = new ComputerUse({ bridge: mac.bridge, logFile });
  c.browser = fakeHub({ editable: false, secret: false, kind: 'page' });
  r = await c.act('type_text', { text: 'hello there', app: 'Google Chrome' });
  assert.equal(r.error, 'focus_guard');
  assert.equal(mac.pastes().length, 0);
  // Replace mode: a paste would add, not replace.
  mac = fakeMac();
  c = new ComputerUse({ bridge: mac.bridge, logFile });
  c.browser = fakeHub({ editable: true, secret: false, kind: 'contenteditable' });
  r = await c.act('type_text', { text: 'hello there', app: 'Google Chrome', mode: 'replace' });
  assert.equal(r.error, 'focus_guard');
  assert.equal(mac.pastes().length, 0);
  // A Mac app from before paste_text: the guard's answer stands.
  mac = fakeMac({ oldApp: true });
  c = new ComputerUse({ bridge: mac.bridge, logFile });
  c.browser = fakeHub({ editable: true, secret: false, kind: 'contenteditable' });
  r = await c.act('type_text', { text: 'hello there', app: 'Google Chrome' });
  assert.equal(r.error, 'focus_guard');
});

test('without the extension: pasted in the browser, and checked by the screen text', async () => {
  on();
  const mac = fakeMac({ onScreen: true });
  const c = new ComputerUse({ bridge: mac.bridge, logFile });
  const r = await c.act('type_text', { text: DESCRIPTION, app: 'Google Chrome' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(mac.pastes()[0].params.pageFocus, 'unknown');
  const looked = mac.seen.filter((x) => x.kind === 'wait').at(-1);
  assert.equal(looked.params.target, pasteProbe(DESCRIPTION).slice(0, 60), 'looked for the start of the text');
  // Not seen anywhere: not claimed, and not pasted twice.
  const blind = fakeMac({ onScreen: false });
  const c2 = new ComputerUse({ bridge: blind.bridge, logFile });
  const r2 = await c2.act('type_text', { text: 'A short line', app: 'Google Chrome' });
  assert.equal(r2.done, false);
  assert.match(r2.note, /Don't type or paste it again yet/);
  assert.equal(blind.pastes().length, 1);
});

test('typing not confirmed: the page is asked first; pasted only when the text is not there', async () => {
  on();
  // It was there after all: confirmed, nothing pasted.
  let mac = fakeMac({ typing: 'unconfirmed' });
  let c = new ComputerUse({ bridge: mac.bridge, logFile });
  c.browser = fakeHub({ editable: true, secret: false, kind: 'contenteditable' }, [DESCRIPTION]);
  let r = await c.act('type_text', { text: DESCRIPTION, app: 'Google Chrome', into: 'Description' });
  assert.equal(r.done, true);
  assert.match(r.note, /in the page/);
  assert.equal(mac.pastes().length, 0);
  // Not there at all: pasted.
  mac = fakeMac({ typing: 'unconfirmed', paste: () => ({ verified: true }) });
  c = new ComputerUse({ bridge: mac.bridge, logFile });
  c.browser = fakeHub({ editable: true, secret: false, kind: 'contenteditable' }, []);
  r = await c.act('type_text', { text: DESCRIPTION, app: 'Google Chrome', into: 'Description' });
  assert.equal(r.done, true);
  assert.equal(r.via, 'paste');
  assert.equal(mac.pastes().length, 1);
  // Only part of it is there (typing got going): never pasted on top.
  mac = fakeMac({ typing: 'unconfirmed' });
  c = new ComputerUse({ bridge: mac.bridge, logFile });
  c.browser = fakeHub({ editable: true, secret: false, kind: 'contenteditable' }, ['Meet the Sto']);
  r = await c.act('type_text', { text: DESCRIPTION, app: 'Google Chrome', into: 'Description' });
  assert.equal(r.done, false);
  assert.equal(mac.pastes().length, 0);
  // Without the extension an unconfirmed step is never pasted on a guess.
  mac = fakeMac({ typing: 'unconfirmed' });
  c = new ComputerUse({ bridge: mac.bridge, logFile });
  r = await c.act('type_text', { text: DESCRIPTION, app: 'Google Chrome', into: 'Description' });
  assert.equal(r.done, false);
  assert.equal(mac.pastes().length, 0);
});

test('the Mac app: paste_text pastes and puts the clipboard back; the focus guard takes an iframe editor; x/y typing goes there', () => {
  const driver = fs.readFileSync(new URL('../macos/Sources/Driver.swift', import.meta.url), 'utf8');
  const fn = driver.slice(driver.indexOf('private func pasteText('), driver.indexOf('/// Empties a field before typing over it'));
  assert.match(fn, /isSecure\(cur\)/, 'never into a password field');
  assert.match(fn, /pageFocus != "not_editable"/);
  assert.match(fn, /guard paste\(text\)/, 'the paste that saves and restores the clipboard');
  assert.match(driver, /case "paste_text":\s*\n\s*pasteText\(/);
  assert.match(driver, /private func isFrameEditor[\s\S]{0,700}"AXWebArea"[\s\S]{0,200}AXEditable/, 'an editable iframe document counts as a field');
  assert.match(driver, /pb\.changeCount == ours[\s\S]{0,120}pb\.writeObjects\(saved\)/, 'what was on the clipboard goes back');
  assert.match(driver, /let hasTarget = !\(p\["target"\] as\? String \?\? ""\)\.isEmpty \|\| \(number\(p\["x"\]\) != nil/, 'typing at x/y clicks there first');
});

test('what a paste is checked by: the first line, a whole-word start of a long one', () => {
  assert.equal(pasteProbe('Hello there\nsecond line'), 'Hello there');
  assert.equal(pasteProbe('\n\n  spaced   out  '), 'spaced out');
  const p = pasteProbe(DESCRIPTION);
  assert.ok(p.length <= 80 && DESCRIPTION.startsWith(p) && !p.endsWith(' '));
});

/* ---------- a real Chrome and a real iframe editor ---------- */

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));

// A listing form like eBay's: a title field, and the description in an about:blank iframe in design mode.
const LISTING = `<!doctype html><html><head><title>Complete your listing</title></head><body style="margin:20px;font:14px sans-serif">
<label for="title">Item title</label> <input id="title" style="width:300px"><br><br>
<div style="height:40px"></div>
<iframe id="desc" title="Item description" style="width:500px;height:160px;border:1px solid #888"></iframe>
<script>
  const d = document.getElementById('desc').contentDocument;
  d.open(); d.write('<!doctype html><html><body style="margin:6px;min-height:140px"></body></html>'); d.close();
  d.designMode = 'on';
</script></body></html>`;

test('a real Chrome: the iframe rich-text editor is found, filled with real input, and read back', { skip: !CHROME && 'Chrome is not installed' }, async (t) => {
  const page = http.createServer((_q, res) => res.end(LISTING));
  await new Promise((r) => page.listen(0, '127.0.0.1', () => r(undefined)));
  const url = `http://127.0.0.1:${/** @type {any} */ (page.address()).port}/listing`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-chrome-'));
  const chrome = spawn(/** @type {string} */ (CHROME), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=900,700', url], { stdio: 'ignore' });
  t.after(() => {
    chrome.kill('SIGKILL');
    page.close();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500).unref();
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  try {
    await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').includes('\n'), 15000, "Chrome's debugging port");
  } catch {
    t.skip("Chrome didn't start headless here");
    return;
  }
  const cdp = new CdpBrowser({ port: Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]), timeoutMs: 5000 });
  await until(() => cdp.available(), 10000, 'the page');
  let snap;
  await until(async () => {
    snap = await cdp.snapshot().catch(() => null);
    return snap?.elements?.some((e) => e.frame);
  }, 10000, 'the editor in the snapshot');
  const editor = snap.elements.find((e) => e.frame && e.editable);
  assert.ok(editor, `the iframe editor is in the snapshot: ${JSON.stringify(snap.elements)}`);
  assert.equal(editor.role, 'textbox');
  assert.equal(editor.name, 'Item description', "named after its frame's title");
  assert.ok(editor.rect.y > 60, 'its box is in the top page (the frame offset added)');

  const r = await cdp.act({ snapshot: snap.snapshot, ref: editor.ref, verb: 'fill', text: 'A handmade birdhouse with a carved door.' });
  assert.equal(judgeBrowserAct('fill', r, { text: 'A handmade birdhouse with a carved door.' }).verified, true, JSON.stringify(r.after));
  const inFrame = await cdp.evaluate(`document.getElementById('desc').contentDocument.body.innerText`);
  assert.match(inFrame, /A handmade birdhouse with a carved door\./, 'the text is in the editor, not the page');
  assert.equal(await cdp.evaluate(`document.getElementById('title').value`), '', 'and nowhere else');

  // The checks the extension runs (focusInFrame, textInFrame) see into the frame.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const focus = await cdp.evaluate(`(${focusInFrame})()`);
  assert.equal(focus?.editable, true, JSON.stringify(focus));
  assert.equal(focus.kind, 'design_mode');
  assert.equal((await cdp.evaluate(`(${textInFrame})(${JSON.stringify('handmade birdhouse')})`)).found, true);
  assert.equal((await cdp.evaluate(`(${textInFrame})("not on the page")`)).found, false);
});
