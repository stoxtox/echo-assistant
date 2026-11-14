// One way of walking the user through an app: what used to be "guide" (point at each thing in
// turn, move on when the next one shows up) is a quick lesson on the lesson engine (lib/teach.js).
// These are guide's behaviours, as lessons: each step pointed at and said, the next one when its
// target appears, never a click, stopping when the light can't find a step or lands on Passwords,
// and more help (not a silent time-out) when the user doesn't do a step. A fake "Mac app" answers
// `point` and `wait`, and a fake clock drives the lesson; nothing touches a real screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sandbox } from './helpers.js';

const dirs = sandbox('quicklesson');
const T = await import('../lib/teach.js');
const { TeachSession, quickLesson, labelAdapter, evalCheck, CHECK_KINDS, TEACH_MAX_STEPS, TEACH_POLL_MS, TEACH_IDLE_MS, TEACH_STUCK_MS } = T;
const { RUNG } = await import('../lib/ladder.js');
const { ComputerUse, computerPrompt } = await import('../lib/computer.js');
const { computerTools } = await import('../lib/tools/computer.js');
const root = path.resolve(import.meta.dirname, '..');

const WIFI = [{ target: 'Control Center', say: 'Top right, click Control Center.', menu_bar: true }, { target: 'Wi-Fi', say: 'Now click Wi-Fi.', menu_bar: true }];

/**
 * A quick lesson on a fake screen and a fake clock. `shown`: the labels on screen now (add one
 * to "do the step"). `point`: what the app answers a point with (default: found).
 * @param {any[]} steps @param {{ shown?: string[], point?: (target: string) => any, wait?: (p: any) => any, lesson?: any }} [o]
 */
function quick(steps, o = {}) {
  let t = 1_000_000;
  const shown = new Set(o.shown || []);
  const said = [], reports = [], cards = [], points = [], released = [], waits = [], rungs = [];
  const bridge = {
    async request(kind, p) {
      if (kind !== 'wait') throw new Error(`a quick lesson asked the app for "${kind}"`);
      waits.push(p);
      return o.wait ? o.wait(p) : { ok: true, found: shown.has(p.target), label: p.target, via: 'accessibility' };
    },
  };
  const made = o.lesson ? { ok: true, lesson: o.lesson } : quickLesson({ goal: 'turn on Wi-Fi', steps });
  const s = new TeachSession({
    adapter: labelAdapter(bridge),
    id: 'Q1',
    say: (x) => { said.push(x); },
    point: (target, step, stepId) => {
      points.push({ target, stepId, route: step.route });
      return o.point ? o.point(target) : { found: true, via: 'accessibility', label: target, app: 'Control Center' };
    },
    release: (stepId, outcome) => released.push(`${stepId} ${outcome}`),
    card: (c) => cards.push(c),
    report: (r) => reports.push(r),
    log: (e) => { if (e.kind === 'rung') rungs.push(e); },
    now: () => t,
    autoPoll: false,
  });
  const started = made.ok ? s.start(made.lesson) : { ok: false, note: made.note };
  return {
    s, said, reports, cards, points, released, waits, rungs, shown, started,
    async tick(ms = TEACH_POLL_MS) { t += ms; await s.poll(); },
    async settle(n = 5) { for (let k = 0; k < n; k++) { t += TEACH_POLL_MS; await s.poll(); } },
    kinds: () => reports.map((r) => r.kind),
  };
}

test('a quick lesson is built from steps that only say what to point at', () => {
  const made = quickLesson({ goal: 'export a PDF', app: 'Preview', steps: [
    { target: 'Preview', say: 'Open Preview.', why: 'A story a quick lesson never tells.' },
    { route: ['File', 'Export'], say: 'Choose File, then Export.' },
    { target: 'Wi-Fi', say: 'Click Wi-Fi.', menu_bar: true, app: 'Control Center' },
    { say: 'Nothing to point at.' },
    { target: 'Save', say: '' },
  ] });
  assert.equal(made.ok, true);
  const { lesson } = made;
  assert.equal(lesson.quick, true);
  assert.deepEqual([lesson.opening, lesson.closing], [undefined, undefined], 'no hook, no closing line');
  assert.deepEqual(lesson.steps.map((s) => s.target), ['Preview', 'Export', 'Wi-Fi', 'Save'], 'a route points at its last label; a step with nothing to point at is dropped');
  assert.deepEqual(lesson.steps.map((s) => s.check), [
    { kind: 'appears', label: 'File', app: 'Preview' }, // the next step is reachable when the first label of its route is there
    { kind: 'appears', label: 'Wi-Fi', menu_bar: true, app: 'Control Center' },
    { kind: 'appears', label: 'Save', app: 'Preview' },
    { kind: 'told' }, // the last one is only pointed out
  ]);
  assert.ok(!lesson.steps.some((s) => 'why' in s), 'no story');
  assert.equal(lesson.steps.at(-1).say, 'Click Save.');
  // A check the assistant gave is kept.
  const own = quickLesson({ steps: [{ target: 'Dark', say: 'Click Dark.', check: { kind: 'element_state', label: 'Dark', selected: true } }, { target: 'Done', say: 'Click Done.' }] });
  assert.equal(own.lesson.steps[0].check.kind, 'element_state');
  // What can't run is refused, with a reason for the assistant.
  assert.deepEqual([quickLesson({ steps: [] }).ok, quickLesson({ steps: [] }).error], [false, 'no_steps']);
  assert.equal(quickLesson({ steps: [{ say: 'No target.' }] }).error, 'no_steps');
  assert.equal(quickLesson({ steps: [{ route: Array(7).fill('Menu'), say: 'Too far.' }] }).error, 'bad_route');
  assert.equal(quickLesson({ steps: Array(20).fill({ target: 'A', say: 'Click A.' }) }).lesson.steps.length, TEACH_MAX_STEPS);
  // `appears` is a check like any other: true when the app found the label.
  assert.ok(CHECK_KINDS.includes('appears'));
  assert.equal(evalCheck({ kind: 'appears', label: 'Wi-Fi' }, { appears: { 'Wi-Fi': true } }), true);
  assert.equal(evalCheck({ kind: 'appears', label: 'Wi-Fi' }, { appears: { 'Wi-Fi': false } }), false);
  assert.equal(evalCheck({ kind: 'appears', label: 'Wi-Fi' }, { labels: { 'Wi-Fi': true } }), false);
});

test('a quick lesson points at each step, says it, moves on when the next thing shows up, and only points the last one out', async () => {
  const h = quick(WIFI);
  assert.equal(h.started.ok, true);
  assert.match(h.started.note, /points at each step and says it/);
  await h.tick(0);
  assert.deepEqual(h.said, ['Top right, click Control Center.'], 'step 1 at once: the light, then its line');
  assert.deepEqual(h.points, [{ target: 'Control Center', stepId: 'Q1.1', route: undefined }], 'the light waits there for the user');
  await h.settle();
  assert.equal(h.s.i, 0, 'it waits: Wi-Fi is not there yet');
  assert.deepEqual(h.said.length, 1);
  h.shown.add('Wi-Fi'); // the user clicks Control Center, and the panel opens
  await h.settle();
  assert.deepEqual(h.said, ['Top right, click Control Center.', 'Now click Wi-Fi.'], 'no "Got it.", no "tell me when you\'ve done it", no recap');
  assert.deepEqual(h.points.map((p) => [p.target, p.stepId]), [['Control Center', 'Q1.1'], ['Wi-Fi', '']], 'the last step is shown, not waited on');
  assert.deepEqual(h.released, ['Q1.1 done']);
  assert.equal(h.s.active, false);
  assert.deepEqual(h.kinds(), ['finished']);
  assert.match(h.reports[0].note, /Say nothing more/);
  // The page's strip: which step, and at the end that every step was shown.
  assert.deepEqual(h.cards.filter((c) => c.state === 'watching').map((c) => `${c.step}/${c.total} ${c.current}`), ['1/2 Top right, click Control Center.', '2/2 Now click Wi-Fi.']);
  assert.deepEqual([h.cards.at(-1).finished, h.cards.at(-1).complete], [true, true]);
  assert.ok(h.cards.slice(0, -1).every((c) => !c.finished));
  // It only ever looked for the next step's target, the way the pointer looks, and captured nothing.
  assert.ok(h.waits.length > 0);
  for (const w of h.waits) assert.deepEqual([w.target, w.menuBar, w.mode, w.useScreen, w.match], ['Wi-Fi', true, 'present', false, undefined]);
});

test('"where is it?" with one step: pointed out, said, over', async () => {
  const h = quick([{ target: 'Save', say: 'Bottom right, click Save.' }]);
  await h.tick(0);
  assert.deepEqual(h.said, ['Bottom right, click Save.']);
  assert.deepEqual(h.points.map((p) => p.stepId), [''], 'nothing to wait for');
  assert.deepEqual([h.s.active, h.kinds(), h.waits.length, h.released.length], [false, ['finished'], 0, 0]);
});

test('every step of a quick lesson begins with the light on it, and a step inside menus carries its route', async () => {
  const h = quick([{ target: 'Preview', say: 'Open Preview.' }, { route: ['File', 'Export'], say: 'Choose File, then Export.' }, { target: 'Save', say: 'Click Save.' }, { target: 'Done', say: 'Click Done.' }]);
  await h.tick(0);
  for (const label of ['File', 'Save', 'Done']) {
    await h.settle(2); // seen not there, then the user does the step
    h.shown.add(label);
    await h.settle();
  }
  assert.deepEqual(h.kinds(), ['finished']);
  assert.deepEqual(h.points.map((p) => [p.target, p.route]), [['Preview', undefined], ['Export', ['File', 'Export']], ['Save', undefined], ['Done', undefined]]);
  // A full lesson fades the light after two steps; a quick one never does.
  assert.deepEqual(h.rungs.filter((r) => r.trigger === 'start').map((r) => r.rung), [RUNG.POINT, RUNG.POINT, RUNG.POINT, RUNG.POINT]);
  assert.equal(h.waits.find((w) => w.target !== 'Save' && w.target !== 'Done').target, 'File', 'the step after is reachable when the first label of its route is there');
});

test('a next thing that is already on screen proves nothing: Echo asks to be told, and takes the user\'s word', async () => {
  const h = quick(WIFI, { shown: ['Wi-Fi'] });
  await h.tick(0);
  assert.deepEqual(h.said, ["Top right, click Control Center. Tell me when you've done it."]);
  await h.settle();
  assert.equal(h.s.i, 0, 'the step is not skipped before the user acts');
  await h.s.hear('done');
  await h.settle();
  assert.equal(h.said.at(-1), 'Now click Wi-Fi.');
  assert.deepEqual(h.kinds(), ['finished']);
});

test('a quick lesson stops when the light can\'t find a step, and the assistant says the rest in words', async () => {
  const missing = quick([{ target: 'Frobnicate', say: 'Click it.' }, { target: 'B', say: 'Click B.' }], { point: () => ({ found: false }) });
  await missing.tick(0);
  assert.deepEqual(missing.kinds(), ['not_found']);
  assert.match(missing.reports[0].note, /Couldn't find "Frobnicate" on screen at step 1/);
  assert.deepEqual([missing.said, missing.s.active, missing.released], [[], false, ['Q1.1 stopped']], 'a step that isn\'t there is never said, and the light is let go');
  assert.deepEqual([missing.cards.at(-1).finished, missing.cards.at(-1).complete], [true, false]);
  // The app can't point at all (no permission): its own words go to the assistant.
  const denied = quick(WIFI, { point: () => ({ ok: false, found: false, error: 'permission', message: 'Allow Echo under Accessibility.' }) });
  await denied.tick(0);
  assert.deepEqual(denied.kinds(), ['failed']);
  assert.match(denied.reports[0].note, /Permission needed\. Tell the user: Allow Echo under Accessibility\./);
  // The app never answered the point.
  const gone = quick(WIFI, { point: () => null });
  await gone.tick(0);
  assert.deepEqual([gone.kinds(), gone.said], [['not_found'], []]);
});

test('a lesson that lands on the Passwords icon stops and says where the step really is', async () => {
  // Oct 2: "Apple" matched the Passwords menu bar icon, the user clicked it and Passwords opened.
  const passwords = () => ({ ok: true, found: true, via: 'menubar', label: 'Apple Passwords', app: 'Passwords' });
  const h = quick([{ target: 'Apple', say: 'Click the Apple menu.', menu_bar: true }, { target: 'System Settings…', say: 'Click System Settings.' }], { point: passwords });
  await h.tick(0);
  assert.deepEqual(h.kinds(), ['off_limits']);
  assert.match(h.reports[0].note, /Apple logo at the far left of the menu bar/);
  assert.match(h.reports[0].note, /Tell the user not to click there/);
  assert.deepEqual([h.said, h.s.active, h.released], [[], false, ['Q1.1 stopped']], 'the step is never said, and the light does not stay on Passwords');
  // The same guard on a full lesson, and on the Keychain by the app's name.
  const full = quick([], { point: () => ({ found: true, label: 'Unlock', app: 'Keychain Access' }), lesson: { goal: 'x', steps: [{ say: 'Click Unlock.', target: 'Unlock', check: { kind: 'told' } }, { say: 'Click Done.', target: 'Done', check: { kind: 'told' } }] } });
  await full.tick(0);
  assert.deepEqual([full.kinds(), full.said, full.s.active], [['off_limits'], [], false]);
  // An ordinary target is fine.
  const fine = quick(WIFI);
  await fine.tick(0);
  assert.equal(fine.s.active, true);
});

test('a step the user doesn\'t do gets more help, then the assistant hears, then the lesson pauses: never a silent time-out', async () => {
  const h = quick(WIFI);
  await h.tick(0);
  await h.tick();
  await h.tick(30_000);
  assert.match(h.said.at(-1), /Want me to do this step for you\?/, 'the light is already there, so the next help is the offer');
  assert.deepEqual(h.kinds(), []);
  await h.tick(TEACH_STUCK_MS);
  assert.deepEqual(h.kinds(), ['stuck']);
  assert.match(h.reports[0].note, /step 1 \("Top right, click Control Center\."\)/);
  await h.tick(TEACH_IDLE_MS);
  assert.deepEqual([h.kinds(), h.s.phase], [['stuck', 'idle'], 'paused']);
  assert.match(h.said.at(-1), /Say "go on" when you're ready/);
  assert.deepEqual(h.released, ['Q1.1 stopped']);
  assert.equal(h.points.length, 1, 'it never moved on by itself');
});

test('stopping a quick lesson lets the light go and tells the assistant; "stop" said aloud does the same', async () => {
  const h = quick(WIFI);
  await h.tick(0);
  h.s.stop();
  assert.deepEqual([h.kinds(), h.released, h.s.active], [['stopped'], ['Q1.1 stopped'], false]);
  await h.settle();
  assert.equal(h.said.length, 1, 'nothing more is said');
  const v = quick(WIFI);
  await v.tick(0);
  assert.deepEqual(await v.s.hear('stop'), { handled: true, command: 'stop' });
  assert.deepEqual([v.kinds(), v.s.active], [['stopped'], false]);
});

test('a Mac app that stops answering mid-lesson: Echo says it can\'t see, and the assistant hears', async () => {
  let dead = false;
  const h = quick(WIFI, { wait: (p) => { if (dead) throw new Error("The Mac app didn't answer in time."); return { ok: true, found: false, label: p.target }; } });
  await h.tick(0);
  dead = true;
  await h.settle(6);
  assert.match(h.said.at(-1), /I can't see your screen right now/);
  assert.deepEqual(h.kinds(), ['cant_see']);
});

test('one tool: teach takes quick, and guide is a thin alias that calls it', async () => {
  const calls = [];
  const computer = /** @type {any} */ ({ startLesson: async (req) => { calls.push(req); return { started: true }; } });
  const tools = Object.fromEntries(computerTools(computer).map((t) => [t.name, /** @type {any} */ (t)]));
  const teach = z.object(tools.teach.inputSchema), guide = z.object(tools.guide.inputSchema);
  assert.ok(teach.safeParse({ goal: 'turn on Wi-Fi', quick: true, steps: WIFI }).success, 'quick steps need no check');
  assert.ok(teach.safeParse({ goal: 'x', steps: [{ say: 'Click Wi-Fi.', target: 'Wi-Fi', check: { kind: 'appears', label: 'Details…', menu_bar: true } }] }).success);
  assert.ok(guide.safeParse({ steps: WIFI }).success);
  assert.ok(!guide.safeParse({ steps: [] }).success);
  assert.ok(!guide.safeParse({ steps: Array(TEACH_MAX_STEPS + 1).fill(WIFI[0]) }).success);
  await tools.guide.handler({ goal: 'turn on Wi-Fi', steps: WIFI }, {});
  await tools.teach.handler({ goal: 'turn on Wi-Fi', quick: true, steps: WIFI }, {});
  assert.deepEqual(calls[0], { goal: 'turn on Wi-Fi', steps: WIFI, quick: true }, 'an old session\'s guide call starts a quick lesson');
  assert.deepEqual(calls[1], calls[0]);
  assert.match(tools.guide.description, /The same as teach with quick: true/);
  assert.match(tools.teach.description, /quick: true/);
  // The guidance: one concept.
  const p = computerPrompt({ computerUse: true, pointer: true });
  assert.match(p, /always a lesson \(teach\); there is no other way/);
  assert.match(p, /"where's Wi-Fi\?".*call teach with quick: true/);
  assert.doesNotMatch(p, /call guide|use guide|Guide mode/);
  assert.match(computerPrompt({ pointer: false }), /Lessons are unavailable because the pointer is off/);
  // A full lesson still needs a check on every step.
  const { ScreenBridge } = await import('../lib/screen.js');
  const { saveSettings } = await import('../lib/settings.js');
  saveSettings({ pointer: true });
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 300 });
  bridge.nativeClients = () => 1;
  const c = new ComputerUse({ bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const r = await c.startLesson({ goal: 'x', steps: [{ say: 'Click Wi-Fi.', target: 'Wi-Fi' }] });
  assert.equal(r.error, 'lesson');
  assert.match(r.message, /step 1: missing or unknown check/);
});

test('lib/guide.js and the page code that only served it are gone', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.equal(fs.existsSync(path.join(root, 'lib/guide.js')), false);
  for (const f of ['lib/computer.js', 'lib/tools/computer.js', 'lib/dispatcher.js', 'lib/screen.js', 'server.js']) assert.doesNotMatch(read(f), /guide\.js|runGuide|new Guide\(|guide_step|GUIDE_MAX_STEPS/, f);
  assert.doesNotMatch(read('public/computer.js'), /guidePill|guideStep|GUIDE_STALE_MS/);
  assert.doesNotMatch(read('public/app.js'), /guide_step|guideStep/);
  // The strip is fed by the lesson's own cards, quick or not.
  assert.match(read('public/app.js'), /case 'lesson_card': \{[\s\S]{0,200}activity\.guide\(\{ step: msg\.step, total: msg\.total, say: msg\.current, finished: Boolean\(msg\.finished\), done: Boolean\(msg\.complete\) \}\);/);
});
