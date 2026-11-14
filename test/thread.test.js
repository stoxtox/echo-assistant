// One thread (lib/thread.js, lib/heardreport.js, lib/explain.js paced): Echo keeps where it and
// the user are, knows what of its last reply was never heard, and walks through things at the
// user's pace. Oct 7, 2026: "next point" made it read the screen again, a riddle cut off by the
// user's voice was taken as heard, and "one by one" got six points at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, wait } from './helpers.js';

sandbox('thread');
const { ThreadKeeper, THREAD_MS } = await import('../lib/thread.js');
const { heardNote } = await import('../lib/heardreport.js');
const { VoiceState, estimateMs } = await import('../lib/voicestate.js');
const { Explainer } = await import('../lib/explain.js');
const { Dispatcher, asksQuiet } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

test('the thread: a list, the one they are on, what is done, and what "next" means', () => {
  let now = 1_000_000;
  const k = new ThreadKeeper({ now: () => now });
  assert.equal(k.note(), '');
  k.keep({ doing: 'going through three Claude chats', items: ['Stoxtox errors', 'Dashboard redesign', 'Echo architecture'], where: 'Claude' });
  k.keep({ at: 0 });
  assert.match(k.note(), /1\. Stoxtox errors \[NOW\]; 2\. Dashboard redesign \[to do\]; 3\. Echo architecture \[to do\]/);
  assert.match(k.note(), /"Next" means number 2\./);
  k.keep({ at: 1 });
  assert.deepEqual(k.current?.done, [0], 'moving on marks the one before as done');
  k.keep({ at: 2, draft: 'Go ahead and merge.' });
  assert.match(k.note(), /1\. Stoxtox errors \[done\]; 2\. Dashboard redesign \[done\]; 3\. Echo architecture \[NOW\]/);
  assert.match(k.note(), /NOT sent yet: "Go ahead and merge\."\. "Send it" means this, as it is\./);
  assert.match(k.note(), /Never go over a done one again unless they ask/);
  k.keep({ draft: '' });
  assert.ok(!k.note().includes('NOT sent yet'));
  k.keep({ done: [2], at: -1 });
  assert.match(k.note(), /Everything on it is handled\./);
  // New items start a new thread; a quiet quarter of an hour ends it.
  k.keep({ doing: 'reading a job page', items: ['Pay', 'Hours'] });
  assert.deepEqual(k.current?.done, []);
  now += THREAD_MS + 1;
  assert.equal(k.current, null);
  assert.equal(k.note(), '');
});

test('the thread rides with the user\'s message, and keep_thread counts from one', async () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const sent = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  const tool = d.allTools().find((t) => t.name === 'keep_thread');
  assert.ok(tool);
  const r = await tool.handler({ doing: 'going through Claude\'s reply', items: ['The XD test', 'Build from 25', 'Keep an eye on it'], at: 1 }, {});
  assert.match(r.content[0].text, /0 of 3 done, on number 1, next is number 2/);
  d.send('alright, next point');
  assert.match(sent.at(-1), /\(thread: going through Claude's reply\./);
  assert.match(sent.at(-1), /"Next" means number 2\./);
  await tool.handler({ clear: true }, {});
  d.busy = false;
  d.send('thanks');
  assert.ok(!sent.at(-1).includes('(thread:'));
  const prompt = d.systemPrompt();
  assert.match(prompt, /Keep the thread\./);
  assert.match(prompt, /One thing at a time means one\./);
  assert.match(prompt, /Look before you say it's there\./);
});

test('what was heard of the last reply: the part cut off or never spoken is said plainly', () => {
  const all = [{ text: 'Here is a tough one.', fate: 'heard' }, { text: 'What has keys but cannot open locks?', fate: 'cut' }, { text: 'Take your time.', fate: 'unsaid' }];
  const note = heardNote(/** @type {any} */ (all));
  assert.match(note, /They heard: "Here is a tough one\."\./);
  assert.match(note, /They did NOT hear all of: "What has keys but cannot open locks\? Take your time\."/);
  assert.equal(heardNote(/** @type {any} */ (all.map((l) => ({ ...l, fate: 'heard' })))), '', 'all heard: nothing to say');
  assert.equal(heardNote(/** @type {any} */ (all.map((l) => ({ ...l, fate: 'unsaid' })))), '', 'the voice is off: they read it');
  assert.match(heardNote(/** @type {any} */ ([{ text: 'One.', fate: 'cut' }, { text: 'Two.', fate: 'pending' }])), /They heard none of it\./);
  assert.equal(heardNote([]), '');
});

test('the voice tracker knows each line\'s fate', () => {
  let now = 10_000;
  const v = new VoiceState({ now: () => now, setTimer: () => 0, clearTimer: () => {} });
  const full = v.line('A full sentence that plays to its end.'), cut = v.line('A sentence that is stopped almost at once by the user.'), never = v.line('Never begun.');
  assert.equal(v.fate(never), 'pending');
  v.event({ event: 'start', id: full }, 'page');
  now += estimateMs(38);
  v.event({ event: 'end', id: full, last: true }, 'page');
  assert.equal(v.fate(full), 'heard');
  v.event({ event: 'start', id: cut }, 'page');
  now += 300;
  v.event({ event: 'queued', id: never }, 'page');
  v.event({ event: 'idle', id: never }, 'page'); // the page hushed: everything it had is over
  assert.equal(v.fate(cut), 'cut');
  assert.equal(v.fate(never), 'unsaid');
  assert.equal(v.fate('v999'), 'unknown');
});

test('one by one: each piece waits for "next", a question pauses it where it is, and it can go on from there', async () => {
  const saidLines = [], moved = [];
  const computer = /** @type {any} */ ({ voice: { whenDone: async () => ({}) }, speak: (t) => (saidLines.push(t), 'v1'), blocked: null, emit() {}, run: null });
  const ex = new Explainer({ bridge: null, computer, beatMs: 5, pacedWaitMs: 400 });
  const chunks = [{ say: 'First point.', key: 'One', target: '' }, { say: 'Second point.', key: 'Two', target: '' }, { say: 'Third point.', key: 'Three', target: '' }];
  const walk = ex.run(chunks, { paced: true, onMove: (i) => moved.push(i) });
  await wait(60);
  assert.deepEqual(saidLines, ['First point.'], 'it stops after one and waits');
  assert.equal(ex.hear('next'), true);
  await wait(60);
  assert.deepEqual(saidLines, ['First point.', 'Second point.']);
  // Something that is not one of its commands: it pauses there and the words go to the assistant.
  assert.equal(ex.hear('wait, what does that mean?'), false);
  const r = await walk;
  assert.deepEqual([r.ended, r.at, r.total], ['interrupted', 2, 3]);
  // Going on: from the third, never from the top.
  const rest = await ex.run(chunks, { paced: true, startAt: 2, onMove: (i) => moved.push(i) });
  assert.deepEqual(saidLines, ['First point.', 'Second point.', 'Third point.']);
  assert.equal(rest.ended, 'finished');
  assert.deepEqual(moved, [0, 1, 2]);
  // Left alone, a paced walk ends where it is and says so.
  // (Its wait does not keep a process alive by itself, so the test waits alongside it.)
  const [alone] = await Promise.all([new Explainer({ bridge: null, computer, beatMs: 5, pacedWaitMs: 40 }).run(chunks, { paced: true }), wait(150)]);
  assert.deepEqual([alone.ended, alone.at], ['waiting', 1]);
  // Without "one by one" it goes through by itself, as before.
  saidLines.length = 0;
  assert.equal((await ex.run(chunks, {})).ended, 'finished');
  assert.equal(saidLines.length, 3);
});

test('"just type it" is not quiet mode', () => {
  for (const t of ["Don't tell me by reading, just type it and let it report us back", 'just type that into Claude', 'type it instead of clicking']) assert.equal(asksQuiet(t), false, t);
  for (const t of ['just type to me', 'type instead of talking', 'quiet mode', "I can't talk right now"]) assert.equal(asksQuiet(t), true, t);
});

test('a quick turn that is certainly for Echo says so, so the quick model does not call it "not for me"', async () => {
  const { FAST_NOTE, SURE_NOTE, FAST_PROMPT, stripNotes } = await import('../lib/dispatcher.js');
  assert.match(FAST_PROMPT, /^\(for you\): this message was said to you on purpose, for certain\. Answer it; never reply \[quiet\] to it/);
  assert.equal(stripNotes(`Hello\n${SURE_NOTE}\n${FAST_NOTE}`), 'Hello', 'the note is never said or shown');
  const src = (await import('node:fs')).readFileSync(new URL('../lib/dispatcher.js', import.meta.url), 'utf8');
  assert.match(src, /\$\{rec\?\.mayQuiet \? `\\n\$\{QUIET_NOTE\}` : fast \? `\\n\$\{SURE_NOTE\}` : ''\}/);
});
