// "What happened" (Settings): the timeline grouped by turn in plain English (lib/timelineview.ts),
// served by GET /api/timeline and shown by public/ui/timelineview.js. Timings only, never words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, pageSource } from './helpers.js';

const dirs = sandbox('timelineview');
const view = await import('../lib/timelineview.ts');
const { apiRoutes } = await import('../lib/server/routes.js');
// @ts-ignore a page module, plain JavaScript
const page = await import('../public/ui/timelineview.js');

type AnyRow = { ts: string; seq: number; src: 'app' | 'page' | 'server'; type: string; trace?: string; f: Record<string, string | number | boolean>; cts?: number; cseq?: number };
let seq = 0;
/** A row `ms` after `t0`; the app and the page carry their own clock. */
const row = (t0: number, ms: number, src: AnyRow['src'], type: string, f: AnyRow['f'] = {}, trace?: string): AnyRow => {
  const own = src !== 'server';
  return { ts: new Date(t0 + ms + (own ? 400 : 0)).toISOString(), seq: ++seq, src, type, ...(trace ? { trace } : {}), f, ...(own ? { cts: t0 + ms, cseq: seq } : {}) };
};
/** A slow spoken turn, a line that dropped between turns, then a quick typed turn a minute later. */
function session(t0: number, name = 'view'): AnyRow[] {
  const a = `t-${name}-0001`;
  const b = `t-${name}-0002`;
  return [
    row(t0, -3000, 'app', 'gate.onset', { label: 'push-to-talk', manual: true }),
    row(t0, -600, 'app', 'gate.end', { seconds: 2.4, peak: 0.3 }),
    row(t0, 0, 'server', 'turn.start', { source: 'speech', model: 'default' }, a),
    row(t0, 3300, 'server', 'model.request', { model: 'opus', ctx: 41000, firstMs: 2900, ms: 3100 }, a),
    row(t0, 3350, 'server', 'turn.tool_end', { name: 'get_task', ms: 900, ok: true }, a),
    row(t0, 3400, 'server', 'turn.first_speech', { ms: 3400 }, a),
    row(t0, 3500, 'app', 'overlay.show', { name: 'caption' }),
    row(t0, 3700, 'page', 'play.start', { chars: 48, ms: 250 }, a),
    row(t0, 3750, 'server', 'turn.first_sound', { ms: 3700 }, a),
    row(t0, 5000, 'server', 'model.turn', { ms: 5000, requests: 1 }, a),
    row(t0, 5000, 'server', 'turn.end', { ms: 5000, requests: 1, spoke: true, spokenChars: 48 }, a),
    row(t0, 20_000, 'server', 'body.drop', { code: 1006, ms: 60_000 }),
    row(t0, 60_000, 'server', 'turn.start', { source: 'typed', model: 'default' }, b),
    row(t0, 60_900, 'server', 'model.request', { model: 'haiku', firstMs: 500, ms: 800 }, b),
    row(t0, 60_950, 'server', 'turn.first_speech', { ms: 950 }, b),
    row(t0, 61_200, 'server', 'turn.first_sound', { ms: 1200 }, b),
    row(t0, 62_000, 'server', 'turn.end', { ms: 2000, requests: 1, spoke: true, spokenChars: 20 }, b),
  ];
}
const NOON = Date.parse('2026-07-04T16:00:00.000Z'); // noon in New York (the sandbox's time zone)

test('turns are grouped newest first, each with its first sound, where the time went, a slow mark and its lines', () => {
  const turns = view.turnsView(session(NOON) as any);
  assert.deepEqual(turns.map((t) => t.trace), ['t-view-0002', 't-view-0001']);
  const [typed, spoken] = turns as [any, any];
  assert.equal(spoken.time, '12:00:00');
  // From the end of the sentence: 600 ms to become a turn, then 3.7 s to the first sound.
  assert.equal(spoken.firstSoundMs, 4300);
  assert.equal(spoken.firstSound, 'First sound after 4.3 s');
  assert.equal(spoken.summary, 'listening 2.4 s, speech recognition 600 ms, model first word 3.4 s, tools 900 ms, voice 300 ms');
  assert.equal(spoken.total, '5.0 s');
  assert.equal(spoken.slow, true, 'the model took 2.9 s to its first word');
  assert.equal(spoken.problem, false, "the line that dropped later is not this turn's doing");
  const texts = spoken.lines.map((l: any) => l.text);
  assert.equal(texts[0], 'Speech started (push-to-talk)', 'the listening before the turn is part of its story');
  assert.equal(spoken.lines[0].ms, -3000);
  assert.ok(texts.includes('Overlay shown: caption'), 'what the app noted during the turn');
  assert.ok(texts.includes('Tool finished: get_task (900 ms)'));
  assert.ok(!texts.some((t: string) => /dropped/.test(t)), 'nothing from after the turn');
  assert.ok(!texts.some((t: string) => /Model: turn/.test(t)), 'the turn is not told twice');
  assert.equal(spoken.lines.find((l: any) => l.text.startsWith('Model call finished')).mark, 'slow');
  assert.equal(spoken.lines.at(-1).time, '12:00:05.000');
  // A typed turn has no listening, even with speech heard shortly before it.
  assert.equal(typed.summary, 'model first word 950 ms, tools 1.2 s, voice 250 ms');
  assert.equal(typed.firstSound, 'First sound after 1.2 s');
  assert.equal(typed.slow, false);
  assert.deepEqual(view.turnsView(session(NOON) as any, 't-view-0001').map((t) => t.trace), ['t-view-0001']);
  // A turn that broke: no sound, and marked.
  const broken = view.turnsView([row(NOON, 0, 'server', 'turn.start', { source: 'typed' }, 't-view-0003'), row(NOON, 900, 'page', 'play.stalled', {}, 't-view-0003')] as any)[0] as any;
  assert.equal(broken.firstSound, 'No sound');
  assert.equal(broken.problem, true);
  assert.equal(broken.lines[1].mark, 'problem');
});

test('"today" starts at midnight in Echo\'s time zone; a span counts back from now', () => {
  const now = Date.parse('2026-07-04T16:30:15.250Z'); // 12:30:15 in New York
  assert.equal(new Date(view.todayStart(now)).toISOString(), '2026-07-04T04:00:00.000Z');
  assert.equal(view.sinceWhen('today', now), view.todayStart(now));
  assert.equal(view.sinceWhen('10m', now), now - 600_000);
  assert.equal(view.sinceWhen('1h', now), now - 3_600_000);
  assert.ok(Number.isNaN(view.sinceWhen('soon', now)));
});

/** Call the route the way the server does, and collect its answer. */
async function get(query: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const routes = apiRoutes({} as any);
  const out = { status: 0, text: '' };
  const res = { writeHead: (s: number) => ((out.status = s), res), end: (t: string) => void (out.text = t) };
  await (routes['GET /api/timeline'] as any)({ headers, method: 'GET' }, res, new URL(`http://localhost/api/timeline${query}`));
  return { status: out.status, body: JSON.parse(out.text) };
}

test('GET /api/timeline: the turns since 10m, 1h or today, or one turn by id; this page only', async () => {
  const now = Date.now();
  const rows = [...session(now - 30 * 60_000), ...session(now - 5 * 60_000, 'late')];
  const dir = path.join(dirs.data, 'timeline');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const recent = await get('?since=10m');
  assert.equal(recent.status, 200);
  assert.deepEqual(recent.body.turns.map((t: any) => t.trace), ['t-late-0002', 't-late-0001']);
  assert.match(recent.body.turns[1].summary, /^listening 2\.4 s, speech recognition 600 ms/);
  // Only timings and names leave the server: these fields, and lines of time, who, wording and mark.
  assert.deepEqual(Object.keys(recent.body.turns[0]).sort(), ['at', 'firstSound', 'firstSoundMs', 'lines', 'problem', 'slow', 'summary', 'time', 'total', 'trace']);
  assert.deepEqual(Object.keys(recent.body.turns[0].lines[0]).sort(), ['mark', 'ms', 'src', 'text', 'time']);
  assert.equal((await get('')).body.turns.length, 2, 'ten minutes when nothing is asked');
  assert.equal((await get('?since=1h')).body.turns.length, 4);
  const one = await get('?turn=t-view-0001');
  assert.deepEqual(one.body.turns.map((t: any) => t.trace), ['t-view-0001'], 'a turn asked for by id is found outside the last ten minutes');
  assert.equal((await get('?since=soon')).status, 400);
  assert.equal((await get('?turn=../../etc')).status, 400);
  assert.equal((await get('?since=1h', { origin: 'http://elsewhere.example' })).status, 403);
});

test('the page: counted times, the slow filter and the text Copy gives', () => {
  assert.equal(page.offset(-2400), '−2.4 s');
  assert.equal(page.offset(340), '+0.3 s');
  const turns = view.turnsView(session(NOON) as any);
  assert.equal(page.shownTurns(turns, false).length, 2);
  assert.deepEqual(page.shownTurns(turns, true).map((t: any) => t.trace), ['t-view-0001']);
  const text = page.turnText(turns[1]).split('\n');
  assert.equal(text[0], 'Turn at 12:00:00 · First sound after 4.3 s · slow');
  assert.equal(text[1], 'Where the time went: listening 2.4 s, speech recognition 600 ms, model first word 3.4 s, tools 900 ms, voice 300 ms (turn 5.0 s)');
  assert.ok(text.includes('11:59:57.000  app     Speech started (push-to-talk)'));
  assert.ok(text.some((l: string) => /server {2}Model call finished .* {2}\(slow\)$/.test(l)));
});

test('the window has the view, and each of Echo\'s replies carries its turn for the "…" beside it', () => {
  const pub = path.resolve(import.meta.dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  for (const since of ['10m', '1h', 'today']) assert.match(html, new RegExp(`class="chip[^"]*" data-since="${since}"`));
  assert.match(html, /id="tlSlow"[^>]*>Only slow ones</);
  assert.match(html, /id="tlList"/);
  const src = pageSource();
  // Both ways a reply reaches the page mark its bubble: streamed (with its first spoken piece) and whole.
  assert.match(src, /case 'speak': gapFiller\.stop\(\); tagTurn\(liveBubble, msg\.trace\)/);
  assert.match(src, /tagTurn\(bubble, msg\.trace\);\n\s+speakAll\(/);
  // The view opens in the dialog (from the "more" menu, or a reply's "…"), and reads the timeline as it does.
  assert.match(html, /<div id="happenedView" hidden>/);
  assert.match(src, /openModal\('What happened', \[happenedView\]/);
  assert.match(src, /more\.onclick = \(\) => show\(more\.dataset\.trace \|\| ''\);/);
  assert.match(src, /state\.only = trace;\n\s+open\(\);\n\s+load\(\);/);
  assert.match(src, /fetch\(`\/api\/timeline\?\$\{query\}`\)/);
  // The gradient is only the thin edge of a flagged turn.
  const tl = css.slice(css.indexOf('/* What happened'), css.indexOf('/* Mac-only settings'));
  assert.deepEqual(tl.match(/[^\n]*var\(--grad\)[^\n]*/g)?.map((l) => l.trim().split(' ')[0]), ['.tl-turn.flagged::before']);
});
