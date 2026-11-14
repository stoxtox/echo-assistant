// What Echo says, and when (Oct 3, 2026, from a real session): the quick model spoke and then
// handed the turn over, so two answers were heard; tool calls were invisible in the logs; a turn
// busy with tools said nothing; and a short spoken turn waited on thinking before its first word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('talk');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, DEFAULT_FAST_MODEL, setFixedForTest } = await import('../lib/settings.js');

const ev = (event: any) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } });
const textBlock = (text: string) => [ev({ type: 'content_block_start', content_block: { type: 'text' } }), ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), ev({ type: 'content_block_stop' })];
const toolBlock = (name: string) => [ev({ type: 'content_block_start', content_block: { type: 'tool_use', name: `mcp__ops__${name}` } }), ev({ type: 'content_block_stop' })];
const stop = ev({ type: 'message_stop' });
const whole = (id: string, content: any[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content } });
const toolUse = (id: string, name: string, input: any = {}) => ({ type: 'tool_use', id, name: `mcp__ops__${name}`, input });
const toolResult = (id: string, isError = false) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'private output' }], ...(isError ? { is_error: true } : {}) }] } });
const RESULT = { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
const lines = (f: string) => (fs.existsSync(path.join(dirs.data, f)) ? fs.readFileSync(path.join(dirs.data, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A dispatcher whose model answers each message with what `script` yields. */
function rig(script: (d: any) => AsyncGenerator<any>) {
  for (const f of ['state.json', 'events.jsonl', 'dispatcher-timing.jsonl']) fs.rmSync(path.join(dirs.data, f), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  const models: any[] = [];
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _ of prompt) yield* script(d);
    })();
    return Object.assign(q, { setModel: async (m: any) => models.push(m), setMaxThinkingTokens: async (n: any) => models.push(`think:${n}`), close() {}, interrupt: async () => {} });
  };
  const spoken: string[] = [];
  const shown: string[] = [];
  const order: string[] = [];
  d.on('speak', (t: string) => spoken.push(t));
  d.on('say_delta', (t: string) => (shown.push(t), order.push('shown')));
  d.on('say', (t: string) => shown.push(t));
  return { d, models, spoken, shown, order };
}
const go = async (d: any) => {
  d.start();
  await until(() => d.q, 1000, 'session');
};

test('quick model: words written before a hand-off are never spoken, shown or remembered', async () => {
  setFixedForTest({ fastModel: 'auto' });
  const { d, spoken, shown } = rig(async function* (d) {
    yield start('m1');
    yield* textBlock("The quick model's passing this to Opus.");
    yield* toolBlock('hand_off');
    yield stop;
    yield whole('m1', [{ type: 'text', text: "The quick model's passing this to Opus." }]);
    yield whole('m1', [toolUse('tu1', 'hand_off')]);
    await d.handOff();
    yield toolResult('tu1');
    yield start('m2');
    yield* textBlock('Paris is the capital.');
    yield stop;
    yield whole('m2', [{ type: 'text', text: 'Paris is the capital.' }]);
    yield RESULT;
  });
  await go(d);
  d.send('how are you today?', { raw: 'x', trace: 'h1' });
  assert.equal(d.onQuickModel(), true, 'a quick turn');
  await until(() => !d.busy, 2000, 'done');
  assert.deepEqual(spoken, ['Paris is the capital.']);
  assert.equal(shown.join(''), 'Paris is the capital.');
  const state = JSON.parse(fs.readFileSync(path.join(dirs.data, 'state.json'), 'utf8'));
  assert.equal(state.exchanges.at(-1).echo, 'Paris is the capital.', 'not in the record either');
  assert.ok(lines('dispatcher-timing.jsonl').some((l) => l.type === 'handoff_text_dropped' && l.trace === 'h1'));
  d.input.close();
});

test('quick model, no hand-off: the first words are held until the block ends, then said; the wait is logged', async () => {
  setFixedForTest({ fastModel: 'auto' });
  let gate = () => {};
  const { d, spoken, shown } = rig(async function* () {
    yield start('m1');
    yield ev({ type: 'content_block_start', content_block: { type: 'text' } });
    yield ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Doing well, thanks. ' } });
    await new Promise<void>((r) => (gate = r));
    yield ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'And you?' } });
    yield ev({ type: 'content_block_stop' });
    yield stop;
    yield whole('m1', [{ type: 'text', text: 'Doing well, thanks. And you?' }]);
    yield RESULT;
  });
  await go(d);
  d.send('how are you today?', { raw: 'x', trace: 'h2' });
  await until(() => d.handHold?.text, 1000, 'first words in');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(spoken, [], 'nothing said while it could still hand over');
  assert.deepEqual(shown, []);
  gate();
  await until(() => !d.busy, 2000, 'done');
  assert.equal(spoken.join(' '), 'Doing well, thanks. And you?');
  assert.equal(shown.join(''), 'Doing well, thanks. And you?');
  const turn = lines('dispatcher-timing.jsonl').find((l) => l.type === 'turn');
  assert.ok(turn.heldMs >= 30, `the added delay is in the timing log (${turn.heldMs})`);
  d.input.close();
});

test('main model: words stream to the voice as they come, as before (nothing held)', async () => {
  setFixedForTest({ fastModel: 'auto' });
  let gate = () => {};
  const { d, spoken } = rig(async function* () {
    yield start('m1');
    yield ev({ type: 'content_block_start', content_block: { type: 'text' } });
    yield ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'The report is saved in your research folder. ' } });
    await new Promise<void>((r) => (gate = r));
    yield ev({ type: 'content_block_stop' });
    yield stop;
    yield RESULT;
  });
  await go(d);
  d.send('research the best standing desks and save a report', { raw: 'x' });
  await until(() => spoken.length === 1, 1000, 'said before the block ended');
  assert.equal(d.handHold, null);
  gate();
  await until(() => !d.busy, 2000, 'done');
  const turn = lines('dispatcher-timing.jsonl').find((l) => l.type === 'turn');
  assert.equal(turn.heldMs, undefined);
  d.input.close();
});

test('every tool call is logged: name, how long, whether it worked; never what went in or came out', async () => {
  const { d } = rig(async function* () {
    yield start('m1');
    yield whole('m1', [toolUse('tu1', 'list_tasks', { secret: 'what the user asked about' }), toolUse('tu2', 'get_task', { id: 4 })]);
    await new Promise((r) => setTimeout(r, 25));
    yield toolResult('tu1');
    yield toolResult('tu2', true);
    yield RESULT;
  });
  await go(d);
  d.send('where are we on the research and the report', { raw: 'x', trace: 'k1' });
  await until(() => !d.busy, 2000, 'done');
  const tools = lines('events.jsonl').filter((e) => e.type.startsWith('tool_'));
  assert.deepEqual(tools.map((e) => `${e.type} ${e.name}`), ['tool_start list_tasks', 'tool_start get_task', 'tool_end list_tasks', 'tool_end get_task']);
  assert.ok(tools.every((e) => e.trace === 'k1'));
  const [a, b] = tools.filter((e) => e.type === 'tool_end');
  assert.ok(a.ms >= 20 && a.ok === true);
  assert.equal(b.ok, false);
  const raw = fs.readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /secret|private output|what the user asked about/);
  d.input.close();
});

test('a turn busy with a tool that has said nothing says one short line; not when it already spoke', async () => {
  const silent = rig(async function* () {
    yield start('m1');
    yield whole('m1', [toolUse('tu1', 'list_tasks'), toolUse('tu2', 'get_task')]);
    await new Promise((r) => setTimeout(r, 150));
    yield toolResult('tu1');
    yield toolResult('tu2');
    yield RESULT;
  });
  silent.d.slowTimes = { still: 60_000, slow: 60_000, noAnswer: 60_000, tool: 40 };
  await go(silent.d);
  silent.d.send('where are we on the research and the report', { raw: 'x', trace: 'p1' });
  await until(() => !silent.d.busy, 2000, 'done');
  assert.deepEqual(silent.spoken, ['One moment.'], 'one short word, said while the tool runs');
  assert.equal(lines('events.jsonl').filter((e) => e.type === 'ack').length, 1);
  silent.d.input.close();

  const spoke = rig(async function* () {
    yield start('m1');
    yield* textBlock('Checking the research task.');
    yield stop;
    yield whole('m1', [{ type: 'text', text: 'Checking the research task.' }, toolUse('tu1', 'get_task')]);
    await new Promise((r) => setTimeout(r, 150));
    yield toolResult('tu1');
    yield RESULT;
  });
  spoke.d.slowTimes = { still: 60_000, slow: 60_000, noAnswer: 60_000, tool: 40 };
  await go(spoke.d);
  spoke.d.send('where are we on the research and the report', { raw: 'x' });
  await until(() => !spoke.d.busy, 2000, 'done');
  assert.deepEqual(spoke.spoken, ['Checking the research task.'], "the model's own progress line is enough");
  spoke.d.input.close();
});

test('a short spoken turn with nothing to work out skips thinking, even on the main model', async () => {
  setFixedForTest({ fastModel: 'off' });
  const { d, models } = rig(async function* () {
    yield RESULT;
  });
  await go(d);
  d.send('go on', { raw: 'go on' });
  assert.deepEqual(models, ['think:0'], 'no thinking before the first word');
  await until(() => !d.busy, 1000, 'done');
  d.send('research the best standing desks', { raw: 'x' });
  assert.deepEqual(models, ['think:0', 'think:null'], 'real work thinks as before');
  await until(() => !d.busy, 1000, 'done');
  d.send('go on');
  assert.deepEqual(models, ['think:0', 'think:null'], 'typed: as before');
  await until(() => !d.busy, 1000, 'done');
  d.lastReply = 'Should I start a task for that?';
  d.send('yes', { raw: 'yes' });
  assert.deepEqual(models, ['think:0', 'think:null'], 'a yes to a question about a job is thought about');
  await until(() => !d.busy, 1000, 'done');
  d.input.close();
  setFixedForTest({ fastModel: 'auto' });
});

test('one bare word in a lesson or driving session may go to the quick model, unless the screen is needed', () => {
  const { d } = rig(async function* () {});
  d.computer.run = { app: 'Notes', requests: 1 };
  d.lastReply = 'The note is saved.';
  assert.equal(d.weighTurn('Okay.'), 'quick');
  assert.equal(d.weighTurn('yes'), 'quick');
  assert.equal(d.weighTurn('what does this button do'), 'full', 'anything more is still the main model');
  assert.equal(d.weighTurn('done'), 'full', 'done or next while driving: Echo has to look to go on');
  assert.equal(d.weighTurn('next'), 'full');
  d.lastReply = 'Want me to click Send?';
  assert.equal(d.weighTurn('yes'), 'full', 'an answer to her question is acted on');
  d.lastReply = 'The note is saved.';
  d.computer.job = { goal: 'tidy the notes', at: Date.now(), updatedAt: Date.now() };
  assert.equal(d.weighTurn('okay'), 'full', 'a job still open');
  d.computer.job = null;
  d.computer.pending.set('c1', {});
  assert.equal(d.weighTurn('yes'), 'full', 'a card is waiting');
  d.computer.pending.clear();
  d.computer.run = null;
  d.computer.lesson = { active: true };
  assert.equal(d.weighTurn('okay'), 'quick');
  assert.equal(d.weighTurn('why is that'), 'full', 'a question mid-lesson stays with the main model');
  d.computer.lesson = null;
});
