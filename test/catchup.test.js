// "What did I miss?" (lib/catchup.js, the catchUp flag): coming back after a while, Echo says at
// once what happened meanwhile, from what it knows, with no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('catchup');
const { isCatchUpQuestion, catchUpLine } = await import('../lib/catchup.js');
const { Dispatcher } = await import('../lib/dispatcher.js');

test('asking what happened meanwhile, in the ways people do', () => {
  for (const t of ['What did I miss?', 'Catch me up', 'Hey Echo, catch me up.', 'Any updates?', "What's new?", "I'm back", 'Echo, I am back', 'back now', 'Fill me in', 'What happened while I was out?'])
    assert.ok(isCatchUpQuestion(t), t);
  for (const t of ['Did I miss the meeting?', 'Send the updates to Sam', 'Go back to the last page', "What's new in iOS 26?", 'Are there any updates to install?', 'Fill me in on the meeting notes', 'What did I miss in the email from Sam?', 'I am back in the office tomorrow, remind me', 'What happened?', ''])
    assert.ok(!isCatchUpQuestion(t), t);
});

test('what happened, most useful first, in a breath', () => {
  const now = Date.parse('2026-10-02T23:00:00Z');
  const since = now - 2 * 3600_000;
  const at = (min) => new Date(since + min * 60_000).toISOString();
  const { line, count } = catchUpLine({
    since, now, news: 2, busy: false,
    job: { goal: 'Tidy the launch page layout', app: 'Adobe XD' },
    tasks: [
      { title: 'Launch deck', status: 'done', finishedAt: at(30) },
      { title: 'Competitor research', status: 'done', finishedAt: at(70) },
      { title: 'Old thing', status: 'done', finishedAt: at(-30) },
      { title: 'Fix the signup form', status: 'failed', finishedAt: at(40) },
      { title: 'Publish the blog post', status: 'waiting_approval', updatedAt: at(50) },
      { title: 'Weekly report', status: 'running', updatedAt: at(90) },
    ],
  });
  assert.match(line, /^Since .+, 2 tasks finished: Launch deck and Competitor research, one task didn't finish \(Fix the signup form\), Publish the blog post is waiting for your OK, Weekly report is still going\./);
  assert.doesNotMatch(line, /Old thing/, 'only what happened since');
  assert.match(line, /2 updates came in too; ask and I'll go through them\./);
  assert.match(line, /Your job on the Mac in Adobe XD is still open: Tidy the launch page layout\. Say "carry on" to pick it up\./);
  assert.equal(count, 8);
  const quiet = catchUpLine({ since: now - 20 * 60_000, now, tasks: [] });
  assert.equal(quiet.line, "Nothing new since 20 minutes ago. All quiet. What's next?");
  assert.equal(quiet.count, 0);
  assert.match(catchUpLine({ since: now - 10_000, now }).line, /since 1 minute ago/, 'never "1 minutes"');
  assert.equal(catchUpLine({ since: now - 5 * 60_000, now, tasks: [{ title: 'Deck', status: 'failed', finishedAt: new Date(now - 60_000).toISOString() }] }).line, "Since 5 minutes ago, one task didn't finish (Deck).");
  assert.equal(catchUpLine({ since: now - 6 * 3600_000, now, sinceRestart: true }).line, "Nothing new in the last few hours. All quiet. What's next?", 'after a restart, no made-up time');
});

test('answered at once with no model call, and the assistant hears it with the next message', async () => {
  process.env.ECHO_FLAG_CATCHUP = '1';
  try {
    fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
    const done = { id: 1, title: 'Launch deck', status: 'done', finishedAt: new Date().toISOString() };
    const { TaskManager } = await import('../lib/tasks.js');
    const tm = new TaskManager({ queryFn: async function* () {} });
    tm.list = () => /** @type {any} */ ([done]);
    const quick = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
    const d = new Dispatcher(/** @type {any} */ (tm), null, /** @type {any} */ (quick));
    /** @type {string[]} */
    const sent = [];
    /** @type {any} */ (d).queryFn = (/** @type {{ prompt: AsyncIterable<any> }} */ { prompt }) => {
      const q = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's1' };
        for await (const m of prompt) {
          sent.push(typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content));
          yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
        }
      })();
      return Object.assign(q, { setModel: async () => {}, close() {}, interrupt: async () => {} });
    };
    /** @type {string[]} */
    const said = [];
    d.on('say', (text) => said.push(text));
    d.start();
    await until(() => d.q, 1000, 'session');
    d.lastUserAt = Date.now() - 60 * 60_000;
    assert.equal(d.send('What did I miss?', { raw: 'x', trace: 'cu1' }), 'local');
    assert.equal(sent.length, 0, 'no model call');
    assert.match(said[0] ?? '', /one task finished: Launch deck/);
    d.send('Open the launch deck for me please', { raw: 'x' });
    await until(() => sent.length === 1, 1000, 'next message');
    assert.match(sent[0] ?? '', /Echo caught the user up without you: "Since .*Launch deck/);
    assert.match(fs.readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8'), /"type":"catch_up","trace":"cu1","count":1/);
    await until(() => !d.busy, 1000, 'done');
    d.input.close();
  } finally {
    delete process.env.ECHO_FLAG_CATCHUP;
  }
});
