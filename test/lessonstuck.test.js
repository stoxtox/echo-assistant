// Oct 3: a four-step Excel lesson (window_title, cell_value, selection, bold) got stuck on step 2.
// He typed the word into another cell, said "done" twice, and the lesson neither passed nor said
// why; fourteen more remarks became questions for the model. The lesson only has the app's state
// to go on, which carries no cells, so a cell check could never be seen to pass (lib/teach.js).
// Here: what "done" does now, "close enough" per check kind, the offer to do the step, "show me
// the whole lesson", remarks that pass in silence, and the one helpful line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('lessonstuck');
const T = await import('../lib/teach.js');
const { TeachSession, closeEnough, seenVersusWanted, doneLook, cellTexts, moveCell, waitingFor, withFocusCell, teachCommand, uiAdapter, CELL_KINDS } = T;

/** His lesson, as the assistant wrote it. */
const excel = () => ({
  title: 'Bold text in Excel',
  steps: [
    { say: 'Open a blank workbook.', check: { kind: 'window_title', contains: 'Book' } },
    { say: 'Type Hello into cell A1.', target: 'A1', check: { kind: 'cell_value', cell: 'A1', equals: 'Hello' } },
    { say: 'Click cell A1.', target: 'A1', check: { kind: 'selection', cell: 'A1' } },
    { say: 'Press Command B to make A1 bold.', check: { kind: 'bold', range: 'A1' } },
  ],
});

/** A sheet Echo can read (cells, selection) on a fake clock. `blind`: only the app's state, as in the real app. */
function harness({ blind = false, startAt = 2 } = {}) {
  let t = 1_000_000;
  const sheet = { window: 'Book1', cells: {}, selection: 'C3', focus: { role: 'AXCell', label: '', value: '' } };
  const said = [], reports = [], logged = [], cards = [];
  const adapter = {
    ...(blind ? { cannotSee: CELL_KINDS } : {}),
    async snapshot() {
      const ui = { app: 'Microsoft Excel', window: sheet.window, focus: sheet.focus };
      return blind ? { cells: {}, ui } : { cells: structuredClone(sheet.cells), selection: sheet.selection, active: sheet.selection, ui };
    },
  };
  const s = new TeachSession({ adapter, say: (x) => said.push(x), report: (r) => reports.push(r), log: (e) => { if (e.kind !== 'rung') logged.push(e.kind); }, card: (c) => cards.push(c), now: () => t, autoPoll: false });
  s.start(excel(), { startAt });
  return {
    s, sheet, said, reports, logged, cards,
    async tick(ms = T.TEACH_POLL_MS) { t += ms; await s.poll(); },
    async settle() { for (let k = 0; k < 4; k++) { t += T.TEACH_POLL_MS; await s.poll(); } },
    wait(ms) { t += ms; },
    last: () => said.at(-1),
  };
}

test('close enough, per check kind: the same text in any cell; any cell holding that text selected', () => {
  const steps = excel().steps;
  const texts = cellTexts(steps);
  assert.deepEqual(Object.keys(texts), ['A1']);
  const typed = { cells: { A5: { value: 'Hello' } }, selection: 'A6' };
  assert.deepEqual(closeEnough(steps[1].check, typed, { baseline: { cells: {} }, texts }), { say: 'I can see Hello in A5, not A1.', moved: { from: 'A1', to: 'A5' } });
  assert.equal(closeEnough(steps[1].check, { cells: { A5: { value: 'Helo' } } }, { texts }), null, 'different text is not close enough');
  assert.equal(closeEnough(steps[1].check, typed, { baseline: { cells: { A5: { value: 'Hello' } } }, texts }), null, 'text that was there before the step proves nothing');
  assert.deepEqual(closeEnough(steps[2].check, { cells: { A5: { value: 'hello' } }, selection: 'A5' }, { texts }), { say: 'I can see A5 selected, not A1.', moved: { from: 'A1', to: 'A5' } });
  assert.equal(closeEnough(steps[2].check, { cells: { A5: { value: 'Hello' } }, selection: 'B2' }, { texts }), null, 'a cell without that text selected is not');
  assert.equal(closeEnough(steps[2].check, { cells: { A5: { value: 'Hello' } }, selection: 'A5:A6' }, { texts }), null, 'nor a range');
  assert.deepEqual(closeEnough(steps[3].check, { cells: { A5: { value: 'Hello', bold: true } } }, { texts })?.moved, { from: 'A1', to: 'A5' });
  assert.equal(closeEnough(steps[0].check, { ui: { window: 'Other' } }, { texts }), null, 'kinds Echo cannot judge from the state are never waved through');
  // What Echo sees against what the step wanted, in one sentence.
  assert.equal(seenVersusWanted(steps[1].check, { cells: { A1: { value: 'Help' } } }), 'I can see Help in A1, not Hello.');
  assert.equal(seenVersusWanted(steps[1].check, { cells: {} }), 'I can see A1 is still empty.');
  assert.equal(seenVersusWanted(steps[2].check, { cells: {}, selection: 'C3' }), 'I can see C3 selected, not A1.');
  assert.equal(seenVersusWanted(steps[0].check, { ui: { window: 'Budget' } }), 'I can see the Budget window, not Book.');
  assert.equal(doneLook(steps[1], { cells: {} }, typed, texts).ok, true);
  assert.deepEqual(doneLook(steps[1], { cells: {} }, { cells: {} }, texts), { ok: false, say: 'I can see A1 is still empty.' });
  // The later steps follow the user to the cell they really used.
  assert.deepEqual(moveCell(steps[3], 'A1', 'A5'), { say: 'Press Command B to make A5 bold.', check: { kind: 'bold', range: 'A5' } });
  assert.equal(moveCell(steps[2], 'A1', 'A5').say, 'Click cell A5.');
  assert.equal(moveCell({ say: 'Click cell A10.', check: { kind: 'selection', cell: 'A10' } }, 'A1', 'A5').say, 'Click cell A10.', 'A10 is not A1');
  assert.equal(waitingFor(steps[1]), "I'm waiting to see Hello in A1.");
  assert.equal(withFocusCell({ cells: {}, ui: { focus: { label: 'A5', value: 'Hello' } } }).cells.A5.value, 'Hello');
});

test('his step 2: Hello typed into A5, "done": Echo says what it sees, passes it, and the lesson moves to A5', async () => {
  const h = harness();
  await h.tick(0);
  assert.equal(h.last(), 'Type Hello into cell A1.');
  h.sheet.cells.A5 = { value: 'Hello' };
  h.sheet.selection = 'A6';
  await h.s.hear('done');
  assert.equal(h.last(), 'I can see Hello in A5, not A1. That works too.');
  assert.equal(h.s.phase, 'praise', 'the step passed');
  await h.settle();
  assert.equal(h.s.i, 2);
  assert.equal(h.last(), 'Click cell A5.', 'the next step names the cell he used');
  h.sheet.selection = 'A5';
  await h.settle();
  assert.equal(h.s.i, 3, 'and its check watches that cell');
  assert.deepEqual(h.reports, [], 'no model call for any of it');
});

test('"done" with the wrong thing on screen: one specific sentence; said again: the sentence and the offer, once; "yes" hands that ONE step over', async () => {
  const h = harness();
  await h.tick(0);
  h.sheet.cells.A1 = { value: 'Help' };
  await h.s.hear("it's done");
  assert.equal(h.last(), 'Not yet. I can see Help in A1, not Hello.');
  await h.s.hear('okay done');
  assert.equal(h.last(), 'Not yet. I can see Help in A1, not Hello. Want me to do this step for you?');
  assert.equal(h.s.takes('yes'), 'yes');
  await h.s.hear('I did');
  assert.equal(h.last(), 'Not yet. I can see Help in A1, not Hello.', 'the offer is made once per step');
  await h.s.hear('yes');
  assert.equal(h.last(), "I'll type Hello into cell A1.");
  assert.equal(h.s.phase, 'paused', 'the lesson stops watching while Echo does the step');
  assert.deepEqual(h.reports.map((r) => [r.kind, r.step]), [['show_step', 2]]);
  assert.match(h.reports[0].note, /exactly this ONE step.*lesson_control with action "skip"/s);
  // The assistant did it and says skip: the result sits, Echo says what changed, offers the
  // turn back, and the lesson carries on at the next step.
  h.sheet.cells.A1 = { value: 'Hello' };
  await h.s.next();
  await h.tick(T.SHOW_PACE.sitMs);
  assert.equal(h.last(), 'A1 says Hello.');
  await h.tick(T.TEACH_PRAISE_MS);
  assert.equal(h.last(), 'Your turn on the next one?');
  await h.tick(10_000);
  assert.equal(h.s.i, 2);
  assert.equal(h.last(), 'Click cell A1.');
});

test('frustration is acknowledged, then the offer; "show me" shows the step and "just do it" does it, with no offer', async () => {
  for (const said of ["why can't you see it", "this isn't working", "I don't want to do this", 'I give up']) {
    const h = harness();
    await h.tick(0);
    assert.equal(h.s.takes(said), 'help', said);
    await h.s.hear(said);
    assert.equal(h.last(), "That one's fiddly. Want me to do it?", said);
    assert.deepEqual(h.reports, []);
  }
  for (const [said, cmd, line, kind] of [['show me', 'show', "I'll type Hello into cell A1.", 'show_step'], ['just do it', 'do', 'Okay.', 'do_step'], ['Do it for me.', 'do', 'Okay.', 'do_step']]) {
    const h = harness();
    await h.tick(0);
    assert.equal(h.s.takes(said), cmd, said);
    await h.s.hear(said);
    assert.equal(h.last(), line, said);
    assert.deepEqual(h.reports.map((r) => r.kind), [kind], said);
  }
  for (const yes of ['yes', 'just do it', 'show me', 'Yes, please.', 'okay']) {
    const h = harness();
    await h.tick(0);
    await h.s.hear("this isn't working");
    await h.s.hear(yes);
    assert.deepEqual(h.reports.map((r) => r.kind), ['show_step'], yes);
  }
  const h = harness();
  await h.tick(0);
  await h.s.hear("this isn't working");
  await h.s.hear('no');
  assert.equal(h.last(), 'Okay, go ahead.');
  assert.equal(h.s.phase, 'watch');
  h.wait(T.TEACH_OFFER_MS + 1);
  assert.equal(h.s.takes('yes'), 'remark', 'a "yes" long after the offer starts nothing');
});

test('"do the rest": the lesson ends and every remaining step goes to the assistant to do, at full speed', async () => {
  assert.equal(teachCommand("Just show me the whole lesson, I don't wanna do anything."), 'show_all', 'wanting to watch is a demonstration (test/teachmore.test.js)');
  for (const said of ['do it all', 'just do the rest']) {
    assert.equal(teachCommand(said), 'do_all', said);
    const h = harness();
    await h.tick(0);
    await h.s.hear(said);
    assert.equal(h.last(), "Okay, I'll do the rest.");
    assert.equal(h.s.active, false);
    assert.equal(h.reports.at(-1).kind, 'do_all');
    assert.match(h.reports.at(-1).note, /1\. Type Hello into cell A1\. 2\. Click cell A1\. 3\. Press Command B to make A1 bold\./);
    assert.match(h.reports.at(-1).note, /at full speed and without narrating them/);
  }
});

test('a remark of a word or two never becomes a model turn; a question and a real sentence still do', async () => {
  const h = harness();
  await h.tick(0);
  const before = h.said.length;
  for (const said of ['okay', 'Hmm.', 'I think', 'I just']) {
    assert.equal(h.s.takes(said), 'remark', said);
    const r = await h.s.hear(said);
    assert.equal(r.handled, true, `${said}: no model turn`);
    h.wait(30_000); // spread out: not three in a minute
  }
  assert.equal(h.said.length, before, 'and Echo says nothing at all');
  assert.equal(h.s.phase, 'watch', 'it keeps watching');
  assert.equal(h.s.takes('why?'), null, 'a question goes to the assistant');
  assert.equal(h.s.takes('What is a cell'), null);
  assert.equal(h.s.takes('the screen looks different from yours'), null, 'so does a real sentence');
  assert.equal(h.s.takes('yes', { answering: true }), null, 'and a short answer to something Echo asked');
  assert.equal(h.s.takes('next'), 'next', 'commands stay commands');
});

test('three remarks in a minute with no step passed: ONE helpful line and the offer, never the step again', async () => {
  const h = harness();
  await h.tick(0);
  const before = h.said.length;
  await h.s.hear('I think');
  h.wait(10_000);
  await h.s.hear('hmm okay');
  assert.equal(h.said.length, before, 'two remarks: silence');
  h.wait(10_000);
  assert.equal(h.s.takes('I typed it in already you know'), 'remark', 'the third, even a whole sentence, is the lesson\'s to answer');
  await h.s.hear('I typed it in already you know');
  assert.equal(h.last(), "I'm waiting to see Hello in A1. Want me to do this step for you?");
  h.wait(5000);
  await h.s.hear('so');
  await h.s.hear('um okay');
  assert.equal(h.said.length, before + 1, 'said once, not at every remark');
  assert.equal(h.s.takes('sure'), 'yes', 'and the offer is open');
  assert.equal(h.logged.filter((k) => k === 'remark').length, 5, 'each remark is noted (the kind only)');
});

test('remarks right after a step passed are not a sign of being stuck', async () => {
  const h = harness();
  await h.tick(0);
  h.sheet.cells.A1 = { value: 'Hello' };
  await h.settle(); // step 2 passes, step 3 is given
  assert.equal(h.s.i, 2);
  const before = h.said.length;
  for (const said of ['nice', 'okay cool', 'that was easy']) await h.s.hear(said);
  assert.equal(h.said.length, before);
});

test('with only the app\'s state (no cells), a cell step asks for the user\'s word, and "done" gets one look from the assistant', async () => {
  assert.deepEqual(uiAdapter({ request: async () => ({}) }).cannotSee, CELL_KINDS);
  const h = harness({ blind: true });
  await h.tick(0);
  assert.equal(h.last(), "Type Hello into cell A1. Tell me when you've done it.");
  await h.settle();
  assert.equal(h.s.i, 1, 'nothing passes by itself');
  await h.s.hear('done');
  assert.deepEqual(h.reports.map((r) => r.kind), ['look']);
  assert.match(h.reports[0].note, /ONE specific sentence.*lesson_control with action "accept"/s);
  assert.equal(h.s.accept(), true); // the assistant looked: close enough
  h.s.endQuiet(); // its one sentence is over: the lesson's own line is said
  assert.equal(h.last(), 'That works too.');
  await h.settle();
  assert.equal(h.s.i, 2);
  // Step 3: the look was not accepted; "done" again gets the offer, and a third time his word is taken.
  await h.s.hear('done');
  assert.equal(h.reports.at(-1).kind, 'look');
  h.s.endQuiet(); // the assistant said what to change
  await h.s.hear('done');
  assert.equal(h.last(), 'Want me to do this step for you?');
  await h.s.hear('no');
  await h.s.hear('I did it');
  assert.equal(h.last(), 'Okay.');
  assert.equal(h.s.phase, 'praise', 'never a dead end');
});

test('with only the app\'s state, the focused cell is enough when it names the cell and holds the text', async () => {
  const h = harness({ blind: true });
  await h.tick(0);
  h.sheet.focus = { role: 'AXCell', label: 'A5', value: 'Hello' };
  await h.s.hear('done');
  assert.equal(h.last(), 'I can see Hello in A5, not A1. That works too.');
  assert.deepEqual(h.reports, []);
});

test('the dispatcher hands a mid-lesson remark to the lesson, not the model, unless Echo just asked something', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/dispatcher.js', import.meta.url), 'utf8');
  assert.match(src, /const answering = this\.answerPending\(\) \|\| [^\n]*lastReply[^\n]*\n\s*if \(this\.computer\.lessonTakes\(String\(textIn\), \{ answering \}\)\) \{\n\s*this\.computer\.hearLesson\(String\(textIn\), \{ answering \}\)[^\n]*\n\s*return 'local';/);
});
