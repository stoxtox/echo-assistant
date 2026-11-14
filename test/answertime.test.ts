// Where the answer time goes, and the two cuts the Oct 3, 2026 logs justified (97 spoken turns):
// - a third of spoken turns began with a tool and stayed silent for 6 s at the median: Echo now
//   says one short word the moment the tool starts (lib/dispatcher.js watchTool, ackLine);
// - one sentence in five without Echo's name waited 0.9 s on the local judge after it had ended:
//   the page now says "probably done" while the app makes sure, and the server gets ahead
//   (public/nativemic.js wordsSoFar, lib/server/speech.js probablyDone).
// Each test with a timing measures the saving it claims.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sandbox, until, wait } from './helpers.js';

const dirs = sandbox('answertime');
process.env.ECHO_FLAG_APPLESPEECH = '1';
const { Dispatcher, ackLine, ACK_MS } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, DEFAULT_FAST_MODEL, setFixedForTest } = await import('../lib/settings.js');
const { speechIntake } = await import('../lib/server/speech.js');
const { pcmWav } = await import('../lib/heard.js');
const { AppMic, looksFinished, PROBABLY_DONE_MS } = await import('../public/nativemic.js');
const { scorecard } = await import('../lib/scorecard.ts');
const { readTimeline } = await import('../lib/timeline.ts');

const ev = (event: any) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } });
const textBlock = (text: string) => [ev({ type: 'content_block_start', content_block: { type: 'text' } }), ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), ev({ type: 'content_block_stop' })];
const toolBlock = (name: string) => [ev({ type: 'content_block_start', content_block: { type: 'tool_use', name: `mcp__ops__${name}` } }), ev({ type: 'content_block_stop' })];
const stop = ev({ type: 'message_stop' });
const whole = (id: string, content: any[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content } });
const toolUse = (id: string, name: string, input: any = {}) => ({ type: 'tool_use', id, name: `mcp__ops__${name}`, input });
const toolResult = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'private output' }] }] } });
const RESULT = { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
const lines = (f: string) => (fs.existsSync(path.join(dirs.data, f)) ? fs.readFileSync(path.join(dirs.data, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A dispatcher whose model answers each message with what `script` yields; what is spoken is kept with when (ms into the turn) and its trace. */
function rig(script: (d: any) => AsyncGenerator<any>) {
  for (const f of ['state.json', 'events.jsonl', 'dispatcher-timing.jsonl']) fs.rmSync(path.join(dirs.data, f), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _ of prompt) yield* script(d);
    })();
    return Object.assign(q, { setModel: async () => {}, setMaxThinkingTokens: async () => {}, close() {}, interrupt: async () => {} });
  };
  const spoken: Array<{ text: string; ms: number; trace?: string }> = [];
  d.on('speak', (text: string, o: any) => spoken.push({ text, ms: Date.now() - (d.turn?.startedAt ?? Date.now()), trace: o?.trace }));
  d.slowTimes = { still: 60_000, slow: 60_000, noAnswer: 60_000, tool: 60 };
  return { d, spoken };
}
const go = async (d: any) => {
  d.start();
  await until(() => d.q, 1000, 'session');
};
/** The model's first move is a look at the screen that takes `toolMs`, and then it answers. `firstMs`: how long its first call takes to get to the tool. */
const lookThenAnswer = (firstMs: number, toolMs: number, tool = 'look_at_screen') =>
  async function* () {
    await wait(firstMs);
    yield start('m1');
    yield* toolBlock(tool);
    yield stop;
    yield whole('m1', [toolUse('tu1', tool)]);
    await wait(toolMs);
    yield toolResult('tu1');
    yield start('m2');
    yield* textBlock('The header is the dark blue bar at the top.');
    yield stop;
    yield whole('m2', [{ type: 'text', text: 'The header is the dark blue bar at the top.' }]);
    yield RESULT;
  };

/* ---------- a word at once when a tool comes first ---------- */

// Each test starts with the local model not yet given up on (lib/localmodel.js).
beforeEach(async () => (await import('../lib/localmodel.js')).resetLocalMisses());

test('the word is chosen from the tool, in Echo, with no model', () => {
  assert.equal(ackLine('look_at_screen'), 'Looking.');
  assert.equal(ackLine('mcp__ops__observe_screen'), 'Looking.');
  assert.equal(ackLine('point_at'), 'Looking.');
  assert.equal(ackLine('sheet_read'), 'Checking the sheet.');
  assert.equal(ackLine('sheet_find'), 'Checking the sheet.');
  assert.equal(ackLine('start_task'), 'One moment.');
  assert.equal(ackLine('hand_off'), 'One moment.');
  assert.equal(ACK_MS, 600, 'about 600 ms into the turn, not 2.5 s after the tool');
});

test('a tool first: one short word while it runs, well before the answer; the saving is measured', async () => {
  setFixedForTest({ fastModel: 'off' });
  // The first call gets to the tool 150 ms in (past the 60 ms this test waits), and the tool takes 400 ms.
  const { d, spoken } = rig(lookThenAnswer(150, 400));
  await go(d);
  d.send('what is that bar at the top', { raw: 'x', trace: 'a1' });
  await until(() => !d.busy, 3000, 'done');
  assert.deepEqual(spoken.map((s) => s.text), ['Looking.', 'The header is the dark blue bar at the top.'], 'the word, then the answer: nothing twice');
  const [ack, answer] = spoken as [typeof spoken[0], typeof spoken[0]];
  assert.equal(ack.trace, 'a1', "it carries the turn's id, so the page times it as the turn's first sound");
  // Said the moment the tool's name streamed in (the turn was already older than the wait).
  assert.ok(ack.ms >= 150 && ack.ms < 300, `said as the tool started (${ack.ms} ms)`);
  const saved = answer.ms - ack.ms;
  assert.ok(saved >= 350, `the user hears something ${saved} ms sooner than the answer`);
  console.log(`  tool-first turn: word at ${ack.ms} ms, answer at ${answer.ms} ms: first sound ${saved} ms sooner`);
  const events = lines('events.jsonl');
  const logged = events.filter((e) => e.type === 'ack');
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].trace, logged[0].tool], ['a1', 'look_at_screen']);
  assert.ok(logged[0].ms >= 150 && logged[0].ms < 300);
  assert.deepEqual(Object.keys(logged[0]).sort(), ['at', 'ms', 'tool', 'trace', 'type'], 'a name and a time, never words');
  // The model's own first words are still timed as themselves.
  assert.ok(events.find((e) => e.type === 'first_speech').ms >= ack.ms + 350);
  // And on the timeline, for the scorecard.
  const row = readTimeline(dirs.data, 0).find((r) => r.type === 'turn.ack' && r.trace === 'a1');
  assert.deepEqual(Object.keys(row!.f).sort(), ['ms', 'tool']);
  d.input.close();
});

test('a tool that starts in the first moments waits until about 600 ms into the turn (here 60), and is never said twice', async () => {
  const early = rig(lookThenAnswer(0, 300, 'sheet_read'));
  early.d.slowTimes.tool = 120;
  await go(early.d);
  early.d.send('how many rows are there', { raw: 'x' });
  await until(() => !early.d.busy, 3000, 'done');
  assert.deepEqual(early.spoken.map((s) => s.text), ['Checking the sheet.', 'The header is the dark blue bar at the top.']);
  assert.ok(early.spoken[0]!.ms >= 110 && early.spoken[0]!.ms < 280, `not before the wait is up (${early.spoken[0]!.ms} ms)`);
  early.d.input.close();

  // The answer came before the wait was up: no word at all.
  const fast = rig(lookThenAnswer(0, 10));
  fast.d.slowTimes.tool = 200;
  await go(fast.d);
  fast.d.send('what is that bar at the top', { raw: 'x' });
  await until(() => !fast.d.busy, 3000, 'done');
  await wait(250);
  assert.deepEqual(fast.spoken.map((s) => s.text), ['The header is the dark blue bar at the top.'], 'the model spoke first');
  fast.d.input.close();

  // Two tools in a row: one word for the turn.
  const two = rig(async function* () {
    await wait(80);
    yield start('m1');
    yield* toolBlock('look_at_screen');
    yield stop;
    yield whole('m1', [toolUse('tu1', 'look_at_screen')]);
    await wait(100);
    yield toolResult('tu1');
    yield start('m2');
    yield* toolBlock('sheet_read');
    yield stop;
    yield whole('m2', [toolUse('tu2', 'sheet_read')]);
    await wait(100);
    yield toolResult('tu2');
    yield RESULT;
  });
  await go(two.d);
  two.d.send('add up the totals column', { raw: 'x' });
  await until(() => !two.d.busy, 3000, 'done');
  assert.deepEqual(two.spoken.map((s) => s.text), ['Looking.']);
  two.d.input.close();
});

test("no word when the model wrote its own progress line, nor for an update Echo started by itself", async () => {
  const own = rig(async function* () {
    await wait(80);
    yield start('m1');
    yield* textBlock('Reading the totals column.');
    yield* toolBlock('sheet_read');
    yield stop;
    yield whole('m1', [{ type: 'text', text: 'Reading the totals column.' }, toolUse('tu1', 'sheet_read')]);
    await wait(150);
    yield toolResult('tu1');
    yield RESULT;
  });
  await go(own.d);
  own.d.send('add up the totals column', { raw: 'x' });
  await until(() => !own.d.busy, 3000, 'done');
  assert.deepEqual(own.spoken.map((s) => s.text), ['Reading the totals column.']);
  own.d.input.close();

  // An update Echo started by itself (a task finished) is never opened with "One moment."
  const event = rig(lookThenAnswer(80, 150, 'get_task'));
  await go(event.d);
  event.d.notify('[task 4 finished] the report is ready');
  await until(() => event.d.busy, 2000, 'event turn');
  await until(() => !event.d.busy, 3000, 'done');
  assert.deepEqual(event.spoken.map((s) => s.text), ['The header is the dark blue bar at the top.']);
  event.d.input.close();
});

test('never for a turn that ends up [quiet], nor for a hand-off of a sentence that may not be for Echo', async () => {
  setFixedForTest({ fastModel: 'auto' });
  // The quick model hands a maybe-not-for-Echo sentence over, and the main model stays quiet.
  const quiet = rig(async function* () {
    await wait(80);
    yield start('m1');
    yield* toolBlock('hand_off');
    yield stop;
    yield whole('m1', [toolUse('tu1', 'hand_off')]);
    await wait(120);
    yield toolResult('tu1');
    yield start('m2');
    yield* textBlock('[quiet]');
    yield stop;
    yield whole('m2', [{ type: 'text', text: '[quiet]' }]);
    yield RESULT;
  });
  await go(quiet.d);
  quiet.d.send('and then he said it was fine', { raw: 'x', trace: 'q1', mayNotBeForEcho: true });
  await until(() => !quiet.d.busy, 3000, 'done');
  assert.deepEqual(quiet.spoken, [], 'nothing at all was said');
  assert.equal(lines('events.jsonl').filter((e) => e.type === 'ack').length, 0);
  assert.equal(lines('events.jsonl').find((e) => e.type === 'turn_end').quiet, true);
  quiet.d.input.close();

  // Once the main model uses a real tool on such a sentence it has taken it as Echo's: the word is said.
  const acted = rig(async function* (d) {
    await wait(80);
    yield start('m1');
    yield* toolBlock('hand_off');
    yield stop;
    yield whole('m1', [toolUse('tu1', 'hand_off')]);
    // What the hand_off tool does in the real session: the rest of the turn is the main model's.
    await d.handOff();
    yield toolResult('tu1');
    yield start('m2');
    yield* toolBlock('look_at_screen');
    yield stop;
    yield whole('m2', [toolUse('tu2', 'look_at_screen')]);
    await wait(150);
    yield toolResult('tu2');
    yield RESULT;
  });
  await go(acted.d);
  acted.d.send('what is that bar at the top', { raw: 'x', mayNotBeForEcho: true });
  await until(() => !acted.d.busy, 3000, 'done');
  assert.deepEqual(acted.spoken.map((s) => s.text), ['Looking.']);
  acted.d.input.close();
});

test("the quick model: 'One moment.' when it hands the turn over, nothing for its own instant errands and answers", async () => {
  setFixedForTest({ fastModel: 'auto' });
  const handed = rig(lookThenAnswer(80, 300, 'hand_off'));
  await go(handed.d);
  handed.d.send('how are you today', { raw: 'x' });
  assert.equal(handed.d.modelNow, DEFAULT_FAST_MODEL, 'a quick turn');
  await until(() => !handed.d.busy, 3000, 'done');
  assert.deepEqual(handed.spoken.map((s) => s.text), ['One moment.', 'The header is the dark blue bar at the top.']);
  handed.d.input.close();

  const errand = rig(lookThenAnswer(80, 150, 'media_control'));
  await go(errand.d);
  errand.d.send('how are you today', { raw: 'x' });
  assert.equal(errand.d.modelNow, DEFAULT_FAST_MODEL);
  await until(() => !errand.d.busy, 3000, 'done');
  assert.deepEqual(errand.spoken.map((s) => s.text), ['The header is the dark blue bar at the top.'], 'its own errand is done in a moment: no word');
  errand.d.input.close();

  const answer = rig(async function* () {
    await wait(80);
    yield start('m1');
    yield* textBlock("I'm well, thanks for asking.");
    yield stop;
    yield whole('m1', [{ type: 'text', text: "I'm well, thanks for asking." }]);
    yield RESULT;
  });
  await go(answer.d);
  answer.d.send('how are you today', { raw: 'x' });
  await until(() => !answer.d.busy, 3000, 'done');
  await wait(100);
  assert.deepEqual(answer.spoken.map((s) => s.text), ["I'm well, thanks for asking."]);
  answer.d.input.close();
  setFixedForTest({ fastModel: 'off' });
});

/* ---------- the page: "probably done" ---------- */

test('a sentence looks finished as the app sees it: not on a comma or a word that leaves it hanging', () => {
  for (const t of ['what time is the meeting tomorrow', 'Open the budget sheet.', 'is that right?', 'yes please', 'make the header bigger']) assert.equal(looksFinished(t), true, t);
  for (const t of ['', '   ', 'I just think', 'make the header bigger and', 'open the', 'so, about the header,', 'I want to', 'okay so', 'the one on the…', 'um']) assert.equal(looksFinished(t), false, t);
});

/** The page's half of the engine with timers the test fires by hand. */
function fakeMic() {
  const sent: Array<{ text: string; mode: string }> = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const mic: any = new AppMic({
    probablyDone: (text: string, notes: any) => sent.push({ text, mode: notes.mode }),
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t: any) => { if (t) t.live = false; },
    send: async () => {},
  });
  /** Fire every live timer of this length, as if that long had passed with nothing new. */
  const pass = (ms: number) => { for (const t of timers.filter((x) => x.live && x.ms === ms)) { t.live = false; t.fn(); } };
  const hearing = (reason: string) => mic.on({ event: 'state', engine: 1, state: 'hearing', reason, running: true, permission: 'allowed' });
  return { mic, sent, timers, pass, hearing };
}

test('the page says "probably done" once the words look finished and stand still for 350 ms; more words start the wait again', () => {
  assert.equal(PROBABLY_DONE_MS, 350);
  const { mic, sent, timers, pass, hearing } = fakeMic();
  mic.plan({ available: true, serverEngine: true, handsFree: true });
  hearing('handsfree');
  mic.on({ event: 'partial', text: 'make the header' });
  mic.on({ event: 'partial', text: 'make the header bigger and' });
  assert.equal(timers.filter((t) => t.live && t.ms === PROBABLY_DONE_MS).length, 0, 'hanging on "and": nothing is waited for');
  mic.on({ event: 'partial', text: 'make the header bigger and darker' });
  mic.on({ event: 'partial', text: 'make the header bigger and darker please' });
  assert.equal(timers.filter((t) => t.live && t.ms === PROBABLY_DONE_MS).length, 1, 'only the newest words are waited on');
  assert.deepEqual(sent, [], 'nothing before the pause');
  pass(PROBABLY_DONE_MS);
  assert.deepEqual(sent, [{ text: 'make the header bigger and darker please', mode: 'hands-free' }]);
  // The recogniser repeating the same words is not a second message.
  mic.on({ event: 'partial', text: 'make the header bigger and darker please' });
  pass(PROBABLY_DONE_MS);
  assert.equal(sent.length, 1);
  // The user carried on: the new words get their own.
  mic.on({ event: 'partial', text: 'make the header bigger and darker please on every page' });
  pass(PROBABLY_DONE_MS);
  assert.equal((sent as any[]).at(-1).text, 'make the header bigger and darker please on every page');
});

test('"probably done" is never sent once the sentence is over, nor for talk still waiting on "Hey Echo"', () => {
  const over = fakeMic();
  over.hearing('window');
  over.mic.on({ event: 'partial', text: 'what time is it' });
  over.mic.on({ event: 'dropped', reason: 'cancelled', arm: 'window' });
  over.pass(PROBABLY_DONE_MS);
  assert.deepEqual(over.sent, []);

  const wake = fakeMic();
  wake.hearing('wake');
  wake.mic.on({ event: 'partial', text: 'did you see the game last night' });
  wake.pass(PROBABLY_DONE_MS);
  assert.deepEqual(wake.sent, [], 'not for Echo until "Hey Echo" is heard');
  wake.mic.on({ event: 'wake' });
  wake.mic.on({ event: 'partial', text: 'hey echo what time is it' });
  wake.pass(PROBABLY_DONE_MS);
  assert.deepEqual(wake.sent, [{ text: 'hey echo what time is it', mode: 'wake' }]);

  // An answer window is its own mode (the server judges each mode its own way).
  const answer = fakeMic();
  answer.mic.plan({ available: true, serverEngine: true, answerOpen: true });
  answer.hearing('window');
  answer.mic.on({ event: 'partial', text: 'the second one please' });
  answer.pass(PROBABLY_DONE_MS);
  assert.deepEqual(answer.sent, [{ text: 'the second one please', mode: 'answer' }]);
});

/* ---------- the server: getting ahead while the sentence ends ---------- */

function clip() {
  const rate = 16000;
  const s = new Float32Array(3 * rate);
  for (let i = 0; i < 2 * rate; i++) s[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.09 * Math.SQRT2;
  return pcmWav(s, rate);
}
/** How long the local model takes to say it can't tell (on Oct 3 it never answered inside its 900 ms). */
const LOCAL_MS = 300;
let localCalls = 0;
const sent: Array<{ text: string }> = [];
const prepared: string[] = [];
const fakeDispatcher: any = {
  lastSpokeAt: 0, busy: false,
  computer: { driving: false, pending: new Map(), lesson: null, instruct() {} },
  routeInput: () => 'turn', localIntentFor: () => null, heard() {}, prepare: (t: string) => prepared.push(t),
  send(text: string) { sent.push({ text }); return 'turn'; },
};
let clock = 1_000_000;
const intake = speechIntake({
  dispatcher: fakeDispatcher, quick: { pendingList: () => [] } as any,
  screen: { native: true, request: async () => { localCalls++; await wait(LOCAL_MS); return { ok: false }; } } as any, broadcast: () => {}, clock: () => clock,
});
/** POST /api/utterance with the Mac app's own text; resolves with the reply and how long it took. */
async function post(text: string, notes: object) {
  const req: any = Object.assign(Readable.from([clip()]), { headers: { 'x-echo-clip': encodeURIComponent(JSON.stringify({ mediaPlaying: false, ...notes, final: { text, ms: 20, words: [] } })) } });
  const t0 = Date.now();
  const body: any = await new Promise((resolve, reject) => {
    const res: any = { on() {}, writeHead() { return res; }, end(b: string) { resolve(JSON.parse(b)); } };
    intake.routes['POST /api/utterance'](req, res).catch(reject);
  });
  return { body, ms: Date.now() - t0 };
}
const HANDS_FREE = { mode: 'hands-free', sinceReplyMs: 3000 };
/** Sentences the rules can't place (a long stretch in the window, no name, no request): the local model is asked. */
const UNSURE = [
  'so I was saying to him the other day that the whole plan for the trip to the lake with the cousins and the dog needed a rethink',
  'and then she told me that her entire idea about a party at their beach house including neighbours plus some band had been postponed',
  'well my uncle reckons our weekend schedule up in those mountains near his cabin beside a river was never properly agreed by anyone',
  'and so my cousin kept on telling everybody about his long holiday down south where it rained the entire fortnight apparently',
];
const headStarts = () => readTimeline(dirs.data, 0).filter((r) => r.type === 'speech.head_start');

test('judging a sentence starts when the page says "probably done": the wait for the local judge is over when the sentence lands', async () => {
  saveSettings({ wakeWord: true, keepRecordings: false });
  // Without a head start: the sentence waits the whole time on the local model after it has ended.
  intake.logConvo('Assistant', 'Sunny, 24 degrees.');
  clock += 20_000;
  const cold = await post(UNSURE[0]!, HANDS_FREE);
  assert.equal(cold.body.text, UNSURE[0]);
  assert.ok(cold.ms >= LOCAL_MS - 20, `waited on the judge (${cold.ms} ms)`);
  assert.equal(headStarts().length, 0);

  // With one: the page's live words arrive 350 ms before the sentence does (recogniser's own case and punctuation).
  intake.logConvo('Assistant', 'Sunny, 24 degrees.');
  clock += 20_000;
  const before = { calls: localCalls, sent: sent.length };
  const live = UNSURE[1]!.replace(/^and/, 'And') + '.';
  await intake.probablyDone({ text: live, ...HANDS_FREE });
  assert.equal(localCalls, before.calls + 1, 'the local model was asked at once');
  assert.equal(sent.length, before.sent, 'nothing goes to Echo until the sentence really ends');
  await wait(350);
  const warm = await post(UNSURE[1]!, HANDS_FREE);
  assert.equal(warm.body.text, UNSURE[1], 'the same sentence, judged the same way');
  assert.equal(localCalls, before.calls + 1, 'not asked a second time');
  assert.ok(warm.ms < 120, `no wait left (${warm.ms} ms)`);
  assert.ok(cold.ms - warm.ms >= 200, `saved ${cold.ms - warm.ms} ms`);
  console.log(`  judged with no head start: ${cold.ms} ms; with one 350 ms earlier: ${warm.ms} ms (saved ${cold.ms - warm.ms} ms)`);
  const row = headStarts().at(-1)!;
  assert.equal(row.trace, warm.body.trace);
  assert.deepEqual(Object.keys(row.f).sort(), ['leadMs', 'savedMs', 'waitMs'], 'times only, never the words');
  assert.ok(Number(row.f.leadMs) >= 340 && Number(row.f.savedMs) >= LOCAL_MS - 30 && Number(row.f.waitMs) < 60, JSON.stringify(row.f));
  const raw = fs.readFileSync(path.join(dirs.data, 'timeline', fs.readdirSync(path.join(dirs.data, 'timeline'))[0]!), 'utf8');
  assert.doesNotMatch(raw, /lake|cousins|party|beach/, 'no word of the sentence on the timeline');
});

test('a head start only part of the way: what is left of the wait is all that is waited', async () => {
  intake.logConvo('Assistant', 'Sunny, 24 degrees.');
  clock += 20_000;
  await intake.probablyDone({ text: UNSURE[2], ...HANDS_FREE });
  await wait(120);
  const r = await post(UNSURE[2]!, HANDS_FREE);
  assert.equal(r.body.text, UNSURE[2]);
  assert.ok(r.ms >= 100 && r.ms < LOCAL_MS - 60, `waited only the rest (${r.ms} ms of ${LOCAL_MS})`);
  const f = headStarts().at(-1)!.f;
  assert.ok(Number(f.savedMs) >= 100 && Number(f.waitMs) >= 100, JSON.stringify(f));
});

test('the user carried on: the preparation is thrown away and the finished sentence is judged afresh', async () => {
  intake.logConvo('Assistant', 'Sunny, 24 degrees.');
  clock += 20_000;
  const rows = headStarts().length;
  await intake.probablyDone({ text: 'and so my cousin kept on telling everybody', ...HANDS_FREE });
  await wait(LOCAL_MS + 50);
  const calls = localCalls;
  const r = await post(UNSURE[3]!, HANDS_FREE);
  assert.equal(r.body.text, UNSURE[3]);
  assert.equal(localCalls, calls + 1, 'asked about the whole sentence');
  assert.ok(r.ms >= LOCAL_MS - 20);
  assert.equal(headStarts().length, rows, 'no head start was used');
});

test('push-to-talk is never judged: "probably done" only gets its model ready, and nothing is sent', async () => {
  clock += 20_000;
  const before = { calls: localCalls, sent: sent.length, prepared: prepared.length };
  await intake.probablyDone({ text: 'What is on my calendar tomorrow?', mode: 'push-to-talk' });
  assert.equal(localCalls, before.calls, 'the local model is not asked');
  assert.deepEqual(prepared.slice(before.prepared), ['What is on my calendar tomorrow?'], "the turn's model is switched to early");
  assert.equal(sent.length, before.sent);
  // Blank words, or with Echo busy: nothing at all.
  fakeDispatcher.busy = true;
  await intake.probablyDone({ text: 'What is on my calendar tomorrow?', mode: 'push-to-talk' });
  await intake.probablyDone({ text: '  ', mode: 'push-to-talk' });
  fakeDispatcher.busy = false;
  assert.equal(prepared.length, before.prepared + 1);
  assert.equal(fs.readFileSync(path.join(dirs.data, 'stt-log.jsonl'), 'utf8').includes('calendar tomorrow?'), false, 'the live words are never logged');
});

/* ---------- the scorecard shows both ---------- */

test('the scorecard: how soon the word came on tool-first turns, and what the head start saved', () => {
  const day = new Date().toISOString().slice(0, 10);
  const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  fs.writeFileSync(path.join(dirs.data, 'events.jsonl'), [
    { at: at(1), type: 'ack', trace: 's1', ms: 900, tool: 'look_at_screen' },
    { at: at(2), type: 'first_speech', trace: 's1', ms: 5200 },
    { at: at(3), type: 'ack', trace: 's2', ms: 1300, tool: 'sheet_read' },
    { at: at(4), type: 'first_speech', trace: 's2', ms: 7000 },
    { at: at(5), type: 'first_speech', trace: 's3', ms: 1100 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = scorecard(dirs.data, Date.now() - 3_600_000, Date.now() + 1000);
  const m: Record<number, any> = Object.fromEntries(r.metrics.map((x) => [x.id, x]));
  assert.equal(m[16].value, 900, 'nearest-rank median of the two');
  assert.equal(m[16].met, true);
  assert.match(m[16].shown, /over 2 turns/);
  assert.match(m[16].note, /5\.20 s/, "against the model's own first words on those turns");
  assert.ok(m[17].value >= 100, 'from the head starts recorded above');
  assert.match(m[17].shown, /over 2 sentences/);
  assert.ok(day);
});

test('a local model that never answers in time is left alone after three misses, and tried again later', async () => {
  const { localDirected, resetLocalMisses, GIVE_UP_AFTER, GIVE_UP_MS } = await import('../lib/localmodel.js');
  resetLocalMisses();
  let asked = 0, t = 1_000_000;
  // It answers, but never with a verdict (the same as running out of time, without the wait).
  const bridge = { native: true, request: async () => { asked++; return { ok: false }; } };
  const ask = () => localDirected({ text: 'okay' }, { bridge, timeoutMs: 20, now: () => t } as any);
  for (let i = 0; i < GIVE_UP_AFTER; i++) assert.equal(await ask(), null);
  assert.equal(asked, GIVE_UP_AFTER);
  const t0 = Date.now();
  assert.equal(await ask(), null);
  assert.equal(asked, GIVE_UP_AFTER, 'not asked again');
  assert.ok(Date.now() - t0 < 200, 'and no wait (the ask itself would take far longer than this when it times out)');
  t += GIVE_UP_MS + 1;
  await ask();
  assert.equal(asked, GIVE_UP_AFTER + 1, 'tried again after ten minutes');
  resetLocalMisses();
});
