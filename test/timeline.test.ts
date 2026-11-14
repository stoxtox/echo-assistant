// The flight recorder (lib/timeline.ts): one file the server, the page and the Mac app all write
// to, holding names, counts and durations and never what anyone said, and the viewer that reads it
// back in plain English (scripts/timeline.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('timeline');
const tl = await import('../lib/timeline.ts');
const { logEvent } = await import('../lib/trace.ts');
const { logTiming } = await import('../lib/rotation.js');
const viewer = await import('../scripts/timeline.ts');

const dir = path.join(dirs.data, 'timeline');
const dayFile = (day: string) => path.join(dir, `${day}.jsonl`);
const lines = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** Every row in every day's file, in file order. */
const everything = (): any[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().flatMap((n) => lines(path.join(dir, n))) : []);
/** Rows written after this point (the count only goes up, whatever old days get pruned meanwhile). */
const marker = (): (() => any[]) => {
  const last = Math.max(0, ...everything().map((r) => Number(r.seq) || 0));
  return () => everything().filter((r) => r.seq > last).sort((a, b) => a.seq - b.seq);
};
const raw = (): string => (fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('') : '');
// Noon in New York (the sandbox's time zone) on fixed days, so the day files are known.
const NOON = Date.parse('2026-03-10T16:00:00.000Z');
const DAY = 86_400_000;

test('one line per event: the envelope, and a count that only goes up', () => {
  tl.record('app', 'ptt.down', {}, undefined, { now: NOON, cts: NOON - 40, cseq: 7 });
  tl.record('server', 'turn.start', { source: 'speech', model: 'fast' }, 't-abc-0001', { now: NOON + 5 });
  tl.record('page', 'play.start', { chars: 12, ms: 30 }, 't-abc-0001', { now: NOON + 9 });
  const rows = lines(dayFile('2026-03-10'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { ts: '2026-03-10T16:00:00.000Z', seq: rows[0].seq, src: 'app', type: 'ptt.down', f: {}, cts: NOON - 40, cseq: 7 });
  assert.deepEqual(Object.keys(rows[1]), ['ts', 'seq', 'src', 'type', 'trace', 'f']);
  assert.deepEqual(rows[1].f, { source: 'speech', model: 'fast' });
  assert.equal(rows[1].trace, 't-abc-0001');
  assert.deepEqual(rows.map((r) => r.seq), [rows[0].seq, rows[0].seq + 1, rows[0].seq + 2]);
  assert.deepEqual(rows.map((r) => r.src), ['app', 'server', 'page']);
});

test('after a restart the count carries on from the last line of today\'s file', () => {
  // A day this process has not written to, with a line left by "the last run".
  fs.writeFileSync(dayFile('2026-03-11'), JSON.stringify({ ts: '2026-03-11T15:00:00.000Z', seq: 90210, src: 'server', type: 'body.connect', f: {} }) + '\n');
  tl.record('server', 'body.drop', { code: 1006, ms: 5 }, undefined, { now: NOON + DAY });
  const rows = lines(dayFile('2026-03-11'));
  assert.equal(rows[1].seq, 90211);
});

test('only the fields a type may carry are kept; text never is; strings are cut to 80', () => {
  tl.record('server', 'turn.end', { ms: 900, requests: 2, spoke: true, text: 'the reply text', transcript: 'what was said', input: { q: 'tool input' }, title: 'A window title', url: 'https://example.com/private' }, 't-abc-0002', { now: NOON + DAY + 1 });
  tl.record('app', 'mic.cancel', { reason: 'x'.repeat(200), said: 'call the dentist' }, undefined, { now: NOON + DAY + 2 });
  tl.record('app', 'gate.end', { seconds: 1.5, peak: 0.2, wav: 'UklGRg==', levels: [0.1, 0.2], live: 'words heard so far' }, undefined, { now: NOON + DAY + 3 });
  // A type nobody listed still shows when it happened and how long it took, but carries no sentence.
  tl.record('server', 'model.tool_done', { ms: 40, tool: 'get_task', name: 'two words', output: 'the tool said this' }, undefined, { now: NOON + DAY + 4 });
  // Not an event name at all: nothing is written.
  tl.record('page', 'please remember this sentence', { ms: 1 }, undefined, { now: NOON + DAY + 5 });
  tl.record('browser' as any, 'ptt.down', {}, undefined, { now: NOON + DAY + 5 });
  const rows = lines(dayFile('2026-03-11')).slice(2);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].f, { ms: 900, requests: 2, spoke: true });
  assert.deepEqual(rows[1].f, { reason: 'x'.repeat(80) });
  assert.deepEqual(rows[2].f, { seconds: 1.5, peak: 0.2 });
  assert.deepEqual(rows[3].f, { ms: 40, tool: 'get_task' });
});

test('recording never throws into the caller', () => {
  const circular: any = { ms: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => tl.record('server', 'turn.end', circular));
  assert.doesNotThrow(() => tl.record('server', 'turn.end', 'not an object'));
  assert.doesNotThrow(() => tl.record(undefined as any, undefined as any, undefined, 12 as any));
  assert.doesNotThrow(() => tl.ingest('app', [null, 5, { type: 12 }, { type: 'ptt.down', f: 'x', cts: 'soon' }]));
});

test('a file a day in Echo\'s time zone; days older than two weeks are deleted', () => {
  // 03:30 UTC is still the evening before in New York.
  tl.record('server', 'body.connect', {}, undefined, { now: Date.parse('2026-04-02T03:30:00.000Z') });
  assert.equal(lines(dayFile('2026-04-01')).length, 1);
  assert.ok(!fs.existsSync(dayFile('2026-04-02')));
  // Old days, and a file that isn't the timeline's.
  fs.writeFileSync(dayFile('2026-05-01'), '{}\n');
  fs.writeFileSync(dayFile('2026-05-07'), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'kept');
  const now = Date.parse('2026-05-20T16:00:00.000Z');
  tl.record('server', 'body.connect', {}, undefined, { now });
  assert.ok(!fs.existsSync(dayFile('2026-05-01')), 'nineteen days old: gone');
  assert.ok(!fs.existsSync(dayFile('2026-04-01')));
  assert.ok(fs.existsSync(dayFile('2026-05-07')), 'thirteen days old: kept');
  assert.ok(fs.existsSync(dayFile('2026-05-20')));
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'only its own files');
});

test('a full day: one "truncated" line, then only what went wrong', () => {
  const was = tl.limits.maxBytes;
  tl.limits.maxBytes = 2000;
  try {
    const now = Date.parse('2026-06-01T16:00:00.000Z');
    for (let i = 0; i < 60; i++) tl.record('app', 'ptt.up', { ms: i }, undefined, { now: now + i });
    tl.record('server', 'body.drop', { code: 1006, ms: 1 }, undefined, { now: now + 100 });
    tl.record('server', 'model.api_retry.error', { attempt: 2 }, undefined, { now: now + 101 });
    tl.record('server', 'body.connect', {}, undefined, { now: now + 102 });
    const rows = lines(dayFile('2026-06-01'));
    assert.equal(rows.filter((r) => r.type === 'timeline.truncated').length, 1);
    const cut = rows.findIndex((r) => r.type === 'timeline.truncated');
    assert.ok(cut > 5 && cut < 60, `stopped taking everything at row ${cut}`);
    assert.deepEqual(rows.slice(cut + 1).map((r) => r.type), ['body.drop', 'model.api_retry.error']);
    assert.ok(rows.every((r, i) => i === 0 || r.seq === rows[i - 1].seq + 1), 'the count has no holes');
    // Even problems stop at twice the size.
    for (let i = 0; i < 80; i++) tl.record('server', 'body.drop', { code: 1006, ms: i }, undefined, { now: now + 200 + i });
    assert.ok(fs.statSync(dayFile('2026-06-01')).size < 2000 * 2 + 200);
  } finally {
    tl.limits.maxBytes = was;
  }
});

test('the turn log and the model-call log feed it, without their words', () => {
  const since = marker();
  logEvent({ type: 'turn_start', trace: 't-feed-0001', source: 'speech', model: 'fast' });
  logEvent({ type: 'slow_notice', trace: 't-feed-0001', text: 'Still working on the tax letter.' });
  logEvent({ type: 'turn_end', trace: 't-feed-0001', ms: 1200, requests: 1, ctx: 5000, spoke: true, spokenChars: 44 });
  logTiming({ type: 'request', trace: 't-feed-0001', model: 'fast', ctx: 5000, firstMs: 310, ms: 900 });
  logTiming({ type: 'api_retry', trace: 't-feed-0001', attempt: 1, error: 'Overloaded: your prompt about the tax letter', status: 529, delayMs: 500 });
  logTiming({ type: 'turn_lost', trace: 't-feed-0001' });
  const rows = since();
  assert.deepEqual(rows.map((r) => r.type), ['turn.start', 'turn.slow_notice', 'turn.end', 'model.request', 'model.api_retry.error', 'model.turn_lost.drop']);
  assert.ok(rows.every((r) => r.src === 'server' && r.trace === 't-feed-0001'));
  assert.deepEqual(rows[0].f, { source: 'speech', model: 'fast' });
  assert.deepEqual(rows[1].f, {});
  assert.deepEqual(rows[3].f, { model: 'fast', ctx: 5000, firstMs: 310, ms: 900 });
  assert.deepEqual(rows[4].f, { attempt: 1, status: 529, delayMs: 500 });
  assert.doesNotMatch(raw(), /tax letter/);
  // The older logs still get their own lines.
  assert.match(fs.readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8'), /turn_start/);
  assert.match(fs.readFileSync(path.join(dirs.data, 'dispatcher-timing.jsonl'), 'utf8'), /"request"/);
});

test('the computer log and the screen log feed it: which step and how it went, never what or where', async () => {
  const { ComputerUse } = await import('../lib/computer.js');
  const { ScreenBridge } = await import('../lib/screen.js');
  const since = marker();
  const screen = new ScreenBridge();
  const computer = new ComputerUse(screen);
  computer.record({ event: 'action', run: 'r1', step: 3, action: 'type_text', target: 'Message to the landlord', app: 'Mail', window: 'Rent dispute draft', text: 'I will not pay', ok: false, error: 'no field called Rent', ms: 420, via: 'ax' });
  computer.record({ event: 'run_ended', run: 'r1', reason: 'done', steps: 3 });
  screen.record('screen_look_failed', { source: 'native', reason: 'timeout' });
  const rows = since();
  assert.deepEqual(rows.map((r) => r.type), ['mac.action.error', 'mac.run_ended', 'screen.screen_look.error']);
  assert.deepEqual(rows[0].f, { run: 'r1', step: 3, action: 'type_text', via: 'ax', ok: false, ms: 420 });
  assert.deepEqual(rows[2].f, { source: 'native', reason: 'timeout' });
  assert.doesNotMatch(raw(), /landlord|Rent|not pay|Mail/);
});

/* ---------- over the sockets, through the real server ---------- */

const WebSocket = (await import('ws')).default;
const srv: any = await import('../server.js');
const SAID = 'remind me about the surprise party for my cousin';
const REPLY = 'Okay, the surprise party is noted.';
srv.dispatcher.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
  const q = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'timeline' };
    let n = 0;
    for await (const _ of prompt) {
      const id = `m${++n}`;
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: REPLY } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
      yield { type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: REPLY }] } };
      yield { type: 'result', subtype: 'success', session_id: 'timeline', total_cost_usd: 0 };
    }
  })();
  return Object.assign(q, { setModel: async () => {}, close() {}, interrupt: async () => {} });
};
const port: number = await srv.start({ port: 0, boot: false });
test.after(() => srv.stop());
const opened = (ws: any) => new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));

test('a screen request that timed out counts as something that went wrong; a folded turn says which reply covered it', async () => {
  const { ScreenBridge } = await import('../lib/screen.js');
  const since = marker();
  new ScreenBridge().record('screen_timeout', { kind: 'look', reason: 'no_answer', ms: 6000, attempt: 1, title: 'Rent dispute draft' });
  logEvent({ type: 'turn_end', trace: 't-fold-0002', ms: 40, requests: 0, ctx: 5000, spoke: false, folded: true, into: 't-fold-0001' });
  logEvent({ type: 'dropped', trace: 't-fold-0003', reason: 'quiet' });
  const rows = since();
  assert.deepEqual(rows.map((r) => r.type), ['screen.screen.timeout', 'turn.end', 'turn.dropped']);
  assert.deepEqual(rows[0].f, { reason: 'no_answer', kind: 'look', ms: 6000, attempt: 1 }, 'which kind and how long, never what for');
  assert.deepEqual([rows[1].f.folded, rows[1].f.into], [true, 't-fold-0001']);
  assert.deepEqual(rows[2].f, { reason: 'quiet' });
  // In the report for a helper…
  const problems = tl.recentProblems(dirs.data, 60, Date.now() + 1000);
  assert.ok(problems.some((p) => p.type === 'screen.screen.timeout'), 'listed with the things that went wrong');
  // …and still written once the day's file is full.
  const was = tl.limits.maxBytes;
  tl.limits.maxBytes = 2000;
  try {
    const now = Date.parse('2026-06-03T16:00:00.000Z');
    for (let i = 0; i < 60; i++) tl.record('app', 'ptt.up', { ms: i }, undefined, { now: now + i });
    const full = lines(dayFile('2026-06-03')).length;
    tl.record('server', 'screen.screen.timeout', { kind: 'look' }, undefined, { now: now + 100 });
    assert.equal(lines(dayFile('2026-06-03')).length, full + 1, 'kept when full');
    assert.equal(lines(dayFile('2026-06-03')).at(-1).type, 'screen.screen.timeout');
  } finally {
    tl.limits.maxBytes = was;
  }
});

test('the Mac app\'s line: connect and drop are recorded, its events land as "app", a stranger as refused', async () => {
  const { bodyToken } = await import('../lib/bodylink.ts');
  const since = marker();
  await new Promise<void>((resolve) => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws/body?token=nope`);
    bad.once('error', () => resolve());
  });
  const app = new WebSocket(`ws://127.0.0.1:${port}/ws/body?token=${bodyToken()}`);
  await opened(app);
  const cts = Date.now() - 1500;
  app.send(JSON.stringify({ type: 'tl', events: [
    { type: 'ptt.down', f: {}, cts, cseq: 1 },
    { type: 'gate.end', f: { seconds: 2.25, peak: 0.31, live: SAID }, cts: cts + 900, cseq: 2 },
    { type: 'mic.cancel', f: { reason: 'too_short', text: SAID }, cts: cts + 950, cseq: 3 },
  ] }));
  app.send('not json');
  // No more than 200 from one message.
  app.send(JSON.stringify({ type: 'tl', events: Array.from({ length: 260 }, (_, i) => ({ type: 'overlay.show', f: { name: 'caption' }, cts: cts + 1000 + i, cseq: 4 + i })) }));
  await until(() => since().filter((r) => r.type === 'overlay.show').length >= 200, 3000, 'the batch landed');
  app.close();
  await until(() => since().some((r) => r.type === 'body.drop'), 2000, 'the drop recorded');
  const rows = since();
  assert.deepEqual(rows.find((r) => r.type === 'body.refused'), { ...rows.find((r) => r.type === 'body.refused'), src: 'server', f: { reason: 'token' } });
  assert.equal(rows.find((r) => r.type === 'body.connect').src, 'server');
  const down = rows.find((r) => r.type === 'ptt.down');
  assert.equal(down.src, 'app');
  assert.equal(down.cts, cts);
  assert.equal(down.cseq, 1);
  assert.deepEqual(rows.find((r) => r.type === 'gate.end').f, { seconds: 2.25, peak: 0.31 });
  assert.deepEqual(rows.find((r) => r.type === 'mic.cancel').f, { reason: 'too_short' });
  assert.equal(rows.filter((r) => r.type === 'overlay.show').length, 200);
  assert.ok(rows.filter((r) => r.type === 'overlay.show').every((r) => r.src === 'app'));
  const drop = rows.find((r) => r.type === 'body.drop');
  assert.equal(typeof drop.f.ms, 'number');
});

test('the page\'s line: open and close are recorded, its events land as "page", and a whole turn leaves no words behind', async () => {
  const since = marker();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const got: any[] = [];
  ws.on('message', (d: Buffer) => got.push(JSON.parse(String(d))));
  await opened(ws);
  ws.send(JSON.stringify({ type: 'user_text', text: SAID, typed: false, mode: 'push-to-talk', confidence: 0.9 }));
  await until(() => got.some((m) => m.type === 'say_end'), 4000, 'the reply finished');
  const trace = got.find((m) => m.type === 'speak' && m.trace)?.trace;
  ws.send(JSON.stringify({ type: 'tl', events: [
    { type: 'play.start', f: { chars: REPLY.length, ms: 120, text: REPLY }, cts: Date.now(), cseq: 1, trace },
    { type: 'play.end', f: {}, cts: Date.now() + 5, cseq: 2, trace },
    { type: 'page.error', f: { kind: 'TypeError', message: `cannot read ${SAID}` }, cts: Date.now() + 6, cseq: 3 },
  ] }));
  await until(() => since().some((r) => r.type === 'page.error'), 2000, 'the page events landed');
  await until(() => since().some((r) => r.type === 'turn.end'), 3000, 'the turn ended');
  ws.close();
  await until(() => since().some((r) => r.type === 'page.ws.close'), 2000, 'the close recorded');
  const rows = since();
  assert.equal(rows.find((r) => r.type === 'page.ws.open').src, 'server');
  const start = rows.find((r) => r.type === 'play.start');
  assert.equal(start.src, 'page');
  assert.equal(start.trace, trace);
  assert.deepEqual(start.f, { chars: REPLY.length, ms: 120 });
  assert.deepEqual(rows.find((r) => r.type === 'page.error').f, { kind: 'TypeError' });
  // The turn's own milestones arrived through the older logs, with the same id.
  assert.ok(rows.some((r) => r.type === 'turn.start' && r.trace === trace && r.src === 'server'));
  assert.ok(rows.some((r) => r.type === 'model.request' && r.trace === trace));
  // What was said and what was answered are in the conversation log, and nowhere on the timeline.
  assert.doesNotMatch(raw(), /surprise|party|cousin|noted/i);
});

/* ---------- the page's own side (public/ui/socket.js) ---------- */

test('the page keeps its newest 300 notes while offline and sends them when the line is up, 200 at a time', async () => {
  const sent: any[] = [];
  class FakeSocket {
    static last: FakeSocket;
    readyState = 0;
    onopen = () => {};
    onclose = () => {};
    onmessage = (_: any) => {};
    constructor() { FakeSocket.last = this; }
    send(data: string) { sent.push(JSON.parse(data)); }
  }
  Object.assign(globalThis, { WebSocket: FakeSocket, location: { host: 'localhost:1' } });
  // @ts-ignore a page module, plain JavaScript
  const page = await import('../public/ui/socket.js');
  for (let i = 0; i < 320; i++) page.timeline('play.end', { n: i });
  let opens = 0;
  page.openSocket({ onOpen: () => opens++, onClose: () => {}, onMessage: () => {} });
  assert.equal(sent.length, 0, 'nothing goes while the line is down');
  FakeSocket.last.readyState = 1;
  FakeSocket.last.onopen();
  assert.equal(opens, 1);
  assert.deepEqual(sent.map((m) => [m.type, m.events.length]), [['tl', 200], ['tl', 100]]);
  assert.equal(sent[0].events[0].f.n, 20, 'the oldest twenty made room');
  assert.equal(typeof sent[0].events[0].cts, 'number');
  assert.equal(sent[1].events.at(-1).cseq, 320);
  // The line drops and comes back: how long it was away is noted.
  sent.length = 0;
  const first = FakeSocket.last;
  first.readyState = 3;
  first.onclose();
  page.timeline('play.start', { chars: 5, ms: 10 }, 't-page-0001');
  await new Promise((r) => setTimeout(r, 30));
  first.readyState = 1; // (the same stand-in comes back; the real page opens a new one after 1.5 s)
  first.onopen();
  const events = sent.flatMap((m) => m.events);
  assert.deepEqual(events.map((e) => e.type), ['play.start', 'page.ws.reconnect']);
  assert.equal(events[0].trace, 't-page-0001');
  assert.ok(events[1].f.ms >= 25 && events[1].f.ms < 5000, `offline ${events[1].f.ms} ms`);
});

test('the page notes when the voice starts, ends and stalls, and errors by kind only', () => {
  const src = pageSource();
  assert.match(src, /timeline\('play\.start', \{ chars: item\.text\.length/);
  assert.match(src, /timeline\('play\.end'/);
  assert.match(src, /timeline\('play\.stalled'/);
  assert.match(src, /timeline\('page\.error', \{ kind: e\.error\?\.name/);
  assert.doesNotMatch(src, /timeline\('page\.error'[^)]*message/);
});

/* ---------- the Mac app's side ---------- */

test('the Mac app notes keys, the mic, speech and overlays, and keeps 500 while its line is down', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', 'macos', 'Sources', f), 'utf8');
  const link = read('BodyLink.swift');
  assert.match(link, /func timeline\(_ type: String, _ f: \[String: Any\] = \[:\]\)/);
  assert.match(link, /static let ring = 500/);
  assert.match(link, /"type": "tl", "events": batch/);
  assert.match(link, /timeline\("body\.retry"/);
  for (const t of ['ptt.down', 'ptt.up', 'ptt.spoiled']) assert.ok(read('PushToTalk.swift').includes(`timeline("${t}"`), t);
  for (const t of ['mic.open', 'mic.close', 'mic.error', 'gate.onset', 'gate.end', 'mic.cancel']) assert.ok(read('NativeMic.swift').includes(`timeline("${t}"`), t);
  for (const f of ['Overlays.swift', 'Caption.swift']) for (const t of ['overlay.show', 'overlay.hide']) assert.ok(read(f).includes(`timeline("${t}"`), `${f} ${t}`);
  assert.match(read('main.swift'), /timeline\("perm\.state", Permissions\.status\(\)\)/);
  // Never a level per frame: nothing is noted where the audio frames are processed.
  const mic = read('NativeMic.swift');
  const frames = mic.slice(mic.indexOf('private func process('), mic.indexOf('private func run('));
  assert.ok(frames.length > 200 && frames.length < 2000, 'the frame loop');
  assert.doesNotMatch(frames, /timeline\(/);
  // And never the words: the clip, the live text and Apple's text stay out of every call.
  for (const call of mic.match(/BodyLink\.shared\.timeline\([^\n]*/g) || []) assert.doesNotMatch(call, /wav|live|final|text|words/);
});

/* ---------- the viewer ---------- */

/** A spoken turn as the three writers would leave it. */
function fixture(): any[] {
  const t0 = Date.parse('2026-07-04T04:55:58.120Z'); // 00:55:58.120 in New York
  const trace = 't-fix-0001';
  let seq = 0;
  const row = (ms: number, src: string, type: string, f: object = {}, tr?: string, own = src !== 'server') => ({ ts: new Date(t0 + ms + (own ? 700 : 0)).toISOString(), seq: ++seq, src, type, ...(tr ? { trace: tr } : {}), f, ...(own ? { cts: t0 + ms, cseq: seq } : {}) });
  return [
    row(0, 'app', 'ptt.down'),
    row(20, 'app', 'mic.open', { aec: true }),
    row(30, 'app', 'gate.onset', { label: 'push-to-talk', manual: true }),
    row(2400, 'app', 'ptt.up', { ms: 2400 }),
    row(2750, 'app', 'gate.end', { seconds: 2.7, peak: 0.42 }),
    row(3350, 'server', 'turn.start', { source: 'speech', model: 'default' }, trace),
    row(6500, 'server', 'model.request', { model: 'opus', ctx: 41000, firstMs: 2900, ms: 3100 }, trace),
    row(6550, 'server', 'model.tool_done', { tool: 'get_task', ms: 900 }, trace),
    row(6600, 'server', 'turn.first_speech', { ms: 3250 }, trace),
    row(6900, 'page', 'play.start', { chars: 48, ms: 250 }, trace),
    row(6950, 'server', 'turn.first_sound', { ms: 3600 }, trace),
    row(9000, 'page', 'play.end', {}, trace),
    row(9100, 'server', 'model.turn', { ms: 5750, requests: 1 }, trace),
    row(9100, 'server', 'turn.end', { ms: 5750, requests: 1, ctx: 41000, spoke: true, spokenChars: 48 }, trace),
    row(21000, 'server', 'body.drop', { code: 1006, ms: 60000 }),
    row(21500, 'app', 'body.retry', { delay: 1 }),
  ];
}

test('the viewer tells a session in plain English, in the order it happened, with where each turn\'s time went', () => {
  const rows = fixture();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dirs.root, 'viewer-data', 'timeline');
  fs.mkdirSync(file, { recursive: true });
  // Written out of order, as batches from the app arrive late.
  fs.writeFileSync(path.join(file, '2026-07-04.jsonl'), [...rows].reverse().map((r) => JSON.stringify(r)).join('\n') + '\n');
  const read = tl.readTimeline(path.join(dirs.root, 'viewer-data'), 0, Date.parse('2026-07-05T00:00:00Z'));
  assert.equal(read.length, rows.length);
  const out = viewer.render(read);
  assert.equal(out[0], '00:55:58.120  app     Key held (push-to-talk)');
  assert.ok(out.includes('00:56:00.520  app     Key let go after 2.4 s'));
  assert.ok(out.includes('00:56:00.870  app     Speech ended: 2.7 s long, peak 0.42'));
  assert.ok(out.includes('00:56:01.470  server  Turn started (spoken)'));
  assert.ok(out.some((l) => /server {2}Model call finished \(opus, first word 2\.9 s, whole call 3\.1 s, 41000 tokens of context\) {2}<< slow$/.test(l)), out.join('\n'));
  assert.ok(out.some((l) => /page {4}Voice started playing \(48 characters, audible in 250 ms\)$/.test(l)));
  assert.ok(out.some((l) => /Model: tool done get_task \(900 ms\)/.test(l)), 'a type with no line of its own is still readable');
  assert.ok(!out.some((l) => /model\.turn|Model: turn/.test(l)), 'the turn is not told twice');
  const summary = out.find((l) => l.includes('Where the time went'));
  assert.match(String(summary), /listening 2\.7 s, speech recognition 600 ms, model first word 3\.3 s, tools 900 ms, voice 350 ms \(turn 5\.8 s\)/);
  // The quiet stretch before the line dropped, and the drop itself.
  assert.ok(out.some((l) => /11\.9 s with nothing happening/.test(l)), out.join('\n'));
  assert.ok(out.some((l) => /Mac app's line to the server dropped after 60\.0 s {2}!! problem$/.test(l)));
  assert.ok(out.at(-1)?.endsWith('Mac app is retrying its line to the server in 1 s'));
  // --slow: only the gaps, the slow steps, what went wrong and the summaries.
  const slow = viewer.render(read, { slow: true });
  assert.ok(slow.some((l) => l.includes('<< slow')) && slow.some((l) => l.includes('!! problem')) && slow.some((l) => l.includes('Where the time went')));
  assert.ok(!slow.some((l) => l.includes('Key held')));
  // --trace: that turn only, still with its listening time.
  const one = viewer.render(read, { trace: 't-fix-0001' });
  assert.ok(one.every((l) => !l.includes('Key held') && !l.includes('dropped')));
  assert.match(one.join('\n'), /listening 2\.7 s/);
  assert.equal(viewer.span('10m'), 600_000);
  assert.equal(viewer.span('30s'), 30_000);
  assert.equal(viewer.span('2h'), 7_200_000);
  assert.ok(Number.isNaN(viewer.span('soon')));
});

test('`npm run timeline` runs the viewer on a data folder', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = path.resolve(import.meta.dirname, '..');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.timeline, 'node scripts/timeline.ts');
  const data = path.join(dirs.root, 'cli-data');
  fs.mkdirSync(path.join(data, 'timeline'), { recursive: true });
  const now = Date.now();
  const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  fs.writeFileSync(path.join(data, 'timeline', `${day}.jsonl`), [
    { ts: new Date(now - 3 * 3_600_000).toISOString(), seq: 1, src: 'server', type: 'body.connect', f: {} },
    { ts: new Date(now - 5000).toISOString(), seq: 2, src: 'app', type: 'ptt.down', f: {}, cts: now - 5200, cseq: 1 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run = (...args: string[]) => execFileSync(process.execPath, [path.join(root, 'scripts', 'timeline.ts'), '--data', data, ...args], { encoding: 'utf8', env: { ...process.env, ECHO_TZ: 'America/New_York' } });
  const out = run('--since', '10m');
  assert.match(out, /^\d\d:\d\d:\d\d\.\d{3} {2}app {5}Key held \(push-to-talk\)\n$/);
  assert.equal(run('--since', '1d').trim().split('\n').length, 3, 'both rows and the gap between them');
  assert.equal(JSON.parse(run('--since', '10m', '--json')).type, 'ptt.down');
  assert.match(run('--since', '2s'), /Nothing on the timeline/);
});

/* ---------- around it ---------- */

test('the report for a helper lists the last things that went wrong, and nothing else from the timeline', async () => {
  const { buildReport } = await import('../lib/diagnostics.js');
  const data = path.join(dirs.root, 'report-data');
  fs.mkdirSync(path.join(data, 'timeline'), { recursive: true });
  const now = Date.parse('2026-08-01T16:00:00.000Z');
  const types = ['body.drop', 'ptt.down', 'mic.error', 'body.refused', 'play.end', 'screen.look.timeout'];
  const rows = Array.from({ length: 150 }, (_, i) => ({ ts: new Date(now - (150 - i) * 1000).toISOString(), seq: i + 1, src: 'server', type: types[i % types.length], f: { ms: i } }));
  fs.writeFileSync(path.join(data, 'timeline', '2026-08-01.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r: any = buildReport({ dataDir: data, logDir: dirs.logs, now });
  assert.equal(r.recentProblems.length, 60);
  assert.ok(r.recentProblems.every((p: any) => /\.(error|drop|timeout|refused)$/.test(p.type)));
  assert.equal(r.recentProblems.at(-1).f.ms, 149, 'the newest last');
  assert.deepEqual(Object.keys(r.recentProblems[0]).sort(), ['f', 'src', 'ts', 'type']);
});

test('the timeline never ships in a shared copy, and the console no longer prints what was heard', async () => {
  const privacy = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'privacy.js'), 'utf8');
  assert.match(privacy.slice(privacy.indexOf('PERSONAL_NAMES'), privacy.indexOf('PERSONAL_ROOT_DIRS')), /'timeline'/);
  const src = serverSource() + fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'stt.js'), 'utf8');
  for (const line of src.split('\n').filter((l) => /console\.(log|error|warn)\(.*\[stt\]/.test(l))) {
    assert.doesNotMatch(line, /JSON\.stringify\((heard|said|live)|\$\{(heard\.text|said|live|pick\.text|cleaned\.text)\}/, line.trim());
  }
  assert.match(src, /\[stt\] \$\{blank\.event\}: final \$\{String\(heard\.text \|\| ''\)\.length\} chars/);
});
