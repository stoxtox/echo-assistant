// Screen awareness: redaction, the look/point bridge, the assistant's screen tools, handing a
// look to a worker (and deleting it after), the new settings, and dropping a retired correction.
// All in throwaway folders; nothing captures a real screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery } from './helpers.js';

const dirs = sandbox('screen');
process.env.ECHO_SCREEN_TMP_DIR = path.join(dirs.root, 'screen-tmp');
fs.mkdirSync(path.join(dirs.projects, 'Website'), { recursive: true });
const { redactText, luhn, cleanLook, cleanPoint, ScreenBridge, LOOK_TIMEOUT_MS, lookContent, isScreenShot, sweepScreenShots, screenTmpDir } = await import('../lib/screen.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { getSettings, saveSettings, PTT_HOTKEYS, COMPANION_LOOKS, setFixedForTest } = await import('../lib/settings.js');
const { dropRetiredCorrections, loadVocab, learnCorrection } = await import('../lib/vocab.js');

// A tiny real JPEG header is enough for the checks (they look at the magic bytes).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const tools = (d) => Object.fromEntries(d.toolList().map((t) => [t.name, /** @type {any} */ (t)]));
const logFile = () => path.join(dirs.data, 'screen-log.jsonl');

/** A bridge whose "Mac app" answers every request with `answer(request)`. */
function fakeApp(answer, { native = true } = {}) {
  const bridge = new ScreenBridge({ logFile: logFile(), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => (native ? 1 : 0);
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const out = answer(r);
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  return { bridge, seen };
}

test('secrets on screen are blacked out; ordinary text is left alone', () => {
  // Fake secrets are put together at run time, so the privacy check (lib/privacy.js) doesn't flag this file.
  const j = (...parts) => parts.join('');
  /** @type {Array<[string, RegExp]>} */
  const cases = [
    [j('export ANTHROPIC_API_KEY=', 'sk-', 'ant-api03-AbCdEfGhIjKlMnOpQrStUv'), /AbCdEfGh/],
    ['password: hunter22', /hunter22/],
    ['token = "abc123def"', /abc123def/],
    [j('gh', 'p_0123456789abcdefghijABCDEFGHIJ012345'), /0123456789abc/],
    [j('AK', 'IAIOSFODNN7EXAMPLE'), /IOSFODNN/],
    ['Card 4242 4242 4242 4242 exp 12/28', /4242 4242/],
    [j('DATABASE_URL=postgres://admin:', 's3cretPw', '@', 'db.example.com/app'), /s3cretPw/],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', /abcdefghijklmnop/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', /eyJhbGci/],
    [j('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIEow\n-----END RSA ', 'PRIVATE KEY-----'), /MIIEow/],
  ];
  for (const [input, secret] of cases) {
    const r = redactText(input);
    assert.doesNotMatch(r.text, secret, input);
    assert.match(r.text, /\[redacted\]/, input);
    assert.ok(r.count >= 1, input);
  }
  // The label stays, so the assistant can say "there's a password field".
  assert.equal(redactText('password: hunter22').text, 'password: [redacted]');
  // Not secrets: an error message, a git hash, an order number that fails the card check, a date.
  for (const plain of [
    "TypeError: Cannot read properties of undefined (reading 'map') at App.jsx:42",
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'Order 1234 5678 9012 3456 shipped',
    'Updated 2026-09-28 17:16',
  ]) {
    assert.deepEqual(redactText(plain), { text: plain, count: 0 }, plain);
  }
  assert.equal(luhn('4242424242424242'), true);
  assert.equal(luhn('1234567890123456'), false);
});

test('a look from the app is checked and redacted again before the assistant sees it', () => {
  const look = cleanLook({ text: 'api_key=zzTopSecret99', image: JPEG.toString('base64'), mime: 'image/jpeg', width: 10, height: 10, app: 'Terminal', redactions: 2 });
  assert.equal(look.text, 'api_key=[redacted]');
  assert.equal(look.redactions, 3, "the app's two plus this one");
  assert.equal(look.ocr, true);
  assert.ok(look.image.data.equals(JPEG));
  assert.throws(() => cleanLook({ image: Buffer.from('not an image').toString('base64') }), /isn't a JPEG or PNG/);
  const browser = cleanLook({ source: 'browser', image: JPEG.toString('base64') });
  assert.equal(browser.ocr, false);
});

test('the bridge asks the app, waits for its answer, and logs only that it looked', async () => {
  fs.rmSync(logFile(), { force: true });
  const { bridge, seen } = fakeApp(() => ({ text: 'Build failed: missing semicolon. password=opensesame', image: JPEG.toString('base64'), mime: 'image/jpeg' }));
  const r = await bridge.request('look', { reason: 'read the error' });
  assert.equal(seen[0].kind, 'look');
  assert.equal(seen[0].native, true);
  assert.ok(r.ok);
  assert.match(r.look.text, /Build failed/);
  assert.ok(bridge.recentLook(), 'kept in memory for a worker');
  const log = fs.readFileSync(logFile(), 'utf8');
  assert.match(log, /"event":"screen_looked"/);
  assert.doesNotMatch(log, /Build failed|opensesame|semicolon|read the error/, 'never what was on screen');
  assert.equal(bridge.deliver('nobody-asked', { text: 'x' }), false, 'answers nobody asked for are ignored');
  bridge.forget();
  assert.equal(bridge.recentLook(), null);
});

test('a look that gets no answer is asked once more, gives up after two short waits, and every time-out is logged', async () => {
  fs.rmSync(logFile(), { force: true });
  assert.equal(LOOK_TIMEOUT_MS, 6000, 'six seconds a try, not twenty');
  assert.equal(new ScreenBridge({ logFile: logFile() }).lookTimeoutMs, 6000);
  assert.equal(new ScreenBridge({ logFile: logFile() }).timeoutMs, 20000, 'other requests (a wait, a click) keep their own limit');

  // The first try is lost (a cold start); the second is answered.
  let n = 0;
  const cold = new ScreenBridge({ logFile: logFile(), lookTimeoutMs: 60 });
  cold.nativeClients = () => 1;
  const ids = [];
  cold.on('request', (r) => {
    ids.push(r.id);
    assert.equal(r.params.reason, 'read the error', 'the retry asks for the same thing');
    if (++n === 2) setImmediate(() => cold.deliver(r.id, { text: 'Build failed', image: JPEG.toString('base64'), mime: 'image/jpeg' }));
  });
  const r = await cold.request('look', { reason: 'read the error' });
  assert.equal(r.ok, true);
  assert.equal(n, 2);
  assert.equal(cold.deliver(ids[0], { text: 'late' }), false, 'a late answer to the first try is ignored');

  // Nobody answers at all: two tries, then a plain message for the assistant.
  const silent = new ScreenBridge({ logFile: logFile(), lookTimeoutMs: 60 });
  silent.nativeClients = () => 1;
  let asked = 0;
  silent.on('request', () => asked++);
  const t0 = Date.now();
  await assert.rejects(silent.request('look', { reason: 'read the error' }), /didn't answer in time \(two tries.*nothing was read from the screen.*don't guess/s);
  assert.equal(asked, 2);
  assert.ok(Date.now() - t0 < 1000);

  // Other requests aren't retried (a click must never be done twice).
  const act = new ScreenBridge({ logFile: logFile(), timeoutMs: 60 });
  act.nativeClients = () => 1;
  let acts = 0;
  act.on('request', () => acts++);
  await assert.rejects(act.request('act', { action: 'click' }), /didn't answer in time/);
  assert.equal(acts, 1);

  const log = fs.readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'screen_timeout');
  assert.deepEqual(log.map((e) => [e.kind, e.reason, e.attempt]), [['look', 'no_answer', 1], ['look', 'no_answer', 1], ['look', 'no_answer', 2], ['act', 'no_answer', 1]]);
  assert.ok(log.every((e) => typeof e.ms === 'number' && e.ms >= 50));
  assert.doesNotMatch(JSON.stringify(log), /read the error|click/, 'the reason for the time-out, never what was asked or seen');
});

test('the Mac app giving up on its own deadline is a plain failure, logged with how long it took', async () => {
  fs.rmSync(logFile(), { force: true });
  const { bridge } = fakeApp(() => ({ ok: false, error: 'slow', message: "Reading the screen took too long, so nothing was read: no text and no picture." }));
  const r = await bridge.request('look');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'slow');
  assert.match(r.message, /no text and no picture/);
  const e = JSON.parse(fs.readFileSync(logFile(), 'utf8').trim().split('\n').at(-1));
  assert.deepEqual([e.event, e.reason, typeof e.ms], ['screen_look_failed', 'slow', 'number']);
});

test('no answer in time, a declined browser share, and pointing without the Mac app', async () => {
  const silent = fakeApp(() => null).bridge;
  await assert.rejects(silent.request('look'), /didn't answer in time/);
  const browser = fakeApp(() => null, { native: false });
  const pending = browser.bridge.request('look');
  assert.equal(browser.seen[0].native, false, 'the browser card is shown');
  browser.bridge.cancel(browser.seen[0].id, 'declined');
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.message, /chose not to share/);
  const p = await browser.bridge.request('point', { target: 'Save' });
  assert.equal(p.found, false);
  assert.equal(p.error, 'no_app');
});

test('look_at_screen returns the text, and the picture only when asked for', async () => {
  (setFixedForTest({ screenAware: true }), saveSettings({ pointer: true }));
  const { bridge } = fakeApp(() => ({ text: 'Error: port 3000 in use', image: JPEG.toString('base64'), mime: 'image/jpeg', app: 'Terminal', window: 'zsh', redactions: 1 }));
  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, bridge);
  const t = tools(d);
  const textOnly = await t.look_at_screen.handler({}, {});
  assert.equal(textOnly.content.length, 1);
  assert.match(textOnly.content[0].text, /port 3000 in use/);
  assert.match(textOnly.content[0].text, /Frontmost app: Terminal/);
  assert.match(textOnly.content[0].text, /1 secret was blacked out/);
  const withImage = await t.look_at_screen.handler({ include_image: true }, {});
  assert.equal(withImage.content[1].type, 'image');
  assert.equal(withImage.content[1].mimeType, 'image/jpeg');
  assert.equal(withImage.content[1].data, JPEG.toString('base64'));

  setFixedForTest({ screenAware: false });
  const off = await t.look_at_screen.handler({}, {});
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /off in Settings/);
  assert.match(d.systemPrompt(), /screen awareness is off in Settings/);
  setFixedForTest({ screenAware: true });
  assert.match(d.systemPrompt(), /only when they ask about it/);
  assert.match(d.systemPrompt(), /never clicks/);
});

test('a permission problem is passed on as something to tell the user', async () => {
  const { bridge } = fakeApp(() => ({ ok: false, error: 'permission', message: 'Allow Echo under Screen Recording.' }));
  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, bridge);
  const out = await tools(d).look_at_screen.handler({}, {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Permission needed.*Screen Recording/);
});

test('point_at points (never clicks), says when it can’t find the label, and respects the setting', async () => {
  (setFixedForTest({ screenAware: true }), saveSettings({ pointer: true }));
  const debug = { method: 'accessibility', frame: { x: 40, y: 700, width: 60, height: 22 }, screen: { index: 0, x: 0, y: 0, width: 1512, height: 982, scale: 2 } };
  const { bridge, seen } = fakeApp((r) => (r.params.target === 'Save' ? { found: true, via: 'accessibility', label: 'Save', role: 'AXButton', app: 'TextEdit', debug } : { found: false, message: 'Nothing called that.' }));
  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, bridge);
  const t = tools(d);
  const hit = JSON.parse((await t.point_at.handler({ target: 'Save' }, {})).content[0].text);
  assert.equal(hit.pointed, true);
  assert.equal(hit.via, 'accessibility');
  assert.match(hit.note, /never click/);
  assert.deepEqual(hit.debug.frame, debug.frame, 'the result says where it pointed');
  assert.equal(hit.debug.screen.scale, 2);
  assert.equal(hit.debug.method, 'accessibility');
  assert.equal(seen[0].kind, 'point');
  assert.equal(seen[0].params.useScreen, true, 'may fall back to reading the screen');
  const miss = JSON.parse((await t.point_at.handler({ target: 'Frobnicate' }, {})).content[0].text);
  assert.equal(miss.pointed, false);
  saveSettings({ pointer: false });
  const off = await t.point_at.handler({ target: 'Save' }, {});
  assert.equal(off.isError, true);
  assert.equal(seen.length, 2, 'no request goes out when the pointer is off');
  saveSettings({ pointer: true });
});

test('a "found" with no real position on screen is not a point (never the middle of the screen)', async () => {
  const screen = { index: 0, x: 0, y: 0, width: 1512, height: 982, scale: 2 };
  const found = { found: true, via: 'accessibility', label: 'Wi‑Fi', role: 'AXStaticText', app: 'System Settings' };
  assert.equal(cleanPoint({ ...found }).found, false, 'no debug frame at all');
  assert.equal(cleanPoint({ ...found }).reason, 'no_frame');
  for (const frame of [{ x: 0, y: 0, width: 0, height: 0 }, { x: NaN, y: 10, width: 20, height: 20 }, { x: 10, y: 10, width: Infinity, height: 20 }, { x: '10', y: 10, width: 20, height: 20 }, null]) {
    const p = cleanPoint({ ...found, debug: { method: 'accessibility', frame, screen } });
    assert.equal(p.found, false, JSON.stringify(frame));
    assert.equal(p.reason, 'no_frame');
  }
  const off = cleanPoint({ ...found, debug: { frame: { x: 4000, y: 10, width: 50, height: 20 }, screen } });
  assert.equal(off.found, false);
  assert.equal(off.reason, 'off_screen');
  const ok = cleanPoint({ ...found, debug: { method: 'accessibility', frame: { x: 773, y: 700, width: 59, height: 24 }, screen } });
  assert.equal(ok.found, true);
  // Negative coordinates are fine on a display left of or below the primary one.
  assert.equal(cleanPoint({ ...found, debug: { frame: { x: -1200, y: -300, width: 40, height: 20 }, screen: { x: -1920, y: -400, width: 1920, height: 1080 } } }).found, true);

  // Through the tool: a scrolled-away row says which way to scroll; a frameless "found" says pointed: false.
  (setFixedForTest({ screenAware: true }), saveSettings({ pointer: true }));
  const answers = {
    'Wi-Fi': { found: false, reason: 'scrolled_out_of_view', label: 'Wi‑Fi', message: '"Wi‑Fi" is in the sidebar but scrolled out of view: scroll up in the sidebar to see it.', debug: { method: 'accessibility', visible: false, frame: { x: 773, y: 880, width: 59, height: 24 } } },
    Bluetooth: { ...found, label: 'Bluetooth' },
  };
  const { bridge } = fakeApp((r) => answers[r.params.target]);
  const t = tools(new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, bridge));
  const wifi = JSON.parse((await t.point_at.handler({ target: 'Wi-Fi', app: 'System Settings' }, {})).content[0].text);
  assert.equal(wifi.pointed, false);
  assert.equal(wifi.reason, 'scrolled_out_of_view');
  assert.match(wifi.note, /scroll up/);
  assert.equal(wifi.debug.visible, false);
  const bt = JSON.parse((await t.point_at.handler({ target: 'Bluetooth' }, {})).content[0].text);
  assert.equal(bt.pointed, false, 'no frame, no point');
  assert.equal(bt.reason, 'no_frame');
  assert.match(fs.readFileSync(logFile(), 'utf8'), /"reason":"no_frame"/);
});

test('"fix the error on my screen": the worker gets a temporary redacted screenshot, deleted when the task ends', async () => {
  const { bridge } = fakeApp(() => ({ text: 'SyntaxError: Unexpected token } in main.js:12', image: JPEG.toString('base64'), mime: 'image/jpeg', app: 'Chrome' }));
  const tm = new TaskManager({ queryFn: fakeQuery(() => []).queryFn });
  tm.on('finished', (t) => bridge.releaseTask(t.id));
  tm.on('stopped', (t) => bridge.releaseTask(t.id));
  const d = new Dispatcher(tm, null, undefined, bridge);
  const t = tools(d);

  const early = await t.start_task.handler({ project: 'Website', instruction: 'Fix it', attach_screen: true }, {});
  assert.equal(early.isError, true, 'needs a look first');
  assert.match(early.content[0].text, /look_at_screen first/);

  await t.look_at_screen.handler({}, {});
  const out = JSON.parse((await t.start_task.handler({ project: 'Website', instruction: 'Fix the syntax error the user sees.', attach_screen: true }, {})).content[0].text);
  assert.equal(out.screenAttached, true);
  const task = tm.get(out.taskId);
  const file = task.instruction.match(/(\/\S+screen-[\w-]+\.jpg)/)?.[1];
  assert.ok(file, 'the instructions name the file');
  assert.ok(file.startsWith(screenTmpDir()));
  assert.match(task.instruction, /Unexpected token/);
  assert.match(task.instruction, /deleted when this task ends/);
  assert.ok(fs.readFileSync(file).equals(JPEG));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only you can read it');
  assert.ok(isScreenShot(file), 'workers may read it');
  assert.ok(!isScreenShot(path.join(screenTmpDir(), '..', 'other.jpg')));
  assert.ok(!isScreenShot('/etc/passwd'));

  await tm.stop(task.id).catch(() => {});
  assert.ok(!fs.existsSync(file), 'gone once the task ends');
});

test('leftover screenshots are swept', () => {
  fs.mkdirSync(screenTmpDir(), { recursive: true });
  const old = path.join(screenTmpDir(), 'screen-1-deadbeef.jpg');
  fs.writeFileSync(old, JPEG);
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  const fresh = path.join(screenTmpDir(), 'screen-2-cafebabe.jpg');
  fs.writeFileSync(fresh, JPEG);
  assert.equal(sweepScreenShots(), 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  sweepScreenShots(0);
  assert.ok(!fs.existsSync(fresh));
});

test('lookContent explains a browser share has no text reading', () => {
  const look = cleanLook({ source: 'browser', image: JPEG.toString('base64') });
  const c = lookContent(look, { includeImage: true });
  assert.match(c.content[0].text, /no text reading in the browser/);
  assert.equal(c.content[1].type, 'image');
});

test('settings: screen awareness and the pointer default on, push-to-talk defaults to Control + Option', () => {
  fs.rmSync(path.join(dirs.data, 'settings.json'), { force: true });
  const s = getSettings();
  assert.equal(s.screenAware, true);
  assert.equal(s.pointer, true);
  assert.equal(s.pttHotkey, 'ctrl-opt');
  assert.equal(PTT_HOTKEYS['ctrl-opt'], 'Control + Option');
  assert.equal(saveSettings({ pttHotkey: 'fn' }).pttHotkey, 'fn');
  assert.equal(saveSettings({ pttHotkey: 'cmd-q' }).pttHotkey, 'ctrl-opt', 'unknown chords fall back');
  assert.equal(saveSettings({ screenAware: false }).screenAware, true, 'not a setting any more: the Screen Recording permission is the switch');
});

test('the mistaken "Hey Claude" → "Hey Clicky" correction is dropped once on start-up', () => {
  const file = path.join(dirs.data, 'vocabulary.json');
  fs.writeFileSync(file, JSON.stringify({ words: ['Echo', 'Hey Clicky', 'Clicky'], corrections: { 'hey claude': 'Hey Clicky', 'hoe broken': 'Hoboken' } }));
  assert.deepEqual(dropRetiredCorrections(), ['hey-claude-clicky']);
  const v = loadVocab();
  assert.deepEqual(v.corrections, { 'hoe broken': 'Hoboken' });
  assert.deepEqual(v.words, ['Echo', 'Clicky'], 'the word it added goes too');
  // Taught again on purpose, it stays.
  learnCorrection('hey claude', 'Hey Clicky');
  assert.deepEqual(dropRetiredCorrections(), []);
  assert.equal(loadVocab().corrections['hey claude'], 'Hey Clicky');
  // A fresh install (no vocabulary file) has nothing to drop.
  fs.rmSync(file);
  assert.deepEqual(dropRetiredCorrections(), []);
});

test('the companion orb: medium, Auto and following macOS for motion; its looks match across settings, page and app', async () => {
  const file = path.join(dirs.data, 'settings.json');
  fs.rmSync(file, { force: true });
  const s = getSettings();
  assert.equal(s.orbSize, 'medium', "the mockup's 28 pt");
  assert.equal(s.companionLook, 'auto');
  assert.equal(s.reduceMotion, 'system');
  // Size and reduced motion are no longer settings: a saved value is ignored.
  assert.deepEqual([saveSettings({ orbSize: 'large', reduceMotion: 'on' }).orbSize, getSettings().reduceMotion], ['medium', 'system']);
  assert.equal(saveSettings({ companionLook: 'moon' }).companionLook, 'moon');
  assert.equal(saveSettings({ companionLook: 'glass' }).companionLook, 'glass');
  assert.equal(saveSettings({ companionLook: 'aurora' }).companionLook, 'auto', 'a look that is gone is Auto');
  // A file from before there were two bodies reads as Auto, without being rewritten.
  fs.writeFileSync(file, JSON.stringify({ companionLook: 'sunset' }));
  assert.equal(getSettings().companionLook, 'auto');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).companionLook, 'sunset', 'reading never rewrites the file');
  assert.equal(saveSettings({}).companionLook, 'auto');
  fs.rmSync(file, { force: true });
  // A size saved by an older version is ignored, and gone once settings are saved again.
  fs.writeFileSync(file, JSON.stringify({ companionSize: 'medium', orbSize: 'large' }));
  assert.equal(getSettings().orbSize, 'medium');
  assert.equal(Object.hasOwn(getSettings(), 'companionSize'), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).companionSize, 'medium', 'reading never rewrites the file');
  saveSettings({});
  assert.deepEqual([JSON.parse(fs.readFileSync(file, 'utf8')).companionSize, JSON.parse(fs.readFileSync(file, 'utf8')).orbSize], [undefined, undefined]);
  fs.rmSync(file, { force: true });
  // The page's Look picker offers exactly the looks.
  const page = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.deepEqual([...page.matchAll(/name="companionLook" value="(\w+)"/g)].map((m) => m[1]), Object.keys(COMPANION_LOOKS));
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'macos', 'Sources', f), 'utf8');
  const math = src('PointMath.swift');
  // The app's pearl has two looks; Settings offers them and Auto, and the app takes all three
  // (on Auto it picks for its own island: CompanionMath.wear).
  assert.deepEqual(JSON.parse(math.match(/static let looks = (\[[^\]]*\])/)[1]), Object.keys(COMPANION_LOOKS));
  assert.deepEqual(Object.keys(COMPANION_LOOKS), ['auto', 'glass', 'moon'], 'two bodies and Auto (the Mac app is told the setting and picks for its own island)');
  assert.ok(JSON.parse(math.match(/static let sizes = (\[[^\]]*\])/)[1]).includes(getSettings().orbSize), 'the app knows the one size');
  // The orb draws over full-screen apps, never takes focus, and respects reduced motion.
  const orb = src('Pointer.swift');
  assert.match(orb, /\.nonactivatingPanel/);
  assert.match(orb, /\.fullScreenAuxiliary/);
  assert.match(orb, /Motion\.reduced/);
  assert.match(src('Config.swift'), /accessibilityDisplayShouldReduceMotion/, 'reduced motion follows macOS unless set');
  assert.match(src('ScreenBridge.swift'), /body\["reduceMotion"\]/);
  assert.doesNotMatch(orb, /makeKey|NSApp\.activate/, 'never steals focus');
  assert.doesNotMatch(src('Caption.swift'), /makeKey|NSApp\.activate/, 'the pill never steals focus either');
  // It docks in the caption pill while the pill is up, and moves on the display's clock.
  assert.match(src('Driver.swift'), /onShowChange = .*\n.*pointer\.dock\(\).*pointer\.undock\(\)/);
  assert.match(orb, /FrameClock\.shared\.add/);
  assert.match(src('Caption.swift'), /FrameClock\.shared\.add/);
});

test('the Mac app only points: click-through overlay, listen-only hotkey, no synthetic clicks or keys', () => {
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'macos', 'Sources', f), 'utf8');
  // Computer use (opt-in) lives in Driver.swift alone; test/computer.test.js checks that file.
  const all = fs.readdirSync(path.join(import.meta.dirname, '..', 'macos', 'Sources')).filter((f) => f.endsWith('.swift') && f !== 'Driver.swift').map(src).join('\n');
  assert.match(src('Pointer.swift'), /ignoresMouseEvents = true/);
  assert.match(src('PushToTalk.swift'), /options: \.listenOnly/);
  // Nothing that could click, type or press for the user.
  assert.doesNotMatch(all, /CGEvent\(mouseEventSource|CGEvent\(keyboardEventSource|\.post\(tap:|CGEventPost|kAXPressAction|AXUIElementPerformAction/);
  // Screenshots are never written to disk by the app.
  assert.doesNotMatch(src('Screen.swift'), /\.write\(to:|writeToFile|FileManager\.default\.createFile/);
});

test('push-to-talk chords match across the settings and the Mac app', async () => {
  const swift = fs.readFileSync(path.join(import.meta.dirname, '..', 'macos', 'Sources', 'PushToTalk.swift'), 'utf8');
  const swiftChords = JSON.parse(swift.match(/static let chords = (\[[^\]]*\])/)[1]);
  assert.deepEqual(swiftChords, Object.keys(PTT_HOTKEYS));
});

test('a look is of the window the user is in, unless the whole screen is asked for (or the switch is off)', async () => {
  setFixedForTest({ screenAware: true });
  const { bridge, seen } = fakeApp((r) => (r.kind === 'look' ? { ok: true, source: 'native', text: 'Inbox', image: JPEG.toString('base64'), mime: 'image/jpeg', width: 800, height: 600, app: 'Mail', window: 'Inbox' } : null));
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, undefined, bridge);
  const t = tools(d);
  await t.look_at_screen.handler({}, {});
  assert.equal(seen.at(-1).params.window, true, 'on by default');
  process.env.ECHO_FLAG_WINDOWCROP = '0';
  await t.look_at_screen.handler({}, {});
  assert.equal(seen.at(-1).params.window, undefined, 'switched off in Labs: the whole screen, as before');
  process.env.ECHO_FLAG_WINDOWCROP = '1';
  try {
    await t.look_at_screen.handler({}, {});
    assert.equal(seen.at(-1).params.window, true);
    await t.look_at_screen.handler({ whole_screen: true }, {});
    assert.equal(seen.at(-1).params.window, undefined, 'the menu bar, the Dock, another window');
  } finally {
    delete process.env.ECHO_FLAG_WINDOWCROP;
  }
  const swift = fs.readFileSync(path.join(import.meta.dirname, '..', 'macos/Sources/ScreenBridge.swift'), 'utf8');
  assert.match(swift, /if params\["window"\] as\? Bool \?\? false, let app = FrontApp\.current\(\)\.app, let w = AXFinder\.focusedWindowFrame\(of: app\) \{\n\s+crop = PointMath\.windowArea\(w, display: screen\.frame\)/);
});

test('point, state and wait requests have their own short limits, each logged when it runs out', async (t) => {
  const { appTimeoutMs, POINT_TIMEOUT_MS, STATE_TIMEOUT_MS } = await import('../lib/screen.js');
  assert.deepEqual([POINT_TIMEOUT_MS, STATE_TIMEOUT_MS], [6000, 4000]);
  assert.equal(appTimeoutMs('point', {}), 6000);
  assert.equal(appTimeoutMs('state', {}), 4000);
  assert.equal(appTimeoutMs('wait', { timeoutMs: 300 }), 2300, 'a wait: its own time-out plus 2 s');
  assert.equal(appTimeoutMs('wait', { timeoutMs: 8000 }), 10000);
  assert.equal(appTimeoutMs('wait', {}), 12000, 'the app waits 10 s when none is named');
  assert.equal(appTimeoutMs('wait', { timeoutMs: 60000 }), 17000, 'and never more than 15 s');
  assert.equal(appTimeoutMs('act', {}), 20000, 'a click keeps the long limit');
  assert.equal(appTimeoutMs('point', {}, 500), 500, 'never more than the limit for any request');

  fs.rmSync(logFile(), { force: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = new ScreenBridge({ logFile: logFile() });
  bridge.nativeClients = () => 1;
  /** Does this request give up exactly when `ms` have gone by (and not before)? */
  const givesUpAt = async (kind, params, ms) => {
    let gone = false;
    const p = bridge.request(kind, params).then(() => {}, () => { gone = true; });
    t.mock.timers.tick(ms - 1);
    await Promise.resolve();
    assert.equal(gone, false, `${kind}: still waiting just before ${ms} ms`);
    t.mock.timers.tick(1);
    await p;
    assert.equal(gone, true, `${kind}: gave up at ${ms} ms`);
  };
  await givesUpAt('point', { target: 'Save' }, 6000);
  await givesUpAt('state', { labels: [] }, 4000);
  await givesUpAt('wait', { target: 'Save', timeoutMs: 300 }, 2300);
  await givesUpAt('act', { action: 'click' }, 20000);
  const log = fs.readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'screen_timeout');
  assert.deepEqual(log.map((e) => e.kind), ['point', 'state', 'wait', 'act']);
  assert.doesNotMatch(JSON.stringify(log), /Save/, 'never what was asked for');
});
