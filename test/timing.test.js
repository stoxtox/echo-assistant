// Echo's voice in step with its light (docs/firefly-protocol.md, section 5): a step's words wait
// until the Mac app says the light has landed on the step's target (`arrived`), or 1.2 s at most;
// words that only say where ("Top left, …") may be spoken while the light flies; a lesson step is
// spoken once the light is on its target; and in a lesson a result sits a moment before the next
// step starts. A fake "Mac app" answers every request and says (or never says) that its light
// arrived; nothing touches a screen or a voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { sandbox, until, wait } from './helpers.js';

const dirs = sandbox('timing');
const { apiHandler } = await import('../lib/server/routes.js');
const { bodyToken } = await import('../lib/bodylink.ts');
const { readTimeline } = await import('../lib/timeline.ts');
const { ScreenBridge } = await import('../lib/screen.js');
const { ComputerUse, splitNarration, lightOf, LIGHT_WAIT_MS, SIT_MS, computerPrompt } = await import('../lib/computer.js');
const { computerTools } = await import('../lib/tools/computer.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const on = (more = {}) => (setFixedForTest({ screenAware: true, reduceMotion: 'system' }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do', ...more }));
const unsynced = () => readTimeline(dirs.data).filter((e) => e.type === 'speech.unsynced');

/**
 * A bridge whose "Mac app" answers every request. `light`: its light flies out for every point and
 * act resolve (the answer says `light: true`) and it says `arrived` this many ms later (`never`:
 * it never does; `early`: before it answers). Without `light` it is an app from before all this.
 * @param {{ light?: number | 'never' | 'early', verified?: boolean }} [o]
 */
function fakeApp(o = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 2000, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  /** @type {Array<{ at: number, what: string }>} */
  const log = [];
  /** @type {{ c: InstanceType<typeof ComputerUse> | null }} */
  const to = { c: null };
  const arrived = (id) => {
    log.push({ at: Date.now(), what: 'arrived' });
    to.c?.light({ type: 'arrived', id, ms: 300 });
  };
  bridge.on('request', (r) => {
    const p = r.params;
    log.push({ at: Date.now(), what: r.kind === 'act' ? `act.${p.step}` : r.kind });
    const flies = o.light !== undefined && (r.kind === 'point' || (r.kind === 'act' && p.step === 'resolve'));
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: 't', label: p.target || '', role: 'AXButton', app: 'Preview', window: 'Untitled' };
    else if (r.kind === 'act') out = { ok: true, via: 'accessibility', app: 'Preview', window: 'Untitled', ...(o.verified ? { verified: true, changes: ['windows', 'content'] } : {}) };
    else if (r.kind === 'wait') out = { ok: true, found: true, via: 'accessibility', label: p.target };
    else if (r.kind === 'state') out = { ok: true, app: 'Preview', window: 'Untitled', menuOpen: false, focus: {}, elements: {} };
    else if (r.kind === 'point') out = { found: true, via: 'accessibility', label: p.target, role: 'AXMenuItem', app: 'Preview', debug: { frame: { x: 100, y: 100, width: 40, height: 20 }, screen: { x: 0, y: 0, width: 1440, height: 900 } } };
    if (!out) return;
    // As the real app does: the answer carries the request's id, and `light` when its light set off.
    out = { ...out, id: r.id, ...(flies ? { light: true } : {}) };
    if (flies && o.light === 'early') arrived(r.id);
    setImmediate(() => bridge.deliver(r.id, out));
    if (flies && typeof o.light === 'number') setTimeout(() => arrived(r.id), o.light);
  });
  return { bridge, log, to, times: (what) => log.filter((e) => e.what === what).map((e) => e.at) };
}

/** A computer over a fake app, with what it said and when. */
function setup(o = {}, opts = {}) {
  on();
  const app = fakeApp(o);
  const c = new ComputerUse({ bridge: app.bridge, logFile, ...opts });
  app.to.c = c;
  /** @type {Array<{ at: number, text: string }>} */
  const said = [];
  c.on('say', (text) => said.push({ at: Date.now(), text }));
  return { ...app, c, said, texts: () => said.map((s) => s.text) };
}

/* ---------- region, then target: the split ---------- */

test('a step that says where first is split there: the place while the light flies, the thing as it lands', () => {
  assert.deepEqual(splitNarration('Top left, the square icon.'), { lead: 'Top left,', rest: 'the square icon.' });
  assert.deepEqual(splitNarration('In the toolbar, click the brush.'), { lead: 'In the toolbar,', rest: 'click the brush.' });
  assert.deepEqual(splitNarration('At the bottom of the window, this one.'), { lead: 'At the bottom of the window,', rest: 'this one.' });
  assert.deepEqual(splitNarration('On the right: the Share button.'), { lead: 'On the right:', rest: 'the Share button.' });
  assert.deepEqual(splitNarration('Top right corner. Click Control Center.'), { lead: 'Top right corner.', rest: 'Click Control Center.' });
  assert.deepEqual(splitNarration('  bottom-left,   this one  '), { lead: 'bottom-left,', rest: 'this one' });
});

test('words with no leading place are never split, and never inside a sentence', () => {
  for (const line of [
    'Clicking Send…',
    'Click Control Center, top right.', // the place comes last: it is all spoken as the light lands
    'Click the brush in the toolbar, then drag.',
    'Opening Chrome, then searching.',
    'Now, click Save.',
    'Top left',
    'Top left,',
    'On the right side of the big window near the very top edge of it, click.', // too long to be only a place
    'This one, top left, is the tool.',
    '',
  ]) assert.deepEqual(splitNarration(line), { lead: '', rest: line.trim() }, line);
  assert.deepEqual(splitNarration(/** @type {any} */ (undefined)), { lead: '', rest: '' });
});

test('the assistant is told to say where first and keep the pointing word for last', () => {
  const tools = Object.fromEntries(computerTools(/** @type {any} */ ({})).map((t) => [t.name, /** @type {any} */ (t)]));
  const text = (shape) => JSON.stringify(z.toJSONSchema(z.object(shape)));
  for (const name of ['click', 'guide', 'teach']) {
    assert.match(text(tools[name].inputSchema), /[Ss]ay where first, then the thing/, name);
    assert.match(text(tools[name].inputSchema), /pointing word \(this, here\) for last/, name);
  }
  assert.equal(typeof computerPrompt, 'function');
});

/* ---------- speech waits for the light ---------- */

test('a step Echo does: its words are held until the app says the light has arrived', async () => {
  const s = setup({ light: 150 });
  const before = unsynced().length;
  const started = Date.now();
  const r = await s.c.act('click', { target: 'Export', say: 'Clicking Export…' });
  assert.equal(r.done, true);
  assert.deepEqual(s.texts(), ['Clicking Export…']);
  const [landed] = s.times('arrived'), [did] = s.times('act.do');
  assert.ok(landed - started >= 140, 'the light took its time');
  assert.ok(s.said[0].at >= landed, `spoken as it landed, not before (said ${s.said[0].at - started} ms in, landed ${landed - started} ms in)`);
  assert.ok(s.said[0].at - landed < 100, 'and no later than that');
  assert.ok(did >= s.said[0].at, 'the click follows the words');
  assert.equal(unsynced().length, before, 'in step: nothing to log');
});

test('the place is spoken while the light flies, the thing as it lands', async () => {
  const s = setup({ light: 150 });
  await s.c.act('click', { target: 'Stop', say: 'Top left, the square icon.' });
  assert.deepEqual(s.texts(), ['Top left,', 'the square icon.']);
  const [landed] = s.times('arrived');
  assert.ok(s.said[0].at < landed - 100, 'the place: at once');
  assert.ok(s.said[1].at >= landed, 'the thing: as the light lands');
});

test('an app that never says it arrived: the words are spoken anyway after the limit, and the timeline says so', async () => {
  assert.equal(LIGHT_WAIT_MS, 1200);
  const s = setup({ light: 'never' }, { lightWaitMs: 120 });
  const before = unsynced().length;
  const started = Date.now();
  const r = await s.c.act('click', { target: 'Export', say: 'Clicking Export…' });
  assert.equal(r.done, true, 'the step still happens');
  assert.deepEqual(s.texts(), ['Clicking Export…']);
  const waited = s.said[0].at - started;
  assert.ok(waited >= 110 && waited < 600, `after the limit, not before and not much after (${waited} ms)`);
  const rows = unsynced().slice(before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].f.kind, 'act');
  assert.ok(Number(rows[0].f.ms) >= 110);
  assert.doesNotMatch(JSON.stringify(rows[0]), /Export/, 'never the words or the target');
});

test('an app that is not pointing (an older app, the pointer off, nothing found to fly to): spoken at once, as before', async () => {
  const s = setup({});
  const before = unsynced().length;
  const started = Date.now();
  await s.c.act('click', { target: 'Export', say: 'Top left, the square icon.' });
  assert.deepEqual(s.texts(), ['Top left, the square icon.'], 'and in one piece');
  assert.ok(s.said[0].at - started < 100);
  assert.ok(s.said[0].at <= s.times('act.do')[0]);
  assert.equal(unsynced().length, before);
  // Only a real answer from the app counts as "a light is coming".
  assert.equal(lightOf({ light: true, id: 'abcdef0123456789' }), 'abcdef0123456789');
  for (const a of [null, {}, { light: true }, { light: 'yes', id: 'abcdef0123456789' }, { light: true, id: 'nope' }, { id: 'abcdef0123456789' }, { light: true, id: 'abcdef0123456789', found: false }]) assert.equal(lightOf(a), '');
});

test('an arrival that beats the answer (a short flight) is not lost', async () => {
  const s = setup({ light: 'early' }, { lightWaitMs: 5000 });
  const started = Date.now();
  await s.c.act('click', { target: 'Export', say: 'Clicking Export…' });
  assert.deepEqual(s.texts(), ['Clicking Export…']);
  assert.ok(s.said[0].at - started < 200, 'no waiting for an arrival that already happened');
});

test('a step with no words waits for nothing', async () => {
  const s = setup({ light: 'never' }, { lightWaitMs: 5000 });
  const started = Date.now();
  assert.equal((await s.c.act('click', { target: 'Export' })).done, true);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(s.texts(), []);
});

test('a quick lesson step (what a guide step was) is spoken as the light lands on it, not as it sets off', async () => {
  const s = setup({ light: 150 });
  const r = await s.c.startLesson({ quick: true, steps: [{ target: 'Export', say: 'In the File menu, choose Export.' }] });
  assert.equal(r.started, true, JSON.stringify(r));
  await until(() => s.said.length === 1);
  assert.deepEqual(s.texts(), ['In the File menu, choose Export.']);
  const [asked] = s.times('point'), [landed] = s.times('arrived');
  assert.ok(landed - asked >= 140);
  assert.ok(s.said[0].at >= landed, 'as it lands');
  assert.equal(s.c.lesson.active, false, 'one step: pointed out, said, over');
});

/* ---------- lessons ---------- */

test('a lesson step is spoken when the light has arrived on its target', async () => {
  const s = setup({ light: 200 });
  await s.c.startLesson({ goal: 'export a file', steps: [{ say: 'Click Export.', target: 'Export', check: { kind: 'label_present', label: 'Saved' } }] });
  await until(() => s.said.length > 0);
  const [landed] = s.times('arrived'), [asked] = s.times('point');
  s.c.abort('test over');
  assert.match(s.said[0].text, /^Click Export\./);
  assert.ok(landed - asked >= 190);
  assert.ok(s.said[0].at >= landed, `not before the light is there (${s.said[0].at - asked} ms after the point, landed at ${landed - asked})`);
});

test('a lesson whose app never says the light arrived still speaks the step, a moment later', async () => {
  const s = setup({ light: 'never' }, { lightWaitMs: 120 });
  const before = unsynced().length;
  await s.c.startLesson({ goal: 'export a file', steps: [{ say: 'Click Export.', target: 'Export', check: { kind: 'label_present', label: 'Saved' } }] });
  await until(() => s.said.length > 0);
  s.c.abort('test over');
  assert.match(s.said[0].text, /^Click Export\./);
  assert.ok(s.said[0].at - s.times('point')[0] >= 110);
  assert.equal(unsynced().slice(before).at(-1)?.f.kind, 'lesson');
});

/* ---------- let the result sit ---------- */

test('in a lesson, after a step that visibly changed something, the next step does not start for 700 ms', async () => {
  assert.equal(SIT_MS, 700);
  const s = setup({ verified: true }, { sitMs: 200 });
  s.c.lesson = /** @type {any} */ ({ active: true, release() {} });
  assert.equal((await s.c.act('click', { target: 'Bold', say: 'Clicking Bold…' })).verified, true);
  const changed = Date.now();
  await s.c.act('click', { target: 'Italic', say: 'Clicking Italic…' });
  const next = s.times('act.resolve')[1];
  assert.ok(next - changed >= 180, `the result sat (${next - changed} ms)`);
  assert.ok(s.said[1].at >= next, 'and its words waited with it');
});

test('show-me mode lets it sit too; just doing the job never waits, nor does Reduce Motion', async () => {
  const gap = async (settings, { lesson = false, still = false, verified = true } = {}) => {
    const s = setup({ verified }, { sitMs: 200 });
    const { reduceMotion = 'system', ...saved } = settings;
    setFixedForTest({ reduceMotion });
    saveSettings(saved);
    if (lesson) s.c.lesson = /** @type {any} */ ({ active: true, release() {} });
    if (still) s.c.light({ type: 'arrived', id: 'a'.repeat(16), ms: 0, still: true });
    // The change itself: as if a step had just been seen to work.
    s.c.changedAt = Date.now();
    const from = Date.now();
    await s.c.act('scroll', { direction: 'down' });
    return s.times('act.resolve')[0] - from;
  };
  assert.ok((await gap({ driveMode: 'show' })) >= 180, 'showing how');
  assert.ok((await gap({ driveMode: 'do' })) < 100, 'doing the job: full speed');
  assert.ok((await gap({ driveMode: 'do', reduceMotion: 'on' }, { lesson: true })) < 100, 'the companion told to keep still');
  assert.ok((await gap({ driveMode: 'do' }, { lesson: true, still: true })) < 100, 'the app said it shows no travel');
  on();
  // A step that changed nothing visible leaves nothing to look at.
  const s = setup({ verified: false }, { sitMs: 200 });
  s.c.lesson = /** @type {any} */ ({ active: true, release() {} });
  await s.c.act('click', { target: 'Bold' });
  const from = Date.now();
  await s.c.act('click', { target: 'Italic' });
  assert.ok(s.times('act.resolve')[1] - from < 100);
});

/* ---------- the event itself ---------- */

test('only the Mac app (its token, never a web page) can say the light arrived; the timeline gets the flight, never a name', async () => {
  const s = setup({ light: 'never' }, { lightWaitMs: 5000 });
  const api = apiHandler(/** @type {any} */ ({ computer: s.c, dispatcher: {}, speech: { routes: {} }, broadcast: () => {}, tasks: { list: () => [] }, shutDown: () => {} }));
  const server = http.createServer((req, res) => {
    api(req, res, new URL(req.url || '/', 'http://localhost')).catch((e) => res.writeHead(400).end(e.message));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const post = (headers, body) => fetch(`http://127.0.0.1:${port}/api/computer/event`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const token = bodyToken();
  try {
    // A step is waiting for its light.
    const step = s.c.act('click', { target: 'Export', say: 'Clicking Export…' });
    await until(() => s.c.lightWaiters.size === 1);
    const [id] = [...s.c.lightWaiters.keys()];
    const arrived = { type: 'arrived', id, ms: 412 };
    assert.equal((await post({}, arrived)).status, 403, 'no token');
    assert.equal((await post({ 'X-Echo-Token': 'f'.repeat(64) }, arrived)).status, 403, 'a wrong token');
    assert.equal((await post({ 'X-Echo-Token': token, Origin: 'http://localhost:4777' }, arrived)).status, 403, 'a web page, even with the token');
    await wait(50);
    assert.deepEqual(s.texts(), [], 'none of those let the words go');
    assert.deepEqual(await (await post({ 'X-Echo-Token': token }, { type: 'arrived', id: 'not-an-id', ms: 1 })).json(), { ok: false });
    assert.deepEqual(await (await post({ 'X-Echo-Token': token }, { type: 'departed', id })).json(), { ok: true });
    assert.deepEqual(s.texts(), [], 'leaving the pearl is not arriving');
    const since = Date.now() - 5000;
    const ok = await post({ 'X-Echo-Token': token }, { ...arrived, label: 'Export', target: 'Export' });
    assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }]);
    assert.equal((await step).done, true);
    assert.deepEqual(s.texts(), ['Clicking Export…']);
    const rows = readTimeline(dirs.data, since).filter((e) => e.type.startsWith('light.'));
    assert.deepEqual(rows.slice(-2).map((e) => [e.type, e.f]), [['light.departed', { id }], ['light.arrived', { id, ms: 412 }]]);
    // Going back to the pearl is noted too (how long it was out, how many things it showed, why,
    // and whether a job was still on), from the app only, and never with a name.
    assert.equal((await post({}, { type: 'home', ms: 5200, stops: 2, why: 'step', working: true })).status, 403, 'no token');
    assert.deepEqual(await (await post({ 'X-Echo-Token': token }, { type: 'home', ms: 5200, stops: 2, why: 'step', working: true, label: 'Export' })).json(), { ok: true });
    assert.deepEqual(await (await post({ 'X-Echo-Token': token }, { type: 'departed', id, ms: 300, from: 'target', target: 'Export' })).json(), { ok: true });
    const more = readTimeline(dirs.data, since).filter((e) => e.type.startsWith('light.')).slice(-2).map((e) => [e.type, e.f]);
    assert.deepEqual(more, [['light.home', { ms: 5200, stops: 2, why: 'step', working: true }], ['light.departed', { id, ms: 300, from: 'target' }]]);
    // The step's words are tied to the landing by name: which voice line, never the words.
    const synced = readTimeline(dirs.data, since).filter((e) => e.type === 'speech.synced').pop();
    assert.equal(synced?.f.light, id);
    assert.match(String(synced?.f.line), /^v\d+$/);
    assert.ok(!JSON.stringify(readTimeline(dirs.data, since)).includes('Export'), 'no name or word reaches the timeline');
    // Stopping a run over the same route still needs no token (the app's take-over, as before).
    assert.equal((await post({}, { type: 'pause', reason: 'user input' })).status, 200);
  } finally {
    server.close();
  }
});
