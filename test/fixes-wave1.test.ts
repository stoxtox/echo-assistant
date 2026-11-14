// What the review of wave 1 found in the turn engine (lib/dispatcher.js) and at quitting:
// a picture sent while a reply was being written was closed as "answered by that reply" every
// time, and then answered on its own with no turn to its name; words the quick model was holding
// were said after "stop"; a "[quiet]" turn left no trace of a dropped sentence; and Quit could
// turn into a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until, serverSource } from './helpers.js';

const dirs = sandbox('fixes-wave1');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

const ev = (event: any) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const start = (id: string) => ev({ type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } });
const blockStart = ev({ type: 'content_block_start', content_block: { type: 'text' } });
const delta = (text: string) => ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const blockStop = ev({ type: 'content_block_stop' });
const stop = ev({ type: 'message_stop' });
const whole = (id: string, text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } });
const reply = (id: string, text: string) => [start(id), blockStart, delta(text), blockStop, stop, whole(id, text)];
const RESULT = { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
const STOPPED = { type: 'result', subtype: 'error_during_execution', session_id: 's1', total_cost_usd: 0 };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const picture = () => {
  const img = path.join(dirs.data, 'pic.png');
  fs.writeFileSync(img, Buffer.from(PNG, 'base64'));
  return [{ path: img, mime: 'image/png', data: PNG }];
};
const jsonl = (f: string): any[] => (fs.existsSync(path.join(dirs.data, f)) ? fs.readFileSync(path.join(dirs.data, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const state = () => JSON.parse(fs.readFileSync(path.join(dirs.data, 'state.json'), 'utf8'));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A session like the Agent SDK's: it reads every message the moment it is pushed, and answers as
 * `script` says. Only the first session follows the script (a rotation would start a second one).
 */
function rig(script: (read: string[], d: any) => AsyncGenerator<any>) {
  for (const f of ['state.json', 'events.jsonl', 'dispatcher-timing.jsonl']) fs.rmSync(path.join(dirs.data, f), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  const read: string[] = [];
  let sessions = 0;
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const mine = ++sessions;
    (async () => {
      for await (const m of prompt) if (mine === 1) read.push(JSON.stringify(m.message.content));
    })();
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: `s${mine}` };
      if (mine === 1) yield* script(read, d);
      else await new Promise(() => {});
    })();
    return Object.assign(q, { setModel: async () => {}, setMaxThinkingTokens: async () => {}, close() {}, interrupt: async () => {} });
  };
  d.summaryQueryFn = () =>
    (async function* () {
      yield { type: 'result', subtype: 'success', result: 'SUMMARY', total_cost_usd: 0 };
    })();
  const spoken: string[] = [];
  const shown: string[] = [];
  const dropped: any[] = [];
  d.on('speak', (t: string) => spoken.push(t));
  d.on('say_delta', (t: string) => shown.push(t));
  d.on('say', (t: string) => shown.push(t));
  d.on('dropped', (e: any) => dropped.push(e));
  d.on('error', () => {});
  return { d, read, spoken, shown, dropped, sessions: () => sessions };
}
const go = async (d: any) => {
  d.start();
  await until(() => d.q, 1000, 'session');
};

/* ---------- 1. a picture sent mid-reply is its own turn ---------- */

test('a picture sent while the reply is being written is NOT closed with that reply: it stays busy, keeps its turn, ends once', async () => {
  let sessionsBeforeItsReply = 0;
  const r = rig(async function* (read) {
    await until(() => read.length === 1, 2000, 'first read');
    yield start('m1');
    yield blockStart;
    yield delta('Here is ');
    // The picture arrives now: the session reads it at once, but this model call never saw it.
    await until(() => read.length === 2, 2000, 'picture read');
    yield delta('the list.');
    yield blockStop;
    yield stop;
    yield whole('m1', 'Here is the list.');
    yield RESULT;
    // The session answers the picture on its own, a moment later.
    await pause(150);
    sessionsBeforeItsReply = r.sessions();
    yield* reply('m2', '[quiet]');
    yield RESULT;
    await until(() => read.length === 3, 2000, 'what was said in the gap goes in next');
    yield* reply('m3', 'You are welcome.');
    yield RESULT;
    await new Promise(() => {});
  });
  const { d, spoken, shown, dropped } = r;
  // Due for a new session after every turn: it must still wait for the picture's reply.
  d.limits = { ...d.limits, turns: 1 };
  await go(d);
  d.send('What is on the list for today', { raw: 'x', trace: 'p1' });
  await until(() => d.turn?.textSeen, 2000, 'the reply is under way');
  d.send('And what is this', { trace: 'p2', mayNotBeForEcho: true }, picture());
  await until(() => d.turn?.trace === 'p2', 2000, 'the picture is the turn under way once the first reply ends');
  assert.equal(d.busy, true, 'no idle gap');
  assert.deepEqual(jsonl('events.jsonl').filter((e) => e.type === 'turn_end').map((e) => e.trace), ['p1'], 'only the first turn has ended');
  // Said in the gap: it waits its turn instead of starting one the picture's reply would land in.
  d.send('Thanks', { raw: 'x', trace: 'p3' });
  assert.equal(d.turn?.trace, 'p2');
  d.limits = { ...d.limits, turns: 1000 };
  await until(() => !d.busy && state().exchanges?.length === 3, 3000, 'all three answered');

  assert.equal(sessionsBeforeItsReply, 1, 'the session was not replaced while a message had no reply');
  const ends = jsonl('events.jsonl').filter((e) => e.type === 'turn_end');
  assert.deepEqual(ends.map((e) => e.trace), ['p1', 'p2', 'p3'], 'exactly one turn_end per turn, in order');
  assert.ok(ends.every((e) => !e.folded), 'none closed as folded');
  assert.equal(ends[1].quiet, true);
  assert.doesNotMatch(spoken.join(' ') + shown.join(''), /quiet/, '"[quiet]" is never said or shown');
  const ex = state().exchanges;
  assert.deepEqual(ex.map((e: any) => [e.user, e.echo]), [['What is on the list for today', 'Here is the list.'], ['And what is this', ''], ['Thanks', 'You are welcome.']], 'each reply against its own turn');
  assert.deepEqual(dropped, [{ reason: 'quiet', trace: 'p2' }]);
  d.input.close();
});

test('a message read BEFORE the reply\'s last model call is covered by it: closed once, and a late answer of its own gets a new turn', async () => {
  const r = rig(async function* (read) {
    await until(() => read.length === 2, 2000, 'both read');
    // A tool call came back: the next model call has both messages in front of it.
    yield start('m1');
    yield stop;
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__ops__list_tasks', input: {} }] } };
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [] }] } };
    yield* reply('m2', 'Here is the answer to both.');
    yield RESULT;
    await pause(60);
    // And then, after all, a reply to the second one alone.
    yield* reply('m3', '[quiet]');
    yield RESULT;
    await new Promise(() => {});
  });
  const { d, spoken, shown } = r;
  await go(d);
  d.send('First thing', { raw: 'x', trace: 'c1' });
  d.send('Second thing', { trace: 'c2', mayNotBeForEcho: true }, picture());
  await until(() => !d.busy && state().exchanges?.length === 2, 3000, 'both replies recorded');
  const ends = jsonl('events.jsonl').filter((e) => e.type === 'turn_end');
  assert.equal(ends.filter((e) => e.trace === 'c1').length, 1);
  assert.deepEqual(ends.filter((e) => e.trace === 'c2').map((e) => [e.folded, e.into]), [[true, 'c1']], 'the folded turn ends exactly once');
  assert.equal(ends.length, 3, 'the late reply ended as a turn of its own');
  const adopted = jsonl('dispatcher-timing.jsonl').find((l) => l.type === 'reply_adopted');
  assert.equal(adopted.from, 'c2');
  assert.notEqual(adopted.trace, 'c2');
  assert.doesNotMatch(spoken.join(' ') + shown.join(''), /quiet/, 'its "[quiet]" is not said: it kept what the folded turn was allowed');
  d.input.close();
});

/* ---------- 4. words the quick model was holding ---------- */

test('held quick-model words are not said after "stop", after a reply that failed, or when the stream is tried again', async () => {
  setFixedForTest({ fastModel: 'auto' });
  // "Stop" while the first words are held: the stream runs on for a moment, then ends interrupted.
  let gate = () => {};
  const a = rig(async function* (read) {
    await until(() => read.length === 1, 2000, 'read');
    yield start('m1');
    yield blockStart;
    yield delta('Doing well, thanks. ');
    await new Promise<void>((res) => (gate = res));
    yield delta('And you?');
    yield blockStop;
    yield stop;
    yield STOPPED;
    await new Promise(() => {});
  });
  await go(a.d);
  a.d.send('how are you today?', { raw: 'x', trace: 'h1' });
  assert.equal(a.d.onQuickModel(), true, 'a quick turn');
  await until(() => a.d.handHold?.text, 1000, 'first words held');
  await a.d.hushNow();
  gate();
  await until(() => !a.d.busy, 2000, 'ended');
  assert.deepEqual([a.spoken, a.shown], [[], []], 'nothing said or shown after stop');
  a.d.input.close();

  // The reply failed before its message ended.
  const b = rig(async function* (read) {
    await until(() => read.length === 1, 2000, 'read');
    yield start('m1');
    yield blockStart;
    yield delta('Doing well, ');
    yield STOPPED;
    await new Promise(() => {});
  });
  await go(b.d);
  b.d.send('how are you today?', { raw: 'x', trace: 'h2' });
  await until(() => !b.d.busy && jsonl('events.jsonl').some((e) => e.type === 'turn_end'), 2000, 'ended');
  assert.deepEqual([b.spoken, b.shown], [[], []], 'half a sentence from a failed reply is not said');
  assert.equal(b.d.handHold, null);
  b.d.input.close();

  // The stream broke off and was tried again: only the second try's words are said, once.
  const c = rig(async function* (read) {
    await until(() => read.length === 1, 2000, 'read');
    yield start('m1');
    yield blockStart;
    yield delta('Doing we');
    yield start('m1b');
    yield blockStart;
    yield delta('Doing well, thanks.');
    yield blockStop;
    yield stop;
    yield whole('m1b', 'Doing well, thanks.');
    yield RESULT;
    await new Promise(() => {});
  });
  await go(c.d);
  c.d.send('how are you today?', { raw: 'x', trace: 'h3' });
  await until(() => !c.d.busy && jsonl('events.jsonl').some((e) => e.type === 'turn_end'), 2000, 'ended');
  assert.deepEqual(c.spoken, ['Doing well, thanks.']);
  assert.equal(c.shown.join(''), 'Doing well, thanks.');
  assert.ok(jsonl('dispatcher-timing.jsonl').some((l) => l.type === 'held_text_cleared' && l.trace === 'h3' && l.chars === 8), 'logged by length, never the words');
  c.d.input.close();
  setFixedForTest({ fastModel: 'off' });
});

/* ---------- 8. "[quiet]" is a sentence dropped ---------- */

test('a turn the assistant answered with [quiet] is logged as dropped (reason quiet, its trace) and the page is told', async () => {
  const r = rig(async function* (read) {
    await until(() => read.length === 1, 2000, 'read');
    yield* reply('m1', '[quiet]');
    yield RESULT;
    await until(() => read.length === 2, 2000, 'read');
    yield* reply('m2', 'It is sunny.');
    yield RESULT;
    await new Promise(() => {});
  });
  await go(r.d);
  r.d.send('so I told him about the trip', { raw: 'so I told him about the trip', trace: 'q1', mayNotBeForEcho: true });
  await until(() => !r.d.busy && jsonl('events.jsonl').some((e) => e.type === 'turn_end'), 2000, 'done');
  assert.deepEqual(r.dropped, [{ reason: 'quiet', trace: 'q1' }]);
  const line = jsonl('events.jsonl').find((e) => e.type === 'dropped');
  assert.deepEqual([line.reason, line.trace, Object.keys(line).sort()], ['quiet', 'q1', ['at', 'reason', 'trace', 'type']], 'the reason and the trace, never the words');
  // An ordinary reply is not a drop.
  r.d.send('what is the weather', { raw: 'x', trace: 'q2' });
  await until(() => !r.d.busy && jsonl('events.jsonl').filter((e) => e.type === 'turn_end').length === 2, 2000, 'done');
  assert.equal(r.dropped.length, 1);
  r.d.input.close();
  assert.match(serverSource(), /dispatcher\.on\('dropped', \(\{ reason, trace \}\) => broadcast\(\{ type: 'dropped', reason/, 'the server passes it on to the page');
});

/* ---------- 6. quit ---------- */

test('Quit always stops for good: a restart under way or a task that cannot be paused does not keep Echo up', async () => {
  const { quitAfter } = await import('../lib/server/quit.js');
  let stops = 0;
  const error = console.error;
  console.error = () => {};
  try {
    await quitAfter(async () => {
      throw new Error('a task would not pause');
    }, () => void stops++);
  } finally {
    console.error = error;
  }
  assert.equal(stops, 1, 'stopped although pausing failed');
  await quitAfter(async () => {}, () => void stops++);
  assert.equal(stops, 2);
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'server.js'), 'utf8');
  const quit = src.slice(src.indexOf('async function quit()'), src.indexOf("process.on('SIGINT'"));
  assert.doesNotMatch(quit, /if \(restarting\) return/, 'a restart under way does not swallow the quit');
  assert.match(quit, /quitAfter\(async \(\) => \{\s*const checkpointed = await tasks\.checkpointAll\(\);/, 'running tasks are paused (to resume) before it stops');
});
