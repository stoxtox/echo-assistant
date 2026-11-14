// The turn engine (Stage 3): turns are numbered and kept apart. A second message while the first
// reply is still streaming is its own turn, recorded with its own reply, timing and trace; the
// first turn's end never closes the second one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('turns');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

/** A model that answers each message after `delayMs`, in order, like the real session. */
function rig(delayMs = 120) {
  for (const f of ['state.json', 'dispatcher-timing.jsonl', 'events.jsonl']) fs.rmSync(path.join(dirs.data, f), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quick);
  let n = 0;
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const m of prompt) {
        n++;
        const said = String(m?.message?.content || '').match(/\] (.*?)(?:\n|$)/)?.[1] || 'x';
        const r = `Reply ${n} to ${said}.`;
        const id = `m${n}`;
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } };
        await new Promise((res) => setTimeout(res, delayMs));
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: r } } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } };
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
        yield { type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: r }] } };
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {}, interrupt: async () => {} });
  };
  return d;
}
const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a second message mid-reply is its own turn: both recorded with their own reply, timing and trace', async () => {
  const d = rig();
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('first question', { raw: 'first question', trace: 't-a-0001' });
  await new Promise((r) => setTimeout(r, 30));
  d.send('second question', { raw: 'second question', trace: 't-b-0002' });
  assert.equal(d.busy, true);
  await until(() => lines(path.join(dirs.data, 'dispatcher-timing.jsonl')).filter((l) => l.type === 'turn').length === 2, 3000, 'two turns logged');
  const turns = lines(path.join(dirs.data, 'dispatcher-timing.jsonl')).filter((l) => l.type === 'turn');
  assert.deepEqual(turns.map((t) => t.trace), ['t-a-0001', 't-b-0002'], 'each turn ends with its own id, in order');
  const state = JSON.parse(fs.readFileSync(path.join(dirs.data, 'state.json'), 'utf8'));
  const ex = state.exchanges.slice(-2);
  assert.deepEqual(ex.map((e: any) => e.user), ['first question', 'second question']);
  assert.match(ex[0].echo, /Reply 1 to first question/);
  assert.match(ex[1].echo, /Reply 2 to second question/);
  await until(() => !d.busy, 1000, 'idle');
  const ends = lines(path.join(dirs.data, 'events.jsonl')).filter((e) => e.type === 'turn_end');
  assert.deepEqual(ends.map((e) => e.trace), ['t-a-0001', 't-b-0002']);
  d.input.close();
});

test('busy stays on until the last turn is done (the first turn ending does not end the second)', async () => {
  const d = rig(150);
  const busy: boolean[] = [];
  d.on('busy', (b: boolean) => busy.push(b));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('one', { raw: 'one' });
  await new Promise((r) => setTimeout(r, 20));
  d.send('two', { raw: 'two' });
  await until(() => lines(path.join(dirs.data, 'dispatcher-timing.jsonl')).filter((l) => l.type === 'turn').length >= 1, 3000, 'first done');
  assert.equal(d.busy, true, 'still busy: the second turn is under way');
  await until(() => !d.busy, 3000, 'all done');
  assert.equal(busy.filter((b) => b === false).length, 1, 'idle once, at the very end');
  d.input.close();
});

test('a new session takes over what the old one never read; stale ones are dropped', async () => {
  const { InputQueue } = await import('../lib/queue.js');
  const old = new InputQueue();
  const dropped: string[] = [];
  old.push('what the user just said');
  old.push('an approval already answered', 'next', { isStale: () => true, onDrop: () => dropped.push('stale') });
  const next = new InputQueue();
  old.handOver(next);
  old.close();
  assert.equal(old.size, 0);
  assert.equal(next.size, 1);
  assert.deepEqual(dropped, ['stale']);
  const it = next[Symbol.asyncIterator]();
  assert.equal((await it.next()).value?.message?.content, 'what the user just said');
  next.close();
});

test('the dispatcher keeps waiting turns apart from a fresh conversation, which drops everything', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'dispatcher.js'), 'utf8');
  assert.match(src, /this\.replaceInput\(\{ keep: false \}\);/, 'a new conversation carries nothing over');
  assert.equal((src.match(/this\.replaceInput\(\);/g) || []).length, 2, 'rotation and reload carry unread input over');
});
