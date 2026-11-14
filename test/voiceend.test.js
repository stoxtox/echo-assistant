// Echo knows when its own voice starts and stops (lib/voicestate.js). The page says what happens
// to each line the server asked for ({type:'voice', event, id, …}), and what used to count from a
// line's length now counts from its real end: a lesson's pauses, the help ladder's idle time, the
// first movement of a step Echo shows. A fake page sends the events here (and one never does);
// clocks and timers are fake where time matters. Nothing touches a real voice, screen or app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { sandbox, until, wait, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('voiceend');
const { VoiceState, estimateMs, leadStartMs, median, VOICE_HANG_MS, START_DELAYS } = await import('../lib/voicestate.js');
const T = await import('../lib/teach.js');
const { TeachSession, spokenMs, SHOW_PACE, TEACH_STORY_QUIET_MS, TEACH_PRAISE_MS } = T;
const { LADDER_IDLE_MS } = await import('../lib/ladder.js');
const { ComputerUse } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { pageConnection } = await import('../lib/server/window.js');
const { readTimeline } = await import('../lib/timeline.ts');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

const flush = () => new Promise((r) => setImmediate(r));

/** A clock that only moves when told to, with its own timers. */
function fakeClock(t = 1_000_000) {
  /** @type {Array<{ fn: () => void, at: number }>} */
  let timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const x = { fn, at: t + Math.max(0, ms) };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => { timers = timers.filter((y) => y !== x); },
    /** Time passes: every timer due on the way fires at its own moment. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((y) => y !== next);
        t = Math.max(t, next.at);
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

/** A voice on a fake clock, and a promise's state without waiting for it. */
function fakeVoice() {
  const clock = fakeClock();
  const voice = new VoiceState(clock);
  return { clock, voice };
}
const settled = async (p) => {
  let out;
  p.then((r) => { out = r; });
  await flush();
  return out;
};

/* ---------- the tracker ---------- */

test('a line is over when the page says its last piece ended, not when its length says so', async () => {
  const { clock, voice } = fakeVoice();
  const line = 'Click the blue button.';
  const id = voice.line(line);
  assert.match(id, /^v\d+$/);
  const done = voice.whenDone(id);
  const from = clock.now();
  voice.event({ event: 'queued', id }, 'page');
  assert.equal(voice.speaking, true);
  await clock.advance(700);
  voice.event({ event: 'start', id, chars: line.length, ms: 100, fresh: true }, 'page');
  // Long past what its length would take: the voice is slow today, and it is still talking.
  await clock.advance(estimateMs(line.length) + 2000);
  assert.equal(await settled(done), undefined, 'still being said');
  voice.event({ event: 'end', id, chars: 10, ms: 900 }, 'page');
  assert.equal(await settled(done), undefined, 'a piece ended, not the line');
  voice.event({ event: 'end', id, chars: 12, ms: 900, last: true }, 'page');
  assert.deepEqual(await settled(done), { at: clock.now(), heard: true });
  assert.equal(voice.lastEndAt, clock.now());
  assert.equal(clock.now() - from, 700 + estimateMs(line.length) + 2000);
  assert.deepEqual(await voice.whenDone(id), { at: clock.now(), heard: true }, 'asked again later: the same answer, at once');
  assert.equal(voice.speaking, true, 'until the page says nothing is queued or playing');
  voice.event({ event: 'idle', id }, 'page');
  assert.equal(voice.speaking, false);
});

test('with no page (or the voice off) a line counts as over after the time its length would take', async () => {
  const { clock, voice } = fakeVoice();
  const id = voice.line('Open the File menu.');
  const est = estimateMs('Open the File menu.'.length);
  assert.equal(est, 300 + 65 * 19);
  const done = voice.whenDone(id);
  await clock.advance(est - 1);
  assert.equal(await settled(done), undefined);
  await clock.advance(1);
  assert.deepEqual(await settled(done), { at: clock.now(), heard: false });
  assert.deepEqual(await voice.whenDone('v999'), { at: clock.now(), heard: false }, 'a line nobody asked for: nothing to wait for');
  assert.equal(estimateMs(0), 0);
});

test('a line the page took and never finished cannot hang anything: it is over a few seconds past its length', async () => {
  const { clock, voice } = fakeVoice();
  const before = readTimeline(dirs.data).filter((e) => e.type === 'voice.unheard').length;
  const id = voice.line('Now drag it across.');
  const est = estimateMs(19);
  const done = voice.whenDone(id);
  const short = voice.whenDone(id, 500);
  voice.event({ event: 'queued', id }, 'page');
  await clock.advance(500);
  assert.deepEqual(await settled(short), { at: clock.now(), heard: false }, 'a limit of the caller\'s own');
  await clock.advance(est);
  assert.equal(await settled(done), undefined, 'the page has it: past its length, it still waits for the real end');
  await clock.advance(est + VOICE_HANG_MS);
  assert.equal((await settled(done)).heard, false, 'and then no longer');
  const rows = readTimeline(dirs.data).filter((e) => e.type === 'voice.unheard');
  assert.equal(rows.length, before + 1, 'the timeline says so');
  assert.deepEqual(Object.keys(rows.at(-1).f).sort(), ['chars', 'id', 'ms'], 'numbers and the line\'s name only, never the words');
  assert.equal(rows.at(-1).f.id, id);
});

test('when the page goes quiet, every line it was given is over; one it has not received yet is not', async () => {
  const { clock, voice } = fakeVoice();
  const a = voice.line('First line.'), b = voice.line('Second line.');
  const doneA = voice.whenDone(a), doneB = voice.whenDone(b);
  voice.event({ event: 'queued', id: a }, 'page');
  voice.event({ event: 'queued', id: b }, 'page');
  // The user cut in: the page hushed, nothing ended. A third line is on its way to the page.
  const c = voice.line('Third line.');
  const doneC = voice.whenDone(c);
  const quiet = voice.whenQuiet(5000);
  assert.equal(await settled(quiet), undefined, 'not quiet yet');
  await clock.advance(100);
  voice.event({ event: 'idle', id: b }, 'page');
  assert.deepEqual(await settled(doneA), { at: clock.now(), heard: false });
  assert.deepEqual(await settled(doneB), { at: clock.now(), heard: false });
  assert.equal(await settled(doneC), undefined, 'the page had not been given this one when it went quiet');
  assert.equal(await settled(quiet), true);
  assert.equal(await voice.whenQuiet(), true, 'nothing is being said: at once');
  // Something that waits for quiet never waits for ever, and a page that goes away is quiet.
  voice.event({ event: 'queued', id: c }, 'page');
  const never = voice.whenQuiet(300);
  await clock.advance(300);
  assert.equal(await settled(never), false);
  const gone = voice.whenQuiet(5000);
  voice.gone('page');
  assert.equal(await settled(gone), true);
  // Nonsense from a page changes nothing.
  for (const bad of [null, {}, { event: 'end', id: 'x; drop', last: true }, { event: 'start', id: 7 }, { event: 'boo', id: c }]) voice.event(/** @type {any} */ (bad), 'page');
  assert.equal(voice.speaking, false);
});

/* ---------- the start-up delay ---------- */

test('the start-up delay is the median of the last ten lines that had nothing ahead of them', async () => {
  const { clock, voice } = fakeVoice();
  assert.equal(voice.startDelayMs(), 0, 'nothing heard yet: nothing to make up for');
  const say = async (delay, o = { fresh: true }) => {
    const id = voice.line('A line.');
    await clock.advance(delay - 50);
    voice.event({ event: 'start', id, chars: 7, ms: 50, ...o }, 'page'); // audible 50 ms after the page says so
    voice.event({ event: 'end', id, last: true }, 'page');
  };
  await say(400);
  assert.equal(voice.startDelayMs(), 400);
  await say(600);
  await say(500);
  assert.equal(voice.startDelayMs(), 500);
  await say(4000, { fresh: false });
  assert.equal(voice.startDelayMs(), 500, 'a line that waited behind another says nothing about the start-up');
  await say(9000);
  assert.equal(voice.startDelayMs(), 500, 'nor does a stall');
  for (let k = 0; k < START_DELAYS; k++) await say(700 + k);
  assert.equal(voice.delays.length, START_DELAYS);
  assert.equal(voice.startDelayMs(), 704, 'only the latest ten count');
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2);
});

test('words held for the light are asked for early by the start-up delay, so word and light land together', () => {
  assert.equal(leadStartMs(900, 400), 500, 'a 900 ms flight, a voice that takes 400 ms: ask 500 ms after the light left');
  assert.equal(leadStartMs(300, 400), 0, 'a flight shorter than the delay: at once');
  assert.equal(leadStartMs(900, 0), 900, 'no delay known: as the light lands');
  assert.equal(leadStartMs(0, 400), 0);
  assert.equal(leadStartMs(/** @type {any} */ (undefined), 400), 0);
  assert.equal(leadStartMs(900, -50), 900);
});

/* ---------- lesson pacing on the real end ---------- */

const WHY = 'That switch is what the whole panel hangs on.';
const lesson = (o = {}) => ({
  goal: 'turn them on',
  steps: ['Alpha', 'Bravo', 'Charlie'].map((name, k) => ({ say: `Turn on ${name}.`, target: name, ...(k === 0 ? { why: WHY } : {}), check: { kind: 'element_state', label: name, checked: true } })),
  ...o,
});

/**
 * A lesson on a fake clock and a fake screen whose lines go to a voice tracker. `page`: 'none'
 * (no page attached: nothing is ever reported) or 'manual' (the test plays the page: `h.end(line)`).
 */
function harness(plan, page = 'manual') {
  const clock = fakeClock();
  const voice = new VoiceState(clock);
  let screen = {};
  /** @type {Array<{ id: string, text: string, at: number }>} */
  const sent = [];
  const reports = [];
  const adapter = {
    async snapshot({ elements = [] }) {
      return { cells: {}, ui: { app: 'Settings' }, elements: Object.fromEntries(elements.map((l) => [l, { present: true, value: screen[l] ? '1' : '0' }])) };
    },
  };
  const s = new TeachSession({
    adapter, id: 'L',
    // As lib/computer.js does it: the line gets its id, and the lesson is told when it ended.
    say: (text) => {
      const id = voice.line(text);
      sent.push({ id, text, at: clock.now() });
      if (page === 'manual') voice.event({ event: 'queued', id }, 'page');
      return voice.whenDone(id).then((r) => r.at);
    },
    report: (r) => reports.push(r),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    autoPoll: false,
  });
  s.start(plan);
  const h = {
    s, voice, clock, sent, reports,
    said: () => sent.map((x) => x.text),
    last: () => sent.at(-1)?.text,
    async tick(ms = T.TEACH_POLL_MS) { await clock.advance(ms); await s.poll(); },
    /** Time passes in polls, as it does for a running lesson. */
    async pass(ms) { for (let left = ms; left > 0; left -= 500) await h.tick(Math.min(500, left)); },
    /** The page: the voice has finished this line (the latest by default). */
    async end(text = h.last()) {
      const line = sent.findLast((x) => x.text === text);
      voice.event({ event: 'start', id: line.id, chars: text.length, ms: 0 }, 'page');
      voice.event({ event: 'end', id: line.id, chars: text.length, ms: 1, last: true }, 'page');
      voice.event({ event: 'idle', id: line.id }, 'page');
      await flush();
    },
    on(name) { screen[name] = true; },
  };
  return h;
}

test('the quiet after a story counts from when the story was really told', async () => {
  const h = harness(lesson());
  await h.tick(0);
  assert.equal(h.last(), 'Turn on Alpha.');
  await h.end();
  await h.tick(3000);
  h.on('Alpha');
  for (let k = 0; k < 4 && h.last() !== WHY; k++) await h.tick();
  await h.pass(TEACH_PRAISE_MS + 1000);
  assert.equal(h.last(), WHY, 'the story, once the result has sat');
  assert.equal(h.s.storyGap, true);
  // The voice takes far longer over it than its length says: nothing follows while it is told.
  await h.pass(spokenMs(WHY) + TEACH_STORY_QUIET_MS + 3000);
  assert.equal(h.last(), WHY, 'still telling it: the next step waits');
  await h.end(WHY);
  await h.pass(TEACH_STORY_QUIET_MS - 500);
  assert.equal(h.last(), WHY, 'then quiet, counted from its end');
  assert.equal(h.s.storyGap, true);
  await h.pass(1000);
  assert.equal(h.last(), 'Turn on Bravo.');
});

test('with no page attached the lesson paces itself by the length of each line, as before', async () => {
  const h = harness(lesson(), 'none');
  await h.tick(0);
  await h.tick(3000);
  h.on('Alpha');
  for (let k = 0; k < 4 && h.last() !== WHY; k++) await h.tick();
  await h.pass(TEACH_PRAISE_MS + 1000);
  assert.equal(h.last(), WHY);
  const over = h.sent.at(-1).at + spokenMs(WHY) + TEACH_STORY_QUIET_MS;
  await h.pass(over - 600 - h.clock.now());
  assert.equal(h.last(), WHY);
  await h.pass(1200);
  assert.equal(h.last(), 'Turn on Bravo.', 'the estimate, and the quiet after it');
});

test('a line that never ends cannot hang a lesson', async () => {
  // The page takes every line and never says one ended (a stalled voice).
  const h = harness(lesson());
  await h.tick(0);
  await h.tick(3000);
  h.on('Alpha');
  for (let k = 0; k < 4 && h.last() !== WHY; k++) await h.tick();
  await h.pass(TEACH_PRAISE_MS + 1000);
  assert.equal(h.last(), WHY);
  await h.pass(2 * spokenMs(WHY) + VOICE_HANG_MS + TEACH_STORY_QUIET_MS + 1000);
  assert.equal(h.last(), 'Turn on Bravo.', 'the lesson went on by itself');
  assert.equal(h.s.active, true);
});

test('the help ladder counts idle time from when the line finished, not from when it was asked for', async () => {
  const plan = lesson();
  plan.steps = plan.steps.map((st) => ({ ...st, hint: `${st.target} is the top switch.`, prompt: 'Have a look near the top.' }));
  const h = harness(plan);
  await h.tick(0);
  assert.equal(h.last(), 'Turn on Alpha.');
  const n = h.sent.length;
  // The voice is slow to start and long in the saying: the idle time has not begun.
  await h.pass(LADDER_IDLE_MS * 2 + 2000);
  assert.equal(h.sent.length, n, 'no nudge while Echo is still saying the step');
  assert.equal(h.s.saying, false, 'the line is over by now (it never ended: the limit)');
  // From here it counts from that end.
  const h2 = harness(plan);
  await h2.tick(0);
  await h2.pass(8000);
  await h2.end(); // the step's line ends 8 s after it was asked for
  const n2 = h2.sent.length;
  await h2.pass(LADDER_IDLE_MS * 2 - 1000);
  assert.equal(h2.sent.length, n2, 'idle time counted from when it was asked for would have nudged by now');
  await h2.pass(1500);
  assert.equal(h2.sent.length, n2 + 1, 'one rung more help, that long after the line FINISHED');
});

test('a step Echo shows does not move until its line of intent has really been said, and a pause', async () => {
  const h = harness(lesson({ mode: 'show' }));
  await h.tick(0);
  assert.equal(h.last(), "I'll turn on Alpha.");
  assert.equal(h.s.leadLeft(), Infinity, 'still being said');
  const lead = h.s.lead();
  await h.clock.advance(spokenMs(h.last()) + SHOW_PACE.leadMs + 1500);
  assert.equal(await settled(lead), undefined, 'its length has passed, the voice has not finished: nothing moves');
  await h.end();
  assert.equal(h.s.leadLeft(), SHOW_PACE.leadMs);
  await h.clock.advance(SHOW_PACE.leadMs - 1);
  let moved = false;
  lead.then(() => { moved = true; });
  await flush();
  assert.equal(moved, false, 'the pause after it');
  await h.clock.advance(1);
  assert.equal(moved, true);
  // With nothing to hear from: the line's length, then the pause.
  const none = harness(lesson({ mode: 'show' }), 'none');
  await none.tick(0);
  let went = false;
  none.s.lead().then(() => { went = true; });
  await none.clock.advance(spokenMs("I'll turn on Alpha.") + SHOW_PACE.leadMs - 1);
  assert.equal(went, false);
  await none.clock.advance(1);
  assert.equal(went, true);
});

test('Echo\'s question waits for its answer from the end of the question', async () => {
  const h = harness(lesson({ mode: 'show', steps: lesson().steps.slice(0, 1).map((st) => ({ ...st, why: undefined })) }));
  await h.tick(0);
  await h.end();
  h.on('Alpha');
  await h.s.next();
  await h.pass(SHOW_PACE.sitMs + 500);
  await h.end();
  await h.pass(TEACH_PRAISE_MS + 500);
  assert.equal(h.last(), 'Want to try it yourself now?');
  await h.pass(T.TEACH_OFFER_MS + spokenMs(h.last()) + 2000);
  assert.equal(h.s.active, true, 'the question is still being asked: its answer time has not begun');
  await h.end();
  await h.pass(T.TEACH_OFFER_MS + 1000);
  assert.equal(h.s.active, false, 'no answer in that long after it ended: the lesson is over');
});

/* ---------- the server's side of the line ---------- */

test('the page\'s voice events reach the tracker over its WebSocket, and a page that closes is quiet', async () => {
  const voice = new VoiceState();
  const stub = new Proxy({}, { get: () => () => [] });
  const connect = pageConnection(/** @type {any} */ ({
    voice,
    tasks: { list: () => [] }, selfImprove: { status: () => ({}) }, quick: { pendingList: () => [] }, screen: stub,
    dispatcher: { busy: false, setVoiceBusy() {} }, computer: { pendingList: () => [], driving: false, noteEchoInput() {} },
    updater: { status: () => ({}) }, speech: { closed() {} }, broadcast() {}, notifyTask() {}, nativePages: new Set(),
  }));
  const ws = /** @type {any} */ (new EventEmitter());
  ws.send = () => {};
  connect(ws);
  const id = voice.line('Here it is.');
  const done = voice.whenDone(id, 5000);
  const page = (m) => ws.emit('message', Buffer.from(JSON.stringify({ type: 'voice', ...m })), false);
  page({ event: 'queued', id });
  page({ event: 'start', id, chars: 11, ms: 20, fresh: true });
  await flush();
  assert.equal(voice.speaking, true);
  page({ event: 'end', id, chars: 11, ms: 700, last: true });
  assert.equal((await done).heard, true);
  assert.ok(voice.startDelayMs() >= 20);
  ws.emit('close', 1000);
  assert.equal(voice.speaking, false);
  const row = readTimeline(dirs.data).filter((e) => e.type === 'voice.line').at(-1);
  assert.deepEqual(Object.keys(row.f).sort(), ['chars', 'id', 'ms', 'startMs'], 'the timeline gets numbers and the line\'s name, never the words');
  assert.equal(row.f.id, id);
});

test('every line the server asks for carries an id, and the page reports on it by that id', () => {
  const server = serverSource();
  assert.match(server, /dispatcher\.on\('speak', \(text, \{[^}]*id = voice\.line\(text\)[^}]*\} = \{\}\) => \{[^]*?broadcast\(\{ type: 'speak', id,/);
  assert.match(server, /broadcast\(\{ type: 'say', id: voice\.line\(speak\),/);
  assert.match(server, /broadcast\(\{ type: 'speak', id: voice\.line\(TAKE_OVER_LINE\)/);
  assert.match(server, /case 'voice':[\s\S]{0,200}voice\?\.event\(msg, ws\)/);
  const page = pageSource();
  assert.match(page, /case 'speak':.*speak\(msg\.text, liveBubble, \{[^}]*line: msg\.id, last: true \}\)/);
  assert.match(page, /speakAll\(msg\.speak \?\? msg\.text, bubble, msg\.trace, msg\.id\)/);
  for (const event of ['queued', 'start', 'end']) assert.match(page, new RegExp(`voiceEvent\\('${event}', item`), event);
  assert.match(page, /send\(\{ type: 'voice', event: 'idle', id: lastLine \}\)/);
  // What the page sends about a line: its id and numbers, never its words.
  const fn = page.slice(page.indexOf('function voiceEvent'), page.indexOf('/** Turns whose first sound'));
  assert.doesNotMatch(fn, /item\.text(?!\.length)/);
});

/* ---------- the computer: lines with ids, the light, letting it sit ---------- */

/** A bridge whose "Mac app" answers every request; its light flies for every act resolve. */
function fakeApp() {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 2000, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  /** @type {Array<{ at: number, what: string, id: string }>} */
  const log = [];
  bridge.on('request', (r) => {
    const p = r.params;
    log.push({ at: Date.now(), what: r.kind === 'act' ? `act.${p.step}` : r.kind, id: r.id });
    const out = r.kind === 'act' && p.step === 'resolve'
      ? { ok: true, found: true, token: 't', label: p.target || '', role: 'AXButton', app: 'Preview', window: 'Untitled', light: true }
      : { ok: true, via: 'accessibility', app: 'Preview', window: 'Untitled' };
    setImmediate(() => bridge.deliver(r.id, { ...out, id: r.id }));
  });
  return { bridge, log };
}

test('held words are asked for before the light lands, by the voice\'s start-up delay, when the app says how long the flight is', async () => {
  (setFixedForTest({ screenAware: true, reduceMotion: 'system' }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do' }));
  const app = fakeApp();
  const voice = new VoiceState();
  const c = new ComputerUse({ voice, bridge: app.bridge, logFile: path.join(dirs.data, 'computer-log.jsonl'), lightWaitMs: 5000 });
  /** @type {Array<{ at: number, text: string, id: string }>} */
  const said = [];
  c.on('say', (text, o) => said.push({ at: Date.now(), text, id: o?.id }));
  // The voice has been taking 300 ms to start.
  for (let k = 0; k < 3; k++) {
    const id = voice.line('A line.');
    voice.event({ event: 'start', id, ms: 300, fresh: true }, 'page');
    voice.event({ event: 'end', id, last: true }, 'page');
    voice.event({ event: 'idle', id }, 'page');
  }
  assert.equal(voice.startDelayMs(), 300);
  // The light leaves when the app answers, for a 500 ms flight; it lands 500 ms later.
  let left = 0;
  app.bridge.on('request', (r) => {
    if (r.kind !== 'act' || r.params.step !== 'resolve') return;
    setImmediate(() => {
      left = Date.now();
      c.light({ type: 'departed', id: r.id, ms: 500 });
      setTimeout(() => c.light({ type: 'arrived', id: r.id, ms: 500 }), 500);
    });
  });
  const r = await c.act('click', { target: 'Export', say: 'Clicking Export…' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(said.length, 1);
  const after = said[0].at - left;
  assert.ok(after >= 190 && after < 480, `asked for about 200 ms after the light left, 300 ms before it lands (was ${after} ms)`);
  assert.match(said[0].id, /^v\d+$/, 'and the line carries its id');

  // An app that doesn't say how long the flight is: on `arrived`, as before.
  said.length = 0;
  app.bridge.removeAllListeners('request');
  const again = fakeApp();
  c.bridge = again.bridge;
  again.bridge.on('request', (q) => {
    if (q.kind !== 'act' || q.params.step !== 'resolve') return;
    setImmediate(() => {
      left = Date.now();
      c.light({ type: 'departed', id: q.id });
      setTimeout(() => c.light({ type: 'arrived', id: q.id, ms: 300 }), 300);
    });
  });
  // (Not "Save": Echo asks before saving, and a step that waits for a yes says nothing yet.)
  await c.act('click', { target: 'Bold', say: 'Clicking Bold…' });
  assert.ok(said[0].at - left >= 290, 'as the light lands');
});

test('while Echo shows how, the next step waits for it to finish what it is saying; when it is just doing the job, it does not', async () => {
  (setFixedForTest({ screenAware: true, reduceMotion: 'system' }), saveSettings({ computerUse: true, pointer: true, driveMode: 'show' }));
  const app = fakeApp();
  const voice = new VoiceState();
  const c = new ComputerUse({ voice, bridge: app.bridge, logFile: path.join(dirs.data, 'computer-log.jsonl'), lightWaitMs: 50 });
  // The page is still saying the last step's words, and finishes 300 ms from now.
  const id = c.speak('That made it bold.');
  voice.event({ event: 'queued', id }, 'page');
  setTimeout(() => {
    voice.event({ event: 'end', id, last: true }, 'page');
    voice.event({ event: 'idle', id }, 'page');
  }, 300);
  const from = Date.now();
  await c.act('click', { target: 'Italic' });
  assert.ok(app.log.find((e) => e.what === 'act.resolve').at - from >= 280, 'the light set off once Echo had finished');
  // Just doing the job: no waiting on the voice.
  saveSettings({ driveMode: 'do' });
  const id2 = c.speak('Working on it.');
  voice.event({ event: 'queued', id: id2 }, 'page');
  const from2 = Date.now();
  await c.act('click', { target: 'Underline' });
  assert.ok(app.log.findLast((e) => e.what === 'act.resolve').at - from2 < 250);
  voice.gone('page');
});

test('a lesson in the computer: its lines carry ids, and it goes on by itself when no page ever answers', async () => {
  saveSettings({ pointer: true, computerUse: false });
  const shown = { Dark: { present: true, selected: false } };
  const bridge = {
    native: true,
    async request(kind, p) {
      if (kind === 'state') return { ok: true, app: 'System Settings', elements: Object.fromEntries((p.labels || []).map((l) => [l, shown[l] || { present: false }])) };
      if (kind === 'wait' || kind === 'point') return { ok: true, found: Boolean(shown[p.target]), label: p.target };
      return { ok: true };
    },
  };
  const voice = new VoiceState();
  const c = new ComputerUse({ voice, bridge: /** @type {any} */ (bridge), logFile: path.join(dirs.data, 'computer-log.jsonl') });
  const said = [];
  c.on('say', (text, o) => said.push({ text, id: o?.id }));
  const r = await c.startLesson({ goal: 'turn on dark mode', mode: 'show', steps: [{ say: 'Click Dark.', target: 'Dark', check: { kind: 'element_state', label: 'Dark', selected: true } }] });
  assert.equal(r.started, true, JSON.stringify(r));
  await c.lesson.poll();
  assert.equal(said.at(-1).text, "I'll click Dark.");
  assert.match(said.at(-1).id, /^v\d+$/);
  // Nobody is listening to the voice: the step may move after the line's length and the pause.
  const from = Date.now();
  await c.sit();
  const took = Date.now() - from;
  const want = spokenMs("I'll click Dark.") + SHOW_PACE.leadMs;
  assert.ok(took >= want - 150 && took < want + 1500, `waited about ${want} ms (was ${took})`);
  c.lesson.stop?.();
  await wait(10);
  await until(() => true);
});
