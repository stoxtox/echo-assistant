// Show me, the story, and fading (lib/teach.js, lib/ladder.js, lib/lessonnotes.js; RESEARCH.md
// 3.1, 3.3 to 3.5, 3.8 and rules 8 to 10, 14 to 20). First the decisions by themselves: may the
// story be told, what a voice command does to the lesson's mode, when Echo says less, and where
// the next lesson in an app starts. Then whole lessons on a fake screen and a fake clock: one Echo
// shows, one the user does with a story in it, and a fast learner who hears almost nothing.
// Nothing here touches a real app, a screen or a voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('teachmore');
const { HelpLadder, RUNG, LADDER_EASY_RUN } = await import('../lib/ladder.js');
const T = await import('../lib/teach.js');
const { TeachSession, mayTellStory, modeAfter, teachCommand, intentLine, sawLine, seenLine, recapLine, spokenMs, repairLesson, SHOW_PACE, TEACH_STORY_QUIET_MS, TEACH_PRAISE_MS, TEACH_OFFER_MS } = T;
const { lessonNote, saveLessonNote, startsLower, medianRung, NOTE_DAYS } = await import('../lib/lessonnotes.js');
const { ComputerUse, computerPrompt } = await import('../lib/computer.js');
const { computerTools } = await import('../lib/tools/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { readTimeline } = await import('../lib/timeline.ts');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

/* ---------- the story gate ---------- */

test('the story is told only right after a step the user did, or one Echo showed', () => {
  const why = 'That box is the button people will press.';
  assert.equal(mayTellStory({ why, by: 'user', rung: 0 }), true);
  assert.equal(mayTellStory({ why, by: 'user', rung: RUNG.POINT }), true, 'the light is still their own doing');
  assert.equal(mayTellStory({ why, by: 'shown', rung: 0 }), true, 'after Echo\'s demonstration of it');
  assert.equal(mayTellStory({ why, by: 'echo' }), false, '"just do it" is not watching');
  assert.equal(mayTellStory({ why, by: 'skipped' }), false);
  assert.equal(mayTellStory({ why: '' }), false, 'no story, nothing to tell');
});

test('the story is dropped when they are struggling, frustrated, ahead, or heard one a moment ago', () => {
  const why = 'Bold is how a header says "I am not data".';
  assert.equal(mayTellStory({ why, rung: RUNG.DO_PART }), false, 'solved on rung 4: Echo did half');
  assert.equal(mayTellStory({ why, rung: RUNG.DO_IT }), false, 'solved on rung 5: Echo did it');
  assert.equal(mayTellStory({ why, by: 'shown', rung: RUNG.DO_IT }), false, 'shown because they were stuck');
  assert.equal(mayTellStory({ why, frustrated: true }), false);
  assert.equal(mayTellStory({ why, ahead: true }), false, 'fast and terse: they want the next step');
  assert.equal(mayTellStory({ why, since: 1 }), false, 'one was told on the last step');
  assert.equal(mayTellStory({ why, since: 2 }), false, 'and within the last two');
  assert.equal(mayTellStory({ why, since: 3 }), true, 'at most one in three steps');
  assert.equal(mayTellStory({ why, again: true }), false, 'never twice');
  assert.equal(mayTellStory({ why: 'x'.repeat(T.TEACH_WHY_MAX) }), true);
  assert.equal(mayTellStory({ why: 'x'.repeat(T.TEACH_WHY_MAX + 1) }), false, 'more than one breath');
});

/* ---------- the mode ---------- */

test('plain words change the mode: show me, let me try, just do it, do the rest', () => {
  assert.deepEqual(T.LESSON_MODES, ['guide', 'show', 'do']);
  assert.equal(teachCommand('Show me.'), 'show');
  for (const s of ['Show me the whole lesson.', 'show me the rest', 'Just show me the whole thing', 'keep showing', 'show me everything']) assert.equal(teachCommand(s), 'show_all', s);
  for (const s of ['let me try', 'Let me do it.', "I'll try", 'my turn', 'I want to try', 'guide me']) assert.equal(teachCommand(s), 'try', s);
  for (const s of ['just do it', 'do it for me', 'you do it']) assert.equal(teachCommand(s), 'do', s);
  for (const s of ['do the rest', 'do it all', 'just do everything']) assert.equal(teachCommand(s), 'do_all', s);
  // One step shown or done leaves the mode alone; the rest change it, from any mode.
  for (const mode of T.LESSON_MODES) {
    assert.equal(modeAfter(mode, 'show'), mode);
    assert.equal(modeAfter(mode, 'do'), mode);
    assert.equal(modeAfter(mode, 'repeat'), mode);
    assert.equal(modeAfter(mode, null), mode);
    assert.equal(modeAfter(mode, 'show_all'), 'show');
    assert.equal(modeAfter(mode, 'do_all'), 'do');
    assert.equal(modeAfter(mode, 'try'), 'guide');
  }
});

/* ---------- saying less ---------- */

const ALL = { hint: true, point: true, part: true };

test('three steps in a row passed with no more than a prompt, and Echo says less, until a step needs a hint or more', () => {
  assert.equal(LADDER_EASY_RUN, 3);
  const l = new HelpLadder();
  // Slow enough that the user is never "ahead": this is about help, not speed.
  const step = (i, climbs = 0) => {
    l.begin(i, i * 60_000, ALL);
    for (let k = 0; k < climbs; k++) l.climb('stuck', i * 60_000 + 1000 + k);
    l.solved(i * 60_000 + 30_000);
  };
  step(0); step(1); step(2);
  assert.equal(l.sayLess, false, 'the first steps were solved with the light, then a hint');
  step(3); step(4);
  assert.equal(l.sayLess, false, 'two easy ones are not three');
  step(5);
  assert.equal(l.sayLess, true);
  assert.equal(l.terse, false, 'not fast, just needing little');
  l.begin(6, 0, ALL);
  l.climb('stuck', 1);
  assert.equal(l.sayLess, true, 'a prompt is still little help');
  l.climb('stuck', 2);
  assert.equal([l.rung, l.sayLess].join(), '2,false', 'a hint: back to saying everything');
  l.solved(3);
  step(7); step(8);
  assert.equal(l.sayLess, false, 'and the count starts again');
  step(9); step(10);
  assert.equal(l.sayLess, true);
  // Time passing on a step that needed two rungs counts too.
  l.begin(11, 0, ALL);
  l.climb('idle', 20_000); l.climb('idle', 40_000);
  assert.equal(l.sayLess, false);
});

/* ---------- across lessons ---------- */

test('the next lesson in an app starts lower only when the last one there went well and was not long ago', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const at = (days) => new Date(now - days * 24 * 3600 * 1000).toISOString();
  assert.equal(startsLower({ medianRung: 2, at: at(1) }, now), true);
  assert.equal(startsLower({ medianRung: 0, at: at(29) }, now), true);
  assert.equal(startsLower({ medianRung: 3, at: at(1) }, now), false, 'they needed the light on most steps');
  assert.equal(startsLower({ medianRung: 5, at: at(1) }, now), false, 'Echo did it for them');
  assert.equal(startsLower({ medianRung: 1, at: at(NOTE_DAYS) }, now), false, 'thirty days on, it says nothing about them');
  assert.equal(startsLower(null, now), false);
  assert.equal(startsLower({ at: at(1) }, now), false);
  assert.deepEqual([medianRung([3, 3, 2, 1, 0]), medianRung([5, 0]), medianRung([4]), medianRung([])], [2, 0, 4, 0]);
});

test('the start rungs with a head start: the first two a rung lower; after watching, every step', () => {
  const starts = (ladder, n = 5) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(ladder.begin(i, i * 60_000, ALL));
      ladder.solved(i * 60_000 + 30_000);
    }
    return out;
  };
  assert.deepEqual(starts(new HelpLadder()), [3, 3, 2, 1, 0], 'a first lesson');
  assert.deepEqual(starts(new HelpLadder({ lowerSteps: T.TEACH_KNOWN_STEPS })), [2, 2, 1, 0, 0], 'an app they did well in');
  assert.deepEqual(starts(new HelpLadder({ lowerSteps: Infinity })), [2, 2, 0, 0, 0], 'a lesson they have just watched');
});

test('the note kept per app is a few numbers, replaced by the next lesson there, and gone after 30 days', () => {
  const file = path.join(dirs.data, 'lesson-notes.json');
  const now = Date.now();
  saveLessonNote({ app: 'Adobe XD', steps: 6, medianRung: 2, shown: false }, now);
  saveLessonNote({ app: 'Numbers', steps: 4, medianRung: 4, shown: true }, now);
  assert.deepEqual(lessonNote('adobe xd', now), { app: 'adobe xd', steps: 6, medianRung: 2, shown: false, at: new Date(now).toISOString() });
  assert.equal(startsLower(lessonNote('Adobe XD', now), now), true);
  assert.equal(startsLower(lessonNote('Numbers', now), now), false);
  assert.equal(lessonNote('Keynote', now), null);
  saveLessonNote({ app: 'Adobe XD', steps: 5, medianRung: 4, shown: true }, now + 1000);
  assert.equal(lessonNote('Adobe XD', now + 1000)?.medianRung, 4, 'the latest lesson there is the one that counts');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 2);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).sort(), ['app', 'at', 'medianRung', 'shown', 'steps'], 'never what the lesson was about');
  const later = now + (NOTE_DAYS + 1) * 24 * 3600 * 1000;
  assert.equal(lessonNote('Adobe XD', later), null, 'expired');
  saveLessonNote({ app: 'Keynote', steps: 3, medianRung: 1, shown: false }, later);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((n) => n.app), ['keynote'], 'and old notes are cleared out on the next save');
  // It lives in Echo's data folder, which "Reset Echo" empties.
  assert.equal(path.dirname(file), dirs.data);
  fs.rmSync(file);
});

/* ---------- the lines ---------- */

test('the line of intent is the step turned from an instruction into what Echo is about to do', () => {
  assert.equal(intentLine({ say: 'Select the top row.' }), "I'll select the top row.");
  assert.equal(intentLine({ say: 'Top left, click the square icon.' }), "Top left, I'll click the square icon.");
  assert.equal(intentLine({ say: 'Open the panel. Turn on Alpha.' }), "I'll turn on Alpha.");
  assert.equal(intentLine({ say: 'Double-click the layer name.' }), "I'll double-click the layer name.");
  assert.equal(intentLine({ say: 'Click your network.' }), "I'll click the network.");
  assert.equal(intentLine({ say: 'Rectangle time!' }), "I'll do this one.", 'no verb Echo knows: nothing clever');
});

test('a small win is said from what the check saw, not a fixed word', () => {
  assert.equal(sawLine({ kind: 'cell_value', cell: 'a1', equals: 'Hello' }, { cells: { A1: { value: 'Hello' } } }), 'A1 says Hello.');
  assert.equal(sawLine({ kind: 'label_present', label: 'Rectangle 1' }, {}), "That's the rectangle.");
  assert.equal(sawLine({ kind: 'label_present', label: 'Layers' }, {}), "That's Layers.");
  assert.equal(sawLine({ kind: 'selection', range: 'B2:B5' }, {}), 'B2 to B5 is selected.');
  assert.equal(sawLine({ kind: 'bold', range: 'A1' }, {}), 'A1 is bold now.');
  assert.equal(sawLine({ kind: 'element_state', label: 'Wi-Fi', checked: true }, {}), 'Wi-Fi is on.');
  assert.equal(sawLine({ kind: 'element_state', label: 'Dark', selected: true }, {}), 'Dark is selected.');
  assert.equal(sawLine({ kind: 'window_title', contains: 'Export' }, {}), "That's the Export window.");
  assert.equal(sawLine({ kind: 'told' }, {}), '', 'nothing on screen to name');
  const either = { kind: 'any_of', checks: [{ kind: 'label_present', label: 'Wi-Fi' }, { kind: 'label_present', label: 'Network' }] };
  assert.equal(seenLine(either, { labels: { Network: true } }), "That's Network.", 'the way that passed');
  assert.equal(seenLine(either, { labels: {} }), '', 'a check that does not hold says nothing');
  assert.equal(seenLine(either, { error: 'unseen' }), '');
});

test('the recap is at most three of the things done, each cut to its action', () => {
  assert.equal(recapLine(['Click cell A2.', 'Type Coffee, then press Return.', 'Top left, click Bold.']), 'You did it: click cell A2, then type Coffee, then click Bold.');
  assert.equal(recapLine(['Click A.', 'Click B.', 'Click C.', 'Click D.', 'Click E.']), 'You did it: click A, then click C, then click E.');
  assert.equal(recapLine(['Click A.', 'Click B.'], { watched: true }), 'That was it: click A, then click B.');
  assert.equal(recapLine(['Click A.']), '', 'one step needs no recap');
  assert.equal(recapLine([]), '');
});

test('the teach tool takes a starting mode, an opening, a closing and a why, and says when to pick which', () => {
  const tools = Object.fromEntries(computerTools(/** @type {any} */ ({})).map((t) => [t.name, /** @type {any} */ (t)]));
  const shape = z.object(tools.teach.inputSchema);
  const step = { say: 'Click Dark.', why: 'Dark mode is easier on your eyes at night.', check: { kind: 'told' } };
  assert.equal(shape.safeParse({ goal: 'x', mode: 'show', opening: 'By the end the screen will be dark.', closing: 'Now you can switch any time.', steps: [step] }).success, true);
  assert.equal(shape.safeParse({ goal: 'x', steps: [step] }).success, true, 'all of it optional');
  assert.equal(shape.safeParse({ goal: 'x', mode: 'do', steps: [step] }).success, false, '"do it for me" is not a lesson');
  const text = JSON.stringify(z.toJSONSchema(shape));
  assert.match(text, /at most one step in three/);
  assert.match(text, /never a definition read aloud/);
  const p = computerPrompt({ computerUse: true, pointer: true });
  assert.match(p, /"teach me X" → guide/);
  assert.match(p, /"show me how to X".*→ show/);
  assert.match(p, /"do X for me" → not a lesson at all/);
  assert.match(p, /"show_step".*no say on the tools and without speaking/s);
  // A mended plan keeps them: the story stays with the part that carries the check.
  const mended = repairLesson({ goal: 'x', mode: 'show', opening: 'O', closing: 'C', steps: [{ say: 'Click A2 and then type Coffee.', why: 'W', check: { kind: 'cell_value', cell: 'A2', equals: 'Coffee' } }] }).lesson;
  assert.deepEqual([mended.mode, mended.opening, mended.closing, mended.steps.map((s) => s.why)], ['show', 'O', 'C', [undefined, 'W']]);
});

/* ---------- whole lessons, on a fake screen and a fake clock ---------- */

const WHY = 'Bravo is the one your phone looks for first.';
const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo Bay', 'Foxtrot'];
const lesson = (n = 3, more = {}) => ({
  goal: 'turn the switches on',
  steps: names.slice(0, n).map((name) => ({ say: `Turn on ${name}.`, target: name, check: { kind: 'element_state', label: name, checked: true }, ...(name === 'Bravo' ? { why: WHY } : {}) })),
  ...more,
});

function harness(plan, opts = {}) {
  let t = 1_000_000;
  let screen = {};
  const said = [], reports = [], logged = [], points = [];
  const adapter = {
    async snapshot({ elements = [] }) {
      return { cells: {}, ui: { app: 'Settings' }, elements: Object.fromEntries(elements.map((l) => [l, { present: true, value: screen[l] ? '1' : '0' }])) };
    },
  };
  const s = new TeachSession({
    adapter, id: 'L',
    say: (x) => said.push(x),
    point: (target) => points.push(target),
    report: (r) => reports.push(r),
    log: (e) => logged.push(e),
    now: () => t,
    autoPoll: false,
    ...opts,
  });
  const started = s.start(plan);
  const h = {
    s, said, reports, logged, points, started,
    async tick(ms = T.TEACH_POLL_MS) { t += ms; await s.poll(); },
    on(name) { screen[name] = true; },
    clear() { screen = {}; },
    /** The user does the step `ms` after it was given (by default not fast, and not so slow that Echo helps): seen, held two polls, acknowledged, and what comes next. */
    async solve(name, ms = 10_000) {
      await h.tick(ms);
      screen[name] = true;
      for (let k = 0; k < 4; k++) await h.tick();
    },
    /** The assistant did the step Echo is showing and called lesson_control skip. */
    async shown(name) {
      screen[name] = true;
      await s.next();
    },
    last: () => said.at(-1),
    starts: () => logged.filter((e) => e.kind === 'rung' && e.trigger === 'start').map((e) => e.rung),
    kinds: (kind) => logged.filter((e) => e.kind === kind),
  };
  return h;
}

test('a lesson Echo shows: intent, quiet while it happens, the result sits, what changed; then the offer of a turn', async () => {
  const h = harness(lesson(3, { mode: 'show', opening: 'By the end all three are on.', closing: 'Now you can set this up anywhere.' }));
  assert.match(h.started.note, /asks you to do that one step \(a "show_step" report\)/);
  await h.tick(0);
  assert.deepEqual(h.said, ['By the end all three are on.', "I'll turn on Alpha."], 'the hook once, then what Echo is about to do');
  assert.deepEqual(h.reports.map((r) => [r.kind, r.step]), [['show_step', 1]]);
  assert.match(h.reports[0].note, /exactly this ONE step.*no "say" on them and without speaking.*lesson_control with action "skip"/s);
  assert.equal(h.s.demoing, true);
  assert.equal(h.s.fullSpeed, false);
  assert.equal(h.s.leadLeft(), spokenMs("I'll turn on Alpha.") + SHOW_PACE.leadMs, 'the first movement waits for the line of intent, and a pause');
  assert.deepEqual(h.points, [], 'the lesson\'s own light does not hold a step Echo is doing');
  // The assistant is acting: the lesson says nothing, however long it takes.
  for (let k = 0; k < 8; k++) await h.tick();
  assert.equal(h.said.length, 2, 'nothing is said while the light moves or the step runs');
  assert.equal(h.s.leadLeft(), 0);
  await h.shown('Alpha');
  assert.equal(h.said.length, 2, 'nor the moment it is done: the result sits first');
  await h.tick(SHOW_PACE.sitMs - 100);
  assert.equal(h.said.length, 2);
  await h.tick(100);
  assert.equal(h.last(), 'Alpha is on.', 'one short line of what changed');
  await h.tick(TEACH_PRAISE_MS);
  assert.equal(h.last(), "I'll turn on Bravo.");
  await h.shown('Bravo');
  await h.tick(SHOW_PACE.sitMs);
  assert.equal(h.last(), 'Bravo is on.');
  await h.tick(TEACH_PRAISE_MS);
  assert.equal(h.last(), WHY, 'the story, after Echo\'s demonstration of the step, once the result has sat');
  await h.tick(spokenMs(WHY) + TEACH_STORY_QUIET_MS - 100);
  assert.equal(h.last(), WHY, 'then quiet');
  await h.tick(100);
  assert.equal(h.last(), "I'll turn on Charlie.");
  await h.shown('Charlie');
  await h.tick(SHOW_PACE.sitMs);
  await h.tick(TEACH_PRAISE_MS);
  assert.deepEqual(h.said, [
    'By the end all three are on.',
    "I'll turn on Alpha.", 'Alpha is on.',
    "I'll turn on Bravo.", 'Bravo is on.', WHY,
    "I'll turn on Charlie.", 'Charlie is on.',
    'Want to try it yourself now?',
  ]);
  assert.equal(h.s.active, true, 'the lesson waits for the answer');
  assert.deepEqual(h.reports.map((r) => r.kind), ['show_step', 'show_step', 'show_step']);
  assert.deepEqual(h.starts(), [], 'a step Echo shows is on no rung of help');

  // Yes: from step 1 again, guided, every step a rung lower than a first lesson (they just watched).
  assert.equal(h.s.takes('yeah'), 'retry');
  await h.s.hear('yeah');
  assert.equal(h.reports.at(-1).kind, 'retry');
  assert.match(h.reports.at(-1).note, /started again from step 1/);
  assert.equal(h.s.mode, 'guide');
  h.clear(); // (the assistant put things back, as that report asks)
  await h.tick(0);
  assert.equal(h.last(), 'Turn on Alpha.', 'the step itself now, and no hook a second time');
  assert.deepEqual(h.starts(), [RUNG.HINT], 'a first step starts at the light; this one a rung below');
  assert.deepEqual(h.points, [], 'so no light yet');
  await h.solve('Alpha');
  await h.solve('Bravo');
  assert.equal(h.said.filter((x) => x === WHY).length, 1, 'the story is never told twice');
  await h.solve('Charlie');
  assert.deepEqual(h.starts(), [2, 2, 0]);
  assert.equal(h.last(), 'You did it: turn on Alpha, then turn on Bravo, then turn on Charlie. Now you can set this up anywhere.');
  assert.equal(h.s.active, false);
  assert.match(h.reports.at(-1).note, /Say nothing more/);
  assert.deepEqual(h.s.summary(), { app: 'Settings', steps: 3, medianRung: 2, shown: true });
});

test('after watching, "no" (or no answer) ends the lesson with what they watched and the closing line', async () => {
  for (const answer of ['no thanks', null]) {
    const h = harness(lesson(2, { mode: 'show', closing: 'Now you know where they are.' }));
    await h.tick(0);
    for (const name of ['Alpha', 'Bravo']) {
      await h.shown(name);
      await h.tick(SHOW_PACE.sitMs);
      await h.tick(TEACH_PRAISE_MS);
      // (The story after Bravo, and its quiet.)
      if (name === 'Bravo') await h.tick(spokenMs(WHY) + TEACH_STORY_QUIET_MS);
    }
    assert.equal(h.last(), 'Want to try it yourself now?');
    if (answer) await h.s.hear(answer);
    else {
      await h.tick(TEACH_OFFER_MS);
      assert.equal(h.s.active, true, 'the question is given its time');
      await h.tick(spokenMs('Want to try it yourself now?'));
    }
    assert.equal(h.last(), 'That was it: turn on Alpha, then turn on Bravo. Now you know where they are.', String(answer));
    assert.equal(h.reports.at(-1).kind, 'finished');
    assert.deepEqual(h.s.summary(), { app: 'Settings', steps: 2, medianRung: RUNG.DO_IT, shown: true });
  }
});

test('"show me" on one step: Echo shows it, offers the turn back, and carries on guided unless told to keep showing', async () => {
  const h = harness(lesson(4));
  await h.tick(0);
  assert.equal(h.last(), 'Turn on Alpha.');
  assert.equal(h.s.mode, 'guide');
  await h.s.hear('show me');
  assert.equal(h.last(), "I'll turn on Alpha.");
  assert.equal(h.s.mode, 'guide', 'one step shown is not a change of mode');
  await h.shown('Alpha');
  await h.tick(SHOW_PACE.sitMs);
  await h.tick(TEACH_PRAISE_MS);
  assert.deepEqual(h.said.slice(-2), ['Alpha is on.', 'Your turn on the next one?']);
  // No answer: three seconds past the question, the next step is theirs.
  await h.tick(spokenMs('Your turn on the next one?') + 2900);
  assert.equal(h.last(), 'Your turn on the next one?');
  await h.tick(100);
  assert.equal(h.last(), 'Turn on Bravo.');
  assert.equal(h.points.at(-1), 'Bravo', 'with the light: Echo did the last one');

  // Shown again, and this time: keep showing.
  await h.s.hear('show me');
  await h.shown('Bravo');
  await h.tick(SHOW_PACE.sitMs);
  await h.tick(TEACH_PRAISE_MS);
  assert.equal(h.last(), WHY, 'they asked to watch and were not stuck: the story is told');
  await h.tick(spokenMs(WHY) + TEACH_STORY_QUIET_MS);
  assert.equal(h.last(), 'Your turn on the next one?');
  assert.equal(h.s.takes('keep showing'), 'show_all');
  await h.s.hear('keep showing');
  assert.equal(h.s.mode, 'show');
  assert.equal(h.last(), "I'll turn on Charlie.");
  // Mid-demonstration: "let me try" hands the lesson back from the next step.
  await h.s.hear('let me try');
  assert.equal(h.s.mode, 'guide');
  assert.equal(h.last(), "Okay, the next one's yours.");
  await h.shown('Charlie');
  await h.tick(SHOW_PACE.sitMs);
  await h.tick(TEACH_PRAISE_MS);
  assert.deepEqual(h.said.slice(-2), ['Charlie is on.', 'Turn on Delta.'], 'no question: they have already said');
  assert.deepEqual(h.kinds('mode').map((e) => [e.step, e.mode]), [[2, 'show'], [3, 'guide']]);
  assert.equal(h.s.summary().shown, true);
});

test('"just do it" is that one step at full speed: "Okay.", one line when it is done, and on with the lesson', async () => {
  const h = harness(lesson(3));
  await h.tick(0);
  await h.solve('Alpha');
  await h.s.hear('just do it');
  assert.equal(h.last(), 'Okay.');
  assert.equal(h.reports.at(-1).kind, 'do_step');
  assert.equal(h.s.fullSpeed, true);
  assert.equal(h.s.leadLeft(), 0, 'no lead-in');
  await h.shown('Bravo');
  assert.equal(h.last(), 'Bravo is on.', 'at once: nothing sits');
  await h.tick(TEACH_PRAISE_MS);
  assert.equal(h.last(), 'Turn on Charlie.', 'no story after a step they did not watch for, and no question');
  assert.equal(h.s.mode, 'guide');
  // "Do the rest": the lesson ends and the rest goes to the assistant, with no narration.
  await h.s.hear('do the rest');
  assert.equal(h.last(), "Okay, I'll do the rest.");
  assert.equal(h.s.active, false);
  assert.equal(h.reports.at(-1).kind, 'do_all');
  assert.equal(h.kinds('mode').at(-1).mode, 'do');
});

test('Echo could not do the step it was showing: the lesson is the user\'s from there', async () => {
  const h = harness(lesson(2, { mode: 'show' }));
  await h.tick(0);
  await h.s.hear('go on'); // lesson_control resume
  assert.equal(h.s.mode, 'guide');
  assert.equal(h.last(), 'Turn on Alpha.');
  assert.equal(h.s.demoing, false);
});

test('a lesson the user does: the story is told once, right after the step, then quiet; what is said in the quiet is for the assistant', async () => {
  const h = harness(lesson(3, { opening: 'By the end all three are on.' }));
  await h.tick(0);
  assert.deepEqual(h.said, ['By the end all three are on.', 'Turn on Alpha.']);
  await h.solve('Alpha');
  assert.deepEqual(h.said.slice(-2), ['Alpha is on.', 'Turn on Bravo.'], 'the acknowledgement is what the check saw');
  await h.tick(10_000);
  h.on('Bravo');
  await h.tick(); await h.tick();
  assert.equal(h.last(), 'Bravo is on.');
  assert.equal(h.s.storyGap, false);
  await h.tick(TEACH_PRAISE_MS);
  assert.equal(h.last(), WHY, 'after the result has sat');
  assert.equal(h.s.storyGap, true);
  // In the quiet: a question is about the story, and goes to the assistant with it.
  assert.equal(h.s.takes('what'), null, '"what?" is not "where?" here');
  assert.equal(h.s.takes('why is that'), null);
  assert.equal(h.s.takes('cool'), 'remark', 'a word that asks nothing gets no reply');
  assert.equal(h.s.takes('stop'), 'stop');
  const heard = await h.s.hear('Why does my phone do that?');
  assert.equal(heard.handled, false);
  assert.equal(heard.context.story, WHY);
  // The lesson's next line waits for the assistant's answer, then is said.
  await h.tick(spokenMs(WHY) + TEACH_STORY_QUIET_MS);
  assert.equal(h.last(), WHY);
  h.s.endQuiet();
  assert.equal(h.last(), 'Turn on Charlie.');
  assert.equal(h.s.context().story, undefined, 'the quiet is over');
  await h.solve('Charlie');
  assert.equal(h.said.filter((x) => x === WHY).length, 1);
  assert.deepEqual(h.kinds('story').map((e) => [e.step, e.told]), [[2, true]]);
  assert.doesNotMatch(JSON.stringify(h.logged), /phone/, 'the log says a story was told, never the story');
});

test('with no word from the user, the next step comes two seconds after the story', async () => {
  const h = harness(lesson(3));
  await h.tick(0);
  await h.solve('Alpha');
  await h.tick(10_000);
  h.on('Bravo');
  await h.tick(); await h.tick();
  await h.tick(TEACH_PRAISE_MS);
  assert.equal(h.last(), WHY);
  await h.tick(spokenMs(WHY) + TEACH_STORY_QUIET_MS - 100);
  assert.equal(h.last(), WHY);
  await h.tick(100);
  assert.equal(h.last(), 'Turn on Charlie.');
});

test('the story is dropped, not saved for later, when they struggled or were frustrated on that step', async () => {
  // Frustrated, then did it themselves after all.
  const a = harness(lesson(3));
  await a.tick(0);
  await a.solve('Alpha');
  await a.s.hear("this isn't working");
  assert.equal(a.last(), "That one's fiddly. Want me to do it?");
  await a.s.hear('no');
  await a.solve('Bravo');
  assert.equal(a.last(), 'Turn on Charlie.');
  await a.solve('Charlie');
  assert.equal(a.said.includes(WHY), false);
  assert.deepEqual(a.kinds('story').map((e) => [e.step, e.told]), [[2, false]]);

  // Stuck, took the offer: Echo shows the step, and the story stays untold.
  const b = harness(lesson(3));
  await b.tick(0);
  await b.solve('Alpha');
  await b.s.hear('where?'); // from the light straight to the offer: this step has no first half
  assert.equal(b.last(), 'Want me to do this step for you?');
  await b.s.hear('yes');
  await b.shown('Bravo');
  await b.tick(SHOW_PACE.sitMs);
  await b.tick(TEACH_PRAISE_MS);
  assert.deepEqual(b.said.slice(-2), ['Bravo is on.', 'Your turn on the next one?']);
  assert.equal(b.said.includes(WHY), false);

  // Two stories on neighbouring steps: only the first is told.
  const plan = lesson(3);
  plan.steps[0].why = 'Alpha wakes the others up.';
  const c = harness(plan);
  await c.tick(0);
  await c.solve('Alpha');
  await c.tick(spokenMs(plan.steps[0].why) + TEACH_STORY_QUIET_MS);
  await c.solve('Bravo');
  await c.solve('Charlie');
  assert.deepEqual(c.said.filter((x) => x === plan.steps[0].why || x === WHY), [plan.steps[0].why]);
  assert.deepEqual(c.kinds('story').map((e) => [e.step, e.told]), [[1, true], [2, false]]);
});

test('a fast learner hears almost nothing: the steps, cut short, and the closing line', async () => {
  const plan = lesson(6, { opening: 'By the end all six are on.', closing: 'That is the whole panel.' });
  plan.steps.forEach((st) => { st.say = `Open the panel. ${st.say}`; });
  plan.steps[4].why = 'Echo Bay is the one that syncs.';
  const h = harness(plan);
  await h.tick(0);
  await h.s.hear('I know this');
  for (const name of names) await h.solve(name, 2000);
  assert.deepEqual(h.said, [
    'By the end all six are on.',
    'Open the panel. Turn on Alpha.',
    'Turn on Bravo.', 'Turn on Charlie.', 'Turn on Delta.', 'Turn on Echo Bay.', 'Turn on Foxtrot.',
    'That is the whole panel.',
  ], 'no acknowledgements, no stories, no recap');
  assert.deepEqual(h.kinds('story').map((e) => e.told), [false, false]);
  assert.equal(h.reports.length, 1, 'and the assistant is only told it is over');
});

test('a learner who needs little, at their own pace: the acknowledgements stop after three easy steps', async () => {
  const h = harness(lesson(6), { prior: (app) => app === 'Settings' });
  await h.tick(0);
  assert.deepEqual(h.said, ["You know your way around Settings now, so I'll say less.", 'Turn on Alpha.'], 'said once, before step 1');
  for (const name of names) await h.solve(name);
  assert.deepEqual(h.starts(), [2, 2, 1, 0, 0, 0], 'the first two a rung lower than a first lesson');
  assert.equal(h.s.ladder.terse, false, 'never fast');
  const acks = h.said.filter((x) => / is on\.$/.test(x));
  assert.deepEqual(acks, ['Alpha is on.', 'Bravo is on.', 'Charlie is on.', 'Delta is on.'], 'steps 3 to 5 needed a prompt at most: from there, no more');
  assert.equal(h.said.filter((x) => x.startsWith('You know your way')).length, 1);
  assert.match(h.last(), /^You did it: /, 'they still hear what they did');
  assert.deepEqual(h.s.summary(), { app: 'Settings', steps: 6, medianRung: 0, shown: false });
});

test('a first lesson in an app says nothing about knowing it', async () => {
  const h = harness(lesson(2), { prior: () => false });
  await h.tick(0);
  assert.deepEqual(h.said, ['Turn on Alpha.']);
  assert.deepEqual(h.starts(), [RUNG.POINT]);
});

/* ---------- through the teach tool ---------- */

test('the tool: a shown lesson, its note for the app, and the next lesson there starting lower', async () => {
  saveSettings({ pointer: true, computerUse: false });
  const shown = { Dark: { present: true, selected: false }, Light: { present: true, selected: false } };
  const bridge = {
    native: true,
    async request(kind, p) {
      if (kind === 'state') return { ok: true, app: 'System Settings', elements: Object.fromEntries((p.labels || []).map((l) => [l, shown[l] || { present: false }])) };
      if (kind === 'wait' || kind === 'point') return { ok: true, found: Boolean(shown[p.target]), label: p.target };
      return { ok: true };
    },
  };
  const c = new ComputerUse({ bridge: /** @type {any} */ (bridge), logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const said = [], reports = [];
  c.on('say', (t) => said.push(t));
  c.on('lesson_report', (r) => reports.push(r.kind));
  const steps = [
    { say: 'Click Dark.', target: 'Dark', why: 'Dark is kinder at night.', check: { kind: 'element_state', label: 'Dark', selected: true } },
    { say: 'Click Light.', target: 'Light', check: { kind: 'element_state', label: 'Light', selected: true } },
  ];
  const r = await c.startLesson({ goal: 'switch the look', mode: 'show', steps });
  assert.equal(r.started, true, JSON.stringify(r));
  await until(() => reports.length === 1);
  assert.deepEqual([said, reports], [["I'll click Dark."], ['show_step']]);
  assert.equal(c.showing, true, 'a watchable pace');
  shown.Dark.selected = true;
  await c.controlLesson({ action: 'skip' });
  await until(() => reports.length === 2, 15_000, 'the second step is shown once the first has sat and its story is told');
  assert.deepEqual(said, ["I'll click Dark.", 'Dark is selected.', 'Dark is kinder at night.', "I'll click Light."]);
  shown.Light.selected = true;
  await c.controlLesson({ action: 'skip' });
  await until(() => said.at(-1) === 'Want to try it yourself now?', 6000);
  assert.equal(c.isLessonCommand('no thanks'), true, 'the answer is the lesson\'s: no model turn');
  await c.hearLesson('no thanks');
  assert.equal(c.lesson.active, false);
  assert.equal(said.at(-1), 'That was it: click Dark, then click Light.');
  const note = lessonNote('System Settings');
  assert.deepEqual([note?.steps, note?.medianRung, note?.shown], [2, RUNG.DO_IT, true], 'how it went, kept for that app');
  assert.doesNotMatch(fs.readFileSync(path.join(dirs.data, 'lesson-notes.json'), 'utf8'), /Dark|Light|look/, 'never what it was about');
  const log = fs.readFileSync(path.join(dirs.data, 'lesson-log.jsonl'), 'utf8');
  assert.match(log, /"event":"lesson_started"[^\n]*"mode":"show"/);
  assert.match(log, /"event":"story"[^\n]*"told":true/);
  assert.doesNotMatch(log, /kinder/);
  assert.deepEqual(readTimeline(dirs.data).filter((e) => e.type === 'lesson.story').map((e) => e.f), [{ step: 1, told: true }]);

  // They were shown everything: the next lesson there starts as a first one does.
  shown.Dark.selected = false;
  const before = readTimeline(dirs.data).filter((e) => e.type === 'lesson.rung').length;
  assert.equal((await c.startLesson({ goal: 'again', steps })).started, true);
  await until(() => said.at(-1) === 'Click Dark.');
  assert.equal(readTimeline(dirs.data).filter((e) => e.type === 'lesson.rung').at(-1).f.rung, RUNG.POINT);
  c.abort('test over');
  // A lesson there that went well: the one after starts a rung lower, and Echo says so.
  saveLessonNote({ app: 'System Settings', steps: 5, medianRung: 1, shown: false });
  said.length = 0;
  assert.equal((await c.startLesson({ goal: 'again', steps })).started, true);
  await until(() => said.at(-1) === 'Click Dark.');
  assert.deepEqual(said, ["You know your way around System Settings now, so I'll say less.", 'Click Dark.']);
  const rungs = readTimeline(dirs.data).filter((e) => e.type === 'lesson.rung');
  assert.ok(rungs.length > before);
  assert.equal(rungs.at(-1).f.rung, RUNG.HINT);
  // "Show me the rest" in the middle of it: the mode is on the timeline, by name only.
  await c.hearLesson('show me the rest');
  assert.deepEqual(readTimeline(dirs.data).filter((e) => e.type === 'lesson.mode').at(-1).f, { step: 1, mode: 'show' });
  c.abort('test over');
  assert.equal(c.lesson.active, false);
});

/* ---------- the driving, while Echo shows a step ---------- */

/** A bridge whose "Mac app" answers every request, and a note of when each arrived. */
function fakeApp() {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 2000, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const log = [];
  bridge.on('request', (r) => {
    const p = r.params;
    log.push({ at: Date.now(), what: r.kind === 'act' ? `act.${p.step}` : r.kind });
    const out = r.kind === 'act' && p.step === 'resolve'
      ? { ok: true, found: true, token: 't', label: p.target || '', role: 'AXButton', app: 'Preview', window: 'Untitled' }
      : { ok: true, via: 'accessibility', app: 'Preview', window: 'Untitled' };
    setImmediate(() => bridge.deliver(r.id, { ...out, id: r.id }));
  });
  return { bridge, log };
}

test('while Echo shows a step, its actions say nothing and do not move before the line of intent is over', async () => {
  (setFixedForTest({ screenAware: true, reduceMotion: 'system' }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do' }));
  const app = fakeApp();
  const c = new ComputerUse({ bridge: app.bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const said = [];
  c.on('say', (t) => said.push(t));
  const until0 = Date.now() + 250;
  c.lesson = /** @type {any} */ ({ active: true, demoing: true, fullSpeed: false, lead: () => new Promise((r) => setTimeout(r, Math.max(0, until0 - Date.now()))), release() {} });
  const from = Date.now();
  const r = await c.act('click', { target: 'Bold', say: 'Clicking Bold…' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.deepEqual(said, [], 'nothing is said while the light moves or the step runs');
  assert.ok(app.log.find((e) => e.what === 'act.resolve').at - from >= 230, 'the light set off only after the lead-in');
  assert.equal(c.showing, true);
  // "Just do it": full speed, and still no narration (the lesson says one line when it is done).
  c.lesson = /** @type {any} */ ({ active: true, demoing: true, fullSpeed: true, lead: async () => {}, release() {} });
  assert.equal(c.showing, false);
  await c.act('click', { target: 'Italic', say: 'Clicking Italic…' });
  assert.deepEqual(said, []);
  // A lesson that is only watching: the assistant's own step is narrated as before.
  c.lesson = /** @type {any} */ ({ active: true, demoing: false, fullSpeed: false, lead: async () => {}, release() {} });
  await c.act('click', { target: 'Underline', say: 'Clicking Underline…' });
  assert.deepEqual(said, ['Clicking Underline…']);
  c.lesson = null;
  c.abort('test over');
});
