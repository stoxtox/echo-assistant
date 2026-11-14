// Explain by showing (lib/explain.js, the explain_on_screen tool): Echo walks through what is on
// screen in small pieces, pointing at each as it says one sentence, with one card in the chat.
// Everything runs against a simulated Mac (a document of pages with a view that scrolls); nothing
// here touches a real screen or app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, until, wait, result, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('explain');
const { ScreenBridge } = await import('../lib/screen.js');
const { ComputerUse } = await import('../lib/computer.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { cleanChunks, explainCommand, wayToScroll, VIEW_TRIES, CHUNKS_MAX } = await import('../lib/explain.js');

setFixedForTest({ screenAware: true });

const SCREEN = { index: 0, x: 0, y: 0, width: 1512, height: 982, scale: 2 };

/**
 * A simulated Mac showing one long document: `doc` says which page each heading is on, and
 * `view` is the page on screen. The pointer finds a heading only when its page is in view (as it
 * does in Word, where the page is read from the picture); a scroll moves the view one page and,
 * as in Word, the app sees nothing change (verified: false).
 * `hints`: a heading out of view is found by name and the app says which way to scroll.
 */
function simMac({ doc, view = 0, pages = 6, hints = false, intoView = false, voiceMs = 5, computerUse = true, lightMs = 10, start = false, beatMs = 5 }) {
  saveSettings({ pointer: true, computerUse });
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const mac = { view, requests: /** @type {any[]} */ ([]), events: /** @type {string[]} */ ([]) };
  const spoken = /** @type {string[]} */ ([]);
  // The voice: a line is over `voiceMs` after it was asked for.
  const voice = { line: (t) => (spoken.push(t), mac.events.push(`say:${t}`), `v${spoken.length}`), whenDone: () => wait(voiceMs), whenQuiet: async () => true, startDelayMs: () => 0 };
  const computer = new ComputerUse({ bridge, voice: /** @type {any} */ (voice), logFile: path.join(dirs.data, 'computer-log.jsonl'), lightWaitMs: 400, sitMs: 0 });
  bridge.on('request', (r) => {
    mac.requests.push(r);
    const p = r.params;
    const answer = (body) => setImmediate(() => bridge.deliver(r.id, body));
    if (r.kind === 'point') {
      const page = doc[p.target];
      if (page === mac.view) {
        answer({ found: true, via: 'screen', label: p.target, role: 'AXStaticText', app: 'Word', light: true, id: r.id, debug: { method: 'screen', frame: { x: 200, y: 400, width: 300, height: 24 }, screen: SCREEN } });
        // The light lands a moment after the answer.
        setTimeout(() => (mac.events.push(`land:${p.target}`), computer.light({ type: 'arrived', id: r.id, ms: lightMs })), lightMs);
      } else if (hints && page !== undefined) {
        const dir = page < mac.view ? 'up' : 'down';
        answer({ found: false, reason: 'scrolled_out_of_view', label: p.target, message: `"${p.target}" is in the document but scrolled out of view: scroll ${dir} in the document to see it.`, debug: { method: 'accessibility', frame: { x: 200, y: -900, width: 300, height: 24 }, visible: false } });
      } else answer({ found: false, reason: 'not_found', message: `Couldn't find "${p.target}" in Word.`, debug: { method: 'none' } });
    } else if (r.kind === 'act' && p.step === 'resolve') {
      // A scroll aimed at something: only if that is on screen now.
      if (p.target && doc[p.target] !== mac.view) answer({ ok: true, found: false, message: `Couldn't find "${p.target}" on screen.` });
      else answer({ ok: true, found: true, token: 't1', label: p.target || '', role: 'AXScrollArea', app: 'Word', window: 'Plan.docx' });
    } else if (r.kind === 'act' && p.step === 'do') {
      // Asked to bring words into view in one move: only an app that can (`intoView`) does.
      if (p.action === 'scroll' && p.scrollTo?.into) {
        const page = doc[p.scrollTo.into];
        if (!intoView || page === undefined) return answer({ ok: true, via: 'into', found: false, moved: false, message: `Couldn't find "${p.scrollTo.into}" to scroll to.`, app: 'Word', window: 'Plan.docx' });
        mac.view = page;
        return answer({ ok: true, via: 'into', found: true, label: p.scrollTo.into, moved: true, position: page / Math.max(1, pages - 1), pageAt: 'part way', app: 'Word', window: 'Plan.docx' });
      }
      if (p.action === 'scroll') mac.view = Math.max(0, Math.min(pages - 1, mac.view + (p.direction === 'up' ? -1 : 1)));
      answer({ ok: true, via: 'events', verified: false, changes: [], app: 'Word', window: 'Plan.docx' });
    } else answer({ ok: false, error: 'unsupported' });
  });
  const q = fakeQuery(() => [result('ok')]);
  const d = /** @type {any} */ (new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), null, undefined, bridge, computer));
  d.queryFn = q.queryFn;
  // (Only the test that lets words through to the model needs a session.)
  if (start) d.start();
  const cards = /** @type {any[]} */ ([]);
  computer.on('explain_card', (c) => cards.push(c));
  const hushes = [];
  d.on('hush', () => hushes.push(1));
  const tool = Object.fromEntries(d.toolList().map((t) => [t.name, /** @type {any} */ (t)])).explain_on_screen;
  // The beat between chunks, short for the tests.
  d.explain.beatMs = beatMs;
  const explain = async (chunks, extra = {}) => {
    const out = await tool.handler({ chunks, ...extra }, {});
    return out.isError ? { error: out.content[0].text } : JSON.parse(out.content[0].text);
  };
  const points = () => mac.requests.filter((r) => r.kind === 'point');
  const jumps = () => mac.requests.filter((r) => r.kind === 'act' && r.params.step === 'do' && r.params.scrollTo?.into).map((r) => r.params.scrollTo.into);
  const scrolls = () => mac.requests.filter((r) => r.kind === 'act' && r.params.step === 'do').filter((r) => !r.params.scrollTo).map((r) => r.params.direction);
  return { mac, d, computer, spoken, cards, hushes, explain, points, scrolls, jumps, modelCalls: () => q.calls.reduce((n, c) => n + c.prompts.length, 0) };
}

const CHUNKS = [
  { say: 'It starts with the goal: one calm voice that listens well.', key: 'The goal', target: 'Goal' },
  { say: 'Then three phases, each a few weeks long.', key: 'Three phases', target: 'Phases' },
  { say: 'The risks come next, with the microphone first.', key: 'Main risks', target: 'Risks' },
  { say: 'It ends with what to do this week.', key: 'This week', target: 'Next steps' },
];

test('walks the chunks in order: the light on each one\'s target, its sentence as the light lands, one card that moves', async () => {
  const s = simMac({ doc: { Goal: 0, Phases: 0, Risks: 0, 'Next steps': 0 } });
  const r = await s.explain(CHUNKS, { app: 'Word' });
  assert.deepEqual(s.points().map((p) => p.params.target), ['Goal', 'Phases', 'Risks', 'Next steps']);
  for (const [i, p] of s.points().entries()) {
    assert.equal(p.params.intent, 'show', 'only ever pointing something out');
    assert.equal(p.params.caption, CHUNKS[i].key, 'the chunk\'s few words go beside the light');
    assert.equal(p.params.app, 'Word');
  }
  assert.deepEqual(s.spoken, CHUNKS.map((c) => c.say), 'one sentence each, in order');
  // Each sentence is said once the light is on its target, and before the next target is looked for.
  assert.deepEqual(s.mac.events, CHUNKS.flatMap((c) => [`land:${c.target}`, `say:${c.say}`]));
  // The card: the same one throughout, with the whole outline and where it is.
  assert.equal(new Set(s.cards.map((c) => c.id)).size, 1, 'one card per explanation');
  const moving = s.cards.filter((c) => !c.done);
  assert.deepEqual(moving.map((c) => c.index), [0, 1, 2, 3]);
  for (const c of s.cards) {
    assert.deepEqual(c.keys, CHUNKS.map((x) => x.key), 'every card message carries the outline');
    assert.equal(c.total, 4);
  }
  assert.equal(moving[1].say, CHUNKS[1].say);
  assert.equal(s.cards.at(-1).done, true);
  assert.equal(s.cards.at(-1).stopped, undefined);
  assert.equal(r.ended, 'finished');
  assert.equal(r.explained, 4);
  assert.equal(r.not_found, undefined);
  assert.match(r.note, /Want the next part/);
  assert.equal(s.scrolls().length, 0, 'everything was in view: nothing scrolled');
  assert.equal(s.computer.driving, false);
});

test('between chunks: the sentence finishes, then a short beat, before the next target is looked for', async () => {
  const s = simMac({ doc: { Goal: 0, Phases: 0 }, voiceMs: 120, beatMs: 150 });
  const at = [];
  s.computer.on('explain_card', (c) => !c.done && at.push(Date.now()));
  await s.explain(CHUNKS.slice(0, 2));
  assert.ok(at[1] - at[0] >= 120 + 150, `the second chunk began ${at[1] - at[0]} ms after the first`);
});

test('"next", "back", "again" and "stop" are taken by the explanation, with no model call', async () => {
  const s = simMac({ doc: { Goal: 0, Phases: 0, Risks: 0, 'Next steps': 0 }, voiceMs: 2000 });
  const running = s.explain(CHUNKS);
  await until(() => s.spoken.length === 1, 2000, 'the first sentence');
  // Each sentence takes two seconds here: only the user's word moves it on this fast.
  assert.equal(s.d.send('next', { raw: 'next' }), 'local');
  await until(() => s.spoken.length === 2, 1000, 'the second chunk');
  assert.equal(s.spoken[1], CHUNKS[1].say);
  assert.equal(s.d.send('Go back.', { raw: 'Go back.' }), 'local');
  await until(() => s.spoken.length === 3, 1000, 'the first chunk again');
  assert.equal(s.spoken[2], CHUNKS[0].say);
  assert.equal(s.d.send('again'), 'local');
  await until(() => s.spoken.length === 4, 1000, 'the same chunk once more');
  assert.equal(s.spoken[3], CHUNKS[0].say);
  assert.deepEqual(s.cards.filter((c) => !c.done).map((c) => c.index), [0, 1, 0, 0], 'the card follows');
  assert.equal(s.hushes.length, 3, 'what Echo was saying stops each time');
  assert.equal(s.d.send('stop', { raw: 'stop' }), 'local');
  const r = await running;
  assert.equal(r.ended, 'stopped');
  assert.match(r.note, /user stopped it/i);
  assert.deepEqual([s.cards.at(-1).done, s.cards.at(-1).stopped], [true, true]);
  assert.equal(s.spoken.length, 4, 'nothing more is said');
  assert.equal(s.modelCalls(), 0, 'none of the four went to the model');
  assert.equal(s.d.busy, false, 'and none of them started a turn');
  assert.deepEqual(['next', 'skip', 'go on', 'back', 'previous', 'again', 'say that again', 'stop', "that's enough", 'what is a phase'].map(explainCommand),
    ['next', 'next', 'next', 'back', 'back', 'again', 'again', 'stop', 'stop', null]);
});

test('anything else the user says ends the explanation and goes to the assistant; with none running, "next" is not taken', async () => {
  const s = simMac({ doc: { Goal: 0, Phases: 0 }, voiceMs: 2000, start: true });
  const running = s.explain(CHUNKS.slice(0, 2));
  await until(() => s.spoken.length === 1, 2000, 'the first sentence');
  assert.equal(s.d.send('what does calm mean here?'), 'turn');
  const r = await running;
  assert.equal(r.ended, 'interrupted');
  assert.match(r.note, /during piece 1 of \d+/);
  assert.equal(s.spoken.length, 1);
  await until(() => s.modelCalls() === 1, 2000, 'their question reaching the model');
  await until(() => !s.d.busy, 2000, 'the turn ending');
  assert.equal(s.d.explain.active, false);
  assert.equal(s.d.explain.hear('next'), false, 'no explanation is running: "next" is not taken');
  s.d.input.close();
});

test('a target that is nowhere: a few pages are tried, the view is put back, the sentence is still said, and the assistant is told', async () => {
  const s = simMac({ doc: { Goal: 1, Phases: 1 }, view: 1 });
  const chunks = [CHUNKS[0], { say: 'The budget is not in this copy yet.', key: 'The budget', target: 'Budget' }, CHUNKS[1]];
  const r = await s.explain(chunks);
  assert.deepEqual(s.spoken, chunks.map((c) => c.say), 'said all the same');
  assert.equal(s.points().filter((p) => p.params.target === 'Budget').length, 1 + VIEW_TRIES, 'looked again after each page, then gave up');
  assert.deepEqual(s.scrolls(), [...Array(VIEW_TRIES).fill('down'), ...Array(VIEW_TRIES).fill('up')], 'a page at a time, and back again');
  assert.equal(s.mac.view, 1, 'the document is where it was');
  assert.deepEqual(r.not_found, ['Budget']);
  assert.equal(r.ended, 'finished');
  assert.equal(r.explained, 3);
  assert.match(r.note, /Not found on screen.*"Budget"/);
  const budget = s.cards.filter((c) => c.index === 1 && !c.done);
  assert.deepEqual(budget.map((c) => c.found), [undefined, false], 'the card says it is not on screen');
  assert.equal(budget[1].say, chunks[1].say, 'and still shows the chunk');
  // The chunk after it is found where the view was put back.
  assert.equal(s.points().at(-1).params.target, 'Phases');
  assert.equal(s.computer.driving, false, 'the scrolling leaves no driving session open');
});

test('bringing a target into view: a page at a time the way the app says (else down), then the light', async () => {
  // Read from the picture (no hint): down, a page at a time, looking again after each.
  const a = simMac({ doc: { Goal: 0, Risks: 2 } });
  const r = await a.explain([CHUNKS[0], CHUNKS[2]]);
  assert.deepEqual(a.scrolls(), ['down', 'down']);
  assert.equal(a.mac.view, 2, 'it stays where the target is');
  assert.equal(r.not_found, undefined);
  assert.deepEqual(a.spoken, [CHUNKS[0].say, CHUNKS[2].say]);
  assert.ok(a.mac.events.indexOf('land:Risks') < a.mac.events.indexOf(`say:${CHUNKS[2].say}`), 'the sentence waits for the light');
  // The first scroll is aimed at what the light last found (so it lands in the document, not under the mouse).
  const aimed = a.mac.requests.filter((q) => q.kind === 'act' && q.params.step === 'resolve').map((q) => q.params.target);
  assert.equal(aimed[0], 'Goal');
  // The app found it by name above the view and said so: up, not the default.
  const b = simMac({ doc: { Goal: 3, Phases: 1 }, view: 3, hints: true });
  await b.explain([CHUNKS[0], CHUNKS[1]]);
  assert.deepEqual(b.scrolls(), ['up', 'up']);
  assert.equal(b.mac.view, 1);
  assert.equal(wayToScroll({ reason: 'scrolled_out_of_view', message: '"Wi-Fi" is in the sidebar but scrolled out of view: scroll up in the sidebar to see it.' }), 'up');
  assert.equal(wayToScroll({ reason: 'not_found', message: 'scroll down' }), '');
  // "back" to a chunk that is now above the view: it looks upwards.
  const c = simMac({ doc: { Goal: 0, Risks: 1 }, voiceMs: 2000 });
  const running = c.explain([CHUNKS[0], CHUNKS[2]]);
  await until(() => c.spoken.length === 1, 2000, 'the first sentence');
  c.d.send('next');
  await until(() => c.spoken.length === 2, 2000, 'the second');
  c.d.send('back');
  await until(() => c.spoken.length === 3, 2000, 'the first again');
  assert.deepEqual(c.scrolls(), ['down', 'up']);
  c.d.send('stop');
  await running;
});

test('a target out of view is brought into view in one move when the app can, with no paging', async () => {
  const s = simMac({ doc: { Goal: 0, Risks: 4 }, intoView: true });
  const r = await s.explain([CHUNKS[0], CHUNKS[2]]);
  assert.deepEqual(s.jumps(), ['Risks']);
  assert.deepEqual(s.scrolls(), [], 'no page-at-a-time search');
  assert.equal(s.mac.view, 4);
  assert.equal(r.not_found, undefined);
  assert.ok(s.mac.events.indexOf('land:Risks') < s.mac.events.indexOf(`say:${CHUNKS[2].say}`), 'the sentence still waits for the light');
  assert.equal(s.computer.driving, false);
});

test('when nothing can be scrolled (computer use is off) it gives up at once, cleanly: no action, the sentence, the report', async () => {
  const s = simMac({ doc: { Goal: 0, Risks: 2 }, computerUse: false });
  const r = await s.explain([CHUNKS[0], CHUNKS[2]]);
  assert.equal(s.mac.requests.filter((q) => q.kind === 'act').length, 0, 'nothing was asked of the Mac but pointing');
  assert.equal(s.points().length, 2, 'one look for each, no more');
  assert.deepEqual(s.spoken, [CHUNKS[0].say, CHUNKS[2].say]);
  assert.deepEqual(r.not_found, ['Risks']);
  assert.equal(r.ended, 'finished');
});

test('it never clicks or types: the only things asked of the Mac are pointing and scrolling', async () => {
  const s = simMac({ doc: { Goal: 0, Phases: 1, Risks: 3 }, view: 0 });
  await s.explain(CHUNKS, { app: 'Word' });
  assert.ok(s.mac.requests.length > 8);
  for (const q of s.mac.requests) {
    assert.ok(q.kind === 'point' || q.kind === 'act', q.kind);
    if (q.kind === 'act') assert.equal(q.params.action, 'scroll', 'the one action it takes');
    if (q.kind === 'point') assert.equal(q.params.hold, undefined, 'nothing waits for the user to do a step: this is no lesson');
  }
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'explain.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/\.act\('(\w+)'/g)].map((m) => m[1]).filter((a) => a !== 'scroll'), []);
  assert.doesNotMatch(src, /type_text|press_keys|'click'/);
});

test('an explanation is 2 to 6 chunks of one short sentence; anything more is refused, never trimmed', async () => {
  const s = simMac({ doc: {} });
  assert.match(cleanChunks([CHUNKS[0]]).error, /2 to 6 chunks/);
  assert.match(cleanChunks(Array(CHUNKS_MAX + 1).fill(CHUNKS[0])).error, /2 to 6 chunks/);
  const long = { say: Array(30).fill('word').join(' ') + '.', key: 'Too much', target: 'Goal' };
  assert.match(cleanChunks([CHUNKS[0], long]).error, /Chunk 2 says too much \(30 words\)/);
  assert.match(cleanChunks([CHUNKS[0], { ...CHUNKS[1], key: 'a title that runs on and on and on' }]).error, /key is too long/);
  assert.deepEqual(cleanChunks([CHUNKS[0], { say: '  Two   words. ', key: ' Key ' }]).chunks[1], { say: 'Two words.', key: 'Key', target: '' });
  const r = await s.explain([CHUNKS[0], long]);
  assert.match(r.error, /says too much/);
  assert.equal(s.spoken.length + s.cards.length + s.mac.requests.length, 0, 'nothing is said, shown or pointed at');
  // No target: nothing to point at, the sentence and the card all the same.
  const ok = await s.explain([{ say: 'First, the short version.', key: 'In short' }, { say: 'Then the detail.', key: 'The detail' }]);
  assert.equal(ok.ended, 'finished');
  assert.equal(s.points().length, 0);
  assert.equal(s.spoken.length, 2);
  assert.equal(ok.not_found, undefined);
});

test('the page shows one card per explanation and moves it; the instructions say when to explain this way', () => {
  assert.match(serverSource(), /computer\.on\('explain_card', \(c\) => broadcast\(\{ type: 'explain_card', \.\.\.c \}\)\)/);
  const page = pageSource();
  assert.match(page, /case 'explain_card': showExplain\(msg\); break;/);
  // One card per id, updated in place: the outline is built once, and only the marks move.
  assert.match(page, /let c = explainCards\.get\(m\.id\);\s+if \(!c\) \{/);
  assert.match(page, /li\.classList\.toggle\('on', !m\.done && i === at\)/);
  assert.match(page, /`\$\{at \+ 1\} of \$\{total\}/);
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  const rules = css.split('\n').filter((l) => /explain-/.test(l));
  assert.ok(rules.some((l) => /^\.explain-key \{[^}]*font-size: 22px/.test(l)), 'the key is large');
  assert.ok(rules.some((l) => /^\.explain-outline li\.on \{[^}]*color: var\(--ink\)/.test(l)), 'the current piece stands out');
  assert.equal(rules.some((l) => /--grad/.test(l)), false, 'no new use of the gradient');
  const s = simMac({ doc: {} });
  const prompt = s.d.systemPrompt();
  assert.match(prompt, /call explain_on_screen instead of describing it in a long reply: six chunks at most, one sentence each/);
  assert.match(prompt, /NOT being shown stays at two or three sentences/);
});
