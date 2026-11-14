// Auto-listen after a question (public/autolisten.js): spotting a reply that waits for an answer,
// and the timing of the mic window (only after Echo's voice has fully died away, closing quietly
// when nobody speaks). Plus the dispatcher's own "this reply asks something" mark, and the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, pageSource } from './helpers.js';

sandbox('autolisten');
const { awaitsAnswer, lastSentence, autoListenMs, AutoListen, AUTO_LISTEN_DEFAULT_MS } = await import('../public/autolisten.js');
const { getSettings, saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { fakeQuery } = await import('./helpers.js');

test('a reply that ends with a question waits for an answer', () => {
  for (const t of [
    'Should I send it?',
    'Which one?',
    'Found two Sams. Which one do you mean?',
    'The draft is ready. Want me to send it?',
    'Done. Should I open it for you?"',
    'I can book 7 or 8. Which works better? ',
    'Three roles look strong. Want me to save the list?)',
  ]) assert.equal(awaitsAnswer(t), true, t);
});

test('an offer or choice without a question mark still counts; statements and mid-reply questions do not', () => {
  for (const t of ['Want me to send it.', 'Should I go ahead…', 'Let me know which one you want.', 'Tell me which time works.', 'Your call.'])
    assert.equal(awaitsAnswer(t), true, t);
  for (const t of [
    '',
    'Done, the message is sent.',
    'Should I send it? Never mind, it already went.',
    'Want to know the best part? It worked first time. All green now.',
    'The build is green.',
    'Who knows?',
    'Opening Chrome…',
    "Sorry, I didn't catch that.",
  ]) assert.equal(awaitsAnswer(t), false, t);
});

test('lastSentence takes the final sentence, trimmed', () => {
  assert.equal(lastSentence('It worked. Want me to open it?'), 'Want me to open it?');
  assert.equal(lastSentence('  One.  Two!  '), 'Two!');
  assert.equal(lastSentence('"Quoted?"'), '"Quoted?');
  assert.equal(lastSentence(''), '');
});

test('the window length: 8 seconds, clamped; it and listening during runs are fixed', () => {
  assert.equal(AUTO_LISTEN_DEFAULT_MS, 8000);
  assert.equal(autoListenMs(undefined), 8000);
  assert.equal(autoListenMs('x'), 8000);
  assert.equal(autoListenMs(0), 0);
  assert.equal(autoListenMs(-5), 0);
  assert.equal(autoListenMs(500), 2000);
  assert.equal(autoListenMs(12000), 12000);
  assert.equal(autoListenMs(999999), 20000);
  assert.equal(getSettings().autoListenMs, 8000);
  assert.equal(getSettings().listenDuringRuns, true);
  // Neither is a setting any more: a saved value is ignored.
  assert.equal(saveSettings({ autoListenMs: 0, listenDuringRuns: false }).autoListenMs, 8000);
  assert.equal(getSettings().listenDuringRuns, true);
});

/** A manual clock for the window's timers. */
function clock() {
  let now = 0;
  let seq = 0;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    get pending() {
      return timers.size;
    },
  };
}

/** An AutoListen on a manual clock, recording what it does. */
function listener(opts = {}) {
  const c = clock();
  const events = [];
  const a = new AutoListen({
    windowMs: 8000,
    tailMs: 450,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onOpen: (mode) => events.push(`open:${mode}`),
    onClose: (reason, mode) => events.push(`close:${reason}:${mode}`),
    ...opts,
  });
  return { a, c, events };
}

test('it opens only after Echo has finished and the echo tail has passed, then closes quietly after the window', () => {
  const { a, c, events } = listener();
  a.speechStarted();
  assert.equal(a.speechEnded({ question: true }), true);
  assert.equal(a.state, 'pending');
  c.advance(449);
  assert.equal(a.isOpen, false, 'not while the room still carries her voice');
  c.advance(1);
  assert.equal(a.isOpen, true);
  assert.deepEqual(events, ['open:answer']);
  c.advance(7999);
  assert.equal(a.isOpen, true);
  c.advance(1);
  assert.equal(a.isOpen, false);
  assert.deepEqual(events, ['open:answer', 'close:timeout:answer'], 'nobody spoke: it closes by itself');
  assert.equal(c.pending, 0);
});

test('no question, or the setting off: the mic stays shut', () => {
  const { a, c, events } = listener();
  assert.equal(a.speechEnded({ question: false }), false);
  c.advance(10000);
  assert.deepEqual(events, []);
  const off = listener({ windowMs: 0 });
  assert.equal(off.a.speechEnded({ question: true }), false);
  off.c.advance(10000);
  assert.deepEqual(off.events, []);
});

test('speaking inside the window keeps it open until the answer is sent', () => {
  const { a, c, events } = listener();
  a.speechEnded({ question: true });
  c.advance(450 + 3000);
  assert.equal(a.heard(), true);
  assert.equal(a.state, 'hearing');
  c.advance(20000);
  assert.equal(a.state, 'hearing', 'a long answer is never cut off by the window');
  a.answered();
  assert.equal(a.isOpen, false);
  assert.deepEqual(events, ['open:answer', 'close:answered:answer']);
});

test('a click or cough is not an answer: back to waiting, with a short deadline', () => {
  const { a, c, events } = listener();
  a.speechEnded({ question: true });
  c.advance(450 + 7000);
  a.heard();
  a.notSpeech();
  assert.equal(a.state, 'open');
  c.advance(2999);
  assert.equal(a.isOpen, true);
  c.advance(1);
  assert.deepEqual(events, ['open:answer', 'close:timeout:answer']);
});

test("Echo's own voice is never captured: talking again closes the window, or stops it opening", () => {
  const { a, c, events } = listener();
  a.speechEnded({ question: true });
  c.advance(200);
  a.speechStarted(); // another piece of the reply (or an update) starts during the tail
  c.advance(10000);
  assert.deepEqual(events, [], 'never opened');
  a.speechEnded({ question: true });
  c.advance(450);
  assert.equal(a.isOpen, true);
  a.speechStarted();
  assert.equal(a.isOpen, false);
  assert.deepEqual(events, ['open:answer', 'close:speaking:answer']);
  // And open() itself refuses while she speaks.
  assert.equal(a.open('answer'), false);
});

test('canOpen can veto (mic off, push-to-talk held, a dialog open)', () => {
  let allowed = false;
  const { a, c, events } = listener({ canOpen: () => allowed });
  a.speechEnded({ question: true });
  c.advance(1000);
  assert.deepEqual(events, []);
  assert.equal(a.state, 'closed');
  allowed = true;
  a.speechEnded({ question: true });
  c.advance(450);
  assert.deepEqual(events, ['open:answer']);
});

test('while Echo drives, it listens between her words with no time limit, and stops when the run ends', () => {
  const { a, c, events } = listener();
  a.setDriving(true);
  assert.equal(a.isOpen, true);
  assert.equal(a.mode, 'run');
  c.advance(60000);
  assert.equal(a.isOpen, true, 'no time-out during a run');
  a.speechStarted(); // "Opening Chrome…"
  assert.equal(a.isOpen, false);
  a.speechEnded({ question: false }); // no question needed mid-run
  c.advance(450);
  assert.equal(a.isOpen, true);
  a.heard();
  a.answered(); // "no, search for otters instead" went off
  assert.equal(a.isOpen, true, 'still listening for the next thing');
  a.setDriving(false);
  assert.equal(a.isOpen, false);
  assert.deepEqual(events, ['open:run', 'close:speaking:run', 'open:run', 'close:run_ended:run']);
});

test('the run ending mid-sentence lets the sentence finish', () => {
  const { a, events } = listener();
  a.setDriving(true);
  a.heard();
  a.setDriving(false);
  assert.equal(a.state, 'hearing');
  a.answered();
  assert.equal(a.isOpen, false);
  assert.deepEqual(events, ['open:run', 'close:answered:run']);
});

test('the dispatcher marks a reply that ends with a question', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }));
  d.input = /** @type {any} */ ({ push() {}, size: 0 });
  const marks = [];
  d.on('reply_end', (m) => marks.push(m.awaitsReply));
  const stream = (text) => {
    d.onMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: `m${marks.length}` } } });
    d.onMessage({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    for (let i = 0; i < text.length; i += 4) d.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + 4) } } });
    d.onMessage({ type: 'stream_event', event: { type: 'content_block_stop' } });
    d.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: 's' });
  };
  stream('The draft is ready. Want me to send it?');
  stream('Sent it to Sam.');
  // Not streamed (a whole message at once).
  d.onMessage({ type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: 'Which one, the 7 or the 9?' }] } });
  d.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: 's' });
  // A turn with no text at all.
  d.onMessage({ type: 'result', subtype: 'success', total_cost_usd: 0, session_id: 's' });
  assert.deepEqual(marks, [true, false, true, false]);
});

test('the page wires it up: after her audio ends, with the echo tail, no chime, and the soft cue', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const app = pageSource();
  assert.match(app, /from '\/autolisten\.js'/);
  assert.match(app, /autoListen\.speechEnded\(\{ question \}\)/, 'decided when her speech has fully ended');
  assert.match(app, /tailMs: ECHO_TAIL_MS/, 'waits out the echo tail');
  assert.match(app, /case 'reply_end'/);
  const opened = app.slice(app.indexOf('function autoOpened'), app.indexOf('function autoClosed'));
  assert.doesNotMatch(opened, /sfx\(/, 'no chime when it opens');
  assert.match(app, /auto-listening/);
  assert.match(app, /Listening…/);
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /body\.auto-listening #viz \{ animation: auto-listen-pulse/);
});

test("the answer window knows when it closes, for the Mac app's mic to close it too", () => {
  let now = 50_000;
  const timers = [];
  const a = new AutoListen({ windowMs: 8000, tailMs: 0, now: () => now, setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} });
  assert.equal(a.until, 0);
  a.open('answer');
  assert.equal(a.until, 58_000);
  a.heard();
  assert.equal(a.until, 0, 'you are talking: it stays open until you finish');
  now += 1000;
  a.notSpeech();
  assert.equal(a.until, 54_000, 'a cough: a short while longer');
  a.close('timeout');
  assert.equal(a.until, 0);
  a.setDriving(true);
  assert.equal(a.until, 0, 'during a run it does not run out');
});
