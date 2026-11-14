// Talking while Echo is busy (Oct 2, driving the Claude app): replies took 15-78 s to start, and
// each sentence said meanwhile became its own queued turn, answered one to three turns late; "Can
// you check that for me?" said three times was answered three times. What's said while a reply is
// under way waits and joins together (one reply), a repeat isn't added, and a slow reply is talked
// about. This is the only path now (it was the calmQueue flag).
//
// And the session can answer two messages with ONE reply (Oct 3): the turns it covered all end
// with it, so Echo goes idle instead of waiting for a reply that never comes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('calmqueue');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

/** A dispatcher whose model answers each message only when `release()` is called. */
function rig() {
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  const sent: string[] = [];
  const gates: Array<() => void> = [];
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const m of prompt) {
        sent.push(typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content));
        await new Promise<void>((r) => gates.push(r));
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {}, interrupt: async () => {} });
  };
  const release = () => gates.shift()?.();
  return { d, sent, release };
}

test('said while a reply is under way: one message, one reply, a repeat not added', async () => {
  const { d, sent, release } = rig();
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('On the cloud desktop there is another session going on for Echo', { raw: 'x', trace: 't1' });
  await until(() => sent.length === 1, 1000, 'first');
  d.send('Can you check that for me?', { raw: 'x', trace: 't2' });
  d.send('Can you check that for me?', { raw: 'x', trace: 't3' });
  d.send('Also look at the other chat.', { raw: 'x', trace: 't4' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1, 'nothing more goes in while the reply is under way');
  assert.equal(d.waitingTurns.length, 1, 'one waiting turn, not three');
  release();
  await until(() => sent.length === 2, 1000, 'the waiting ones, together');
  const next = sent[1] ?? '';
  assert.equal(next.match(/Can you check that for me\?/g)?.length, 1, 'the repeat is not added');
  assert.match(next, /Can you check that for me\?[\s\S]*Said a moment later[\s\S]*Also look at the other chat\./);
  release();
  await until(() => !d.busy, 1000, 'done');
  const events = fs.readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"repeat_held","trace":"t3"/);
  assert.match(events, /"type":"merged","trace":"t4","into":"t2"/);
  d.input.close();
});

test('a slow reply is talked about: still working, then slow with what is waiting', async () => {
  const { d, sent, release } = rig();
  d.slowTimes = { still: 40, slow: 90, noAnswer: 5000 };
  const spoken: string[] = [];
  d.on('speak', (t: string) => spoken.push(t));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('Check the other session', { raw: 'x', trace: 'a1' });
  await until(() => sent.length === 1, 1000, 'sent');
  d.send('Hello?', { raw: 'x', trace: 'a2' });
  await until(() => spoken.length >= 2, 2000, 'two lines');
  assert.equal(spoken[0], 'Still working on that.');
  assert.equal(spoken[1], 'This is taking a while, and one more message is waiting. Say stop to cancel.');
  release();
  await until(() => sent.length === 2, 1000, 'the waiting one');
  release();
  await until(() => !d.busy, 1000, 'done');
  d.input.close();
});

test('a repeat is the same ask in other words; more words, or the opposite, is not a repeat', async () => {
  const { sayingOf } = await import('../lib/dispatcher.js');
  assert.equal(sayingOf('Can you check that for me?'), sayingOf('check that'));
  assert.equal(sayingOf('Hey Echo, can you please check that again?'), sayingOf('Check that.'));
  assert.notEqual(sayingOf("Don't send it"), sayingOf('send it'), 'the opposite is new');
  assert.notEqual(sayingOf('Can you check that'), sayingOf('Can you check that and the Jira board'), 'more asked is new (it was dropped as a repeat before)');
  assert.notEqual(sayingOf('check the mail'), sayingOf('check the main'));
  assert.equal(sayingOf('Okay.'), 'okay', 'all filler: still something to compare');
});

test('"stop" while busy drops what was waiting too, and nothing more goes in', async () => {
  const { d, sent, release } = rig();
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('Look at the other session', { raw: 'x', trace: 'b1' });
  await until(() => sent.length === 1, 1000, 'first');
  d.send('Also check the mail', { raw: 'x', trace: 'b2' });
  assert.ok(d.nextUp, 'held');
  await d.send('stop', { raw: 'x', trace: 'b3' });
  assert.equal(d.nextUp, null, 'what was waiting is dropped');
  assert.equal(d.waitingTurns.length, 0);
  release();
  await until(() => !d.busy, 1000, 'done');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1, 'the waiting message never went in');
  assert.match(fs.readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8'), /"type":"next_dropped","trace":"b2","count":1/);
  d.input.close();
});

test('a picture sent while sentences wait goes in after them, in order', async () => {
  const { d, sent, release } = rig();
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('Look at the other session', { raw: 'x', trace: 'c1' });
  await until(() => sent.length === 1, 1000, 'first');
  d.send('Also check the mail', { raw: 'x', trace: 'c2' });
  const img = path.join(dirs.data, 'p.png');
  fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  d.send('What is this?', { trace: 'c3' }, [{ path: img, mime: 'image/png', data: fs.readFileSync(img).toString('base64') }]);
  assert.equal(d.nextUp, null, 'the held sentence went in first');
  for (let i = 0; i < 3; i++) {
    release();
    await new Promise((r) => setTimeout(r, 30));
  }
  await until(() => sent.length === 3, 1000, 'all three');
  assert.match(sent[1] ?? '', /Also check the mail/);
  assert.match(sent[2] ?? '', /What is this\?/);
  release();
  await until(() => !d.busy, 1000, 'done');
  d.input.close();
});

test('a stop the user made themselves is not talked about: the assistant hears it with their next message', async () => {
  const { serverSource } = await import('./helpers.js');
  const src = serverSource();
  assert.match(src, /computer\.on\('aborted'[\s\S]{0,400}dispatcher\.noteForNext\(/);
  assert.doesNotMatch(src, /Say so in a few words and don't carry on unless they ask again/);
  const { d, sent, release } = rig();
  d.start();
  await until(() => d.q, 1000, 'session');
  d.noteForNext('(Echo stopped using the computer because the user stopped it (said stop).)');
  assert.equal(sent.length, 0, 'no turn of its own');
  d.send('Summarize the launch plan for me', { raw: 'x' });
  await until(() => sent.length === 1, 1000, 'next message');
  assert.match(sent[0] ?? '', /user stopped it \(said stop\)[\s\S]*Summarize the launch plan/);
  release();
  await until(() => !d.busy, 1000, 'done');
  d.input.close();
});

/** A session like the Agent SDK's: it reads what is queued at once, and answers as `script` says. */
function foldRig(script: (read: string[]) => AsyncGenerator<any>) {
  for (const f of ['state.json', 'events.jsonl', 'dispatcher-timing.jsonl']) fs.rmSync(path.join(dirs.data, f), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} } as any), null, quick);
  const read: string[] = [];
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    // Reads ahead, as the SDK does: every message is taken the moment it is pushed.
    (async () => {
      for await (const m of prompt) read.push(JSON.stringify(m.message.content));
    })();
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      yield* script(read);
    })();
    return Object.assign(q, { setModel: async () => {}, close() {}, interrupt: async () => {} });
  };
  return { d, read };
}
const reply = (id: string, text: string) => [
  { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } } },
  { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } },
  { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
  { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } },
  { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
  { type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } },
];
const RESULT = { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const picture = () => {
  const img = path.join(dirs.data, 'fold.png');
  fs.writeFileSync(img, Buffer.from(PNG, 'base64'));
  return [{ path: img, mime: 'image/png', data: PNG }];
};
const events = () => fs.readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('two messages read, ONE reply: both turns end, nothing is left waiting, and Echo goes idle', async () => {
  const { d, read } = foldRig(async function* (read) {
    await until(() => read.length === 2, 2000, 'both read');
    // A tool came back, and the model call that writes the reply goes out with both in front of it.
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu0', content: [] }] } };
    yield* reply('m1', 'Here is the answer to both.');
    yield RESULT;
    await new Promise(() => {}); // the session has nothing more to say
  });
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('What is on the list for today', { raw: 'x', trace: 'f1' });
  d.send('And what is this', { trace: 'f2' }, picture());
  assert.equal(d.waitingTurns.length, 1, 'the second waits for a reply of its own');
  await until(() => !d.busy, 2000, 'idle after the one reply');
  assert.equal(read.length, 2);
  assert.equal(d.turn, null);
  assert.deepEqual(d.waitingTurns, [], 'no phantom turn');
  const ends = events().filter((e) => e.type === 'turn_end');
  assert.deepEqual(ends.map((e) => e.trace).sort(), ['f1', 'f2'], 'both turns logged as ended, once each');
  assert.deepEqual(ends.find((e) => e.trace === 'f2')?.into, 'f1', 'the folded one says which reply covered it');
  const state = JSON.parse(fs.readFileSync(path.join(dirs.data, 'state.json'), 'utf8'));
  assert.match(state.exchanges.at(-1).user, /on the list for today \/ And what is this/, 'one exchange for the one reply');
  // The next thing said is an ordinary turn again: not queued behind a phantom.
  d.send('Thanks', { raw: 'x', trace: 'f3' });
  assert.equal(d.waitingTurns.length, 0);
  assert.equal(d.turn?.trace, 'f3');
  d.input.close();
});

test('two messages read, but answered one by one (the first reply\'s model call never saw the second): the second keeps its own turn', async () => {
  const { d } = foldRig(async function* (read) {
    await until(() => read.length === 2, 2000, 'both read');
    yield* reply('m1', 'First answer.');
    yield RESULT;
    await new Promise((r) => setTimeout(r, 60));
    yield* reply('m2', 'Second answer.');
    yield RESULT;
    await new Promise(() => {});
  });
  const busy: boolean[] = [];
  d.on('busy', (b: boolean) => busy.push(b));
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('First thing', { raw: 'x', trace: 'g1' });
  d.send('Second thing', { trace: 'g2' }, picture());
  await until(() => JSON.parse(fs.readFileSync(path.join(dirs.data, 'state.json'), 'utf8')).exchanges?.length === 2, 2000, 'both replies recorded');
  await until(() => !d.busy, 1000, 'idle');
  const state = JSON.parse(fs.readFileSync(path.join(dirs.data, 'state.json'), 'utf8'));
  assert.match(state.exchanges[1].user, /Second thing/);
  assert.match(state.exchanges[1].echo, /Second answer/, 'logged against its own turn');
  assert.equal(busy.at(-1), false);
  const ends = events().filter((e) => e.type === 'turn_end');
  assert.deepEqual(ends.map((e) => [e.trace, Boolean(e.folded)]), [['g1', false], ['g2', false]], 'each ended exactly once, as itself');
  assert.equal(busy.filter((b) => !b).length, 1, 'busy the whole time: no gap between the two replies');
  d.input.close();
});

test('busy with nothing to be busy with (no turn, none waiting, nothing unread) clears itself', async () => {
  const { d } = foldRig(async function* () {
    await new Promise(() => {});
  });
  d.idleCheckMs = 30;
  d.start();
  await until(() => d.q, 1000, 'session');
  d.setBusy(true);
  assert.equal(d.turn, null);
  await until(() => !d.busy, 1000, 'cleared');
  assert.match(fs.readFileSync(path.join(dirs.data, 'dispatcher-timing.jsonl'), 'utf8'), /"type":"busy_cleared"/);
  // A real turn under way is left alone.
  d.send('Tell me about the plan', { raw: 'x' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(d.busy, true);
  d.input.close();
});

test('the flag is gone: this is the only path', async () => {
  const { FLAGS } = await import('../lib/flags.ts');
  assert.ok(!('calmQueue' in FLAGS));
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'dispatcher.js'), 'utf8');
  assert.doesNotMatch(src, /flagOn\('calmQueue'\)/);
});
