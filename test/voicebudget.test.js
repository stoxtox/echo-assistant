// The premium voice speaks while its free credits last, then Kokoro until they're back
// (lib/voicebudget.js, lib/voice.js synthesize).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('voicebudget');
const { VoiceBudget, nextMonthlyReset, isQuotaError, REFRESH_MS } = await import('../lib/voicebudget.js');
const voice = await import('../lib/voice.js');
const root = path.resolve(import.meta.dirname, '..');

const HOUR = 3600000;
let file = 0;
/**
 * A budget with its own file, a clock you move, and keys for both premium voices.
 * @param {{ env?: Record<string, string>, fetch?: any }} [o]
 */
function budget({ env = {}, fetch = undefined } = {}) {
  const clock = { t: new Date(2026, 9, 10, 12).getTime() };
  const changes = [];
  const b = new VoiceBudget({
    file: path.join(dirs.data, `budget-${++file}.json`),
    now: () => clock.t,
    env: { ELEVENLABS_API_KEY: 'k', CARTESIA_API_KEY: 'k', CARTESIA_MONTHLY_CHARS: '100', ...env },
    fetch: fetch || (async () => { throw new Error('offline'); }),
    onChange: (p, c) => changes.push({ p, ...c }),
  });
  return { b, clock, changes };
}

test('a monthly period starts on its day, the next one after now', () => {
  assert.deepEqual(nextMonthlyReset(new Date(2026, 9, 10, 12)), new Date(2026, 10, 1));
  assert.deepEqual(nextMonthlyReset(new Date(2026, 9, 10, 12), 15), new Date(2026, 9, 15));
  assert.deepEqual(nextMonthlyReset(new Date(2026, 11, 20), 1), new Date(2027, 0, 1));
  assert.deepEqual(nextMonthlyReset(new Date(2026, 1, 1), 31), new Date(2026, 1, 28), 'a day past the 28th is the 28th');
});

test('used-up characters are told apart from a network blip', () => {
  assert.equal(isQuotaError(401, '{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}'), true);
  assert.equal(isQuotaError(402, ''), true);
  assert.equal(isQuotaError(429, 'Insufficient credits'), true);
  assert.equal(isQuotaError(429, 'too many concurrent requests'), false);
  assert.equal(isQuotaError(401, 'invalid api key'), false);
  assert.equal(isQuotaError(500, 'oops'), false);
});

test('no key, no premium voice', () => {
  const { b } = budget({ env: { CARTESIA_API_KEY: '' } });
  assert.deepEqual(b.canUse('cartesia', 10), { ok: false, why: 'no_key' });
});

test('it stops before the free limit, rests until the period resets, then speaks again', () => {
  const { b, clock, changes } = budget();
  assert.deepEqual(b.canUse('cartesia', 60), { ok: true, why: '' });
  b.spent('cartesia', 60);
  assert.equal(b.status().cartesia.left, 40);
  assert.deepEqual(b.canUse('cartesia', 50), { ok: false, why: 'free_used_up' }, 'never past the free characters');
  const st = b.status().cartesia;
  assert.equal(st.resting, true);
  assert.equal(st.restingUntil, new Date(2026, 10, 1).getTime(), 'until the 1st');
  assert.deepEqual(changes, [{ p: 'cartesia', why: 'free_used_up', prevWhy: '', until: st.restingUntil }]);
  assert.equal(b.canUse('cartesia', 1).ok, false, 'even a short line waits');
  clock.t = new Date(2026, 10, 1, 0, 1).getTime();
  assert.equal(b.status().cartesia.used, 0, 'a new period');
  assert.equal(b.canUse('cartesia', 50).ok, true);
  b.spent('cartesia', 50);
  assert.equal(changes.at(-1).why, '');
  assert.equal(changes.at(-1).prevWhy, 'free_used_up', 'back, and said so once');
  assert.equal(changes.length, 2);
});

test('the provider saying "out of characters" rests it; unknown reset time means a try every 6 hours', () => {
  const { b, clock, changes } = budget();
  b.failed('elevenlabs', { status: 401, body: '{"detail":{"status":"quota_exceeded"}}' });
  assert.equal(b.status().elevenlabs.why, 'quota');
  assert.equal(b.status().elevenlabs.restingUntil, clock.t + 6 * HOUR);
  clock.t += 6 * HOUR + 1;
  assert.equal(b.canUse('elevenlabs', 10).ok, true, 'one try');
  b.failed('elevenlabs', { status: 401, body: 'quota_exceeded' });
  assert.equal(changes.length, 1, 'still out: no "back" and "out" again');
});

test('a refused key rests an hour; three failures in a row rest 5 minutes; one success clears the count', () => {
  const { b, clock } = budget();
  b.failed('cartesia', { status: 401, body: 'invalid api key' });
  assert.equal(b.status().cartesia.why, 'bad_key');
  assert.equal(b.status().cartesia.restingUntil, clock.t + HOUR);
  const { b: c, clock: k } = budget();
  c.failed('cartesia', { timeout: true });
  c.failed('cartesia', { status: 503 });
  c.spent('cartesia', 5);
  c.failed('cartesia', { status: 503 });
  c.failed('cartesia', { status: 503 });
  assert.equal(c.status().cartesia.resting, false, 'not three in a row');
  c.failed('cartesia', { timeout: true });
  assert.equal(c.status().cartesia.why, 'failing');
  assert.equal(c.status().cartesia.restingUntil, k.t + 5 * 60000);
});

test("ElevenLabs' own count is used, and its plan's overage is never used", async () => {
  const calls = [];
  const fetch = async (url, o) => {
    calls.push({ url, key: o.headers['xi-api-key'] });
    return { ok: true, json: async () => ({ character_count: 9950, character_limit: 10000, next_character_count_reset_unix: Math.floor(new Date(2026, 10, 3).getTime() / 1000), can_extend_character_limit: true }) };
  };
  const { b, clock } = budget({ fetch });
  await b.refresh('elevenlabs');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/user/subscription');
  assert.equal(b.status().elevenlabs.left, 50);
  assert.deepEqual(b.canUse('elevenlabs', 80), { ok: false, why: 'free_used_up' });
  assert.equal(b.status().elevenlabs.restingUntil, new Date(2026, 10, 3).getTime());
  // Asked at most every 10 minutes.
  b.maybeRefresh('elevenlabs');
  assert.equal(calls.length, 1);
  clock.t += REFRESH_MS + 1;
  b.maybeRefresh('elevenlabs');
  await b.refreshing;
  assert.equal(calls.length, 2);
  // Its period turned over: the old count is dropped and it's asked again.
  clock.t = new Date(2026, 10, 3, 0, 1).getTime();
  assert.equal(b.status().elevenlabs.used, 0);
  assert.equal(b.status().elevenlabs.resting, false);
});

test('what it knows survives a restart', () => {
  const { b } = budget();
  b.spent('cartesia', 70);
  const again = new VoiceBudget({ file: b.file, now: b.now, env: b.env });
  assert.equal(again.status().cartesia.used, 70);
});

/* ---------- synthesize: premium, else Kokoro ---------- */

const kokoroCalls = [];
voice.setLocalVoiceForTests(async (text, v, speed) => {
  kokoroCalls.push({ text, voice: v, speed });
  return { mime: 'audio/wav', data: Buffer.from('kokoro'), words: null };
});
const realFetch = globalThis.fetch;
function stubFetch(fn) {
  const sent = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => { sent.push({ url: String(url), headers: o?.headers, body: o?.body ? JSON.parse(o.body) : null }); return fn(String(url)); });
  return sent;
}
test.after(() => { globalThis.fetch = realFetch; });

test('Cartesia speaks while it may, with its key, model, voice and speed', async () => {
  process.env.CARTESIA_API_KEY = 'ck';
  const sent = stubFetch(() => new Response(Buffer.from('RIFFwav'), { status: 200 }));
  const a = await voice.synthesize({ text: 'Good news.', provider: 'cartesia', voice: 'v-123', speed: 2, fallbackVoice: 'bf_emma' });
  assert.equal(a.provider, 'cartesia');
  assert.equal(a.mime, 'audio/wav');
  assert.equal(a.fellBack, undefined);
  assert.equal(sent[0].url, 'https://api.cartesia.ai/tts/bytes');
  assert.equal(sent[0].headers.Authorization, 'Bearer ck');
  assert.ok(sent[0].headers['Cartesia-Version']);
  assert.equal(sent[0].body.transcript, 'Good news.');
  assert.deepEqual(sent[0].body.voice, { mode: 'id', id: 'v-123' });
  assert.equal(sent[0].body.generation_config.speed, 1.5, 'clamped to what Sonic takes');
  assert.equal(voice.voiceBudget.status().cartesia.used, 'Good news.'.length);
});

test('out of characters: Kokoro says it in the backup voice, and Echo stops asking until they reset', async () => {
  process.env.ELEVENLABS_API_KEY = 'ek';
  const sent = stubFetch((url) => (url.includes('/subscription') ? new Response('{}', { status: 500 }) : new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 })));
  kokoroCalls.length = 0;
  const a = await voice.synthesize({ text: 'Done.', provider: 'elevenlabs', voice: 'eleven-voice', speed: 1, fallbackVoice: 'bf_emma' });
  assert.deepEqual([a.provider, a.fellBack], ['kokoro', 'quota']);
  assert.deepEqual(kokoroCalls, [{ text: 'Done.', voice: 'bf_emma', speed: 1 }]);
  const tts = sent.filter((s) => s.url.includes('text-to-speech')).length;
  const b = await voice.synthesize({ text: 'Next.', provider: 'elevenlabs', voice: 'eleven-voice', speed: 1, fallbackVoice: 'bf_emma' });
  assert.deepEqual([b.provider, b.fellBack], ['kokoro', 'quota']);
  assert.equal(sent.filter((s) => s.url.includes('text-to-speech')).length, tts, 'no request while resting');
  await assert.rejects(voice.synthesize({ text: 'Hi.', provider: 'elevenlabs', voice: 'x', strict: true }), /quota/);
});

test('a premium voice that fails says that sentence with Kokoro; Kokoro itself is unchanged', async () => {
  process.env.CARTESIA_API_KEY = 'ck';
  stubFetch(() => { throw new Error('getaddrinfo ENOTFOUND'); });
  kokoroCalls.length = 0;
  const a = await voice.synthesize({ text: 'Still here.', provider: 'cartesia', voice: 'v', fallbackVoice: 'af_bella' });
  assert.deepEqual([a.provider, a.fellBack], ['kokoro', 'error']);
  assert.equal(kokoroCalls[0].voice, 'af_bella');
  const k = await voice.synthesize({ text: 'Local.', provider: 'kokoro', voice: 'am_puck', fallbackVoice: 'af_bella' });
  assert.deepEqual([k.provider, k.fellBack], ['kokoro', undefined]);
  assert.equal(kokoroCalls.at(-1).voice, 'am_puck');
});

test('the server says which voice spoke, keeps the backup ready, and tells you when it switches', () => {
  const src = serverSource();
  assert.match(src, /fallbackVoice: s\.fallbackVoice/);
  assert.match(src, /'X-Echo-Voice': audio\.provider/);
  assert.match(src, /budget: voiceBudget\.status\(\)/);
  assert.match(src, /voiceBudget\.onChange = /);
  assert.match(src, /Nothing is being charged/);
  assert.match(src, /\? s\.fallbackVoice : null/);
  assert.match(fs.readFileSync(path.join(root, 'lib/settings.js'), 'utf8'), /fallbackVoice: 'af_heart'/);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.doesNotMatch(html, /id="setFallbackVoice"/, 'Kokoro is always the backup: nothing to pick');
  const app = pageSource();
  assert.match(app, /case 'voiceBudget'/);
  assert.match(fs.readFileSync(path.join(root, 'lib/privacy.js'), 'utf8'), /CARTESIA/);
});
