// Faster first sound (Oct 8, 2026). Measured over three days: one turn in nine waited 10 to 30 s
// because the new answer queued behind the old one's voice; in a driving session a finished
// sentence always waited the full 1.3 s pause; and the main model thought before most answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

const dirs = sandbox('firstsound');
const { nativeMicPlan } = await import('../public/nativemic.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { record, readTimeline } = await import('../lib/timeline.ts');

const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const swift = (f) => fs.readFileSync(new URL(`../macos/Sources/${f}`, import.meta.url), 'utf8');

test('a new turn of the user\'s stops what is still being read out from the one before', () => {
  const heard = page.slice(page.indexOf("case 'heard': {"), page.indexOf("case 'heard': {") + 900);
  assert.match(heard, /if \(playing \|\| speechQueue\.length \|\| sources\.size\) \{ timeline\('play\.cut', \{ queued: speechQueue\.length \}, msg\.trace\); hush\(\); \}/);
  // (The correction of a sentence already heard is not a new turn: it cuts nothing.)
  const fix = page.slice(page.indexOf("case 'heard_fix'"), page.indexOf("case 'heard': {"));
  assert.doesNotMatch(fix, /hush\(\)/);
  record('page', 'play.cut', { queued: 3, text: 'never kept' }, 't-cut');
  assert.deepEqual(readTimeline(dirs.data).filter((r) => r.type === 'play.cut').at(-1)?.f, { queued: 3 });
});

test('in a driving session a finished sentence ends sooner when Echo is idle, and keeps its full pause mid-step or in a lesson', () => {
  const base = { available: true, setting: true, serverEngine: true, driving: true };
  assert.equal(nativeMicPlan({ ...base }).handsBusy, true, 'not said: as before');
  assert.equal(nativeMicPlan({ ...base, handsBusy: false }).handsBusy, false);
  assert.match(page, /handsBusy: busy \|\| lessonOn,/);
  assert.match(page, /if \(was !== b\) syncNativeMic\(\);/);
  assert.match(swift('NativeMic.swift'), /let handsBusy = b\["handsBusy"\] as\? Bool \?\? true/);
  assert.match(swift('VoiceMath.swift'), /TurnEnd\.endMs\(after: text, base: baseEndMs, working: r == \.run && handsBusy\)/);
});

test('a short spoken turn the quick model would answer is answered by the main model without thinking first', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  assert.equal(d.lightTurn('what do you suggest about that door scanner question'), true, 'nine words, nothing to work out');
  assert.equal(d.lightTurn('can you repeat that one more time'), true);
  assert.equal(d.lightTurn('build me a spreadsheet of all my expenses from last month'), false, 'a job thinks');
  assert.equal(d.lightTurn('so I have been thinking about how the whole plan for the launch should go and what we do first'), false, 'a long one thinks');
});

test('each model call says when its first words came and how long it thought before them', () => {
  record('server', 'model.request', { model: 'm', ctx: 10, firstMs: 900, textMs: 1900, thinkMs: 950, ms: 2500, text: 'no' }, 't-req');
  assert.deepEqual(readTimeline(dirs.data).filter((r) => r.type === 'model.request').at(-1)?.f, { model: 'm', ctx: 10, firstMs: 900, textMs: 1900, thinkMs: 950, ms: 2500 });
  const src = fs.readFileSync(new URL('../lib/dispatcher.js', import.meta.url), 'utf8');
  assert.match(src, /this\.reqThinkAt \|\|= Date\.now\(\);/);
  assert.match(src, /this\.reqTextAt \|\|= Date\.now\(\);/);
});

test('the speed report: plain turns, turns that queued behind old speech, and where the time went', async () => {
  const { speed, render } = await import('../scripts/speed.ts');
  let seq = 0;
  const row = (at, type, f = {}, trace = undefined) => /** @type {any} */ ({ ts: new Date(Date.parse('2026-10-08T15:00:00Z') + at).toISOString(), seq: ++seq, src: 'server', type, f, ...(trace ? { trace } : {}) });
  const rows = [
    row(0, 'turn.start', { source: 'speech' }, 'a'), row(1900, 'model.request', { firstMs: 900, textMs: 1700, thinkMs: 600 }, 'a'), row(2000, 'turn.first_speech', { ms: 2000 }, 'a'), row(2400, 'turn.first_sound', { ms: 2400 }, 'a'),
    // Its words were ready at 1.5 s, its voice came at 21 s: it waited behind the old answer.
    row(10000, 'turn.start', { source: 'typed' }, 'b'), row(11500, 'turn.first_speech', { ms: 1500 }, 'b'), row(31000, 'turn.first_sound', { ms: 21000 }, 'b'),
    row(40000, 'turn.start', { source: 'speech' }, 'c'), row(40500, 'turn.tool_start', { name: 'look_at_screen' }, 'c'), row(46000, 'turn.first_speech', { ms: 6000 }, 'c'), row(46400, 'turn.first_sound', { ms: 6400 }, 'c'),
    row(50000, 'turn.start', { source: 'event' }, 'd'), row(51000, 'turn.first_sound', { ms: 1000 }, 'd'),
    row(60000, 'play.cut', { queued: 2 }, 'e'), row(61000, 'speech.second', { why: 'better', outcome: 'restarted' }, 'e'),
  ];
  const s = speed(rows);
  assert.deepEqual([s.turns, s.plain.n, s.plain.median, s.toolFirst.n, s.queued, s.cut, s.restarted], [3, 1, 2400, 1, 1, 1, 1]);
  assert.deepEqual([s.firstToken, s.firstWords, s.thinking, s.voiceStart], [900, 1700, { n: 1, median: 600 }, 400]);
  assert.match(render(s).join('\n'), /Waited more than 3 s behind the old answer's voice: 1\. Old answer cut off by a new turn instead: 1\./);
});
