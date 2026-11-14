// Lessons in any app: the general checks (lib/teach.js), the any-app adapter over the Mac app's
// read-only `state` request, the guard against checks that are already true, and the `teach`
// tool's wiring (lib/computer.js). A fake "Mac app" stands in for the screen; changing it is
// "the user doing the step".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('lessons');
const T = await import('../lib/teach.js');
const { TeachSession, evalCheck, uiAdapter, validateLesson, nearMiss } = T;
const { ComputerUse, COMPUTER_TOOL_NAMES } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings } = await import('../lib/settings.js');

/** What the Mac app would report: change it to simulate the user. */
function fakeScreen() {
  return {
    app: 'System Settings', front: 'com.apple.systempreferences', window: 'General', windows: 1, url: '', menuOpen: false, signature: 1,
    focus: { role: 'AXTextField', label: 'Search', value: '' },
    elements: { 'Dark': { present: true, selected: false }, 'Wi-Fi': { present: true, value: '0' }, 'Brightness': { present: true, value: '40' } },
    shown: { 'File': true, 'Save': false },
  };
}

/** A fake bridge answering `state` and `wait` from the fake screen (and `point`). */
function fakeBridge(screen, { oldApp = false, native = true } = {}) {
  const seen = [];
  return {
    seen,
    native,
    // An older Mac app answers pointing and looking, but never the lesson's state request.
    ...(oldApp ? { answeredKinds: new Set(['point', 'look']), lastAnswerAt: Date.now() } : {}),
    async request(kind, p) {
      seen.push({ kind, p });
      if (kind === 'state') {
        if (oldApp) throw new Error("The Mac app didn't answer in time.");
        const elements = Object.fromEntries((p.labels || []).map((l) => [l, screen.elements[l] || { present: false }]));
        return { ok: true, ...screen, elements };
      }
      if (kind === 'wait') return { ok: true, found: Boolean(screen.shown[p.target] ?? screen.elements[p.target]?.present), label: p.target };
      if (kind === 'point') return { found: Boolean(screen.shown[p.target] ?? screen.elements[p.target]?.present) };
      return { ok: true };
    },
  };
}

function harness(screen, lesson) {
  let t = 1_000_000;
  const said = [], reports = [];
  const s = new TeachSession({ adapter: uiAdapter(fakeBridge(screen)), say: (x) => said.push(x), report: (r) => reports.push(r), now: () => t, autoPoll: false });
  const started = s.start(lesson);
  return {
    s, said, reports, started,
    async tick(ms = T.TEACH_POLL_MS) { t += ms; await s.poll(); },
    async settle() { for (let k = 0; k < 4; k++) { t += T.TEACH_POLL_MS; await s.poll(); } },
  };
}

test('general checks read the app, window, page, menus, the focused field and named controls', () => {
  const snap = {
    ui: { app: 'Safari', front: 'com.apple.Safari', window: 'Settings — General', url: 'https://example.com/account', menuOpen: true, focus: { role: 'AXTextField', label: 'Address', value: 'otters' } },
    elements: { 'Dark': { present: true, selected: true }, 'Wi-Fi': { present: true, value: '1' }, 'Size': { present: true, value: '72' } },
    labels: { 'Save': true, 'Cancel': false },
  };
  const yes = (c) => assert.equal(evalCheck(c, snap), true, JSON.stringify(c));
  const no = (c, why = JSON.stringify(c)) => assert.equal(evalCheck(c, snap), false, why);
  yes({ kind: 'app_front', app: 'safari' });
  no({ kind: 'app_front', app: 'Notes' });
  yes({ kind: 'window_title', contains: 'general' });
  yes({ kind: 'menu_open' });
  no({ kind: 'menu_open', open: false });
  yes({ kind: 'url_contains', text: '/account' });
  yes({ kind: 'focused', label: 'Address' });
  yes({ kind: 'field_value', equals: 'Otters' });
  no({ kind: 'field_value', equals: 'otter' });
  yes({ kind: 'element_state', label: 'Dark', selected: true });
  yes({ kind: 'element_state', label: 'Wi-Fi', checked: true });
  no({ kind: 'element_state', label: 'Missing', selected: true });
  yes({ kind: 'element_value', label: 'Size', approx: 70, tolerance: 3 });
  no({ kind: 'element_value', label: 'Size', approx: 50, tolerance: 3 });
  yes({ kind: 'label_present', label: 'Save' });
  yes({ kind: 'label_gone', label: 'Cancel' });
  no({ kind: 'label_gone', label: 'Save' });
  no({ kind: 'window_title', contains: '' }, 'an empty expectation never passes');
  assert.equal(validateLesson({ steps: [{ say: 'Click Appearance.', check: { kind: 'element_state', label: 'Appearance', selected: true } }] }).ok, true);
});

test('a lesson in any app passes each step when the screen shows it, two polls in a row', async () => {
  const screen = fakeScreen();
  const h = harness(screen, {
    title: 'Dark mode',
    steps: [
      { say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } },
      { say: 'Turn on Wi-Fi.', target: 'Wi-Fi', check: { kind: 'element_state', label: 'Wi-Fi', checked: true } },
    ],
  });
  assert.equal(h.started.ok, true);
  await h.tick(0); // INSTRUCT step 1
  assert.equal(h.said.at(-1), 'Click Dark.');
  await h.tick();
  assert.equal(h.s.i, 0, 'nothing done yet');
  screen.elements.Dark.selected = true; // the user clicks Dark
  await h.settle();
  assert.equal(h.s.i, 1);
  assert.equal(h.said.at(-1), 'Turn on Wi-Fi.');
  screen.elements['Wi-Fi'].value = '1';
  await h.settle();
  assert.equal(h.reports.at(-1).kind, 'finished');
});

test('a check that is already true at the start never passes by itself, whatever else changes', async () => {
  const screen = fakeScreen();
  const h = harness(screen, { steps: [{ say: 'Open the File menu.', target: 'File', check: { kind: 'label_present', label: 'File' } }] });
  await h.tick(0);
  assert.equal(h.said.at(-1), "Open the File menu. Tell me when you've done it.");
  assert.deepEqual(h.reports, [], 'the model is not called about it');
  await h.settle();
  await h.settle();
  assert.equal(h.s.active, true, 'no false pass: the File label was there all along');
  screen.menuOpen = true; // something else on screen changed (on Oct 3 this passed the step 2.8 s in)
  await h.settle();
  assert.equal(h.s.active, true, 'a change elsewhere proves nothing about this step');
  await h.s.hear('I did it');
  await h.settle();
  assert.equal(h.reports.at(-1).kind, 'finished');
});

test('a weak check is a line in the lesson log, never a report the assistant reads aloud', async () => {
  saveSettings({ pointer: true });
  const screen = fakeScreen();
  const lessonLog = path.join(dirs.data, 'lesson-log.jsonl');
  fs.rmSync(lessonLog, { force: true });
  const c = new ComputerUse({ bridge: /** @type {any} */ (fakeBridge(screen)), logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const reports = [], said = [];
  c.on('lesson_report', (r) => reports.push(r));
  c.on('say', (t) => said.push(t));
  await c.startLesson({ goal: 'open a menu', steps: [{ say: 'Open the File menu.', target: 'File', check: { kind: 'label_present', label: 'File' } }] });
  await until(() => said.length > 0);
  const log = fs.readFileSync(lessonLog, 'utf8');
  c.abort('test over');
  assert.match(log, /"event":"weak_check"/);
  assert.doesNotMatch(log, /File menu/, 'the log never holds the step\'s words');
  assert.deepEqual(reports.map((r) => r.kind), ['stopped'], 'nothing but the stop reached the assistant, so there is no "Quick note" to speak');
  assert.equal(said[0], "Open the File menu. Tell me when you've done it.");
});

test('general near-misses: another app in front, a typo in the field, a value not there yet', () => {
  const base = { ui: { app: 'Google Chrome', focus: { value: '' } }, elements: { Brightness: { present: true, value: '40' } } };
  assert.equal(nearMiss({ say: 'Switch to Notes.', check: { kind: 'app_front', app: 'Notes' } }, base, { ui: { app: 'Reminders' } })?.say, "That's Reminders. We want Notes.");
  assert.equal(nearMiss({ say: 'Type Coffee.', check: { kind: 'field_value', equals: 'Coffee' } }, base, { ui: { app: 'Google Chrome', focus: { value: 'Cofee' } } })?.say, 'Almost. It says Cofee. Try Coffee.');
  assert.equal(nearMiss({ say: 'Set brightness to 70.', check: { kind: 'element_value', label: 'Brightness', approx: 70, tolerance: 5 } }, base, { elements: { Brightness: { present: true, value: '55' } } })?.say, "That's 55. We want about 70.");
  assert.equal(nearMiss({ say: 'Set brightness to 70.', check: { kind: 'element_value', label: 'Brightness', approx: 70 } }, base, base), null, 'no change, no correction');
});

test('the any-app adapter asks the Mac app for state once per poll, and spots an older app', async () => {
  const screen = fakeScreen();
  const bridge = fakeBridge(screen);
  const snap = await uiAdapter(bridge, { app: 'System Settings' }).snapshot({ labels: ['Save'], elements: ['Dark'] });
  assert.deepEqual(snap.elements, { Dark: { present: true, selected: false } });
  assert.equal(snap.labels.Save, false);
  assert.equal(snap.ui.app, 'System Settings');
  assert.equal(bridge.seen.filter((r) => r.kind === 'state').length, 1);
  assert.equal(bridge.seen.find((r) => r.kind === 'state').p.app, 'System Settings');
  assert.equal(await uiAdapter(fakeBridge(screen, { oldApp: true })).probe(), false);
  assert.equal(await uiAdapter(bridge).probe(), true);
});

test('the teach tool checks the lesson, the Mac app and step 1 on screen, then runs on its own and logs', async () => {
  saveSettings({ pointer: true, computerUse: false });
  assert.ok(COMPUTER_TOOL_NAMES.includes('teach'));
  const screen = fakeScreen();
  const logFile = path.join(dirs.data, 'computer-log.jsonl');
  const lessonLog = path.join(dirs.data, 'lesson-log.jsonl');
  const make = (o) => new ComputerUse({ bridge: /** @type {any} */ (fakeBridge(screen, o)), logFile });
  const lesson = { goal: 'turn on dark mode', steps: [{ say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } }] };

  assert.equal((await make({ native: false }).startLesson(lesson)).error, 'no_app');
  assert.equal((await make().startLesson({ goal: 'x', steps: [{ say: 'Click Dark.', check: { kind: 'no_such_check' } }] })).error, 'lesson', 'a plan that cannot run is refused');
  // A two-action step is mended and the lesson starts (on Oct 3 it was sent back twice, 15 s each).
  const mended = make();
  const m = await mended.startLesson({ goal: 'x', steps: [{ say: 'Click Dark and then click Light and then save everything right now please.', target: 'Dark', check: { kind: 'menu_open' } }] });
  assert.deepEqual([m.started, m.steps], [true, 3], JSON.stringify(m));
  assert.match(m.note, /Echo adjusted the plan: step 1 had 3 actions/);
  mended.abort('test over');
  const planLog = fs.readFileSync(lessonLog, 'utf8');
  assert.match(planLog, /"event":"plan_repaired","lesson":"[0-9a-f]+","step":1,"reason":"split"/);
  assert.match(planLog, /"event":"plan_rejected","lesson":"[0-9a-f]+","reasons":\["step 1: missing or unknown check"\]/);
  assert.doesNotMatch(planLog, /Click Dark|save everything/, 'a reason, never the step\'s words');
  assert.equal((await make({ oldApp: true }).startLesson(lesson)).error, 'old_app');
  assert.equal((await make().startLesson({ goal: 'x', steps: [{ say: 'Click Light.', target: 'Light', check: { kind: 'element_state', label: 'Light', selected: true } }] })).error, 'not_on_screen', 'never say a step whose target is not there');

  const c = make();
  const said = [];
  c.on('say', (t) => said.push(t));
  const r = await c.startLesson(lesson);
  assert.equal(r.started, true);
  assert.equal(c.isLessonCommand('repeat'), true);
  assert.equal(c.isLessonCommand('why is it called dark mode?'), false);
  // A remark of a word or two is the lesson's to take in silence (never a model turn), but it is
  // not a command: the speech intake may still hold it for the rest of the thought.
  assert.equal(c.isLessonCommand('I think'), false);
  assert.equal(c.lessonTakes('I think'), true);
  assert.equal(c.lessonTakes('okay', { answering: true }), false, 'a short answer to something Echo asked goes to the assistant');
  assert.equal(c.lessonTakes('why is it called dark mode?'), false);
  assert.equal(c.isLessonCommand('just do it'), true);
  const remark = await c.hearLesson('I think');
  assert.equal(remark.handled, true);
  assert.doesNotMatch(fs.readFileSync(lessonLog, 'utf8'), /I think/, 'a remark is noted without its words');
  assert.match(fs.readFileSync(lessonLog, 'utf8'), /"event":"remark"/);
  const started = fs.readFileSync(lessonLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.event === 'lesson_started');
  assert.deepEqual([started.steps, started.kinds], [1, ['element_state']]);
  // The assistant looked and the step is done or close enough: lesson_control accept passes it.
  assert.equal((await c.controlLesson({ action: 'accept' })).accepted, true);
  await until(() => said.includes('That works too.'));
  await until(() => !c.lesson.active, 4000, 'the last step passed: the lesson ends once the result has sat');
  const again = await c.startLesson(lesson);
  assert.equal(again.started, true, JSON.stringify(again));
  c.abort('escape'); // Escape ends a lesson too
  assert.equal(c.lesson.active, false);
  assert.ok(fs.readFileSync(lessonLog, 'utf8').includes('"event":"stopped"'));
  assert.ok(!said.some((s) => /click/i.test(s) && s !== 'Click Dark.'), 'only the lesson speaks its step');
});

test('the bridge sends state requests to the Mac app like other read-only requests', async () => {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500 });
  bridge.nativeClients = () => 1;
  bridge.on('request', (r) => setImmediate(() => bridge.deliver(r.id, { ok: true, app: 'Notes', elements: {} })));
  assert.equal((await bridge.request('state', { labels: [] })).app, 'Notes');
  bridge.nativeClients = () => 0;
  assert.equal((await bridge.request('state', {})).error, 'no_app');
});

test('during a lesson its commands skip the model, and a question reaches it with the step', async () => {
  saveSettings({ pointer: true });
  const { Dispatcher } = await import('../lib/dispatcher.js');
  const { TaskManager } = await import('../lib/tasks.js');
  const screen = fakeScreen();
  const c = new ComputerUse({ bridge: /** @type {any} */ (fakeBridge(screen)), logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, undefined, null, c);
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (m) => pushed.push(m), size: 0 });
  await c.startLesson({ goal: 'turn on dark mode', steps: [{ say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } }] });
  assert.equal(d.send('repeat'), 'local');
  assert.equal(pushed.length, 0, 'no model call for a lesson command');
  assert.equal(d.send('why is it called dark mode?'), 'turn');
  assert.match(String(pushed.at(-1)), /lesson "turn on dark mode" in progress, step 1 of 1: "Click Dark\."/);
  const notes = [];
  d.notify = (e) => notes.push(e);
  c.emit('lesson_report', { kind: 'struggling', step: 1, total: 1, note: 'The user has missed step 1 three times.' });
  assert.match(notes[0], /^\[lesson, step 1 of 1, struggling\]/);
  c.abort('test over');
});

/* ---------- Phase A: what went wrong in the Adobe XD lesson on Oct 1 (LIVE_TUTOR_PLAN.md) ---------- */

test('the same sentence from two mics at once goes through once; a real repeat still does', async () => {
  // Decided by when the two recordings were made (lib/heard.js), whatever each recognizer wrote.
  const { heardTwice } = await import('../lib/heard.js');
  const first = { mic: 'page', endAt: 4000, ms: 2200 };
  assert.equal(heardTwice(first, { mic: 'app', endAt: 3900, ms: 2100 }), true, 'two mics, the same moment');
  assert.equal(heardTwice(first, { mic: 'page', endAt: 4000, ms: 2200 }), false, 'the same mic again is a real repeat');
  assert.equal(heardTwice(first, { mic: 'app', endAt: 9000, ms: 2000 }), false, 'said afterwards');
});

test('"Alright, I did" and "now what next?" mean "check now", never a question for the model', () => {
  for (const s of ['Alright, I did.', 'All right, I did.', 'Seems like I did.', 'I think I did it', 'I got it. Now what next?', "What's next?", 'Okay, done.', 'I clicked it', 'ok got it']) {
    assert.equal(T.teachCommand(s), 'done', s);
  }
  assert.equal(T.teachCommand('next'), 'next', 'a bare "next" still skips');
  for (const s of ['I did not', "I didn't", 'why is it called dark mode', 'where is the rectangle tool', 'I did what you said but nothing happened']) {
    assert.notEqual(T.teachCommand(s), 'done', s);
  }
});

test('a question keeps the watch going: a step done meanwhile passes, and the lesson waits to speak', async () => {
  const screen = fakeScreen();
  const h = harness(screen, {
    steps: [
      { say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } },
      { say: 'Turn on Wi-Fi.', target: 'Wi-Fi', check: { kind: 'element_state', label: 'Wi-Fi', checked: true } },
    ],
  });
  await h.tick(0);
  const q = await h.s.hear('why is it called dark mode?');
  assert.equal(q.handled, false);
  screen.elements.Dark.selected = true;
  await h.settle();
  assert.equal(h.s.i, 1, 'passed while the model was answering');
  assert.equal(h.said.at(-1), 'Click Dark.', 'nothing said over the answer');
  h.s.endQuiet();
  assert.equal(h.said.at(-1), 'Turn on Wi-Fi.', 'the next step, once the answer is over');
});

test('"Alright, I did" is answered from the screen', async () => {
  const screen = fakeScreen();
  const h = harness(screen, { steps: [{ say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } }] });
  await h.tick(0);
  await h.s.hear('Alright, I did.');
  assert.match(h.said.at(-1), /^Not yet\. I don't see it on screen\./);
  screen.elements.Dark.selected = true;
  await h.s.hear('Seems like I did.');
  await h.settle();
  assert.equal(h.reports.at(-1).kind, 'finished');
});

test('label checks see a label that is already there, and read the screen text when Accessibility finds nothing', async () => {
  const asked = [];
  let t = 0;
  const bridge = { request: async (kind, p) => { asked.push(p); return { ok: true, found: p.useScreen, via: p.useScreen ? 'text' : undefined, label: p.target }; } };
  const a = T.labelAdapter(bridge, { useScreen: true, screenEveryMs: 3000, now: () => t });
  assert.equal((await a.snapshot({ labels: ['Rectangle 1'] })).labels['Rectangle 1'], true, 'found in the screen text');
  assert.equal(asked[0].mode, 'present', 'present, not appear: a label already there counts');
  t = 1000;
  await a.snapshot({ labels: ['Rectangle 1'] });
  assert.equal(asked[1].useScreen, false, 'the screen is read at most every few seconds');
  t = 4000;
  await a.snapshot({ labels: ['Rectangle 1'] });
  assert.equal(asked[2].useScreen, true);
  const off = [];
  await T.labelAdapter({ request: async (k, p) => { off.push(p); return { found: false }; } }).snapshot({ labels: ['x'] });
  assert.equal(off[0].useScreen, false, 'no screen reading unless allowed');
});

test('a drag is one step with from and to; the model can replace a step that cannot work', async () => {
  saveSettings({ pointer: true });
  assert.equal(validateLesson({ steps: [{ say: 'Drag from the top left of the artboard to its middle.', gesture: 'drag', from: 'top left of the artboard', to: 'the middle', check: { kind: 'label_present', label: 'Rectangle 1' } }] }).ok, true);
  assert.equal(validateLesson({ steps: [{ say: 'Drag across the artboard.', check: { kind: 'label_present', label: 'Rectangle 1' } }] }).ok, false, 'a drag without from/to still needs to say where to grab');
  assert.match(validateLesson({ steps: [{ say: 'Drag across the artboard.', gesture: 'drag', from: 'x', check: { kind: 'menu_open' } }] }).errors.join(), /needs from and to/);

  const screen = fakeScreen();
  const c = new ComputerUse({ bridge: /** @type {any} */ (fakeBridge(screen)), logFile: path.join(dirs.data, 'computer-log.jsonl') });
  assert.equal((await c.controlLesson({ action: 'stop' })).error, 'no_lesson');
  await c.startLesson({ goal: 'draw a rectangle', steps: [{ say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } }] });
  const r = await c.controlLesson({ action: 'replace_steps', steps: [{ say: 'Drag from the top left of the artboard to its middle.', gesture: 'drag', from: 'Dark', to: 'the middle', check: { kind: 'label_present', label: 'Save' } }] });
  assert.equal(r.replaced, true, JSON.stringify(r));
  assert.equal(c.lesson.steps[0].target, 'Dark', 'a drag points at where to grab');
  assert.equal((await c.controlLesson({ action: 'stop' })).stopped, true);
  assert.equal(c.lesson.active, false);
});

test('lessons and "what do you think?" go to the main model', async () => {
  const { turnWeight } = await import('../lib/intent.js');
  assert.equal(turnWeight('all right, I did'), 'quick');
  assert.equal(turnWeight('all right, I did', { lesson: true }), 'full');
  for (const s of ['so what do you think?', 'is this plan any good', 'your thoughts on it']) assert.equal(turnWeight(s), 'full', s);
});

test('installed apps are in the speech vocabulary, suites and year-numbered names included', async () => {
  const apps = fs.mkdtempSync(path.join(dirs.root, 'apps-'));
  fs.mkdirSync(path.join(apps, 'Adobe XD', 'Adobe XD.app'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'Adobe Illustrator 2026.app'), { recursive: true });
  const saved = process.env.ECHO_APP_DIRS;
  process.env.ECHO_APP_DIRS = apps;
  try {
    const V = await import('../lib/vocab.js');
    assert.deepEqual(V.installedAppNames().sort(), ['Adobe Illustrator', 'Adobe Illustrator 2026', 'Adobe XD']);
    assert.ok(V.vocabularyTerms().includes('Adobe XD'));
  } finally {
    process.env.ECHO_APP_DIRS = saved;
  }
});

/* ---------- when Echo can't see the screen (Apple Vision took 38 s on macOS 27, Oct 1) ---------- */

test('a slow screen-text read turns that fallback off for the lesson instead of holding every poll', async () => {
  const asked = [];
  let t = 0;
  const off = [];
  const bridge = { request: (kind, p) => { asked.push(p); return p.useScreen ? new Promise(() => {}) : Promise.resolve({ ok: true, found: false }); } };
  const a = T.labelAdapter(bridge, { useScreen: true, screenMs: 30, screenEveryMs: 1000, now: () => t, onScreenOff: (i) => off.push(i) });
  const t0 = Date.now();
  assert.equal((await a.snapshot({ labels: ['Rectangle 1'] })).labels['Rectangle 1'], false);
  assert.ok(Date.now() - t0 < 1000, 'the poll wasn\'t held up by the slow read');
  assert.deepEqual(off.map((o) => o.why), ['slow']);
  t = 5000;
  await a.snapshot({ labels: ['Rectangle 1'] });
  assert.equal(asked.at(-1).useScreen, false, 'off for the rest of the lesson');
  assert.equal(off.length, 1, 'reported once');
});

test('when the Mac app does not answer, the any-app adapter says it could not see instead of hanging', async () => {
  const a = uiAdapter({ request: () => new Promise(() => {}) }, { requestMs: 30 });
  const snap = await a.snapshot({ labels: [], elements: ['Dark'] });
  assert.equal(snap.error, 'slow');
});

test('while Echo cannot see, nothing passes, the check-ins still come, and Echo says so once', async () => {
  let blind = true;
  const screen = fakeScreen();
  const real = uiAdapter(fakeBridge(screen));
  let t = 1_000_000;
  const said = [], reports = [];
  const s = new TeachSession({ adapter: { snapshot: (req) => (blind ? Promise.resolve({ cells: {}, error: 'slow' }) : real.snapshot(req)) }, say: (x) => said.push(x), report: (r) => reports.push(r), now: () => t, autoPoll: false });
  s.start({ steps: [{ say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } }] });
  const tick = async (ms = T.TEACH_POLL_MS) => { t += ms; await s.poll(); };
  await tick(0);
  screen.elements.Dark.selected = true; // done, but Echo can't see it
  for (let k = 0; k < T.TEACH_BLIND_POLLS + 2; k++) await tick();
  assert.equal(s.active, true, 'no pass on what Echo couldn\'t see');
  assert.equal(said.filter((x) => /can't see your screen/.test(x)).length, 1, 'said once');
  assert.deepEqual(reports.map((r) => r.kind), ['cant_see']);
  await s.hear('Alright, I did.');
  assert.match(said.at(-1), /can't see your screen right now/);
  await tick(T.TEACH_HINT1_MS);
  assert.match(said.at(-1), /^Still with me\?/, 'not seeing isn\'t activity: the check-in still comes');
  blind = false; // the screen is back, and the step was done while Echo couldn't see
  for (let k = 0; k < 4; k++) await tick();
  assert.equal(reports.at(-1).kind, 'finished', 'what was done while blind counts once Echo can see it');
});
