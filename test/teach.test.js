// Teaching mode (lib/teach.js): one step at a time, watched and checked. A fake sheet and a fake
// clock stand in for Excel and time; "clicks" and "typing" are simulated by changing the fake sheet.
// Covers the happy path, wrong-then-right, abandoning mid-lesson, menu nesting, another way there,
// typos, the wrong neighbour, the fill-handle wipeout with undo, hints, and the voice commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('teach');
const T = await import('../lib/teach.js');
const { TeachSession, evalCheck, collateralChanges, nearMiss, lintSay, validateLesson, teachCommand, describeCells, direction, parseA1, colLetters, isCellAddress, labelAdapter, labelFits, repairLesson, splitSay } = T;
const { computerPrompt } = await import('../lib/computer.js');

/** A fake Excel: cells, selection, edit mode, labels on screen, and an undo stack. */
function fakeSheet(cells = {}) {
  const sheet = {
    cells: structuredClone(cells),
    active: 'A1',
    selection: 'A1',
    editing: false,
    labels: new Set(),
    history: [],
    undoMisses: [],
    click(addr) { sheet.active = addr; sheet.selection = addr; },
    select(range) { sheet.selection = range; sheet.active = range.split(':')[0]; },
    type(addr, value) {
      sheet.history.push(structuredClone(sheet.cells));
      const v = String(value);
      sheet.cells[addr] = v.startsWith('=') ? { value: '?', formula: v } : { value: v };
    },
    fill(from, cells) {
      sheet.history.push(structuredClone(sheet.cells));
      for (const c of cells) sheet.cells[c] = { ...sheet.cells[from] };
    },
    adapter: {
      async snapshot({ labels }) {
        if (sheet.editing) throw new Error('Excel is in edit mode');
        return {
          active: sheet.active,
          selection: sheet.selection,
          cells: structuredClone(sheet.cells),
          labels: Object.fromEntries(labels.map((l) => [l, sheet.labels.has(l)])),
        };
      },
      async undo() {
        const prev = sheet.history.pop();
        if (!prev) return;
        sheet.cells = prev;
        for (const c of sheet.undoMisses) sheet.cells[c] = { value: 'junk' };
      },
      async restore(cells) {
        for (const [addr, c] of Object.entries(cells)) {
          if (!c || (c.value === undefined && c.formula === undefined)) delete sheet.cells[addr];
          else sheet.cells[addr] = { ...c };
        }
      },
    },
  };
  return sheet;
}

/** A session on a fake clock that records everything Echo says, points at, shows and reports. */
function harness(sheet, extra = {}) {
  let t = 1_000_000;
  const said = [], pointed = [], cards = [], reports = [], logged = [];
  const s = new TeachSession({
    adapter: sheet.adapter,
    say: (x) => said.push(x),
    point: (target) => pointed.push(target),
    card: (c) => cards.push(c),
    report: (r) => reports.push(r),
    // (Rung changes are the help ladder's: test/ladder.test.js.)
    log: (e) => { if (e.kind !== 'rung') logged.push(e); },
    now: () => t,
    autoPoll: false,
    ...extra,
  });
  return {
    s, said, pointed, cards, reports, logged,
    /** Moves the clock and runs one watch tick. */
    async tick(ms = T.TEACH_POLL_MS) { t += ms; await s.poll(); },
    /** Two ticks (a pass needs two polls in a row) plus the praise pause. */
    async settle() { for (let k = 0; k < 4; k++) { t += T.TEACH_POLL_MS; await s.poll(); } },
    last: () => said[said.length - 1],
  };
}

const budget = {
  title: 'Entering data',
  goal: 'enter your first items',
  steps: [
    { say: 'Click cell A2.', target: { cell: 'A2' }, check: { kind: 'selection', cell: 'A2' } },
    { say: 'Type Coffee, then press Return.', target: { cell: 'A2' }, check: { kind: 'cell_value', cell: 'A2', equals: 'Coffee' }, hint: 'Click the box under column A, row 2.' },
    { say: 'Click B2. Type 4, then press Return.', target: { cell: 'B2' }, check: { kind: 'cell_value', cell: 'B2', number: 4 }, praise: 'Great.' },
  ],
};

test('happy path: each step is spoken once, checked, acknowledged with what Echo saw, and the end is a one-line recap', async () => {
  const sheet = fakeSheet({ A1: { value: 'Item' }, B1: { value: 'Cost' } });
  const h = harness(sheet);
  const r = h.s.start(budget);
  assert.equal(r.ok, true);
  assert.match(r.note, /step 1 of 3/);
  await h.tick(0); // INSTRUCT step 1
  assert.deepEqual(h.said, ['Click cell A2.']);
  assert.deepEqual(h.pointed, [{ cell: 'A2' }]);
  assert.equal(h.cards.at(-1).step, 1);
  assert.equal(h.cards.at(-1).next, 'Type Coffee, then press Return.');

  // Nothing done yet: Echo stays quiet (no burst of steps).
  await h.tick(); await h.tick();
  assert.equal(h.said.length, 1);

  sheet.click('A2');
  await h.tick();
  assert.equal(h.said.length, 1, 'one poll is not enough: the check must hold twice');
  await h.settle();
  assert.deepEqual(h.said, ['Click cell A2.', 'A2 is selected.', 'Type Coffee, then press Return.']);

  sheet.editing = true; // typing in the cell: silent
  await h.tick(); await h.tick();
  assert.equal(h.said.length, 3);
  sheet.editing = false;
  sheet.type('A2', 'Coffee');
  await h.settle();
  assert.equal(h.said.at(-1), 'Click B2. Type 4, then press Return.');

  sheet.click('B2');
  sheet.type('B2', '4');
  await h.settle();
  assert.deepEqual(h.said.slice(-2), ['B2 says 4.', 'You did it: click cell A2, then type Coffee, then type 4.'], 'what the check saw, then what they did; then Echo is quiet');
  assert.equal(h.s.active, false);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].kind, 'finished');
  assert.match(h.reports[0].note, /Say nothing more/);
  assert.deepEqual(h.cards.at(-1).done, budget.steps.map((x) => x.say));
});

test('wrong then right: a wrong cell gets a gentle correction by address, then the right one passes', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start({ steps: [{ say: 'Click A5.', target: { cell: 'A5' }, check: { kind: 'selection', cell: 'A5' } }, budget.steps[1]] });
  await h.tick(0);
  sheet.click('C5');
  await h.tick();
  assert.equal(h.last(), "That's C5. We want A5, two cells to the left.");
  assert.doesNotMatch(h.said.join(' '), /wrong/i);
  assert.deepEqual(h.pointed, [{ cell: 'A5' }, { cell: 'A5' }], 're-points at the right target');
  // Same mistake again: no nagging.
  await h.tick(); await h.tick();
  assert.equal(h.said.length, 2);
  sheet.click('A5');
  await h.settle();
  assert.equal(h.said.at(-2), 'A5 is selected.');
  assert.equal(h.said.at(-1), 'Type Coffee, then press Return.');
});

test('wrong neighbour for a value: C5 instead of A5 names both addresses, and retyping in A5 passes without an undo alarm', async () => {
  const sheet = fakeSheet({ B5: { value: '23' } });
  const h = harness(sheet);
  h.s.start({ steps: [{ say: 'Click A5. Type Total.', target: { cell: 'A5' }, check: { kind: 'cell_value', cell: 'A5', equals: 'Total' } }] });
  await h.tick(0);
  sheet.type('C5', 'Total');
  await h.tick();
  assert.equal(h.last(), "That's C5. We want A5, two cells to the left.");
  sheet.type('A5', 'Total');
  await h.settle();
  assert.doesNotMatch(h.said.join(' '), /Oops/);
  assert.equal(h.reports[0].kind, 'finished');
});

test('a typo gets "Almost", and corrections are at most one per 10 seconds', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start({ steps: [budget.steps[1]] });
  await h.tick(0);
  sheet.type('A2', 'Cofee');
  await h.tick();
  assert.equal(h.last(), 'Almost. It says Cofee. Try Coffee.');
  sheet.type('A2', 'Cofe');
  await h.tick(1000);
  assert.equal(h.said.length, 2, 'too soon for another correction');
  await h.tick(T.TEACH_CORRECTION_GAP_MS);
  assert.equal(h.last(), 'Almost. It says Cofe. Try Coffee. Want me to do this step for you?', 'a second miss with the light already on it: the correction, and the offer');
});

test('the user abandons mid-lesson: the offer once the light has waited, the model hears at 45 s (it may re-plan), then a spoken pause', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start(budget);
  await h.tick(0);
  sheet.click('A2');
  await h.settle();
  const n = h.said.length;
  await h.tick(20_000);
  assert.equal(h.said.length, n, 'the light is on it: Echo waits twice as long before offering to take over');
  await h.tick(5000);
  assert.equal(h.last(), 'Want me to do this step for you?');
  assert.deepEqual(h.reports, []);
  await h.tick(T.TEACH_STUCK_MS);
  assert.equal(h.said.length, n + 1, 'nothing more is said');
  assert.equal(h.reports.at(-1).kind, 'stuck', 'the model hears, so it can fix a step that can\'t work');
  await h.tick(T.TEACH_IDLE_MS);
  assert.equal(h.last(), 'I\'ll pause here. Say "go on" when you\'re ready.', 'the pause is said out loud');
  assert.equal(h.reports.at(-1).kind, 'idle');
  assert.equal(h.reports.at(-1).step, 2);
  assert.equal(h.s.phase, 'paused');
  const quiet = h.said.length;
  await h.tick(60_000);
  assert.equal(h.said.length, quiet, 'a paused lesson says nothing');
  // "go on" picks it up at the same step.
  const r = await h.s.hear('go on');
  assert.equal(r.handled, true);
  assert.equal(h.last(), 'Type Coffee, then press Return.');
  assert.equal(h.s.active, true);
});

test('the user stops mid-lesson: "stop" ends it and reports where they were', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start(budget);
  await h.tick(0);
  const r = await h.s.hear('Echo, stop the lesson.');
  assert.equal(r.handled, true);
  assert.equal(h.s.active, false);
  assert.equal(h.reports[0].kind, 'stopped');
  assert.equal(h.reports[0].step, 1);
});

test('menu nesting: open a menu, then click inside it; the next step waits for the menu to open', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start({
    title: 'Conditional formatting',
    steps: [
      { say: 'Click Format in the menu bar.', target: { label: 'Format' }, check: { kind: 'label_present', label: 'Conditional Formatting…' } },
      { say: 'Click Conditional Formatting.', target: { label: 'Conditional Formatting…' }, check: { kind: 'label_present', label: 'New Rule…' } },
      { say: 'Click New Rule.', target: { label: 'New Rule…' }, check: { kind: 'label_present', label: 'New Formatting Rule' } },
    ],
  });
  await h.tick(0);
  assert.deepEqual(h.pointed, [{ label: 'Format' }]);
  sheet.labels.add('Conditional Formatting…'); // the Format menu opened
  await h.settle();
  assert.equal(h.last(), 'Click Conditional Formatting.');
  assert.deepEqual(h.pointed.at(-1), { label: 'Conditional Formatting…' });
  sheet.labels.add('New Rule…'); // the submenu opened
  await h.settle();
  sheet.labels.add('New Formatting Rule'); // the dialog opened
  await h.settle();
  assert.equal(h.reports[0].kind, 'finished');
});

test('another way there: an any_of branch or a later step already done gets "That works too."', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start({
    steps: [
      { say: 'Click Control Center in the menu bar.', target: { label: 'Control Center' }, check: { kind: 'any_of', checks: [{ kind: 'label_present', label: 'Wi-Fi' }, { kind: 'label_present', label: 'Network' }] } },
      { say: 'Click Wi-Fi.', target: { label: 'Wi-Fi' }, check: { kind: 'label_present', label: 'Other Networks' } },
      { say: 'Click your network.', target: { label: 'Home' }, check: { kind: 'label_present', label: 'Connected' } },
    ],
  });
  await h.tick(0);
  sheet.labels.add('Network'); // went through Settings instead
  await h.settle();
  assert.equal(h.said[1], 'That works too.');
  assert.equal(h.last(), 'Click Wi-Fi.');
  // Skipped straight to the network list's result: step 3 done while on step 2.
  sheet.labels.add('Connected');
  await h.settle();
  assert.equal(h.said.at(-2), 'That works too.');
  assert.match(h.said.at(-1), /^You did it: /);
  assert.equal(h.reports[0].kind, 'finished');
});

test('lesson-declared near-miss: an unhelpful click is named, and Echo re-points and waits', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start({ steps: [{ say: 'Click Wi-Fi.', target: { label: 'Wi-Fi' }, check: { kind: 'label_present', label: 'Other Networks' }, near_miss: [{ check: { kind: 'label_present', label: 'Display' }, say: "That's Display. We want Wi-Fi, at the top." }] }] });
  await h.tick(0);
  sheet.labels.add('Display');
  await h.tick();
  assert.equal(h.last(), "That's Display. We want Wi-Fi, at the top.");
  assert.equal(h.pointed.length, 2);
  assert.equal(h.s.active, true);
});

test('fill-handle wipeout: B3:B5 overwritten and SUM lost → immediate undo offer → undo restores the snapshot', async () => {
  const sheet = fakeSheet({ B2: { value: '5' }, B3: { value: '12' }, B4: { value: '6' }, B5: { value: '23', formula: '=SUM(B2:B4)' } });
  const h = harness(sheet);
  h.s.start({ steps: [{ say: 'Click B2. Hold Shift and click B5.', target: { cell: 'B2' }, check: { kind: 'selection', range: 'B2:B5' }, alt_say: 'Click B2.' }] });
  await h.tick(0);
  sheet.fill('B2', ['B3', 'B4', 'B5']);
  sheet.select('B2:B5'); // the selection check would pass, but the sheet got wiped
  await h.tick();
  assert.equal(h.last(), 'Oops, that changed B3 to B5 and removed a formula. Say "undo" and I\'ll fix it.');
  await h.settle();
  assert.equal(h.s.active, true, 'never passes while cells are wiped');
  assert.equal(h.said.filter((x) => x.startsWith('Oops')).length, 1, 'the alert is said once');
  const r = await h.s.hear('undo');
  assert.equal(r.command, 'undo');
  assert.deepEqual(sheet.cells.B5, { value: '23', formula: '=SUM(B2:B4)' });
  assert.equal(h.said.at(-2), 'Fixed it.');
  assert.equal(h.said.at(-1), 'Click B2.', 'replays the drag-free way');
  await h.settle();
  assert.equal(h.reports[0].kind, 'finished');
});

test('undo that misses cells: Echo puts them back from the snapshot and says so', async () => {
  const sheet = fakeSheet({ B3: { value: '12' } });
  sheet.undoMisses = ['D9'];
  const h = harness(sheet);
  h.s.start({ steps: [{ say: 'Click B2.', check: { kind: 'selection', cell: 'B2' } }] });
  await h.tick(0);
  sheet.fill('B2', ['B3']);
  await h.tick();
  await h.s.hear('oops');
  assert.equal(sheet.cells.D9, undefined);
  assert.deepEqual(sheet.cells.B3, { value: '12' });
  assert.equal(h.said.at(-2), 'Undo missed some cells, so I put them back.');
});

test('formula near-misses: as text, and a wrong range', async () => {
  const step = { say: 'Click B5. Type the SUM formula.', check: { kind: 'cell_formula', cell: 'B5', matches: '^=SUM\\(B2:B4\\)$', range: 'B2:B4' } };
  const base = { cells: {} };
  assert.equal(nearMiss(step, base, { cells: { B5: { value: 'SUM(B2:B4)' } } }).say, 'Almost. Start the formula with an equals sign.');
  assert.equal(nearMiss(step, base, { cells: { B5: { value: '18', formula: '=SUM(B2:B3)' } } }).say, 'That adds B2 to B3. We want B2 through B4.');
  assert.equal(evalCheck(step.check, { cells: { B5: { value: '19', formula: '= sum(b2:b4)' } } }), true);
});

test('voice commands: repeat, back, next, pause; other speech goes to the model while the watch carries on quietly', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start(structuredClone(budget));
  await h.tick(0);
  await h.s.hear('what was that?');
  assert.equal(h.last(), 'Click cell A2.');
  await h.s.hear('next');
  assert.equal(h.last(), 'Type Coffee, then press Return.');
  await h.s.hear('back');
  assert.equal(h.last(), 'Click cell A2.');
  await h.s.hear('pause');
  assert.equal(h.s.phase, 'paused');
  await h.s.hear('continue');
  assert.equal(h.s.phase, 'watch');
  const q = await h.s.hear('why is it called a cell?');
  assert.equal(q.handled, false);
  assert.equal(q.context.step, 1);
  assert.equal(q.context.say, 'Click cell A2.');
  sheet.click('A2');
  await h.settle();
  assert.equal(h.said.at(-1), 'Click cell A2.', 'nothing is said over the model\'s answer');
  assert.equal(h.s.i, 1, 'but the watch carried on: the step done meanwhile passed');
  h.s.resume(); // the answer is over
  assert.equal(h.said.at(-1), 'Type Coffee, then press Return.', 'the held line is said now');
});

test('"done" forces a check now', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start(budget);
  await h.tick(0);
  await h.s.hear("I'm done");
  assert.equal(h.last(), 'Not yet. I can see A1 selected, not A2.', 'one specific sentence: what Echo sees against what the step wanted');
  assert.equal(h.s.held, 'lesson.1', 'and the light still waits');
  sheet.click('A2');
  await h.s.hear('done');
  assert.equal(h.last(), 'A2 is selected.');
});

test('start validates and returns at once; a second lesson is refused', () => {
  const h = harness(fakeSheet());
  assert.equal(h.s.start({ steps: [] }).ok, false);
  assert.match(h.s.start({ steps: [{ say: 'Click A1.', check: { kind: 'nope' } }] }).note, /unknown check/);
  assert.equal(h.s.start(budget).ok, true);
  assert.equal(h.s.start(budget).ok, false);
  assert.equal(h.said.length, 0, 'nothing spoken until the background loop runs');
});

test('runs on its own timer in the background', async () => {
  const sheet = fakeSheet();
  const said = [];
  const s = new TeachSession({ adapter: sheet.adapter, say: (x) => said.push(x) });
  s.start(budget);
  const deadline = Date.now() + 2000;
  while (!said.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(said, ['Click cell A2.']);
  s.stop();
  assert.equal(s.active, false);
});

test('labelAdapter answers label checks through the Mac app\'s wait request, without screen captures', async () => {
  const calls = [];
  const bridge = { request: async (type, p) => { calls.push({ type, ...p }); return { ok: true, found: p.target === 'Wi-Fi', label: 'Wi\u2011Fi' }; } };
  const snap = await labelAdapter(bridge, { app: 'Control Center' }).snapshot({ labels: ['Wi-Fi', 'Bluetooth'] });
  assert.deepEqual(snap.labels, { 'Wi-Fi': true, Bluetooth: false });
  assert.ok(calls.every((c) => c.type === 'wait' && c.useScreen === false && c.app === 'Control Center' && c.match === 'exact'));
});

/* ---------- Oct 3: the lesson that went from step 1 to step 5 after one click ---------- */

test('a label check is the whole label: the Rectangle tool is not the "Rectangle 1" layer', async () => {
  assert.equal(labelFits('Rectangle', 'Rectangle 1'), false, 'the prefix match that skipped the lesson ahead');
  assert.equal(labelFits('Rectangle 1 copy', 'Rectangle 1'), false);
  assert.equal(labelFits('  rectangle  1 ', 'Rectangle 1'), true, 'case and spacing folded');
  assert.equal(labelFits('Wi\u2011Fi', 'wifi'), true);
  assert.equal(labelFits('Save…', 'save'), true);
  assert.equal(labelFits('Text', 'Text tool'), false);
  assert.equal(labelFits('', ''), false);
  assert.equal(labelFits('Rectangle 1 copy', 'Rectangle 1', 'contains'), true, 'label_contains is the explicit loose one');
  assert.equal(labelFits('Rectangle', 'Rectangle 1', 'contains'), false, 'never a label shorter than what was asked for');
  assert.equal(labelFits('Rectangles', 'Rectangle', 'contains'), false, 'whole words');

  // The Mac app answers with what it found; a loose find (an older app) doesn't count.
  const asked = [];
  const bridge = { request: async (type, p) => { asked.push(p); return { ok: true, found: true, via: 'accessibility', label: p.target === 'Text' ? 'Text' : 'Rectangle' }; } };
  const snap = await labelAdapter(bridge).snapshot({ labels: ['Rectangle 1', 'Text'], contains: ['Rect'] });
  assert.deepEqual(snap.labels, { 'Rectangle 1': false, Text: true });
  assert.deepEqual(snap.contains, { Rect: false });
  assert.deepEqual(asked.map((a) => a.match), ['exact', 'exact', 'contains']);
  assert.equal(evalCheck({ kind: 'label_contains', label: 'Rect' }, { contains: { Rect: true } }), true);
  assert.equal(evalCheck({ kind: 'label_present', label: 'Rect' }, { contains: { Rect: true } }), false);
});

test('a label only the screen text shows holds between reads, and only the current step\'s labels are read that way', async () => {
  let t = 0;
  const asked = [];
  const bridge = { request: async (type, p) => { asked.push(p); return p.useScreen ? { ok: true, found: true, via: 'text', label: p.target } : { ok: true, found: false }; } };
  const a = labelAdapter(bridge, { useScreen: true, screenEveryMs: 3000, now: () => t });
  const req = { labels: ['Rectangle 1', 'Later'], screenLabels: ['Rectangle 1'] };
  assert.deepEqual((await a.snapshot(req)).labels, { 'Rectangle 1': true, Later: false });
  t = 500;
  assert.deepEqual((await a.snapshot(req)).labels, { 'Rectangle 1': true, Later: false }, 'no flicker to false on the polls between screen reads');
  t = 4000;
  await a.snapshot(req);
  assert.ok(asked.filter((p) => p.target === 'Later').every((p) => p.useScreen === false), 'a look-ahead label never costs a screen read');
  assert.equal(asked.filter((p) => p.useScreen).length, 2);
});

test('a check already true when the step began never passes it: Echo asks, and takes the user\'s word', async () => {
  const sheet = fakeSheet();
  sheet.labels.add('Rectangle'); // the tool is in the toolbar all along
  const h = harness(sheet);
  h.s.start({ steps: [
    { say: 'Click the Rectangle tool.', check: { kind: 'label_present', label: 'Rectangle' } },
    { say: 'Click cell A2.', check: { kind: 'selection', cell: 'A2' } },
  ] });
  await h.tick(0);
  assert.equal(h.last(), "Click the Rectangle tool. Tell me when you've done it.");
  assert.deepEqual(h.logged.map((e) => e.kind), ['weak_check'], 'noted in the log');
  assert.deepEqual(h.reports, [], 'and never sent to the model, so nothing is read aloud about it');
  sheet.click('C3'); // something on screen changes, as it did 2.8 s into the real step
  sheet.labels.add('Fill');
  await h.settle(); await h.settle();
  assert.equal(h.s.i, 0, 'a change elsewhere is not the step being done');
  await h.s.hear('okay, done');
  assert.equal(h.s.i, 0);
  assert.equal(h.last(), 'Got it.', 'their word passes a step the screen cannot judge (and nothing is claimed about the screen)');
  await h.settle();
  await h.s.hear('I did it');
  assert.match(h.last(), /^Not yet\./, 'a step the screen can judge is still answered from the screen');
});

test('a check that was true passes once the lesson has seen it go away and come back', async () => {
  const sheet = fakeSheet();
  sheet.labels.add('Layers');
  const h = harness(sheet);
  h.s.start({ steps: [{ say: 'Open the Layers panel.', check: { kind: 'label_present', label: 'Layers' } }] });
  await h.tick(0);
  sheet.labels.delete('Layers');
  await h.tick();
  sheet.labels.add('Layers'); // gone for one poll only: a blip, not a change
  await h.settle();
  assert.equal(h.s.active, true);
  sheet.labels.delete('Layers');
  await h.settle();
  sheet.labels.add('Layers');
  await h.settle();
  assert.equal(h.reports.at(-1)?.kind, 'finished');
});

test('no jump ahead on a check that was already true, over one that was, or on a single poll', async () => {
  const steps = [
    { say: 'Click the Rectangle tool.', check: { kind: 'label_present', label: 'Tool on' } },
    { say: 'Drag on the artboard from its top left to its middle.', check: { kind: 'label_present', label: 'Rectangle 1' } },
    { say: 'Click the Text tool.', check: { kind: 'label_present', label: 'Text' } },
  ];
  // The later step's check is already true (the Text tool in the toolbar): it never pulls the lesson ahead.
  let sheet = fakeSheet();
  sheet.labels.add('Text');
  let h = harness(sheet);
  h.s.start({ steps });
  await h.tick(0);
  sheet.click('B2');
  await h.settle(); await h.settle();
  assert.equal(h.s.i, 0, 'still on step 1');

  // A step in between whose check was already true can't be jumped over.
  sheet = fakeSheet();
  sheet.labels.add('Rectangle 1');
  h = harness(sheet);
  h.s.start({ steps });
  await h.tick(0);
  sheet.labels.add('Text');
  await h.settle(); await h.settle();
  assert.equal(h.s.i, 0, 'step 2 was never seen being done');

  // The step being watched was itself already true: no jump from it either.
  sheet = fakeSheet();
  sheet.labels.add('Tool on');
  h = harness(sheet);
  h.s.start({ steps });
  await h.tick(0);
  sheet.labels.add('Rectangle 1');
  await h.settle(); await h.settle();
  assert.equal(h.s.i, 0);

  // Every check false to begin with: a later step done another way still rolls on, after two polls.
  sheet = fakeSheet();
  h = harness(sheet);
  h.s.start({ steps });
  await h.tick(0);
  sheet.labels.add('Rectangle 1');
  await h.tick();
  assert.equal(h.s.i, 0, 'one poll is not enough');
  await h.tick();
  assert.equal(h.s.i, 1);
  assert.equal(h.last(), 'That works too.');
});

test('a told step waits for the user to say so, and the step after it can still be seen done', async () => {
  const sheet = fakeSheet();
  const h = harness(sheet);
  h.s.start({ steps: [
    { say: 'Click the Rectangle tool.', check: { kind: 'told' } },
    { say: 'Click cell A2.', check: { kind: 'selection', cell: 'A2' } },
    { say: 'Click cell A3.', check: { kind: 'selection', cell: 'A3' } },
  ] });
  await h.tick(0);
  assert.equal(h.last(), "Click the Rectangle tool. Tell me when you've done it.");
  assert.deepEqual(h.logged, [], 'asking on purpose is not a weak check');
  sheet.labels.add('Anything');
  await h.settle();
  assert.equal(h.s.i, 0);
  await h.s.hear('done');
  await h.settle();
  assert.equal(h.last(), 'Click cell A2.');
  await h.s.hear('back');
  sheet.click('A2'); // they carried on without saying so
  await h.settle();
  assert.equal(h.last(), 'Click cell A3.', 'the next step seen done carries the lesson past the told one');
});

test('a plan with small problems is mended, not sent back; only one that cannot run is refused', () => {
  assert.deepEqual(splitSay('Click A2 and then type Coffee.'), ['Click A2.', 'Type Coffee.']);
  assert.deepEqual(splitSay('Click B2. Type 4, then press Return.'), ['Click B2.', 'Type 4, then press Return.']);
  assert.deepEqual(splitSay('Select the layer; open the Object menu'), ['Select the layer.', 'Open the Object menu.']);
  assert.deepEqual(splitSay('Click the Rectangle tool, then drag on the middle of the artboard.'), ['Click the Rectangle tool.', 'Drag on the middle of the artboard.']);
  assert.deepEqual(splitSay('Type Coffee, then press Return.'), ['Type Coffee, then press Return.'], 'one action stays whole');

  const r = repairLesson({ goal: 'x', steps: [
    { say: 'Click the Rectangle tool, then drag on the middle of the artboard.', target: 'Rectangle', check: { kind: 'label_present', label: 'Rectangle 1' }, hint: 'Hold the mouse down as you drag.' },
    { say: 'Click Fill in the panel on the right. It is the first box under Appearance, a small square.', check: { kind: 'menu_open' } },
    { say: 'Click the box next to Border.', check: { kind: 'menu_open' } },
  ] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lesson.steps.map((s) => s.say), ['Click the Rectangle tool.', 'Drag on the middle of the artboard.', 'Click Fill in the panel on the right.', 'Click the box next to Border.']);
  assert.deepEqual(r.lesson.steps.map((s) => s.check.kind), ['told', 'label_present', 'menu_open', 'menu_open'], 'the last part keeps the check');
  assert.equal(r.lesson.steps[0].target, 'Rectangle', 'the pointer goes to the first action');
  assert.equal(r.lesson.steps[1].hint, 'Hold the mouse down as you drag.');
  assert.match(r.lesson.steps[2].hint, /^It is the first box/, 'the rest of a long line becomes the hint');
  assert.deepEqual(r.repairs, [{ step: 1, reason: 'split' }, { step: 2, reason: 'trimmed' }, { step: 3, reason: 'kept' }]);
  assert.match(r.note, /step 1 had 2 actions/);
  assert.doesNotMatch(JSON.stringify(r.repairs), /Rectangle|Fill|Border/, 'reasons only, never the step\'s words');

  assert.equal(repairLesson(budget).ok, true, 'the plan the old rules refused for "more than one action"');
  assert.equal(repairLesson(budget).lesson.steps.length, 4);
  assert.equal(repairLesson({ steps: [] }).ok, false);
  assert.equal(repairLesson({ steps: [{ say: 'Click A1.', check: { kind: 'nope' } }] }).ok, false);
  assert.equal(repairLesson({ steps: [{ say: '', check: { kind: 'told' } }] }).ok, false);
  const full = repairLesson({ steps: Array.from({ length: 12 }, () => ({ say: 'Click A2 and then type Coffee.', check: { kind: 'told' } })) });
  assert.equal(full.lesson.steps.length, 12, 'never more than twelve steps: a step that can\'t be split is kept');
  assert.equal(full.ok, true);
  const drag = repairLesson({ steps: [{ say: 'Drag from the middle of the box to the corner.', gesture: 'drag', check: { kind: 'told' } }] });
  assert.equal(drag.ok, true);
  assert.equal(drag.lesson.steps[0].gesture, undefined);
});

test('checks over snapshots', () => {
  const snap = {
    selection: '$B$5:$B$2',
    cells: { A1: { value: 'Item', bold: true }, B1: { value: 'Cost', bold: true }, B2: { value: '12', format: '$#,##0' }, B3: { value: '6', format: '$#,##0' }, B4: { value: '3', format: '$#,##0' } },
    charts: 1,
  };
  assert.equal(evalCheck({ kind: 'selection', range: 'B2:B5' }, snap), true);
  assert.equal(evalCheck({ kind: 'cell_value', cell: 'a1', equals: 'item' }, snap), true);
  assert.equal(evalCheck({ kind: 'cell_value', cell: 'A1', equals: 'item', ci: false }, snap), false);
  assert.equal(evalCheck({ kind: 'cell_value', cell: 'B2', number: 12 }, snap), true);
  assert.equal(evalCheck({ kind: 'bold', range: 'A1:B1' }, snap), true);
  assert.equal(evalCheck({ kind: 'number_format', range: 'B2:B4', like: '$' }, snap), true);
  assert.equal(evalCheck({ kind: 'sorted', range: 'B1:B4', by: 'B', order: 'desc' }, snap), true);
  assert.equal(evalCheck({ kind: 'sorted', range: 'B1:B4', by: 'B', order: 'asc' }, snap), false);
  assert.equal(evalCheck({ kind: 'chart_exists' }, snap), true);
  assert.equal(evalCheck({ kind: 'all_of', checks: [{ kind: 'chart_exists' }, { kind: 'bold', range: 'B2' }] }, snap), false);
  assert.equal(evalCheck({ kind: 'mystery' }, snap), false);
  const step = { check: { kind: 'cell_value', cell: 'A2', equals: 'Coffee' } };
  assert.deepEqual(collateralChanges(step, { cells: {} }, { cells: { A2: { value: 'Coffee' } } }), []);
  assert.equal(collateralChanges(step, { cells: { A1: { value: 'Item' } } }, { cells: { A1: { value: 'Coffee' } } }).length, 1, 'overwriting a filled cell is collateral');
});

test('cell helpers and wording', () => {
  assert.deepEqual(parseA1('$AB$12'), { col: 28, row: 12 });
  assert.equal(colLetters(28), 'AB');
  assert.equal(isCellAddress('B2:B5'), true);
  assert.equal(isCellAddress('Name Box'), false);
  assert.equal(describeCells(['B5', 'B3', 'B4']), 'B3 to B5');
  assert.equal(describeCells(['A1', 'C7']), 'A1 and C7');
  assert.equal(direction('A5', 'C5'), 'two cells to the right');
  assert.equal(direction('A6', 'A5'), 'one cell up');
  assert.equal(direction('A1', 'B2'), '');
});

test('lesson lint: one action, short, no "next to", no bare "drag"', () => {
  assert.deepEqual(lintSay('Click A2.'), []);
  assert.deepEqual(lintSay('Type Coffee, then press Return.'), []);
  assert.deepEqual(lintSay('Hold Shift and click B5.'), []);
  assert.deepEqual(lintSay('Put the pointer in the middle of B2. Hold and drag down to B5.'), []);
  assert.ok(lintSay('Click the cell next to the 23.').some((p) => /ambiguous/.test(p)));
  assert.ok(lintSay('Drag down to B5.').some((p) => /grab/.test(p)));
  assert.ok(lintSay('Click A2 and then type Coffee.').some((p) => /and then/.test(p)));
  assert.ok(lintSay('Click A2, type Coffee, press Return, then click B2 and type 4 and press Return.').some((p) => /too long/.test(p)));
  assert.ok(lintSay('Select A1, open the Data menu.').some((p) => /more than one action/.test(p)));
  assert.equal(validateLesson(budget).ok, false, 'step 3 has two actions');
  assert.equal(validateLesson({ steps: budget.steps.slice(0, 2) }).ok, true);
});

test('voice command words', () => {
  assert.equal(teachCommand('Repeat.'), 'repeat');
  assert.equal(teachCommand('Echo, show me'), 'show');
  for (const s of ['just do it', 'Do it for me.', 'you do it']) assert.equal(teachCommand(s), 'do', s);
  for (const s of ['Where?', "I can't find it", 'help', 'What?', 'which one']) assert.equal(teachCommand(s), 'stuck', s);
  assert.equal(teachCommand('where is the rectangle tool'), null, 'a real question is the assistant\'s');
  assert.equal(teachCommand('I know this'), 'know');
  assert.equal(teachCommand('skip this one'), 'next');
  assert.equal(teachCommand('Oops!'), 'undo');
  assert.equal(teachCommand('how do I make a chart'), null);
});

test('the assistant\'s teaching rules: one step at a time, cell addresses, no Name Box while teaching', () => {
  const p = computerPrompt({ computerUse: true, pointer: true });
  assert.match(p, /exactly ONE action per turn/);
  assert.match(p, /never "next to"/);
  assert.match(p, /fill handle/);
  assert.match(p, /Name Box.*never while teaching|never while teaching.*Name Box/s);
});
