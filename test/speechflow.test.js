// Faster speaking (clause-sized pieces, a quick acknowledgement), the live task digest, and task
// events that wait for Echo to finish talking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sandbox } from './helpers.js';

sandbox('speechflow');
const { nextSpeechChunk, ackFor, stripLeadingAck, ACKS } = await import('../lib/speech.js');
const { taskDigest, EventLog } = await import('../lib/digest.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

/** Feed text in small deltas, the way the model streams it; returns the spoken pieces. */
function pieces(text, step = 3) {
  const out = [];
  let buf = '';
  let n = 0;
  for (let i = 0; i < text.length; i += step) {
    buf += text.slice(i, i + step);
    let next;
    while ((next = nextSpeechChunk(buf, { first: n === 0 }))) {
      out.push(next.chunk);
      buf = next.rest;
      n++;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

test('the first piece starts at a comma or about seven words, not the end of the sentence', () => {
  const p = pieces('The job search finished, and I found twelve roles that match what you asked for in Hoboken and nearby towns. Three look strong.');
  assert.equal(p[0], 'The job search finished,');
  assert.ok(p.length >= 3);
  // Nothing lost, nothing repeated.
  assert.equal(p.join(' '), 'The job search finished, and I found twelve roles that match what you asked for in Hoboken and nearby towns. Three look strong.');
  for (const piece of p) assert.ok(piece.split(/\s+/).length <= 13, piece);

  const long = pieces('I found twelve roles that match what you asked for in Hoboken and nearby towns today');
  assert.ok(long[0].split(/\s+/).length <= 7, long[0]);
  assert.doesNotMatch(long[0], /\b(the|and|for|in|to|a)$/i, 'never stops on a dangling word');
});

test('short openers and numbers are not split badly', () => {
  assert.equal(nextSpeechChunk('Okay, so', { first: true }), null, 'too short to cut at the comma');
  assert.equal(nextSpeechChunk('It costs 1,200 dollars', { first: true }), null, 'a comma inside a number is not a pause');
  assert.deepEqual(nextSpeechChunk('Done. Next', { first: true }), { chunk: 'Done.', rest: 'Next' });
  assert.deepEqual(nextSpeechChunk('Line one\nLine two'), { chunk: 'Line one', rest: 'Line two' });
});

test('an acknowledgement fits what was said, varies, and stays quiet for small talk', () => {
  assert.ok(ACKS.check.includes(ackFor("how's the job search going")));
  assert.ok(ACKS.do.includes(ackFor('make me a monthly budget spreadsheet')));
  assert.ok(ACKS.think.includes(ackFor('what should I cook for dinner tonight')));
  for (const small of ['thanks', 'hi Echo', 'yes', 'no thanks', 'okay cool', 'thank you so much']) assert.equal(ackFor(small), null, small);
  let last = '';
  for (let i = 0; i < 30; i++) {
    const a = ackFor('check on the website build please');
    assert.notEqual(a, last);
    last = a;
  }
  assert.equal(stripLeadingAck('Sure, the build is green.'), 'the build is green.');
  assert.equal(stripLeadingAck('Okay. It finished.'), 'It finished.');
  assert.equal(stripLeadingAck('Surely not.'), 'Surely not.');
});

test('the digest has status, the last activity line, pending approvals with risk, and recent events', () => {
  const now = Date.parse('2026-09-25T20:00:00Z');
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const list = [
    { id: 3, kind: 'research', project: 'research', title: 'Find entry-level supply chain jobs', status: 'running', lastActivityAt: iso(2), updatedAt: iso(2), log: [{ kind: 'claude', text: 'Searching LinkedIn for Hoboken roles' }, { kind: 'grant', text: 'x' }] },
    { id: 2, kind: 'code', project: 'Budget2', title: 'Fix the totals row', status: 'waiting_approval', updatedAt: iso(5), log: [], pendingApproval: { id: 'a1', level: 'risky', reason: 'git push to origin' } },
    { id: 1, kind: 'research', project: 'research', title: 'Movie times tonight', status: 'done', finishedAt: iso(40), updatedAt: iso(40), summary: 'Three showings after 8. The 8:40 at AMC is best.', log: [] },
    { id: 0, kind: 'code', project: 'Old', title: 'Ancient job', status: 'done', finishedAt: iso(60 * 50), updatedAt: iso(60 * 50), log: [] },
  ];
  const tasks = { list: () => list, isLive: (id) => id === 3, isApprovalPending: () => true };
  const events = new EventLog();
  events.add('#1 finished', iso(40));
  events.add('#2 asked for OK (risky)', iso(5));
  const d = taskDigest(tasks, { now, events: events.list() });
  assert.match(d, /#3 running · Research · "Find entry-level supply chain jobs" · 2 min ago: Searching LinkedIn for Hoboken roles/);
  assert.match(d, /#2 needs OK \(risky\) · Budget2 · "Fix the totals row" · wants to: git push to origin/);
  assert.match(d, /#1 done 40 min ago · Research · "Movie times tonight": Three showings after 8/);
  assert.doesNotMatch(d, /Ancient job/, 'day-old finished tasks drop out');
  assert.match(d, /Recent: 5 min ago #2 asked for OK \(risky\) · 40 min ago #1 finished/);
  assert.ok(d.split('\n').length <= 6, 'compact');
  assert.equal(taskDigest({ list: () => [], isLive: () => false }), '');
});

/** A dispatcher with a fake session input, to see what the model would be sent. */
function rig() {
  const tasks = new TaskManager({ queryFn: async function* () {} });
  const d = new Dispatcher(tasks);
  const sent = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  const spoken = [];
  d.on('speak', (t) => spoken.push(t));
  return { d, tasks, sent, spoken };
}

test('every message carries the fresh task digest', () => {
  const { d, tasks, sent } = rig();
  tasks.tasks.set(7, { id: 7, kind: 'code', project: 'Cardz', title: 'Add dark mode', status: 'running', updatedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), log: [{ kind: 'tool', text: 'Edit styles.css' }] });
  d.send("where are we");
  assert.match(sent[0], /where are we\n\n\[task digest\]\nTasks \(fresh as of this message/);
  assert.match(sent[0], /#7 queued|#7 running|#7 running \(worker not running\)/);
  assert.match(d.systemPrompt(), /\[task digest\]/);
});

test('after an acknowledgement, the tool filler stays quiet and the reply drops its "Sure"', () => {
  const { d, spoken } = rig();
  assert.ok(d.acknowledge('check how the website build is going'));
  d.send('check how the website build is going');
  d.onStreamEvent({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__ops__get_task' } });
  d.onStreamEvent({ type: 'content_block_start', content_block: { type: 'text' } });
  for (const w of 'Sure, the build finished, and every page loads fine now. '.match(/.{1,4}/g)) d.onStreamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: w } });
  d.onStreamEvent({ type: 'content_block_stop' });
  assert.equal(spoken.length, 3, spoken.join(' | '));
  assert.ok(Object.values(ACKS).flat().includes(spoken[0]));
  assert.equal(spoken[1], 'the build finished,');
  assert.equal(spoken[2], 'and every page loads fine now.');
});

test('task events wait until Echo has finished speaking, then open with a transition', async () => {
  const { d, sent } = rig();
  const page = new EventEmitter();
  d.setVoiceBusy(page, true);
  d.notify('Task 4 (Cardz) finished. Spoken summary: Dark mode is in.');
  assert.equal(sent.length, 0, 'held while Echo is speaking');
  d.setVoiceBusy(page, false);
  assert.equal(sent.length, 0, 'a short grace after she stops');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\[event\] Task 4 \(Cardz\) finished/);
  assert.match(sent[0], /short natural transition/);
});

test('an approval answered in the window while Echo was talking is never announced', async () => {
  const { d, sent } = rig();
  const page = {};
  let answered = false;
  d.setVoiceBusy(page, true);
  d.notify('Task 5 wants to do something risky: git push.', { isStale: () => answered });
  answered = true;
  d.setVoiceBusy(page, false);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(sent.length, 0);
  assert.equal(d.busy, false);
});
