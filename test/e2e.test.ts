// End to end through the real server (server.js start({ port: 0, boot: false })): a sentence over
// the page's WebSocket goes through the real pipeline to a fake model, and the reply comes back as
// the page's chat and voice events. The base for Stage 3's turn-engine and concurrency tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('e2e');
const WebSocket = (await import('ws')).default;
const srv: any = await import('../server.js');

/** The fake model: answers each message with `reply(text)`, streamed in pieces like the real one. */
const seen: string[] = [];
let reply = (text: string) => `You said: ${text.slice(0, 40)}.`;
srv.dispatcher.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
  const q = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'e2e' };
    for await (const m of prompt) {
      const text = typeof m?.message?.content === 'string' ? m.message.content : JSON.stringify(m);
      seen.push(text);
      const r = reply(text);
      const id = `m${seen.length}`;
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, model: 'fake', usage: { input_tokens: 3 } } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } };
      for (let i = 0; i < r.length; i += 6) yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: r.slice(i, i + 6) } } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop' } };
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } };
      yield { type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: r }] } };
      yield { type: 'result', subtype: 'success', session_id: 'e2e', total_cost_usd: 0 };
    }
  })();
  return Object.assign(q, { setModel: async () => {}, close() {}, interrupt: async () => {} });
};

const port: number = await srv.start({ port: 0, boot: false });
test.after(() => srv.stop());

/** A page connected to the server, keeping every message it gets. */
async function page() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const got: any[] = [];
  ws.on('message', (d: Buffer) => got.push(JSON.parse(String(d))));
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  return { ws, got, send: (m: object) => ws.send(JSON.stringify(m)) };
}

test('the server answers its health check and serves settings with the flags', async () => {
  const h: any = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(h.ok, true);
  const s: any = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  assert.equal(s.flags?.policy, true, 'on by default');
  assert.equal(s.flags?.messages, false);
  assert.equal('hints' in s.flags || 'verify' in s.flags, false, 'no longer switches');
  assert.ok(s.flagInfo.every((f: any) => f.label && f.about), 'each with its plain description, for Labs');
});

test('a typed message: through the dispatcher to the model, back as chat and voice', async () => {
  const p = await page();
  p.send({ type: 'user_text', text: 'hello from the test', typed: true });
  await until(() => p.got.some((m) => m.type === 'say_end'), 3000, 'reply finished');
  assert.ok(seen.some((t) => t.includes('hello from the test')), 'the model got it');
  const shown = p.got.filter((m) => m.type === 'say_delta').map((m) => m.text).join('');
  assert.match(shown, /^You said: /);
  assert.ok(p.got.some((m) => m.type === 'speak' && /You said/.test(m.text)), 'the voice gets it');
  const convo = fs.readdirSync(path.join(dirs.data, 'conversations'));
  assert.ok(convo.length > 0, 'the conversation is logged');
  p.ws.close();
});

test('a spoken sentence (the browser recognizer path) goes through the same pipeline', async () => {
  const p = await page();
  const before = seen.length;
  p.send({ type: 'user_text', text: 'tell me something about Mars', typed: false, mode: 'push-to-talk', confidence: 0.9 });
  await until(() => seen.length > before && p.got.some((m) => m.type === 'say_end'), 3000, 'spoken reply');
  assert.ok(p.got.some((m) => m.type === 'heard' && /Mars/.test(m.text)), 'the page is told what was heard');
  const stt = fs.readFileSync(path.join(dirs.data, 'stt-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const entry = stt.find((l) => /Mars/.test(l.raw || ''));
  assert.ok(entry?.trace, 'logged with its trace id');
  p.ws.close();
});

test("the Mac app's own line: requests go straight to it and only to it; no token, no line", async () => {
  const { bodyToken, tokenFile } = await import('../lib/bodylink.ts');
  const token = bodyToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(tokenFile()).mode & 0o777, 0o600, 'readable by this user only');
  const refused = async (url: string, headers: Record<string, string> = {}) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.once('open', () => (ws.close(), resolve(false)));
      ws.once('error', () => resolve(true));
    });
  assert.equal(await refused(`ws://127.0.0.1:${port}/ws/body?token=nope`), true, 'a wrong token is refused');
  assert.equal(await refused(`ws://127.0.0.1:${port}/ws/body?token=${token}`, { Origin: 'http://evil.example' }), true, 'a web page is refused');

  const p = await page();
  p.send({ type: 'hello', native: true });
  const app = new WebSocket(`ws://127.0.0.1:${port}/ws/body?token=${token}`);
  const got: any[] = [];
  app.on('message', (d: Buffer) => got.push(JSON.parse(String(d))));
  await new Promise((r) => app.once('open', r));
  await until(() => srv.screen.nativeClients() >= 1, 1000, 'app counted');
  const asked = srv.screen.request('state', { app: 'Finder', labels: [] }).catch(() => null);
  await until(() => got.length > 0, 2000, 'request reached the app');
  assert.equal(got[0].type, 'screen_request');
  assert.equal(got[0].kind, 'state');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!p.got.some((m) => m.type === 'screen_request'), 'not through the page as well: nothing runs twice');
  // The app answers the usual way, over HTTP.
  await fetch(`http://127.0.0.1:${port}/api/screen/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: got[0].id, ok: true, front: 'Finder' }) });
  const answer: any = await asked;
  assert.equal(answer?.front, 'Finder');
  // A look: the app does it, and the page only shows its "Looking" chip (a notice, never a request to do it).
  const looked = srv.screen.request('look', {}).catch(() => null);
  await until(() => got.length > 1, 2000, 'the look reached the app');
  await until(() => p.got.some((m) => m.type === 'screen_request'), 2000, 'the page told');
  const told = p.got.find((m) => m.type === 'screen_request');
  assert.equal(told.notice, true);
  assert.equal(told.id, got[1].id);
  assert.equal(told.params, undefined, 'nothing for the page to do');
  await fetch(`http://127.0.0.1:${port}/api/screen/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: got[1].id, ok: false, error: 'test' }) });
  await looked;
  await until(() => p.got.some((m) => m.type === 'screen_done' && m.id === got[1].id), 2000, 'the chip goes when it is done');
  app.close();
  p.ws.close();
});

/** A short 16 kHz mono WAV of quiet noise (the clip a sentence comes with). */
function wavOf(seconds = 0.8) {
  const n = Math.round(16000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 7) * 3000 * (i % 3200 < 2400 ? 1 : 0.1)), 44 + i * 2);
  return b;
}

test("the Mac app's own transcription (Apple's model) is used as is: no Whisper, its timing logged", async () => {
  const clip = (final?: object) =>
    fetch(`http://127.0.0.1:${port}/api/utterance`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-Echo-Clip': encodeURIComponent(JSON.stringify({ mode: 'push-to-talk', native: true, inApp: true, ...(final ? { final } : {}) })) },
      body: wavOf(),
    });
  const final = { text: 'tell me about Jupiter', ms: 41.5, words: [{ word: 'tell', p: 0.98 }, { word: 'me', p: 0.97 }, { word: 'about', p: 0.99 }, { word: 'Jupiter', p: 0.93 }] };
  try {
    const before = seen.length;
    const r: any = await (await clip(final)).json();
    assert.equal(r.engine, 'apple');
    assert.equal(r.text, 'tell me about Jupiter');
    await until(() => seen.length > before, 3000, 'reached the model');
    assert.ok(seen.some((t) => t.includes('tell me about Jupiter')));
    const stt = fs.readFileSync(path.join(dirs.data, 'stt-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = stt.find((l) => l.raw === 'tell me about Jupiter');
    assert.equal(entry.engine, 'apple');
    assert.equal(entry.sttMs, 42, 'speech to text is what the app measured after the sentence ended');
  } finally {
    // (no switch: the app's text is always used)
  }
  // The app's text is used whichever engine is picked for the server (no Whisper needed for it).
  const setEngine = (sttEngine: string) => fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sttEngine }) });
  await setEngine('browser');
  const again: any = await (await clip(final)).json();
  assert.equal(again.engine, 'apple');
  await setEngine('auto');
});

test("the voice's first sound is timed: the page says when it became audible, logged once per turn", async () => {
  const p = await page();
  p.send({ type: 'user_text', text: 'time my voice', typed: true });
  await until(() => p.got.some((m) => m.type === 'speak' && m.trace), 3000, 'a spoken piece with its turn');
  const trace = p.got.find((m) => m.type === 'speak' && m.trace).trace;
  const at = Date.now() + 250;
  p.send({ type: 'voice_started', trace, at });
  p.send({ type: 'voice_started', trace, at: at + 5000 }); // a later piece of the same turn: not counted again
  const events = () => fs.readFileSync(path.join(dirs.data, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  await until(() => events().some((e) => e.type === 'first_sound' && e.trace === trace), 2000, 'first_sound logged');
  const logged = events().filter((e) => e.type === 'first_sound' && e.trace === trace);
  assert.equal(logged.length, 1);
  assert.ok(logged[0].ms >= 250 && logged[0].ms < 5000, `ms ${logged[0].ms}`);
  p.ws.close();
});
