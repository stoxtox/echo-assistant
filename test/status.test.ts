// "Can you hear me?" always gets an answer (lib/status.js): asked while Echo is
// busy, it's answered at once from what Echo knows, never queued behind the slow reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('status');
const { isStatusQuestion, statusLine, gist, howLong } = await import('../lib/status.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

test('questions about Echo itself, as they were really asked', () => {
  for (const q of ['Echo, can you able to hear me?', 'Can you able to hear me?', "Echo, what's happening?", 'Hey Echo, what\'s happening? Why are you not answering to me?', 'Hey Echo, where did you go?', "What's happening? Why not listen to me?", 'Hey, are you listening to me?', 'Are you there?', 'what are you doing'])
    assert.ok(isStatusQuestion(q), q);
  for (const q of ['Can you check that for me?', 'Open a new chat in Claude', 'What did you find about it?', 'hear me out on the design', 'Research more about C5 and C6 and tell me what is happening with the launch plan and the scanner and the date', ''])
    assert.ok(!isStatusQuestion(q), q);
});

test('the answer: what it is on, how long, what it waits for, what is next', () => {
  assert.equal(howLong(40_000), '40 seconds');
  assert.equal(howLong(65_000), '1 minute');
  assert.equal(howLong(75_000), '1 minute 15 seconds');
  assert.equal(gist('Open a new chat and make sure the work folder is Fortuna2 please and thanks'), 'Open a new chat and make sure the work…');
  assert.equal(
    statusLine({ busy: true, request: 'Open a new chat in Claude.', sinceMs: 40_000, waitingForModel: true, waiting: 2 }),
    'Yes, I hear you. I\'m still on "Open a new chat in Claude", waiting for the model to answer, 40 seconds so far. 2 of your messages are next. Say stop to cancel it.',
  );
  assert.match(statusLine({ busy: true, request: 'x', sinceMs: 5000, retry: { attempt: 3, error: 'overloaded' } }), /the model is busy, so I'm retrying \(try 3\)/);
  assert.match(statusLine({ busy: true, request: 'x', driving: { app: 'Claude' }, activity: 'click “New” in Claude' }), /working in Claude: click “New” in Claude/);
  assert.match(statusLine({ busy: false }), /not working on anything/);
});

function rig(extra: any[] = []) {
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  const gates: Array<() => void> = [];
  const sent: string[] = [];
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const m of prompt) {
        sent.push(String(m.message.content));
        for (const e of extra) yield e;
        await new Promise<void>((r) => gates.push(r));
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {}, interrupt: async () => {} });
  };
  return { d, sent, release: () => gates.shift()?.() };
}

test('while busy: answered at once, not queued, with the retry it is waiting on', async () => {
  const { d, sent, release } = rig([{ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded', session_id: 's1' }]);
  d.slowTimes = { still: 60_000, slow: 60_000, noAnswer: 60_000 };
  const said: string[] = [];
  d.on('say', (t: string) => said.push(t));
  d.on('speak', (t: string) => said.push(t));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('Open a new chat in Claude', { raw: 'x', trace: 'r1' });
  await until(() => said.some((t) => /trying again/.test(t)), 1000, 'the retry said once');
  assert.equal(d.send('Echo, can you able to hear me?', { raw: 'x', trace: 'r2' }), 'local');
  assert.equal(d.waitingTurns.length, 0, 'not queued');
  assert.equal(sent.length, 1, 'no model call for it');
  const answer = said.find((t) => t.startsWith('Yes, I hear you.')) || '';
  assert.match(answer, /still on "Open a new chat in Claude", and the model is busy, so I'm retrying \(try 2\)/);
  assert.equal(said.filter((t) => /trying again/.test(t)).length, 1, 'the retry is said once a turn');
  release();
  await until(() => !d.busy, 1000, 'done');
  const timing = fs.readFileSync(path.join(dirs.data, 'dispatcher-timing.jsonl'), 'utf8');
  assert.match(timing, /"type":"api_retry"[^\n]*"attempt":2[^\n]*"error":"overloaded"[^\n]*"status":529/);
  d.input.close();
});

test("a plan limit reached is said at once", async () => {
  const { d, release } = rig([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.round(Date.now() / 1000) + 3600 }, session_id: 's1' }]);
  const said: string[] = [];
  d.on('speak', (t: string) => said.push(t));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('hello there', { raw: 'x' });
  await until(() => said.some((t) => /reached your Claude plan's usage limit until/.test(t)), 1000, 'limit said');
  release();
  await until(() => !d.busy, 1000, 'done');
  d.input.close();
});
