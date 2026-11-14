// Phase 2 of the computer-use plan: "show me how" mode, undo chips, the local UI grounder, the
// orb's finishing touches in the Mac app (idle rest, key caps, shape-true rings, a haptic, the
// background cursor), the onboarding's magic-words step, the settings, and the eval's Phase 2 bar.
// Fake apps answer; nothing real is clicked, sent or undone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('phase2');
const { ComputerUse, UNDO_MS } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, getSettings, setFixedForTest } = await import('../lib/settings.js');
const { localIntent, runLocalIntent } = await import('../lib/intent.js');
const { parsePoint, toImagePixels, localEndpoint, ground } = await import('../lib/grounder.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const on = (extra = {}) => (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do', ...extra }));
const src = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');

/** @param {{ did?: (p: any) => object, resolved?: (p: any) => object, look?: () => object }} [o] */
function fakeApp({ did = () => ({ verified: true, changes: ['content'] }), resolved = () => ({}), look } = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, label: p.target || '', role: 'AXButton', app: 'Google Chrome', window: 'Inbox - Gmail', ...resolved(p) };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: 'Google Chrome', window: 'Inbox - Gmail', ...did(p) };
    else if (r.kind === 'look') out = look?.() || { ok: true, source: 'native', text: 'x', image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64'), mime: 'image/jpeg', width: 1000, height: 800, app: 'Sketchpad' };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  return { bridge, seen, does: () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do') };
}

test('"show me how": the orb points and Echo says what to do, but nothing is clicked or typed', async () => {
  on({ driveMode: 'show' });
  const { bridge, does, seen } = fakeApp();
  const c = new ComputerUse({ bridge, logFile });
  const r = await c.act('click', { target: 'Compose' });
  assert.equal(r.shown, true);
  assert.equal(r.done, false);
  assert.match(r.note, /did NOT click/);
  assert.equal(does().length, 0, 'never acts');
  assert.ok(seen.some((x) => x.params.step === 'resolve'), 'but the orb flew there');
  const t = await c.act('type_text', { text: 'hello', into: 'Subject' });
  assert.equal(t.shown, true);
  assert.equal(does().length, 0);
  // Secrets are still refused outright, even just pointing.
  assert.equal((await c.act('type_text', { text: `${['sk-', 'ant-', 'api03-'].join('')}${'D'.repeat(40)}`, into: 'Notes' })).refused, true);
  on({ driveMode: 'do' });
  assert.equal((await c.act('click', { target: 'Compose' })).done, true, 'just do it: acts again');
  c.end('done');
});

test('switching by voice: "show me how" and "just do it" are instant local commands', async () => {
  assert.deepEqual(localIntent('Show me how'), { kind: 'mode', mode: 'show' });
  assert.deepEqual(localIntent('just do it'), { kind: 'mode', mode: 'do' });
  assert.equal(localIntent('show me how to rename a file'), null, 'a real question goes to the assistant');
  const r = await runLocalIntent({ kind: 'mode', mode: 'show' }, { quick: {}, computer: /** @type {any} */ ({}) });
  assert.match(r.say, /show you/);
  assert.equal(getSettings().driveMode, 'show');
  await runLocalIntent({ kind: 'mode', mode: 'do' }, { quick: {}, computer: /** @type {any} */ ({}) });
  assert.equal(getSettings().driveMode, 'do');
});

test('undo chips: after an allowed send in Gmail, Undo clicks Gmail\'s own Undo; elsewhere ⌘Z; then it expires', async () => {
  on();
  let now = 1_000_000;
  const { bridge, does } = fakeApp({ resolved: (p) => (p.target === 'Send' ? { label: 'Send' } : {}) });
  const c = new ComputerUse({ bridge, logFile, now: () => now, confirmSettleMs: 0 });
  const offers = [];
  c.on('undo_offer', (o) => offers.push(o));
  const ask = await c.act('click', { target: 'Send' });
  assert.equal(ask.waitingForConfirmation, true);
  const sent = await c.confirm(ask.confirmId, true, 'window');
  assert.equal(sent.done, true);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].label, 'Sent');
  assert.equal(sent.undo.seconds, UNDO_MS / 1000);
  const undone = await c.undo(offers[0].id);
  assert.equal(undone.done, true);
  assert.equal(does().at(-1).params.target, 'Undo', "Gmail's own Undo");
  assert.equal(does().at(-1).params.scope, 'page');
  assert.equal((await c.undo(offers[0].id)).error, 'expired', 'once only');
  // A delete in Finder: ⌘Z (the Trash puts it back).
  const { bridge: b2, does: d2 } = fakeApp({ resolved: () => ({ label: 'Move to Trash', app: 'Finder', window: 'Desktop' }), did: () => ({ verified: true, changes: ['content'], app: 'Finder', window: 'Desktop' }) });
  const f = new ComputerUse({ bridge: b2, logFile, now: () => now, confirmSettleMs: 0 });
  const fo = [];
  f.on('undo_offer', (o) => fo.push(o));
  const del = await f.act('click', { target: 'Move to Trash', app: 'Finder' });
  await f.confirm(del.confirmId, true, 'window');
  await f.undo(fo[0].id);
  assert.equal(d2().at(-1).params.keys, 'cmd+z');
  // Too late.
  const again = await f.act('click', { target: 'Move to Trash', app: 'Finder' });
  await f.confirm(again.confirmId, true, 'window');
  now += UNDO_MS + 1;
  assert.equal((await f.undo(fo[1].id)).error, 'expired');
  c.end('done');
  f.end('done');
});

test('the local UI grounder: points parsed and mapped, only on this Mac, and a click that is checked', async () => {
  assert.deepEqual(parsePoint('(512, 300)'), { x: 512, y: 300 });
  assert.deepEqual(parsePoint('[100, 200, 300, 400]'), { x: 200, y: 300 }, 'a box: its centre');
  assert.equal(parsePoint('no idea'), null);
  assert.deepEqual(toImagePixels({ x: 500, y: 250 }, { width: 1600, height: 1000 }, 'norm1000'), { x: 800, y: 250 });
  assert.deepEqual(toImagePixels({ x: 0.5, y: 0.5 }, { width: 1600, height: 1000 }, 'norm1000'), { x: 800, y: 500 }, 'fractions are fractions');
  assert.deepEqual(toImagePixels({ x: 30, y: 40 }, { width: 1600, height: 1000 }, 'pixels'), { x: 30, y: 40 });
  assert.equal(toImagePixels({ x: 5000, y: 40 }, { width: 1600, height: 1000 }, 'pixels'), null, 'off the picture');
  assert.equal(localEndpoint('http://127.0.0.1:8765'), true);
  assert.equal(localEndpoint('https://api.example.com'), false, 'the screenshot never leaves the Mac');
  const shot = { image: 'AAAA', width: 1000, height: 800 };
  assert.equal(/** @type {any} */ (await ground('x', shot, { url: '' })).error, 'not_set_up');
  assert.equal(/** @type {any} */ (await ground('x', shot, { url: 'https://grounder.example.com' })).error, 'not_local');
  let body;
  const fetchImpl = /** @type {any} */ (async (_u, init) => { body = JSON.parse(init.body); return { json: async () => ({ choices: [{ message: { content: '(40, 275)' } }] }) }; });
  const at = /** @type {any} */ (await ground('the rectangle tool', shot, { url: 'http://127.0.0.1:8765', fetchImpl }));
  assert.deepEqual({ x: at.x, y: at.y }, { x: 40, y: 220 });
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,AAAA/);
  on();
  const { bridge, does } = fakeApp({ resolved: (p) => (p.x !== undefined ? { label: 'Rectangle', role: 'AXImage', app: 'Sketchpad' } : {}) });
  const c = new ComputerUse({ bridge, logFile });
  const r = await c.clickVisual({ description: 'the rectangle tool' }, { groundImpl: async () => ({ x: 40, y: 220, raw: '' }) });
  assert.equal(r.done, true);
  assert.deepEqual([does()[0].params.x, does()[0].params.y], [40, 220]);
  const miss = await c.clickVisual({ description: 'a unicorn' }, { groundImpl: async () => ({ error: 'not_found', message: 'nope' }) });
  assert.equal(miss.error, 'not_found');
  c.end('done');
});

test('the Mac app: a pearl that costs little at rest, key caps, shape-true rings, a haptic, the background cursor', () => {
  const pointer = src('macos/Sources/Pointer.swift');
  const mark = src('macos/Sources/Companion.swift');
  // The pearl breathes and blinks, in its own small view: the island under it is redrawn only
  // when something in it moves, and with reduced motion a pearl at rest asks for no frames.
  assert.doesNotMatch(pointer, /RestMath|EyeMath|rest\.breath|addRestEyes/, 'no Core Animation rest loop');
  assert.doesNotMatch(src('macos/Sources/PointMath.swift'), /enum RestMath|enum EyeMath/);
  assert.match(mark, /moving = !reduced \|\| !settled \|\| blink > 0 \|\| moment != nil/, 'reduced motion: a settled pearl asks for no more frames');
  const island = src('macos/Sources/Caption.swift');
  assert.match(island, /let alive = moving \|\| mixing \|\| wordIn \|\| lighting\n/, 'the island redraws only while something in it moves');
  assert.match(island, /pearl: nil,/, 'the pearl is not part of that drawing');
  assert.match(island, /now - pearlDrawnAt >= \(calm \? 1\.0 \/ 31 : 1\.0 \/ 61\)/, 'its own view: 30 frames a second while it only breathes, 60 when it is doing something');
  assert.match(island, /if showing && !alive && !pearl\.moving && peek < 0\.01/, 'the clock rests when nothing moves at all');
  assert.match(pointer, /guard redraw \|\| art\.moving \|\| shown != drawn else \{ return \}/, 'and so does the mark out pointing');
  assert.match(pointer, /func showKeys\(_ combo: String\)/);
  assert.match(pointer, /TouchMath\.corner\(role: role/);
  assert.match(pointer, /NSHapticFeedbackManager\.defaultPerformer\.perform/);
  const driver = src('macos/Sources/Driver.swift');
  assert.match(driver, /pointer\?\.showKeys\(p\["keys"\]/, 'key caps for every shortcut');
  assert.match(driver, /let back = ComputerPrefs\.background \? Self\.toGlobal\(NSEvent\.mouseLocation\) : nil/, 'the pointer goes back');
  assert.match(driver, /CaptionBar\.shared\.onChange = \{ \[weak self\] in self\?\.pointer\.wake\(\) \}/, 'the light flying home follows the island');
  assert.match(src('macos/Sources/Caption.swift'), /onChange\?\(\)/);
});

test('onboarding: the three magic words and Echo for Chrome; show-me is said by voice, the background cursor is a setting', async () => {
  const { STEPS, MAGIC_WORDS } = await import('../public/onboarding.js');
  assert.ok(STEPS.indexOf('magic') === STEPS.indexOf('tour') - 1);
  assert.deepEqual(MAGIC_WORDS.map(([w]) => w), ['“Echo…”', '“Stop”', '“Show me how”']);
  const html = src('public/index.html');
  assert.doesNotMatch(html, /id="setShowMe"/, '"show me how" and "just do it" are said, not switched');
  assert.match(html, /id="setBackground"/);
  assert.match(html, /id="chromeCode"/);
  assert.equal(saveSettings({ backgroundCursor: 1 }).backgroundCursor, true);
  assert.equal(saveSettings({ driveMode: 'show' }).driveMode, 'show');
  saveSettings({ driveMode: 'do', backgroundCursor: false });
  const app = pageSource();
  assert.match(app, /background: setBackground\.checked/, 'the Mac app hears about the background cursor');
});

test('first visible feedback comes before any correction or model: the heard cue, then the rest', () => {
  const server = serverSource();
  const body = server.slice(server.indexOf('async function handleUtterance'), server.indexOf('/* ---------- transcribe while talking'));
  const heardAsSaid = body.indexOf('hearAsSaid(raw');
  assert.ok(heardAsSaid > 0);
  assert.ok(body.indexOf("if (route === 'turn') dispatcher.heard();") < heardAsSaid, 'the heard cue goes out first');
  assert.ok(body.indexOf('dispatcher.localIntentFor(raw)') < heardAsSaid, 'instant commands go before anything else');
  assert.doesNotMatch(body, /await corrector|await early/, 'and no model is waited on before the assistant');
});

test('eval harness: Phase 2 targets (60 tasks), and the grounder solves the canvas without false success', async () => {
  on({ driveMode: 'do' });
  const { runSuite, ALL_TASKS, STRESS_TASKS } = await import('../lib/evalsuite.js');
  const v2 = await runSuite('v2', { logFile, tasks: ALL_TASKS });
  assert.ok(v2.metrics.successRate >= 0.9, `success ${v2.metrics.successRate}`);
  assert.ok(v2.metrics.medianSeconds <= 15);
  const stress = await runSuite('v2', { logFile, tasks: STRESS_TASKS });
  assert.equal(stress.results.find((r) => r.id === 'canvas-no-labels')?.success, true);
  assert.equal(stress.metrics.falseSuccess, 0);
});
