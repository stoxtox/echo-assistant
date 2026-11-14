// The light report (scripts/light.ts): the light's trips read back from the timeline, with the
// words of each step from the conversation log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Row } from '../lib/timeline.ts';
import type { Line } from '../lib/transcript.ts';
import { sandbox } from './helpers.js';

sandbox('light');
const { trips, summary, render } = await import('../scripts/light.ts');

const T0 = Date.parse('2026-10-07T15:00:00.000Z');
let seq = 0;
const row = (at: number, type: string, f: Row['f'] = {}): Row => ({ ts: new Date(T0 + at).toISOString(), seq: ++seq, src: 'server', type, f });
const step = (at: number, id: string, text: string): Line => ({ ts: new Date(T0 + at).toISOString(), who: 'echo', kind: 'step', text, id });
const A = 'a'.repeat(16), B = 'b'.repeat(16), C = 'c'.repeat(16);

test('a job read back: each thing shown, the words that went with it, and a trip home in the middle', () => {
  const rows = [
    row(0, 'light.departed', { id: A, ms: 500, from: 'pearl' }),
    row(500, 'light.arrived', { id: A, ms: 500 }),
    row(510, 'speech.synced', { kind: 'act', ms: 510, light: A, line: 'v2', lead: 'v1' }),
    // v2 was asked for at 510 and first heard 200 ms later; it ended at 1700.
    row(1700, 'voice.line', { id: 'v2', chars: 20, ms: 1190, startMs: 200 }),
    // (The words were asked for as the light left: their row comes before the landing's.)
    row(3000, 'light.departed', { id: B, ms: 350, from: 'target' }),
    row(3002, 'speech.synced', { kind: 'act', ms: 2, light: B, line: 'v3' }),
    row(3350, 'light.arrived', { id: B, ms: 350 }),
    row(6000, 'voice.line', { id: 'v3', chars: 12, ms: 2998, startMs: 1858 }),
    row(8000, 'light.home', { ms: 8000, stops: 2, why: 'step', working: true }),
    row(11000, 'light.departed', { id: C, ms: 600, from: 'pearl' }),
    row(16000, 'speech.unsynced', { kind: 'act', ms: 5000, light: C }),
    row(20000, 'light.home', { ms: 9000, stops: 1, why: 'over' }),
  ];
  const lines = [step(5, 'v1', 'In the sidebar,'), step(512, 'v2', 'clicking Desktop.'), step(3003, 'v3', 'Now Save.')];
  const all = trips(rows, lines);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0]?.stops.map((s: any) => [s.from, s.words, s.gapMs]), [['pearl', 'In the sidebar, clicking Desktop.', 210], ['target', 'Now Save.', 1510]]);
  assert.equal(all[0]?.midJob, true);
  assert.deepEqual(summary(all), { trips: 2, shown: 3, onward: 1, turned: 0, homeMidJob: 1, together: 1, late: 1, early: 0, lateAvgMs: 1510, unsynced: 1 });
  const text = render(all).join('\n');
  assert.match(text, /Went home in the middle of a job: 1 time\b/);
  assert.match(text, /said: “In the sidebar, clicking Desktop.”/);
  assert.match(text, /words began with the landing/);
  assert.match(text, /words began 1\.5 s after it landed {3}<< late/);
  assert.match(text, /On to the next thing, landed after 350 ms/);
  assert.match(text, /never said it landed/);
  assert.match(text, /<< in the middle of a job/);
});

test('with no conversation log the report still counts, without words', () => {
  const all = trips([row(0, 'light.departed', { id: A, ms: 400, from: 'pearl' }), row(400, 'light.arrived', { id: A, ms: 400 }), row(2500, 'light.home', { ms: 2500, stops: 1, why: 'over' })]);
  assert.equal(summary(all).trips, 1);
  assert.ok(!render(all).join('\n').includes('said:'));
});
