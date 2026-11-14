// The help ladder in lessons (lib/ladder.js, driven from lib/teach.js): how much help a step gets,
// one rung at a time. More after a failure, less after a success (RESEARCH.md 3.2, rules 13 to 20).
// First the ladder by itself, on a clock passed in; then whole lessons on a fake screen: a learner
// who needs every rung, one who needs none, and one who gets frustrated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('ladder');
const { HelpLadder, RUNG, LADDER_IDLE_MS, LADDER_ASKED_MS, LADDER_FAST_MS } = await import('../lib/ladder.js');
const T = await import('../lib/teach.js');
const { TeachSession, generalPrompt, hintInWords, lastSentence, teachCommand } = T;
const { ComputerUse, computerPrompt } = await import('../lib/computer.js');
const { readTimeline, safeFields } = await import('../lib/timeline.ts');
const { saveSettings } = await import('../lib/settings.js');

/* ---------- the ladder by itself ---------- */

const ALL = { hint: true, point: true, part: true };

test('the rungs, least help to most', () => {
  assert.deepEqual(RUNG, { WAIT: 0, PROMPT: 1, HINT: 2, POINT: 3, DO_PART: 4, DO_IT: 5 });
  assert.deepEqual([LADDER_IDLE_MS, LADDER_ASKED_MS, LADDER_FAST_MS], [12_000, 3000, 8000]);
});

test('every trigger climbs one rung, never more; an unknown one does nothing', () => {
  for (const trigger of ['idle', 'wrong', 'done', 'stuck']) {
    const l = new HelpLadder();
    l.prev = 0;
    l.begin(4, 0, ALL);
    assert.equal(l.rung, 0);
    assert.deepEqual(l.climb(trigger, 100), { from: 0, to: 1, trigger, quiet: false }, trigger);
    assert.deepEqual(l.climb(trigger, 200), { from: 1, to: 2, trigger, quiet: false }, trigger);
    assert.equal(l.climb(trigger, 300).to, 3, trigger);
  }
  const l = new HelpLadder();
  l.prev = 0;
  l.begin(4, 0, ALL);
  assert.equal(l.climb('sneezed', 100), null);
  assert.equal(l.rung, 0);
});

test('a rung where Echo acts for the user takes two misses or twice the idle time; asking climbs at once', () => {
  const l = new HelpLadder();
  l.begin(0, 0, ALL);
  assert.equal(l.rung, RUNG.POINT);
  assert.equal(l.climb('wrong', 100), null, 'one slip gets its correction, not a takeover');
  assert.equal(l.rung, RUNG.POINT);
  assert.deepEqual(l.climb('done', 200), { from: 3, to: 4, trigger: 'done', quiet: false }, 'the second miss');
  assert.equal(l.climb('wrong', 300), null, 'and the count starts again on the new rung');
  assert.equal(l.climb('stuck', 400).to, RUNG.DO_IT, '"where?" climbs at once');
  assert.equal(l.climb('stuck', 500), null, 'nothing above the top');
  // Idle: 12 s below the point, 24 s from it.
  const m = new HelpLadder();
  m.prev = 3;
  m.begin(2, 0, ALL);
  assert.equal(m.rung, RUNG.HINT);
  assert.equal(m.idleDue(LADDER_IDLE_MS - 1), false);
  assert.equal(m.idleDue(LADDER_IDLE_MS), true);
  assert.equal(m.idleDue(LADDER_IDLE_MS, 5000), false, 'counted from the last thing the user did');
  assert.equal(m.idleDue(LADDER_IDLE_MS + 5000, 5000), true);
  m.climb('idle', LADDER_IDLE_MS);
  assert.equal(m.rung, RUNG.POINT);
  assert.equal(m.idleDue(2 * LADDER_IDLE_MS), false, 'counted afresh from the change of rung, and longer at the point');
  assert.equal(m.idleDue(3 * LADDER_IDLE_MS), true);
});

test('a rung the step cannot give is passed over: no first half, nothing to point at, no hint', () => {
  const l = new HelpLadder();
  l.begin(0, 0, { hint: true, point: true, part: false });
  assert.equal(l.climb('stuck', 1).to, RUNG.DO_IT, 'no first half: from the point straight to doing it');
  const m = new HelpLadder();
  assert.equal(m.begin(0, 0, { hint: true, point: false }), RUNG.HINT, 'nothing to point at: a first step starts with the hint in words');
  assert.equal(m.climb('stuck', 1).to, RUNG.DO_IT);
  const n = new HelpLadder();
  assert.equal(n.begin(0, 0, { hint: false, point: false }), RUNG.PROMPT);
  // Wait, a prompt, then nothing but the offer: that last climb still takes two misses.
  assert.equal(n.climb('wrong', 1), null, 'one typo is not a reason to take over');
  assert.equal(n.idleDue(LADDER_IDLE_MS), false);
  assert.equal(n.climb('wrong', 2).to, RUNG.DO_IT);
  n.prev = 0;
  n.begin(3, 0, { hint: false, point: true });
  assert.deepEqual([n.climb('idle', 1).to, n.climb('idle', 2).to], [RUNG.PROMPT, RUNG.POINT]);
});

test('the start rung over a six-step lesson: the first two at the point, then one rung below where the last was solved', () => {
  const l = new HelpLadder();
  const starts = [];
  // Every step solved on the rung it began on: the help fades a rung a step, down to waiting.
  for (let i = 0; i < 6; i++) {
    starts.push(l.begin(i, i * 60_000, ALL));
    l.solved(i * 60_000 + 20_000);
  }
  assert.deepEqual(starts, [3, 3, 2, 1, 0, 0]);
});

test('fading follows the rung each step was solved on, and a step never begins with Echo acting', () => {
  const l = new HelpLadder();
  const next = (i) => l.begin(i, 0, ALL);
  next(0); l.solved(1); next(1); l.solved(1);
  assert.equal(next(2), RUNG.HINT, 'solved with the point: the next starts with a hint in words');
  l.solved(1);
  assert.equal(next(3), RUNG.PROMPT, 'solved with a hint: the next starts with a general prompt');
  l.climb('stuck', 1); l.climb('stuck', 2);
  assert.equal(l.rung, RUNG.POINT);
  l.solved(3);
  assert.equal(next(4), RUNG.HINT, 'needed the point again: back up a rung from there');
  l.top('do', 1);
  l.left(); // Echo did the step
  assert.equal(next(5), RUNG.POINT, 'after Echo did one, the next is the user\'s, with the light');
  l.climb('stuck', 1);
  assert.equal(l.rung, RUNG.DO_PART);
  l.solved(2);
  assert.equal(next(6), RUNG.POINT);
  // A step begun again (the plan was replaced, "back") earns nothing new.
  assert.equal(next(6), RUNG.POINT);
});

test('"show me" jumps to the top from any rung; frustration does too', () => {
  for (const trigger of ['do', 'frustrated']) {
    const l = new HelpLadder();
    l.prev = 0;
    l.begin(4, 0, ALL);
    assert.deepEqual(l.top(trigger, 50), { from: 0, to: 5, trigger, quiet: false });
    assert.equal(l.top(trigger, 60), null, 'already there');
  }
});

test('after a question Echo waits three seconds before any prompt of its own; the user asking is never held', () => {
  const l = new HelpLadder();
  l.prev = 0;
  l.begin(4, 0, ALL);
  l.asked(20_000);
  assert.equal(l.waiting(20_000 + LADDER_ASKED_MS - 1), true);
  assert.equal(l.idleDue(22_000), false, 'idle long enough, but a question is still in the air');
  assert.equal(l.climb('idle', 22_000), null);
  assert.equal(l.climb('wrong', 22_000), null);
  assert.equal(l.rung, 0);
  assert.equal(l.climb('stuck', 22_000).to, 1, '"where?" is answered at once');
  assert.equal(l.waiting(20_000 + LADDER_ASKED_MS), false);
  assert.equal(l.climb('idle', 23_000).to, 2);
});

test('two fast steps in a row on rung 0 or 1 make Echo say less; so does "I know this"; needing help ends it', () => {
  const l = new HelpLadder();
  l.prev = 1;
  l.begin(4, 0, ALL);
  l.solved(LADDER_FAST_MS);
  assert.equal(l.terse, false, 'one fast step is not a pattern');
  l.begin(5, 100_000, ALL);
  l.solved(100_000 + LADDER_FAST_MS + 1);
  l.begin(6, 200_000, ALL);
  l.solved(200_000 + 1000);
  assert.equal(l.terse, false, 'a slow one in between starts the count again');
  l.begin(7, 300_000, ALL);
  l.solved(300_000 + 1000);
  assert.equal(l.terse, true);
  l.begin(8, 400_000, ALL);
  assert.deepEqual(l.climb('idle', 412_000), { from: 0, to: 1, trigger: 'idle', quiet: true }, 'no prompt unless asked: the rung moves in silence');
  assert.equal(l.terse, true);
  assert.equal(l.climb('idle', 424_000).quiet, false, 'the hint after it is said');
  assert.equal(l.climb('stuck', 425_000).quiet, false);
  assert.equal(l.terse, false, 'they asked for help: Echo says the steps in full again');
  // Fast steps passed with the light on them don't count: the light did the finding.
  const m = new HelpLadder();
  for (let i = 0; i < 2; i++) { m.begin(i, i * 10_000, ALL); m.solved(i * 10_000 + 1000); }
  assert.equal(m.terse, false);
  m.ahead();
  assert.equal(m.terse, true, '"I know this" / "skip"');
  m.begin(2, 0, ALL);
  assert.equal(m.climb('idle', 1).quiet, false, 'a hint is not a prompt');
});

/* ---------- what Echo says on each rung ---------- */

test('rung lines: the step\'s own prompt and hint, else a general one by check kind and the target\'s label', () => {
  assert.equal(generalPrompt({ say: 'x', prompt: 'Have a look along the left edge.', check: { kind: 'told' } }), 'Have a look along the left edge.');
  assert.equal(generalPrompt({ say: 'Click cell A2.', check: { kind: 'selection', cell: 'A2' } }), 'Have a look at the sheet. Which cell is it?');
  assert.equal(generalPrompt({ say: 'Open File.', check: { kind: 'menu_open' } }), 'Have a look along the menu bar.');
  assert.equal(generalPrompt({ say: 'Click Dark.', check: { kind: 'element_state', label: 'Dark', selected: true } }), 'What do you think comes next?');
  for (const kind of T.CHECK_KINDS) {
    const line = generalPrompt({ say: 'Click the Rectangle tool.', target: 'Rectangle', check: { kind, label: 'Rectangle', cell: 'B7', app: 'Notes' } });
    assert.ok(line.split(' ').length <= 10, `${kind}: short`);
    assert.doesNotMatch(line, /Rectangle|B7|Notes/, `${kind}: never the answer`);
  }
  assert.equal(hintInWords({ say: 'x', hint: "It's the square icon, second from the top.", target: 'Rectangle' }), "It's the square icon, second from the top.");
  assert.equal(hintInWords({ say: 'Click the Rectangle tool.', target: 'Rectangle' }), 'Look for Rectangle.');
  assert.equal(hintInWords({ say: 'Export it.', target: 'PDF…', route: ['File', 'Export', 'PDF…'] }), 'Look for File, then Export, then PDF….');
  assert.equal(hintInWords({ say: 'Click A2.', hint: 'Click A2.' }), '', 'a hint that only repeats the step is no hint');
  assert.equal(hintInWords({ say: 'Tell me when.', check: { kind: 'told' } }), '');
  assert.equal(lastSentence('Click B2. Type 4, then press Return.'), 'Type 4, then press Return.');
  assert.equal(lastSentence('Click Dark.'), 'Click Dark.');
});

test('the words that climb: stuck, show me, just do it, I know this; "do the rest" still hands the rest over', () => {
  for (const s of ['Where?', "I can't find it.", 'Help.', 'What?', 'Which one?', "I'm stuck"]) assert.equal(teachCommand(s), 'stuck', s);
  assert.equal(teachCommand('Show me.'), 'show');
  for (const s of ['Just do it.', 'Do it for me', 'Okay, just do it for me please']) assert.equal(teachCommand(s), 'do', s);
  for (const s of ['I know this.', 'I know how to do this', 'I already know this']) assert.equal(teachCommand(s), 'know', s);
  assert.equal(teachCommand('Show me the whole lesson.'), 'show_all');
  assert.equal(teachCommand('just do the rest'), 'do_all');
  for (const s of ["This isn't working.", "Why can't you see it?", 'I give up']) assert.equal(teachCommand(s), 'help', s);
  assert.equal(teachCommand('What was that?'), 'repeat');
  assert.equal(teachCommand('where is the rectangle tool'), null, 'a real question still goes to the assistant');
});

/* ---------- whole lessons on a fake screen ---------- */

/** Six steps in a settings window: each turns one named control on. Step 5 has a first half Echo may do. */
const lesson = () => ({
  title: 'Six switches',
  steps: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo Bay', 'Foxtrot'].map((name, k) => ({
    say: `Open the panel. Turn on ${name}.`,
    target: name,
    prompt: `Have a look down the ${k % 2 ? 'right' : 'left'} side.`,
    hint: `${name} is the ${['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][k]} switch from the top.`,
    ...(k === 4 ? { first_half: 'Open the panel.' } : {}),
    check: { kind: 'element_state', label: name, selected: true },
    near_miss: [{ check: { kind: 'element_state', label: 'Zulu', selected: true }, say: "That's Zulu." }],
  })),
});

/** A lesson on a fake clock and a fake screen. `on(name)` is the user turning that control on. */
function harness(plan = lesson()) {
  let t = 1_000_000;
  const screen = {};
  const said = [], reports = [], rungs = [], points = [], released = [];
  const adapter = {
    async snapshot({ elements = [] }) {
      return { cells: {}, ui: { app: 'Settings' }, elements: Object.fromEntries(elements.map((l) => [l, { present: true, selected: Boolean(screen[l]) }])) };
    },
  };
  const s = new TeachSession({
    adapter,
    id: 'L',
    say: (x) => said.push(x),
    point: (target, step, stepId) => points.push({ target, stepId }),
    release: (stepId, outcome) => released.push({ stepId, outcome }),
    report: (r) => reports.push(r),
    log: (e) => { if (e.kind === 'rung') rungs.push({ step: e.step, from: e.from, rung: e.rung, trigger: e.trigger }); },
    now: () => t,
    autoPoll: false,
  });
  s.start(plan);
  const h = {
    s, screen, said, reports, rungs, points, released,
    async tick(ms = T.TEACH_POLL_MS) { t += ms; await s.poll(); },
    /** The user does the step `ms` after it was given: seen, held two polls, praised, and the next step given. */
    async solve(name, ms = 1000) {
      await h.tick(ms);
      screen[name] = true;
      for (let k = 0; k < 4; k++) await h.tick();
    },
    on(name) { screen[name] = true; },
    last: () => said.at(-1),
    /** What the ladder logged for one step: "from>to trigger". */
    moves: (step) => rungs.filter((r) => r.step === step).map((r) => `${r.from}>${r.rung} ${r.trigger}`),
  };
  return h;
}

test('a learner who needs none: the help fades a rung a step, then the lines get shorter', async () => {
  const h = harness();
  await h.tick(0);
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo Bay', 'Foxtrot'];
  const lines = [];
  for (const name of names) {
    lines.push(h.last());
    await h.solve(name);
  }
  assert.deepEqual(lines, [
    'Open the panel. Turn on Alpha.',
    'Open the panel. Turn on Bravo.',
    'Open the panel. Turn on Charlie. Charlie is the third switch from the top.',
    'Open the panel. Turn on Delta. Have a look down the right side.',
    'Open the panel. Turn on Echo Bay.',
    'Turn on Foxtrot.',
  ], 'point, point, hint in words, a prompt, nothing, and then only the last sentence');
  assert.deepEqual(h.rungs.filter((r) => r.trigger === 'start').map((r) => r.rung), [3, 3, 2, 1, 0, 0]);
  assert.deepEqual(h.rungs.filter((r) => r.trigger !== 'start'), [], 'no climbing at all');
  assert.deepEqual(h.points.map((p) => p.target), ['Alpha', 'Bravo'], 'the light only where a beginner needs it');
  assert.deepEqual(h.released.map((r) => r.outcome), ['done', 'done'], 'and it is let go each time');
  assert.equal(h.s.ladder.terse, true);
  assert.equal(h.reports.at(-1).kind, 'finished');
  assert.deepEqual(h.reports.map((r) => r.kind), ['finished'], 'the model was never called');
});

test('a learner who is ahead gets no prompt unless they ask', async () => {
  const h = harness();
  await h.tick(0);
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo Bay']) await h.solve(name);
  assert.equal(h.last(), 'Turn on Foxtrot.');
  const n = h.said.length;
  await h.tick(LADDER_IDLE_MS);
  assert.equal(h.said.length, n, 'the prompt rung passes in silence');
  assert.deepEqual(h.moves(6), ['0>0 start', '0>1 idle']);
  await h.s.hear('where?');
  assert.equal(h.last(), 'Foxtrot is the sixth switch from the top.', 'asked: the next rung, at once');
  assert.equal(h.s.ladder.terse, false);
});

test('"I know this" and "skip" make Echo say less', async () => {
  const h = harness();
  await h.tick(0);
  const n = h.said.length;
  assert.equal(h.s.takes('I know this'), 'know');
  await h.s.hear('I know this');
  assert.equal(h.said.length, n, 'nothing is said back');
  assert.equal(h.s.i, 0, 'and the step is still theirs to do');
  await h.solve('Alpha');
  assert.equal(h.last(), 'Turn on Bravo.');
  const g = harness();
  await g.tick(0);
  await g.s.hear('skip');
  assert.equal(g.last(), 'Turn on Bravo.');
  assert.deepEqual(g.released.map((r) => r.outcome), ['skipped']);
});

test('a learner who needs every rung: prompt, hint, the light, the first half, then the offer, one at a time and each said once', async () => {
  const h = harness();
  await h.tick(0);
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await h.solve(name, 10_000);
  assert.equal(h.s.i, 4);
  assert.equal(h.last(), 'Open the panel. Turn on Echo Bay.', 'rung 0: the step, once');
  const from = h.said.length;
  assert.equal(h.s.held, '', 'no light: they find it themselves');

  await h.tick(LADDER_IDLE_MS - 1000);
  assert.equal(h.said.length, from, 'Echo waits');
  await h.tick(1000);
  assert.equal(h.last(), 'Have a look down the left side.', 'rung 1: a prompt that does not give the answer');
  await h.tick(LADDER_IDLE_MS);
  assert.equal(h.last(), 'Echo Bay is the fifth switch from the top.', 'rung 2: where it is, in words');
  assert.equal(h.points.length, 2, 'still no light');
  await h.tick(LADDER_IDLE_MS);
  assert.equal(h.last(), "It's here. Your turn.", 'rung 3: the light');
  assert.equal(h.points.at(-1).target, 'Echo Bay');
  assert.notEqual(h.s.held, '', 'and it holds');
  const held = h.s.held;

  await h.tick(LADDER_IDLE_MS);
  assert.equal(h.last(), "It's here. Your turn.", 'before acting for them Echo waits twice as long');
  await h.tick(LADDER_IDLE_MS);
  assert.equal(h.last(), "I'll start this one. Watch.", 'rung 4: the first half');
  assert.equal(h.reports.at(-1).kind, 'do_part');
  assert.match(h.reports.at(-1).note, /Do ONLY this first part.*: Open the panel\. Say what you did in a few words, then call lesson_control with action "resume"/s);
  assert.equal(h.s.phase, 'paused', 'the lesson does not watch while Echo acts');
  assert.deepEqual(h.released.at(-1), { stepId: held, outcome: 'stopped' }, 'the light is let go while it does');
  await h.s.hear('go on'); // lesson_control resume, once the assistant has done the first half
  assert.equal(h.last(), 'Your turn.', 'the rest is handed back, not the whole step again');
  assert.notEqual(h.s.held, '', 'with the light on it');

  await h.tick(2 * LADDER_IDLE_MS);
  assert.equal(h.last(), 'Want me to do this step for you?', 'rung 5: never taken over without asking');
  assert.deepEqual(h.moves(5), ['0>0 start', '0>1 idle', '1>2 idle', '2>3 idle', '3>4 idle', '4>5 idle']);
  const lines = h.said.slice(from - 1);
  assert.equal(new Set(lines).size, lines.length, 'nothing is said twice');
  await h.tick(LADDER_IDLE_MS * 2);
  assert.equal(h.last(), 'Want me to do this step for you?', 'and the top is the top: no more nudges');

  await h.s.hear('yes');
  assert.equal(h.last(), "I'll turn on Echo Bay.", 'what Echo is about to do, before it does it');
  assert.equal(h.reports.at(-1).kind, 'show_step');
  h.on('Echo Bay');
  await h.s.next(); // lesson_control skip, once the assistant has done the step
  await h.tick(T.SHOW_PACE.sitMs);
  assert.equal(h.last(), 'Echo Bay is selected.', 'the result sat, then what changed');
  await h.tick(T.TEACH_PRAISE_MS);
  assert.equal(h.last(), 'Your turn on the next one?');
  await h.tick(10_000);
  assert.equal(h.s.i, 5, 'the lesson moves on');
  assert.equal(h.last(), 'Open the panel. Turn on Foxtrot.', 'in full: being done for is not being ahead');
  assert.deepEqual(h.moves(6), ['3>3 start'], 'after Echo did one, the next is theirs, with the light');
  assert.equal(h.points.at(-1).target, 'Foxtrot');
});

test('a wrong try the check can see climbs a rung; so does "done" when it is not; "where?" climbs at once', async () => {
  const h = harness();
  await h.tick(0);
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await h.solve(name, 10_000);
  h.on('Zulu');
  await h.tick();
  assert.equal(h.last(), "That's Zulu.", 'the correction is the help: no prompt on top of it');
  assert.deepEqual(h.moves(5), ['0>0 start', '0>1 wrong']);
  await h.s.hear('done');
  assert.match(h.last(), /^Not yet\. I don't see it on screen\./, '"done" still gets what Echo sees');
  assert.deepEqual(h.moves(5).at(-1), '1>2 done');
  assert.equal(h.points.length, 2, 'no light yet');
  await h.s.hear("I can't find it");
  assert.equal(h.last(), "It's here. Your turn.");
  assert.deepEqual(h.moves(5).at(-1), '2>3 stuck');
  assert.equal(h.points.at(-1).target, 'Echo Bay');
  await h.solve('Echo Bay');
  assert.equal(h.last(), 'Open the panel. Turn on Foxtrot. Foxtrot is the sixth switch from the top.', 'solved with the light: the next starts with the hint in words');
});

test('"show me" goes straight to Echo doing that step, from any rung, with no offer', async () => {
  const h = harness();
  await h.tick(0);
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await h.solve(name, 10_000);
  await h.s.hear('show me');
  assert.equal(h.last(), "I'll turn on Echo Bay.");
  assert.deepEqual(h.moves(5), ['0>0 start', '0>5 do']);
  assert.deepEqual(h.reports.map((r) => r.kind), ['show_step']);
  assert.match(h.reports[0].note, /exactly this ONE step/);
});

test('a learner who gets frustrated: a few words that say Echo heard, the offer, and on yes Echo does the step', async () => {
  const h = harness();
  await h.tick(0);
  await h.solve('Alpha');
  h.on('Zulu');
  await h.tick();
  assert.equal(h.last(), "That's Zulu.", 'one slip with the light on it: the correction, and no offer yet');
  assert.deepEqual(h.moves(2), ['3>3 start']);
  await h.s.hear("This isn't working.");
  assert.equal(h.last(), "That one's fiddly. Want me to do it?");
  assert.deepEqual(h.moves(2), ['3>3 start', '3>5 frustrated']);
  assert.deepEqual(h.reports, [], 'no model call to say so');
  const n = h.said.length;
  await h.tick(1000);
  h.screen.Zulu = false;
  await h.tick(1000);
  await h.tick(LADDER_IDLE_MS * 2);
  assert.equal(h.said.length, n, 'and Echo waits for the answer');
  await h.s.hear('yeah');
  assert.equal(h.last(), "I'll turn on Bravo.");
  assert.equal(h.reports.at(-1).kind, 'show_step');
  assert.equal(h.s.held, '', 'the light is let go while Echo does it');
  h.on('Bravo');
  await h.s.next();
  await h.tick(T.SHOW_PACE.sitMs);
  await h.tick(T.TEACH_PRAISE_MS);
  await h.s.hear('okay'); // "Your turn on the next one?"
  assert.equal(h.last(), 'Open the panel. Turn on Charlie.');
  assert.deepEqual(h.moves(3), ['3>3 start']);
  // Frustrated again once the offer has been made on a step: Echo just does it.
  await h.s.hear('I give up');
  await h.s.hear("why can't you do it");
  assert.equal(h.reports.at(-1).step, 3);
  assert.deepEqual(h.reports.map((r) => r.kind), ['show_step', 'do_step'], '"you do it": that one at full speed');
});

test('after Echo asks something, a correction waits three seconds', async () => {
  const h = harness();
  await h.tick(0);
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await h.solve(name, 10_000);
  const plain = h.s.steps[4];
  delete plain.prompt; // the general prompt for this kind of step is a question
  await h.tick(LADDER_IDLE_MS);
  assert.equal(h.last(), 'What do you think comes next?');
  h.on('Zulu');
  await h.tick(1000);
  await h.tick(1000);
  assert.equal(h.last(), 'What do you think comes next?', 'Echo lets the question sit');
  await h.tick(1000);
  assert.equal(h.last(), "That's Zulu.");
});

/* ---------- the tool, the log and the timeline ---------- */

test('the teach tool logs every rung change with its number and trigger, to the lesson log and the timeline, never the words', async () => {
  saveSettings({ pointer: true, computerUse: false });
  const shown = { Dark: { present: true, selected: false } };
  const bridge = {
    native: true,
    async request(kind, p) {
      if (kind === 'state') return { ok: true, app: 'System Settings', elements: Object.fromEntries((p.labels || []).map((l) => [l, shown[l] || { present: false }])) };
      if (kind === 'wait' || kind === 'point') return { ok: true, found: Boolean(shown[p.target]), label: p.target };
      return { ok: true };
    },
  };
  const c = new ComputerUse({ bridge: /** @type {any} */ (bridge), logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const said = [];
  c.on('say', (t) => said.push(t));
  const r = await c.startLesson({ goal: 'turn on dark mode', steps: [
    { say: 'Click Dark.', target: 'Dark', prompt: 'Have a look near the top.', hint: 'Dark is the middle picture of three.', first_half: 'Open Appearance.', check: { kind: 'element_state', label: 'Dark', selected: true } },
  ] });
  assert.equal(r.started, true, JSON.stringify(r));
  await c.lesson.poll();
  assert.deepEqual(said, ['Click Dark.']);
  assert.equal(c.isLessonCommand('where?'), true, 'the lesson takes it: no model turn');
  await c.hearLesson('where?');
  assert.equal(said.at(-1), "I'll start this one. Watch.");
  await c.controlLesson({ action: 'resume' });
  assert.equal(said.at(-1), 'Your turn.');
  await c.hearLesson("this isn't working");
  await c.hearLesson('yes');
  assert.equal(said.at(-1), "I'll click Dark.");
  shown.Dark.selected = true;
  assert.equal((await c.controlLesson({ action: 'skip' })).skipped, true);
  await until(() => !c.lesson.active, 6000, 'Echo did the last step: once the result has sat, the lesson is over');
  assert.deepEqual(said.slice(-1), ['Dark is selected.'], 'what changed, and then nothing (one step is no recap)');

  const log = fs.readFileSync(path.join(dirs.data, 'lesson-log.jsonl'), 'utf8');
  const rungs = log.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'rung');
  assert.deepEqual(rungs.map((e) => [e.step, e.from, e.rung, e.trigger]), [[1, 3, 3, 'start'], [1, 3, 4, 'stuck'], [1, 4, 5, 'frustrated']]);
  assert.doesNotMatch(log, /where|working|Appearance|middle picture|near the top/, 'never what was said, by either side');
  const rows = readTimeline(dirs.data).filter((e) => e.type === 'lesson.rung');
  assert.deepEqual(rows.map((e) => e.f), [
    { step: 1, rung: 3, from: 3, trigger: 'start' },
    { step: 1, rung: 4, from: 3, trigger: 'stuck' },
    { step: 1, rung: 5, from: 4, trigger: 'frustrated' },
  ]);
  assert.deepEqual(safeFields('lesson.rung', { step: 2, rung: 1, from: 0, trigger: 'idle', say: 'Click Dark.', target: 'Dark' }), { step: 2, rung: 1, from: 0, trigger: 'idle' }, 'the timeline takes nothing else');
});

test('the teach tool\'s step takes a prompt, a hint and a first half, and the guidance says the lesson gives the help itself', async () => {
  const src = fs.readFileSync(new URL('../lib/tools/computer.js', import.meta.url), 'utf8');
  const step = src.slice(src.indexOf('const lessonStep'), src.indexOf('The dispatcher\'s computer-use'));
  for (const field of ['prompt', 'hint', 'first_half']) assert.match(step, new RegExp(`\\n  ${field}: z\\.string\\(\\)\\.optional\\(\\)`), field);
  const p = computerPrompt({ computerUse: true, pointer: true });
  assert.match(p, /one rung at a time/);
  assert.match(p, /"do_part", do only the first half it names.*lesson_control resume/);
});
