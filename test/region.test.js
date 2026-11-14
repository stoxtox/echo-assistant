// Hints that say where: the Mac app reports where a found thing is in fixed words (place,
// container, kind), the server keeps only those words, a lesson's hint in words is built from
// them ("It's in the toolbar at the top left: the Rectangle button."), and the lesson asks with
// `locate`, which never moves the light. A fake "Mac app" answers; nothing touches a real screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, wait } from './helpers.js';

const dirs = sandbox('region');
const { ScreenBridge, cleanPlace, cleanPoint, whereWords, appTimeoutMs, PLACES, CONTAINERS, TARGET_KINDS, APP_KINDS, LOCATE_TIMEOUT_MS } = await import('../lib/screen.js');
const T = await import('../lib/teach.js');
const { TeachSession, hintInWords, hintTarget } = T;
const { ComputerUse, cleanAnswer, computerPrompt } = await import('../lib/computer.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, getSettings, setFixedForTest } = await import('../lib/settings.js');
const { fakeQuery } = await import('./helpers.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const frame = { frame: { x: 100, y: 100, width: 40, height: 20 }, screen: { x: 0, y: 0, width: 1440, height: 900 } };

/**
 * A bridge whose "Mac app" knows where a few things are. `where[label]` is what it says of that
 * label (place, container, kind); a label it doesn't know is not found. `locate: false` is an
 * older app that never answers a `locate`.
 */
function fakeApp(where, { locate = true } = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 300, browserTimeoutMs: 300 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    const at = where[p.target];
    let out;
    if (r.kind === 'locate') out = !locate ? null : at ? { ok: true, found: true, label: p.target, role: 'AXButton', app: 'Shapes', ...at } : { ok: true, found: false };
    else if (r.kind === 'point') out = at ? { found: true, via: 'accessibility', label: p.target, app: 'Shapes', debug: frame, ...at } : { found: false };
    else if (r.kind === 'wait') out = { ok: true, found: Boolean(at), via: 'accessibility', label: p.target, app: 'Shapes', ...at };
    else if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, label: p.target, role: 'AXButton', app: 'Shapes', window: 'Untitled', ...at };
    else if (r.kind === 'act') out = { ok: true, via: 'accessibility', app: 'Shapes', window: 'Untitled' };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  return { bridge, seen, kinds: () => seen.map((r) => r.kind) };
}

test('only the fixed words are kept from what the app says of a place', () => {
  assert.deepEqual(cleanPlace({ place: 'top left', container: 'toolbar', kind: 'button' }), { place: 'top left', container: 'toolbar', kind: 'button' });
  assert.deepEqual(cleanPlace({ place: 'bottom right' }), { place: 'bottom right' });
  // Anything else in their place is dropped: these fields never carry text off the screen.
  assert.deepEqual(cleanPlace({ place: 'next to the note that says otters', container: 'Inbox (3)', kind: 'AXButton' }), {});
  assert.deepEqual(cleanPlace({ place: ['top'], container: 7, kind: null }), {});
  assert.deepEqual(cleanPlace(null), {});
  assert.deepEqual(cleanPlace('top left'), {});
  assert.equal(PLACES.length, 9);
  assert.deepEqual(CONTAINERS, ['toolbar', 'sidebar', 'menu bar', 'tab bar', 'dialog']);
  assert.deepEqual(TARGET_KINDS, ['button', 'menu', 'field', 'tab', 'checkbox', 'icon']);
  for (const place of PLACES) assert.deepEqual(cleanPlace({ place }), { place });
});

test('where it is, as people say it', () => {
  assert.equal(whereWords({ place: 'top left', container: 'toolbar' }), 'in the toolbar at the top left');
  assert.equal(whereWords({ place: 'top' }), 'at the top');
  assert.equal(whereWords({ place: 'bottom right' }), 'at the bottom right');
  assert.equal(whereWords({ place: 'left', container: 'sidebar' }), 'in the sidebar on the left');
  assert.equal(whereWords({ place: 'right' }), 'on the right');
  assert.equal(whereWords({ place: 'middle' }), 'in the middle');
  assert.equal(whereWords({ container: 'dialog' }), 'in the dialog');
  assert.equal(whereWords({ kind: 'button' }), '', 'a kind alone says nothing of where');
  assert.equal(whereWords({ place: 'over there' }), '');
  assert.equal(whereWords(null), '');
  assert.equal(whereWords(undefined), '');
});

test('the hint in words says where first, then the thing; without a place it is as before', () => {
  const step = { say: 'Click the Rectangle tool.', target: 'Rectangle' };
  assert.equal(hintInWords(step, { place: 'top left', container: 'toolbar', kind: 'button' }), "It's in the toolbar at the top left: the Rectangle button.");
  assert.equal(hintInWords(step, { place: 'left', kind: 'icon' }), "It's on the left: the Rectangle icon.");
  assert.equal(hintInWords(step, { place: 'bottom' }), "It's at the bottom: Rectangle.");
  assert.equal(hintInWords(step, { container: 'sidebar' }), "It's in the sidebar: Rectangle.");
  // Nothing from the app, or nothing it may say: only the label, as it was.
  assert.equal(hintInWords(step), 'Look for Rectangle.');
  assert.equal(hintInWords(step, null), 'Look for Rectangle.');
  assert.equal(hintInWords(step, {}), 'Look for Rectangle.');
  assert.equal(hintInWords(step, { kind: 'button' }), 'Look for Rectangle.');
  assert.equal(hintInWords(step, { place: 'somewhere', container: 'Layers' }), 'Look for Rectangle.');
  // The kind is said once, and a label's own full stop isn't doubled.
  assert.equal(hintInWords({ say: 'Open it.', target: 'File menu' }, { place: 'top left', container: 'menu bar', kind: 'menu' }), "It's in the menu bar at the top left: the File menu.");
  assert.equal(hintInWords({ say: 'Click it.', target: 'Export…' }, { place: 'right' }), "It's on the right: Export…");
  // A route: where its first label is, then the whole way; the kind (of the first label only) is left out.
  const routed = { say: 'Export it.', target: 'PDF', route: ['File', 'Export', 'PDF'] };
  assert.equal(hintInWords(routed, { place: 'top left', container: 'menu bar', kind: 'menu' }), "It's in the menu bar at the top left: File, then Export, then PDF.");
  assert.equal(hintInWords(routed), 'Look for File, then Export, then PDF.');
  // A hint the lesson wrote always wins; a cell is still named by its address.
  assert.equal(hintInWords({ ...step, hint: 'It looks like a small square.' }, { place: 'top left' }), 'It looks like a small square.');
  assert.equal(hintInWords({ say: 'Click B2.', target: { cell: 'b2' } }, { place: 'top left' }), "It's at the top left: cell B2.");
  assert.equal(hintInWords({ say: 'Say when.' }, { place: 'top left' }), '');
});

test('what a lesson asks the app to find for a hint', () => {
  assert.equal(hintTarget({ say: 'Click it.', target: 'Rectangle' }), 'Rectangle');
  assert.equal(hintTarget({ say: 'Export it.', target: 'PDF', route: ['File', 'Export', 'PDF'] }), 'File', 'a route: where it starts');
  assert.equal(hintTarget({ say: 'Click it.', target: 'Rectangle', hint: 'A small square.' }), '', 'a hint the lesson wrote needs no finding');
  assert.equal(hintTarget({ say: 'Click it.', target: 'Rectangle', hint: 'Click it.' }), 'Rectangle', 'a hint that only repeats the step is no hint');
  assert.equal(hintTarget({ say: 'Click B2.', target: { cell: 'B2' } }), '', 'a cell is found by its address');
  assert.equal(hintTarget({ say: 'Say when.' }), '');
});

test('a point answer and an act answer keep the place; `locate` is a quick, app-only request', async () => {
  const p = cleanPoint({ found: true, via: 'accessibility', label: 'Rectangle', debug: frame, place: 'top left', container: 'toolbar', kind: 'icon' });
  assert.deepEqual([p.found, p.place, p.container, p.kind], [true, 'top left', 'toolbar', 'icon']);
  const plain = cleanPoint({ found: true, via: 'accessibility', label: 'Rectangle', debug: frame, place: 'under the text "otters"' });
  assert.equal('place' in plain, false, 'words the app may not say are dropped');
  const a = cleanAnswer({ ok: true, found: true, label: 'Rectangle', place: 'right', container: 'Layers panel', kind: 'button' });
  assert.deepEqual([a.place, a.container, a.kind], ['right', undefined, 'button']);
  assert.equal('place' in cleanAnswer({ ok: true, found: true }), false);

  assert.ok(APP_KINDS.includes('locate'));
  assert.equal(appTimeoutMs('locate', {}), LOCATE_TIMEOUT_MS);
  assert.ok(LOCATE_TIMEOUT_MS <= 3000, 'a hint never waits long for it');
  const noApp = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl') });
  assert.equal((await noApp.request('locate', { target: 'Rectangle' })).error, 'no_app');
  // Unlike point and act, it carries nothing for the light: no colour, no caption.
  const { bridge, seen } = fakeApp({ Rectangle: { place: 'top left' } });
  await bridge.request('locate', { target: 'Rectangle', caption: 'Here' });
  assert.equal('intent' in seen[0].params, false);
});

/** A lesson of five steps with no hints of its own, on a fake clock; `locate` goes to the fake app through ComputerUse. */
function lessonOn(app, { names = ['Alpha', 'Bravo', 'Rectangle', 'Delta', 'Zebra'], hints = {} } = {}) {
  saveSettings({ pointer: true });
  let t = 1_000_000;
  const screen = {};
  const said = [], points = [];
  const c = new ComputerUse({ bridge: app.bridge, logFile });
  const s = new TeachSession({
    adapter: { async snapshot({ elements = [] }) { return { cells: {}, ui: { app: 'Shapes' }, elements: Object.fromEntries(elements.map((l) => [l, { present: true, selected: Boolean(screen[l]) }])) }; } },
    say: (x) => said.push(x),
    point: (target) => points.push(target),
    locate: (label, step) => c.locateForLesson(label, step, 'Shapes'),
    now: () => t,
    autoPoll: false,
  });
  s.start({ title: 'Shapes', steps: names.map((n) => ({ say: `Click ${n}.`, target: n, ...(hints[n] ? { hint: hints[n] } : {}), check: { kind: 'element_state', label: n, selected: true } })) });
  const h = {
    s, c, said, points, screen,
    async tick(ms = T.TEACH_POLL_MS) { t += ms; await s.poll(); },
    async solve(name, ms = 1000) {
      await h.tick(ms);
      screen[name] = true;
      for (let k = 0; k < 4; k++) await h.tick();
    },
    locates: () => app.seen.filter((r) => r.kind === 'locate').map((r) => r.params.target),
  };
  return h;
}

test('a step that begins on the hint rung says where its target is, asked with locate: the light stays put', async () => {
  const app = fakeApp({ Rectangle: { place: 'top left', container: 'toolbar', kind: 'button' }, Delta: { place: 'right', kind: 'tab' } });
  const h = lessonOn(app);
  await h.tick(0);
  await h.solve('Alpha');
  await h.solve('Bravo');
  // Step 3 begins a rung below the point: the hint in words, with where the app says it is.
  assert.equal(h.s.ladder.rung, 2);
  assert.equal(h.said.at(-1), "Click Rectangle. It's in the toolbar at the top left: the Rectangle button.");
  assert.deepEqual(h.locates(), ['Rectangle']);
  assert.deepEqual(h.points, ['Alpha', 'Bravo'], 'the light went only to the first two steps: finding it for a hint never points');
  assert.equal(app.kinds().includes('point'), false);
  assert.equal(app.seen.find((r) => r.kind === 'locate').params.app, 'Shapes');

  // Step 4 begins on the prompt; a pause climbs to the hint, and that one says where too.
  await h.solve('Rectangle');
  assert.equal(h.s.ladder.rung, 1);
  assert.equal(h.said.at(-1), 'Click Delta.');
  await h.s.hear('where?');
  assert.equal(h.s.ladder.rung, 2);
  assert.equal(h.said.at(-1), "It's on the right: the Delta tab.");
  assert.deepEqual(h.locates(), ['Rectangle', 'Delta']);
  assert.deepEqual(h.points, ['Alpha', 'Bravo'], 'still no light: the user is finding it themselves');
});

test('a thing the app cannot place gets the old hint; a hint the lesson wrote is never looked up', async () => {
  const app = fakeApp({ Rectangle: { place: 'top left' } });
  const h = lessonOn(app, { names: ['Alpha', 'Bravo', 'Zebra', 'Rectangle', 'Echo Bay'], hints: { Rectangle: 'It looks like a small square.' } });
  await h.tick(0);
  await h.solve('Alpha');
  await h.solve('Bravo');
  assert.equal(h.said.at(-1), 'Click Zebra.', 'not found: the bare label adds nothing to the step, as before');
  await h.solve('Zebra', 10_000);
  // Step 4 has its own hint: said on the hint rung with no question to the app.
  const asked = h.locates().length;
  await h.s.hear('where?');
  await h.s.hear('where?');
  assert.ok(h.said.includes('It looks like a small square.'));
  assert.equal(h.locates().length, asked);
  // And a climb onto the hint rung for something the app can't find: "Look for …", as it was.
  const g = lessonOn(fakeApp({}), { names: ['Alpha', 'Bravo', 'Charlie', 'Zebra', 'Echo Bay'] });
  await g.tick(0);
  for (const n of ['Alpha', 'Bravo', 'Charlie']) await g.solve(n);
  assert.equal(g.s.ladder.rung, 1);
  await g.s.hear('where?');
  assert.equal(g.said.at(-1), 'Look for Zebra.');
});

test('an older Mac app that never answers locate is asked once, then hints are the label with no wait', async () => {
  const app = fakeApp({ Rectangle: { place: 'top left' } }, { locate: false });
  saveSettings({ pointer: true });
  const c = new ComputerUse({ bridge: app.bridge, logFile });
  assert.equal(await c.locateForLesson('Rectangle', {}, 'Shapes'), null, 'no answer in time');
  const started = Date.now();
  assert.equal(await c.locateForLesson('Rectangle', {}, 'Shapes'), null);
  assert.ok(Date.now() - started < 100, 'not asked again');
  assert.equal(app.seen.filter((r) => r.kind === 'locate').length, 1);
  // One that does answer keeps being asked, found or not; only fixed words come back.
  const ok = fakeApp({ Rectangle: { place: 'top left', container: 'the Layers panel', kind: 'button' } });
  const d = new ComputerUse({ bridge: ok.bridge, logFile });
  assert.deepEqual(await d.locateForLesson('Rectangle', { menu_bar: true }, 'Shapes'), { place: 'top left', kind: 'button' });
  assert.equal(ok.seen[0].params.menuBar, true);
  assert.equal(await d.locateForLesson('Zebra', {}, 'Shapes'), null);
  assert.equal(ok.seen.length, 2);
});

test('a lesson stopped while the app is finding the hint says nothing more', async () => {
  let t = 1_000_000;
  const said = [];
  /** @type {(v: any) => void} */
  let answer = () => {};
  const s = new TeachSession({
    adapter: { async snapshot({ elements = [] }) { return { cells: {}, ui: { app: 'Shapes' }, elements: Object.fromEntries(elements.map((l) => [l, { present: true, selected: false }])) }; } },
    say: (x) => said.push(x),
    locate: () => new Promise((r) => (answer = r)),
    now: () => t,
    autoPoll: false,
  });
  s.start({ title: 'One', steps: [{ say: 'Click Rectangle.', check: { kind: 'element_state', label: 'Rectangle', selected: true } }, { say: 'Click Delta.', target: 'Delta', check: { kind: 'element_state', label: 'Delta', selected: true } }] });
  await s.poll();
  s.i = 1; // straight to a step with a target, on the prompt rung
  s.ladder.rung = 1;
  s.ladder.has = { hint: true, point: true, part: false };
  const n = said.length;
  const climbing = s.climb('stuck');
  await wait(10);
  s.stop();
  const stopped = said.length;
  answer({ place: 'top left' });
  await climbing;
  assert.ok(stopped >= n);
  assert.equal(said.length, stopped, 'the hint for a lesson that is over is never spoken');
});

test('the assistant gets the place on a click, a wait and a point, and is told what it is for', async () => {
  (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));
  const app = fakeApp({ Rectangle: { place: 'top left', container: 'toolbar', kind: 'icon' }, Plain: {} });
  const c = new ComputerUse({ bridge: app.bridge, logFile });
  const r = await c.act('click', { target: 'Rectangle' });
  assert.equal(r.done, true);
  assert.deepEqual([r.place, r.container, r.kind], ['top left', 'toolbar', 'icon']);
  const bare = await c.act('click', { target: 'Plain' });
  assert.equal('place' in bare, false, 'nothing said of a thing the app did not place');
  const w = await c.act('wait_for', { target: 'Rectangle', timeout_seconds: 2 });
  assert.deepEqual([w.found, w.place, w.container], [true, 'top left', 'toolbar']);
  c.end('done');

  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, app.bridge);
  const tools = Object.fromEntries(d.toolList().map((t) => [t.name, /** @type {any} */ (t)]));
  const hit = JSON.parse((await tools.point_at.handler({ target: 'Rectangle' }, {})).content[0].text);
  assert.deepEqual([hit.pointed, hit.place, hit.container, hit.kind], [true, 'top left', 'toolbar', 'icon']);
  assert.match(computerPrompt(getSettings()), /carries place \("top left"\), container \("toolbar"\) or kind \("button"\)/);
});
