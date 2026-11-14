// Natural speaking (whole-sentence pieces, no canned acknowledgement), the live task digest, and task
// events that wait for Echo to finish talking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sandbox } from './helpers.js';

sandbox('speechflow');
const speech = await import('../lib/speech.js');
const { nextSpeechChunk } = speech;
const dispatcherModule = await import('../lib/dispatcher.js');
const { vizStateFor } = await import('../public/ui/mark.js');
const { captionStatus } = await import('../public/caption.js');
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

test('the voice gets whole sentences, and the first one goes as soon as it is written', () => {
  // The old clause-sized pieces ("The job search finished,") made each one sound like a finished
  // thought, read out word by word. A piece is one or more whole sentences; the first goes on its
  // own at once, so the voice starts while the rest is written. A tiny opener waits for the next.
  assert.deepEqual(pieces("Hey there! What's up?"), ["Hey there! What's up?"], 'a tiny opener goes with the next sentence');
  assert.deepEqual(pieces("Yep, all done. Nothing's running right now."), ['Yep, all done.', "Nothing's running right now."], 'the first sentence goes at once');

  const reply = 'The job search finished, and I found twelve roles that match what you asked for in Hoboken. Three look strong, and two of them are remote. Want me to send you the list?';
  const p = pieces(reply);
  assert.equal(p[0], 'The job search finished, and I found twelve roles that match what you asked for in Hoboken.', 'never cut at the first comma');
  for (const piece of p) assert.match(piece, /[.!?]$/, `ends a sentence: ${piece}`);
  assert.equal(p.join(' '), reply, 'nothing lost, nothing repeated');

  const later = pieces('Done. The file is saved in your research folder. I also added a short summary at the top, so you can skim it. Want me to email it to Sam? He asked about it yesterday.');
  assert.equal(later[0], 'Done. The file is saved in your research folder.', 'two short sentences together');
  for (const piece of later) assert.match(piece, /[.!?]$/, piece);
});

test('only a long sentence is cut, at a comma, and never on a dangling word', () => {
  const long = 'Okay, so the website build finished about ten minutes ago, and every page loads fine on my end, including the new pricing page and the updated signup form.';
  const p = pieces(long);
  assert.equal(p[0], 'Okay, so the website build finished about ten minutes ago,', 'a long first sentence starts at its first good comma');
  assert.equal(p.join(' '), long);

  const runOn = Array.from({ length: 50 }, (_, i) => (i === 44 ? 'the' : `word${i}`)).join(' ') + ' ';
  const cut = nextSpeechChunk(runOn);
  assert.ok(cut, 'a run-on with no sentence end is cut eventually');
  assert.ok(cut.chunk.split(/\s+/).length <= 36, cut.chunk);
  assert.doesNotMatch(cut.chunk, /\b(the|and|for|in|to|a)$/i, 'never stops on a dangling word');
});

test('numbers and abbreviations are not sentence ends, and a lone short opener waits for the next', () => {
  assert.equal(nextSpeechChunk('Okay, so', { first: true }), null);
  assert.equal(nextSpeechChunk('Done. Next', { first: true }), null, 'a short first sentence waits for the second');
  assert.deepEqual(nextSpeechChunk('Done. The tests pass. More', { first: true }), { chunk: 'Done. The tests pass.', rest: 'More' });
  assert.deepEqual(nextSpeechChunk('Version 1.5 costs 1,200 dollars, e.g. for teams. Dr. Smith agreed. Then', { first: true }), { chunk: 'Version 1.5 costs 1,200 dollars, e.g. for teams.', rest: 'Dr. Smith agreed. Then' });
  assert.deepEqual(nextSpeechChunk('Here are three:\nFirst one\nSecond', { first: true }), { chunk: 'Here are three:', rest: 'First one\nSecond' }, 'line breaks end a piece');
  assert.equal(nextSpeechChunk('The tests pass', { first: true }), null, 'half a sentence waits');
  assert.deepEqual(nextSpeechChunk('The tests pass. And', { first: true }), { chunk: 'The tests pass.', rest: 'And' }, 'a whole first sentence goes at once');
});

test('there are no canned acknowledgements or fillers left to speak', () => {
  for (const name of ['ACKS', 'ackFor', 'stripLeadingAck']) assert.equal(speech[name], undefined, name);
  for (const name of ['FILLERS', 'fillerFor']) assert.equal(dispatcherModule[name], undefined, name);
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
  assert.doesNotMatch(d, /Movie times tonight/, 'finished over 15 minutes ago: only counted');
  assert.match(d, /\+1 older finished today \(list_tasks or get_task has them\)/);
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
  assert.match(sent[0], /where are we\n\[model\] [^\n]+\n\n\[task digest\]\nTasks \(fresh as of this message/);
  assert.match(sent[0], /#7 queued|#7 running|#7 running \(worker not running\)/);
  assert.match(d.systemPrompt(), /\[task digest\]/);
});

const STOCK = /^(sure|okay|ok|got it|on it|hmm|alright|right|one sec|let me (look|check|see)|checking|hang on|yep|ooh)( now| on it| one sec)?[.!,…]*$/i; // a line that says nothing

test('the moment the user stops talking, only the visual cue fires: nothing is spoken', () => {
  const { d, spoken } = rig();
  let cues = 0;
  d.on('thinking', () => cues++);
  for (const said of ["how's the job search going", 'make me a monthly budget spreadsheet', 'what should I cook for dinner tonight', 'check on the website build please']) {
    d.heard();
    d.send(said);
  }
  assert.equal(cues, 4);
  assert.deepEqual(spoken, [], 'no acknowledgement is spoken');
  // The sunset and the caption bar show thinking straight away.
  assert.equal(vizStateFor({ heard: true }), 'thinking');
  assert.equal(vizStateFor({ heard: true, speaking: true }), 'speaking');
  assert.equal(vizStateFor({ heard: true, listening: true }), 'listening');
  assert.equal(vizStateFor({}), 'idle');
  assert.equal(captionStatus({ busy: true }), 'Thinking…');
});

test('a tool call says no filler; progress speech comes only from the model stream, once', () => {
  const { d, spoken } = rig();
  const say = (text) => {
    d.onStreamEvent({ type: 'content_block_start', content_block: { type: 'text' } });
    for (const w of text.match(/.{1,4}/g)) d.onStreamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: w } });
    d.onStreamEvent({ type: 'content_block_stop' });
  };
  d.send('check how the Fortuna staging site is doing');
  // Straight to a tool: silence (the visual cue covers it), never a stock phrase.
  d.onStreamEvent({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__ops__get_task' } });
  assert.deepEqual(spoken, []);
  // The model's own first sentence goes to the voice before the next tool runs.
  say("Checking Fortuna's staging.");
  assert.deepEqual(spoken, ["Checking Fortuna's staging."]);
  d.onStreamEvent({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'WebFetch' } });
  // Said again after the tools: not repeated.
  say("Checking Fortuna's staging. Staging is up, and the login page loads fine now.");
  assert.deepEqual(spoken, ["Checking Fortuna's staging.", 'Staging is up, and the login page loads fine now.']);
  for (const s of spoken) assert.doesNotMatch(s, STOCK);
  // The next turn (after this one's reply ends) may say the same line again.
  d.onMessage({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0 });
  d.send('and again please, check the staging');
  say("Checking Fortuna's staging.");
  assert.equal(spoken.at(-1), "Checking Fortuna's staging.");
});

test('each piece carries the one before it, so the voice keeps the intonation going', () => {
  const { d } = rig();
  const got = [];
  d.on('speak', (text, o) => got.push({ text, prev: o?.prev }));
  d.send('tell me about the job search results please');
  d.onStreamEvent({ type: 'content_block_start', content_block: { type: 'text' } });
  const reply = 'The job search finished, and I found twelve roles that match what you asked for in Hoboken. Three of them look strong, and two are remote. The list is in your research folder.';
  for (const w of reply.match(/.{1,5}/g)) d.onStreamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: w } });
  d.onStreamEvent({ type: 'content_block_stop' });
  assert.ok(got.length >= 2, JSON.stringify(got));
  assert.equal(got[0].prev, '');
  for (let i = 1; i < got.length; i++) assert.equal(got[i].prev, got[i - 1].text);
});

test('a spoken bare "." or whitespace never reaches the assistant', () => {
  const { d, sent } = rig();
  d.send('.', { raw: '.' });
  d.send('  ', {});
  d.send(' ?! ', { raw: ' ?! ' });
  assert.equal(sent.length, 0);
  assert.equal(d.busy, false);
  d.send('?', {}); // typed on purpose: goes through
  assert.equal(sent.length, 1);
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
