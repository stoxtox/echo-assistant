// One id per turn, in every log (lib/trace.ts): hearing, the turn's milestones, model timing and
// computer actions can be joined on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until, serverSource } from './helpers.js';

const dirs = sandbox('trace');
const { newTrace, traceTime, logEvent, eventsFile } = await import('../lib/trace.ts');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('trace ids sort by time and say when they were made', () => {
  const a = newTrace(1_000_000);
  const b = newTrace(2_000_000);
  assert.match(a, /^t-[0-9a-z]+-[0-9a-f]{4}$/);
  assert.ok(a < b || a.length < b.length, 'later ids sort after earlier ones');
  assert.equal(traceTime(a), 1_000_000);
  assert.ok(Number.isNaN(traceTime('nope')));
  assert.notEqual(newTrace(5), newTrace(5), 'two in the same millisecond still differ');
});

test('milestones go to data/events.jsonl, and a bad path never throws', () => {
  const f = eventsFile();
  assert.equal(f, path.join(dirs.data, 'events.jsonl'));
  logEvent({ type: 'first_speech', trace: 't-1-abcd', ms: 420 });
  const last = lines(f).at(-1);
  assert.equal(last.type, 'first_speech');
  assert.equal(last.trace, 't-1-abcd');
  assert.ok(last.at);
  assert.doesNotThrow(() => logEvent({ type: 'first_speech', trace: 'x', ms: 1 }, path.join(dirs.data, 'missing', 'dir', 'e.jsonl')));
});

test("a spoken turn's id reaches the turn's milestones, the timing log and computer actions", async () => {
  const timing = path.join(dirs.data, 'dispatcher-timing.jsonl');
  for (const f of [timing, eventsFile(), path.join(dirs.data, 'state.json')]) fs.rmSync(f, { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quick);
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const _m of prompt) {
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 20_000 } } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'It is sunny today. ' } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'It is sunny today.' }] } };
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {} });
  };
  d.start();
  await until(() => d.q, 1000, 'session');
  const trace = newTrace();
  d.send("what's the weather?", { raw: "what's the weather", trace });
  assert.equal(d.computer.trace, trace, 'computer actions in this turn are stamped with it');
  await until(() => lines(timing).some((l) => l.type === 'turn'), 2000, 'turn logged');

  const turn = lines(timing).find((l) => l.type === 'turn');
  assert.equal(turn.trace, trace);
  assert.ok(lines(timing).filter((l) => l.type === 'request').every((l) => l.trace === trace), 'model calls carry it too');
  const ev = lines(eventsFile()).filter((e) => e.trace === trace);
  assert.deepEqual(ev.map((e) => e.type), ['turn_start', 'first_speech', 'turn_end']);
  assert.equal(ev[0].source, 'speech');
  assert.ok(ev[1].ms >= 0 && ev[1].ms <= ev[2].ms);
  assert.equal(ev[2].spoke, true);

  // A typed message without an id gets its own.
  d.send('and tomorrow?');
  const typed = lines(eventsFile()).filter((e) => e.type === 'turn_start').at(-1);
  assert.equal(typed.source, 'typed');
  assert.notEqual(typed.trace, trace);
  d.input.close();
});

test('the computer-use log stamps each action with the turn id', async () => {
  const { ComputerUse } = await import('../lib/computer.js');
  const logFile = path.join(dirs.data, 'computer-trace.jsonl');
  const c: any = new ComputerUse({ logFile });
  c.newTurn('click the button', { trace: 't-abc-1234' });
  c.record({ event: 'action', action: 'click' });
  c.record({ event: 'action', action: 'type_text', trace: 't-other-0000' });
  const got = lines(logFile);
  assert.equal(got[0].trace, 't-abc-1234');
  assert.equal(got[1].trace, 't-other-0000', 'an explicit id wins');
});

test('the server gives every sentence an id and passes it all the way through', () => {
  const src = serverSource();
  assert.match(src, /const trace = newTrace\(\);\n\s+const logStt = \(e\) => fs\.appendFileSync\(sttLog, JSON\.stringify\(\{ \.\.\.e, trace,/);
  assert.match(src, /audio, stages, rec, trace, mayNotBeForEcho: Boolean\(verdict\.mayNotBeForEcho\), soft: /);
  assert.match(src, /trace \|\|= newTrace\(\);/);
  assert.match(src, /dispatcher\.send\(fixed\.text, \{ raw, unsure: fixed\.unsure, lowOverall, trace, hints: fixed\.hints,/);
  assert.match(src, /dispatcher\.send\(typedText, \{ trace: newTrace\(\) \}, images\)/);
});
