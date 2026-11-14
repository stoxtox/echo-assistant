// The Sky (lib/sky.ts, public/ui/sky.js): each day with Echo as a constellation, built from the
// timeline's times and counts, kept as numbers, and played as a tune.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Row } from '../lib/timeline.ts';
import { sandbox } from './helpers.js';

const dirs = sandbox('sky');
const { turnsOf, skyDay, buildNight, buildSky, nameOf, sky, keptNights, skyDir, MAX_MAIN } = await import('../lib/sky.ts');
const { noteOf, tune, layout, moonPhase, widthOf, STEPS } = await import('../public/ui/sky.js');
const { record } = await import('../lib/timeline.ts');
const { said } = await import('../lib/transcript.ts');
const { apiHandler } = await import('../lib/server/routes.js');

const TZ = 'America/New_York';
let seq = 0;
const row = (iso: string, type: string, f: Row['f'] = {}, trace?: string): Row => ({ ts: iso, seq: ++seq, src: 'server', type, f, ...(trace ? { trace } : {}) });
/** One turn's rows: said or typed at `iso`, answered with `chars`, with `tools` tool calls and maybe an action. */
const turn = (iso: string, id: string, o: { typed?: boolean; chars?: number; tools?: number; acted?: boolean } = {}): Row[] => [
  row(iso, 'turn.start', { source: o.typed ? 'typed' : 'speech' }, id),
  ...Array.from({ length: o.tools || 0 }, () => row(iso, 'turn.tool_start', { name: 'click' }, id)),
  ...(o.acted ? [row(iso, 'mac.action', { ok: true }, id)] : []),
  row(iso, 'turn.end', { ms: 1200, textChars: o.chars ?? 80 }, id),
];

test('a turn is a star: when, spoken or typed, how much Echo answered, and whether it acted; events are not stars', () => {
  const rows = [
    ...turn('2026-10-06T14:00:00.000Z', 'a', { chars: 40 }),
    ...turn('2026-10-06T14:01:00.000Z', 'b', { typed: true, chars: 900, tools: 2, acted: true }),
    row('2026-10-06T14:02:00.000Z', 'turn.start', { source: 'event' }, 'c'),
    row('2026-10-06T14:02:01.000Z', 'turn.end', { textChars: 50 }, 'c'),
  ];
  const turns = turnsOf(rows);
  assert.deepEqual(turns.map((t) => [t.trace, t.kind, t.chars, t.tools, t.acted]), [['a', 'said', 40, 0, false], ['b', 'typed', 900, 2, true]]);
});

test('a late night belongs to the day it began in', () => {
  assert.equal(skyDay(Date.parse('2026-10-07T06:15:00.000Z'), TZ), '2026-10-06', 'quarter past two at night');
  assert.equal(skyDay(Date.parse('2026-10-07T09:30:00.000Z'), TZ), '2026-10-07', 'half past five in the morning');
});

test('a night is drawn the same every time: later is further right, more answered is higher, and Echo\'s work is bigger', () => {
  const rows = [
    ...turn('2026-10-06T14:00:00.000Z', 'a', { chars: 20 }),
    ...turn('2026-10-06T14:00:40.000Z', 'b', { chars: 1400, tools: 3, acted: true }),
    ...turn('2026-10-06T16:30:00.000Z', 'c', { chars: 200 }),
    ...turn('2026-10-06T16:31:00.000Z', 'd', { chars: 60, typed: true }),
  ];
  const [n] = buildSky(rows, TZ), [again] = buildSky(rows, TZ);
  assert.ok(n && again);
  assert.deepEqual(n, again);
  assert.equal(n.day, '2026-10-06');
  assert.equal(n.label, 'Tuesday 6 October');
  const [a, b, c, d] = n.stars;
  assert.ok(a && b && c && d);
  assert.ok(a.x < b.x && b.x < c.x && c.x < d.x);
  assert.ok(c.x - b.x > b.x - a.x, 'a long silence is a wider step');
  assert.ok(b.y < a.y, 'the long answer is higher up');
  assert.ok(b.size > a.size);
  assert.ok(n.stars.every((s) => s.x >= 0 && s.x <= 1 && s.y > 0 && s.y < 1));
  assert.ok(n.stars.every((s) => s.main), 'a small day joins all its stars');
  assert.deepEqual(n.links, [[0, 1], [2, 3]], 'joined within a conversation, not across the afternoon');
  assert.deepEqual(n.stats, { stars: 4, said: 3, typed: 1, acted: 1, late: 0 });
  assert.ok(!JSON.stringify(n).includes('said":"'), 'numbers only');
});

test('a big day joins and plays only its main stars', () => {
  const rows = Array.from({ length: 150 }, (_, i) => turn(new Date(Date.parse('2026-10-05T13:00:00.000Z') + i * 90_000).toISOString(), `t${i}`, { chars: 30 + (i * 37) % 900, tools: i % 5 === 0 ? 2 : 0 })).flat();
  const [n] = buildSky(rows, TZ);
  assert.ok(n);
  assert.equal(n.stars.length, 150);
  assert.equal(n.stars.filter((s) => s.main).length, MAX_MAIN);
  assert.ok(n.stars[0]?.main && n.stars[149]?.main, 'the first and the last star are always in');
  const notes = tune(n);
  assert.equal(notes.length, MAX_MAIN);
  assert.ok((notes.at(-1)?.at ?? 99) <= 24, 'the tune fits in its time');
  assert.ok(notes.every((x, i) => !i || x.at > (notes[i - 1]?.at ?? 0)));
});

test('what a night is called', () => {
  const at = (iso: string, o: any = {}) => ({ t: Date.parse(iso), trace: iso, kind: 'said', chars: 80, tools: 0, acted: false, ...o });
  assert.equal(nameOf([at('2026-10-06T15:00:00Z')], '2026-10-06', TZ).name, 'The Quiet One');
  const late = Array.from({ length: 8 }, (_, i) => at(`2026-10-07T06:${10 + i}:00Z`));
  assert.deepEqual(nameOf(late, '2026-10-06', TZ), { name: 'The Night Owl', why: 'most of it after midnight' });
  const made = Array.from({ length: 8 }, (_, i) => at(`2026-10-06T18:${10 + i}:00Z`, { acted: i < 5 }));
  assert.equal(nameOf(made, '2026-10-06', TZ).name, 'The Maker');
  const typed = Array.from({ length: 8 }, (_, i) => at(`2026-10-06T18:${10 + i}:00Z`, { kind: 'typed' }));
  assert.equal(nameOf(typed, '2026-10-06', TZ).name, 'The Whisper');
  const morning = Array.from({ length: 8 }, (_, i) => at(`2026-10-06T11:${10 + i}:00Z`));
  assert.equal(nameOf(morning, '2026-10-06', TZ).name, 'The Early Bird');
});

test('a finished day is kept as numbers and outlives the timeline; today is never kept', () => {
  const now = Date.parse('2026-10-07T18:00:00.000Z');
  const rows = [...turn('2026-10-06T14:00:00.000Z', 'a'), ...turn('2026-10-06T14:05:00.000Z', 'b'), ...turn('2026-10-07T15:00:00.000Z', 'c')];
  const first = sky(rows, { dataDir: dirs.data, now, tz: TZ });
  assert.deepEqual(first.map((n) => n.day), ['2026-10-06', '2026-10-07']);
  assert.deepEqual(fs.readdirSync(skyDir(dirs.data)), ['2026-10-06.json']);
  assert.equal(keptNights(dirs.data).length, 1);
  // Two weeks on the timeline has forgotten the 6th: it is still in the sky.
  const later = sky([...turn('2026-10-21T15:00:00.000Z', 'z')], { dataDir: dirs.data, now: Date.parse('2026-10-21T18:00:00.000Z'), tz: TZ });
  assert.deepEqual(later.map((n) => n.day), ['2026-10-06', '2026-10-07', '2026-10-21'].filter((d) => d !== '2026-10-07'));
  // A day the timeline only half remembers does not replace its fuller copy.
  const half = sky([...turn('2026-10-06T14:05:00.000Z', 'b')], { dataDir: dirs.data, now, tz: TZ });
  assert.equal(half.find((n) => n.day === '2026-10-06')?.stars.length, 2);
});

test('the tune: a star\'s height is its pitch, on the night\'s own five notes', () => {
  const night = { root: 60, minor: false, stars: [] };
  const low = noteOf({ y: 1 }, night), high = noteOf({ y: 0 }, night);
  assert.equal(low, 48);
  assert.ok(high > low + 24 && high <= low + 36);
  const all = new Set(Array.from({ length: 101 }, (_, i) => noteOf({ y: i / 100 }, night) % 12));
  assert.deepEqual([...all].sort((a, b) => a - b), [0, 2, 4, 7, 9], 'only the five notes');
  assert.equal(STEPS, 15);
  assert.deepEqual([...new Set(Array.from({ length: 101 }, (_, i) => noteOf({ y: i / 100 }, { root: 57, minor: true }) % 12))].sort((a, b) => a - b), [0, 4, 7, 9].concat([2]).sort((a, b) => a - b));
});

test('the sky is laid out oldest to newest, a fuller day is wider, and the moon fills with today', () => {
  const nights = [{ day: 'a', stars: new Array(10).fill({}) }, { day: 'b', stars: new Array(100).fill({}) }, { day: 'c', stars: new Array(25).fill({}) }];
  const l = layout(nights) as { x: number[]; w: number[]; total: number };
  const [n0, n1] = nights as [any, any, any];
  assert.ok((l.x[0] as number) < (l.x[1] as number) && (l.x[1] as number) < (l.x[2] as number));
  assert.ok(widthOf(n1) > widthOf(n0));
  assert.ok(l.total > (l.x[2] as number) + (l.w[2] as number));
  assert.equal(moonPhase(nights, 'c'), 0.25);
  assert.equal(moonPhase(nights, 'b'), 1);
  assert.equal(moonPhase(nights, 'nothing yet'), 0.06);
});

test('GET /api/sky: this page only, with what was said at a star from the conversation log', async () => {
  const now = Date.now();
  record('server', 'turn.start', { source: 'speech' }, 'sky-1', { now: now - 60_000 });
  record('server', 'turn.end', { ms: 900, textChars: 120 }, 'sky-1', { now: now - 59_000 });
  record('server', 'turn.start', { source: 'typed' }, 'sky-2', { now: now - 30_000 });
  record('server', 'turn.end', { ms: 900, textChars: 60 }, 'sky-2', { now: now - 29_000 });
  said('you', 'said', 'show me something cool', { trace: 'sky-1' }, { now: now - 60_000 });
  said('you', 'typed', 'go', {}, { now: now - 30_500 }); // typed lines carry no turn id: matched by time
  const api = apiHandler({ computer: {}, dispatcher: {}, speech: { routes: {} }, broadcast: () => {}, tasks: { list: () => [] }, shutDown: () => {} } as any);
  const server = http.createServer((req, res) => { api(req, res, new URL(req.url || '/', 'http://localhost')).catch((e: Error) => res.writeHead(400).end(e.message)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = server.address() as import('node:net').AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/sky`, { headers: { Origin: 'https://example.com' } })).status, 403);
    const r = (await (await fetch(`http://127.0.0.1:${port}/api/sky`)).json()) as any;
    assert.equal(r.words, true);
    const stars = r.nights.at(-1).stars;
    assert.deepEqual(stars.slice(-2).map((s: any) => [s.kind, s.said]), [['said', 'show me something cool'], ['typed', 'go']]);
    assert.ok(!fs.readdirSync(path.join(dirs.data, 'timeline')).some((f) => fs.readFileSync(path.join(dirs.data, 'timeline', f), 'utf8').includes('something cool')), 'the timeline still holds no words');
  } finally {
    server.close();
  }
});
