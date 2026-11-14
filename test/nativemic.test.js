// The one listening engine: what the Mac app's own mic is armed for, and the page's half of it
// driven by a fake app (state, onsets, live words, delivered and dropped sentences); then taking back
// control (a click stops the step, Escape ends the session), routing what's said, and clicking
// things the user points at on screen ("the first video"). A fake "Mac app" answers every request;
// nothing touches a real screen, mouse, keyboard or microphone. The Swift decisions (speech gate,
// ducking, take-back policy) are compiled and run when Apple's Swift tools are installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox, fakeQuery, pageSource } from './helpers.js';

const dirs = sandbox('nativemic');
const { ComputerUse, routeSpeech, screenReference, computerPrompt, TAKE_OVER_LINE } = await import('../lib/computer.js');
const { ScreenBridge, lookContent } = await import('../lib/screen.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, getSettings, setFixedForTest } = await import('../lib/settings.js');
const { nativeMicPlan, clipMode, BargeIn, BARGE_HOLD_MS, AppMic, ringLive, stateLine, dropLine, sendWithRetry, CANT_HEAR_LINE, MIC_ERROR_LINE, RETRY_MS } = await import('../public/nativemic.js');

const root = path.join(import.meta.dirname, '..');
/**
 * The one table of what the app's mic sends the page: its events and the fields of each. The
 * app's own code is checked against it in macos/Tests/Voice/main.swift, the page's below.
 * @type {{ states: string[], reasons: string[], drops: string[], final: string[], events: Record<string, { fields: string[], optional: string[] }> }}
 */
const EVENTS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'nativemic-events.json'), 'utf8'));
/** An event as the app sends it: a name the table lists, carrying only fields the table lists for it. */
function checkEvent(e) {
  const spec = EVENTS.events[e.event];
  assert.ok(spec, `the app sends no "${e.event}" event`);
  const extra = Object.keys(e).filter((k) => k !== 'event' && !spec.fields.includes(k) && !spec.optional.includes(k));
  assert.deepEqual(extra, [], `"${e.event}" has no such field (test/fixtures/nativemic-events.json)`);
  return e;
}
const logFile = path.join(dirs.data, 'computer-log.jsonl');
const on = () => (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));

/** A fake Mac app. `did(p)` can change what the "do" step answers. */
function fakeApp(o = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: `t${seen.length}`, label: p.target || '', role: 'AXLink', app: p.app || 'Google Chrome', window: 'YouTube', ...(o.resolve?.(p) || {}) };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'events', app: 'Google Chrome', window: 'YouTube', ...(o.did?.(p) || {}) };
    else if (r.kind === 'look') out = o.look?.(p) || { text: 'YouTube', app: 'Google Chrome' };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  return { bridge, seen, resolves: () => seen.filter((r) => r.kind === 'act' && r.params.step === 'resolve'), does: () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do') };
}

/* ---------- what the app's mic is armed for ---------- */

test('the plan: one mic, armed for a run, an answer, hands-free, the window or "Hey Echo"', () => {
  const base = { available: true, setting: true, serverEngine: true, wakeWord: true, listenDuringRuns: true };
  assert.equal(nativeMicPlan({ ...base, driving: true }).arm, 'run', 'driving: always listening, no Space or wake word');
  assert.equal(nativeMicPlan({ ...base, driving: true, speaking: true }).echo, true, 'it knows when Echo is speaking (barge-in threshold)');
  const answer = nativeMicPlan({ ...base, answerOpen: true, windowUntil: 9000.4 });
  assert.deepEqual([answer.arm, answer.label, answer.then, answer.windowUntil], ['window', 'answer', 'wake', 9000]);
  assert.equal(nativeMicPlan(base).arm, 'wake', '"Hey Echo" from any app');
  assert.equal(nativeMicPlan({ ...base, wakeWord: false }).arm, '', 'nothing armed: only the key');
  assert.equal(nativeMicPlan({ ...base, driving: true, listenDuringRuns: false }).arm, 'wake');
  // Hands-free is the app's mic too (it used to be the window's own, which you couldn't talk over).
  assert.equal(nativeMicPlan({ ...base, handsFree: true }).arm, 'handsfree');
  assert.equal(nativeMicPlan({ ...base, handsFree: true, driving: true }).arm, 'run');
  assert.deepEqual([nativeMicPlan({ ...base, handsFree: true, answerOpen: true }).label, nativeMicPlan({ ...base, handsFree: true, answerOpen: true }).then], ['answer', 'handsfree']);
  // Push-to-talk needs no arming at all: with nothing armed the mic is closed (no orange dot),
  // opens for the key, and may stay open a short while after it for the next press.
  const idle = nativeMicPlan({ ...base, wakeWord: false });
  assert.deepEqual([idle.enabled, idle.linger, idle.arm], [true, true, '']);
  assert.equal('warm' in idle, false, 'nothing keeps the mic open just because the app runs');
  // The privacy switch: nothing is armed and the mic closes as soon as the key's sentence is over.
  const off = nativeMicPlan({ ...base, driving: true, handsFree: true, micOff: true });
  assert.deepEqual([off.enabled, off.linger, off.arm], [true, false, '']);
  assert.equal(nativeMicPlan({ ...base, driving: true, blocked: true }).arm, '', 'first-run setup is never talked over');
  // Fallbacks: no Mac app mic, the setting off, or nothing to turn speech into text.
  for (const miss of [{ available: false }, { setting: false }, { serverEngine: false }]) {
    const p = nativeMicPlan({ ...base, driving: true, ...miss });
    assert.deepEqual([p.enabled, p.linger, p.arm], [false, false, '']);
  }
  // With no engine yet, Apple's model is still got ready (its being ready is what enables the mic).
  assert.equal(nativeMicPlan({ ...base, serverEngine: false }).prepare, true);
  assert.equal(nativeMicPlan({ ...base, setting: false }).prepare, false);
  assert.equal(nativeMicPlan({ ...base, duckMedia: false }).duck, false);
  assert.equal(nativeMicPlan({ ...base, bargeIn: false }).bargeIn, false);
  // The switches this engine made pointless are gone from the plan too.
  for (const gone of ['appleSpeech', 'smartEnd', 'mode']) assert.equal(gone in nativeMicPlan(base), false, gone);
  // How the server is told which way a sentence came in.
  assert.equal(clipMode('ptt'), 'push-to-talk');
  assert.equal(clipMode('run'), 'run');
  assert.equal(clipMode('wake'), 'wake');
  assert.equal(clipMode('handsfree'), 'hands-free');
  assert.equal(clipMode('window', 'answer'), 'answer');
  assert.equal(clipMode('window', 'follow'), 'follow');
  assert.equal(clipMode('weird'), 'push-to-talk');
});

test('barge-in: talking over Echo lowers her at once, stops her on real words, and holds the rest of that reply', async () => {
  const { realWords, BARGE_CONFIRM_MS } = await import('../public/nativemic.js');
  assert.equal(realWords('um'), false);
  assert.equal(realWords('hmm, uh'), false);
  assert.equal(realWords(''), false);
  assert.equal(realWords('wait'), true);
  assert.equal(realWords('no stop'), true);
  assert.ok(BARGE_CONFIRM_MS >= 800 && BARGE_CONFIRM_MS <= 2000);

  let now = 1000;
  const b = new BargeIn({ now: () => now });
  assert.equal(b.onset({ echo: false }), 'none', 'she was quiet: nothing to cut off');
  assert.equal(b.holding, false);
  assert.equal(b.onset({ echo: true, enabled: false }), 'none', 'barge-in switched off');
  assert.equal(b.onset({ echo: true }), 'duck');
  assert.equal(b.ducked, true);
  assert.equal(b.holding, false, 'lowered, not held: the reply goes on quietly');
  assert.equal(b.words('um'), 'none', 'a filler is not yet you talking');
  assert.equal(b.words('wait a second'), 'hush');
  assert.equal(b.holding, true, 'stopped, and the rest of that reply held');
  assert.equal(b.ducked, false);
  now += 2000;
  assert.equal(b.holding, true);
  b.release(); // your words were heard
  assert.equal(b.holding, false);

  assert.equal(b.onset({ echo: true }), 'duck');
  assert.equal(b.cancel(), 'resume', 'a cough: she carries on');
  assert.equal(b.holding, false);
  assert.equal(b.cancel(), 'none');

  assert.equal(b.onset({ echo: true }), 'duck');
  assert.equal(b.confirm(), 'hush', 'no live words in time (or the sentence arrived): she stops');
  now += BARGE_HOLD_MS + 1;
  assert.equal(b.holding, false, 'never quiet forever if your words never arrive');
  assert.equal(b.onset({ echo: true, soft: false }), 'hush', "a voice that can't be lowered (the browser's) stops at once");
});

/* ---------- the page's half of the engine, with a fake app ---------- */

/** The page's AppMic wired to recorders: what it posts to the app, and everything it does here. */
function fakePage(o = {}) {
  const did = [];
  const timers = [];
  let now = 1_000_000;
  const mic = new AppMic({
    post: (m) => did.push(['post', m]),
    now: () => now,
    hush: () => did.push(['hush']),
    duck: (on) => did.push(['duck', on]),
    sfx: (n) => did.push(['sfx', n]),
    surprised: () => did.push(['surprised']),
    note: (t) => did.push(['note', t]),
    words: (t) => did.push(['words', t]),
    clearWords: () => did.push(['clearWords']),
    level: (v) => did.push(['level', v]),
    send: async (wav, live, notes) => { did.push(['send', { bytes: wav.length, live, notes }]); },
    heard: (r) => did.push(['heard', r]),
    ended: (r, delivered, why) => did.push(['ended', r, delivered, why]),
    changed: () => did.push(['changed']),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    sinceReplyMs: () => 5000,
    ...o,
  });
  // Everything the fake app says is held to the table of real events: a field the app doesn't
  // send can't make a test pass. (`raw` is for an app too old to be in the table.)
  const raw = mic.on.bind(mic);
  mic.on = (e) => raw(checkEvent(e));
  const state = (st, reason = '', more = {}) => {
    const e = { event: 'state', engine: 1, state: st, reason, since: now, windowLeftMs: 0, running: true, permission: 'allowed', voiceProcessing: true, appleReady: true, ...more };
    assert.deepEqual(Object.keys(e).filter((k) => k !== 'event').sort(), [...EVENTS.events.state.fields].sort(), 'the fake state report has every field of the real one');
    return mic.on(e);
  };
  /** What it did since the last call, without the redraws. */
  const take = () => did.splice(0).filter(([k]) => k !== 'changed');
  return { mic, did, take, timers, state, raw, tick: (ms) => { now += ms; }, now: () => now };
}
const names = (list) => list.map(([k, v]) => (v === undefined || typeof v === 'object' ? k : `${k}:${v}`));
const wav = Buffer.from('RIFFxxxxWAVE').toString('base64');

test('the page draws the app\'s state and nothing else: "listening" only when its mic is armed or hearing', () => {
  const p = fakePage();
  assert.equal(p.mic.usable, false, 'before the app has answered, the page does not assume it listens');
  assert.equal(p.mic.live, false);
  // The wake word is off and nothing is armed: the ring must not say "Listening · 8 s".
  p.state('idle');
  assert.equal(p.mic.usable, true);
  assert.equal(p.mic.live, false, 'idle: not listening');
  p.state('armed', 'wake');
  assert.equal(p.mic.live, false, 'armed for "Hey Echo" only: the ring stays hidden');
  for (const r of ['window', 'run', 'handsfree']) {
    p.state('armed', r);
    assert.equal(p.mic.live, true, r);
  }
  assert.equal(ringLive({ state: 'hearing', reason: 'handsfree', running: true }), true);
  assert.equal(ringLive({ state: 'hearing', reason: 'ptt', running: true }), false, 'a held key is not the conversation window');
  assert.equal(ringLive({ state: 'finishing', reason: '', running: true }), false);
  // Armed, but the app's mic isn't open (it stopped, or couldn't start): that is not listening.
  assert.equal(ringLive({ state: 'armed', reason: 'handsfree', running: false }), false);
  assert.equal(ringLive({ state: 'armed', reason: 'handsfree' }), false);
  p.state('armed', 'handsfree', { running: false });
  assert.equal(p.mic.live, false, 'the ring never claims a mic that is not running');
  // The countdown is the app's own.
  p.state('armed', 'window', { windowLeftMs: 8000 });
  p.tick(3000);
  assert.equal(p.mic.windowLeftMs(), 5000);
  p.state('armed', 'run');
  assert.equal(p.mic.windowLeftMs(), 0);
  // An old app (no engine in its state), or a refused mic: the page's own mic is the fallback.
  p.raw({ event: 'state', running: false, permission: 'allowed', mode: 'off' });
  assert.equal(p.mic.usable, false);
  p.state('idle', '', { permission: 'denied' });
  assert.equal(p.mic.usable, false);
});

test('the line under the orb says only what is true, and only the ways to cut in that work', () => {
  assert.match(stateLine({ speaking: true, spaceCuts: true }), /<kbd>Space<\/kbd> to cut in/);
  assert.doesNotMatch(stateLine({ speaking: true, spaceCuts: false, handsFree: true }), /Space/, 'the browser fallback in hands-free: Space is off, so it is not offered');
  assert.match(stateLine({ speaking: true, spaceCuts: true, talkCuts: true }), /<kbd>Space<\/kbd> or just talk to cut in/, 'hands-free in the Mac app: both work');
  assert.equal(stateLine({ ptt: true }), 'Listening');
  assert.match(stateLine({ ptt: true, pttHint: true }), /release <kbd>Space<\/kbd> to send/);
  assert.match(stateLine({ ptt: true, pttHint: true, byShortcut: true }), /let go to send/);
  assert.equal(stateLine({ hearing: true }), 'Hearing you…');
  assert.equal(stateLine({ transcribing: true, hearing: true }), 'Transcribing…');
  assert.match(stateLine({ open: 'run' }), /say “stop” anytime/);
  assert.match(stateLine({ open: 'answer' }), />Listening</);
  assert.match(stateLine({ open: 'answer', speaking: true }), /^Speaking/, 'never "Listening" over her voice');
  assert.equal(stateLine({ handsFree: true }), 'Hands-free: just talk');
  assert.match(stateLine({ wake: true }), /Hey Echo/);
  assert.match(stateLine({}), /^Hold <kbd>Space<\/kbd> or click to talk/, 'nothing armed: nothing claimed');
  assert.equal(stateLine({ busy: true }), 'Thinking…');
});

test('Space and the mic button go to the app; Control + Option is followed from its state', () => {
  const p = fakePage();
  p.state('armed', 'handsfree');
  p.take();
  // Space held: Echo stops at once, the app is told, and the page shows it before the app answers.
  p.mic.pttBegin(true);
  assert.deepEqual(names(p.take()), ['hush', 'sfx:listen', 'post']);
  assert.deepEqual(p.did.length, 0);
  assert.equal(p.mic.ptt, true);
  p.mic.pttBegin(true);
  assert.deepEqual(p.take(), [], 'key repeat does nothing');
  // The key took over a hands-free sentence already under way: the app only reports the state.
  p.state('hearing', 'ptt');
  assert.deepEqual(p.take(), [], 'no second hush or chime');
  p.mic.pttEnd();
  assert.deepEqual(p.take(), [['post', { type: 'nativePtt', action: 'end' }]]);
  assert.equal(p.mic.ptt, true, 'still recording the tail, as the app says');
  p.mic.on({ event: 'utterance', reason: 'ptt', wav, seconds: 2.1, peak: 0.3, level: 0.05, voicedMs: 1500, onsetAt: p.now() - 2100, endAt: p.now(), aec: true, bargeIn: false });
  const sent = p.take();
  assert.deepEqual(names(sent), ['sfx:stop', 'ended:ptt', 'send']);
  const notes = sent.at(-1)[1].notes;
  assert.deepEqual([notes.mode, notes.native, notes.inApp, notes.rate], ['push-to-talk', true, true, 16000]);
  assert.deepEqual([notes.level, notes.voicedMs, notes.onsetAt, notes.sinceReplyMs], [0.05, 1500, p.now() - 2100, 5000], 'every sentence carries its onset, level and voiced time');
  assert.equal(sent.at(-1)[1].bytes, 12, 'the clip itself');
  assert.equal(p.mic.ptt, false);
  // The mic button: clicked, not held.
  p.state('armed', 'handsfree');
  p.take();
  p.mic.pttBegin(false);
  assert.deepEqual(p.take().at(-1), ['post', { type: 'nativePtt', action: 'begin', held: false }]);
  assert.equal(p.mic.clicked, true);
  p.mic.on({ event: 'onset', reason: 'ptt', manual: true });
  assert.deepEqual(p.take(), [], 'hushed already');
  assert.equal(p.mic.ptt, true);
  p.mic.on({ event: 'dropped', reason: 'silent', arm: 'ptt' });
  p.take();
  // The mic was closed (nothing armed): it opens for the key, which takes a moment. Echo is
  // hushed at once, but the "go ahead" chime waits until the app says it's recording.
  p.state('idle', '', { running: false });
  p.take();
  p.mic.pttBegin(true);
  assert.deepEqual(names(p.take()), ['hush', 'post'], 'no chime while the mic is still opening');
  assert.equal(p.mic.ptt, true);
  p.mic.on({ event: 'onset', reason: 'ptt', echo: false, bargeIn: false, manual: true });
  assert.deepEqual(names(p.take()), ['hush', 'sfx:listen'], 'the chime, now that the mic is open');
  p.mic.on({ event: 'dropped', reason: 'cancelled', arm: 'ptt' });
  p.take();
  // Control + Option from another app: nothing was pressed here; the onset says so.
  p.state('armed', 'wake');
  p.take();
  p.mic.on({ event: 'onset', reason: 'ptt', manual: true });
  assert.deepEqual(names(p.take()), ['hush', 'sfx:listen']);
  assert.equal(p.mic.ptt, true);
  // …or it took over a sentence under way, with no onset of its own.
  p.mic.on({ event: 'dropped', reason: 'cancelled', arm: 'ptt' });
  p.mic.on({ event: 'onset', reason: 'handsfree', echo: false });
  p.take();
  p.state('hearing', 'ptt');
  assert.deepEqual(names(p.take()), ['hush', 'sfx:listen']);
});

test('no silent losses: every dropped sentence shows a short plain line', () => {
  assert.equal(dropLine('too_short', 'ptt'), 'Too short: hold the key while you talk');
  assert.equal(dropLine('silent', 'ptt'), 'I couldn’t hear anything: check the mic');
  assert.match(dropLine('spoiled', 'ptt'), /another key was pressed/);
  assert.match(dropLine('mode', 'handsfree'), /listening was switched off/);
  assert.match(dropLine('cancelled', 'ptt'), /nothing was sent/);
  assert.match(dropLine('silent', 'wake'), /Say “Hey Echo” and your request/, '"Hey Echo" and then nothing');
  // Sound that was never a sentence for Echo is not announced.
  assert.equal(dropLine('not_wake', 'wake'), '');
  assert.equal(dropLine('too_short', 'wake'), '');
  assert.equal(dropLine('too_short', 'handsfree'), '', 'a cough');

  const p = fakePage();
  p.state('idle');
  for (const reason of ['too_short', 'silent', 'spoiled', 'mode', 'cancelled']) {
    p.mic.pttBegin(true);
    p.take();
    p.mic.on({ event: 'dropped', reason, arm: 'ptt', seconds: 0.2 });
    const out = p.take();
    assert.deepEqual(out.find(([k]) => k === 'note'), ['note', dropLine(reason, 'ptt')], reason);
    assert.deepEqual(out.find(([k]) => k === 'ended'), ['ended', 'ptt', false, reason]);
    assert.equal(out.some(([k]) => k === 'send'), false, 'nothing is sent');
    assert.equal(p.mic.ptt, false, 'and the key is no longer shown as recording');
  }
  // Held with nothing coming from the mic: a warning while it's still held.
  p.mic.pttBegin(true);
  p.take();
  p.mic.on({ event: 'warn', what: 'cant_hear' });
  assert.deepEqual(p.take(), [['note', CANT_HEAR_LINE]]);
  assert.equal(p.mic.ptt, true);
  // The mic went dead and a restart didn't help: the sentence is dropped, then the reason is said
  // (it stays on screen), and the key is no longer shown as recording.
  p.mic.on({ event: 'dropped', reason: 'mode', arm: 'ptt', seconds: 3, bargeIn: false });
  p.mic.on({ event: 'error', message: 'no sound' });
  assert.deepEqual(p.take().filter(([k]) => k === 'note').at(-1), ['note', MIC_ERROR_LINE]);
  // It couldn't open for a key at all: no "dropped" comes, and the key must not stay lit.
  p.state('idle', '', { running: false });
  p.mic.pttBegin(true);
  p.take();
  p.mic.on({ event: 'error', message: 'No microphone was found' });
  assert.deepEqual(p.take(), [['note', MIC_ERROR_LINE]]);
  assert.equal(p.mic.ptt, false);
});

test('Apple too slow: the clip goes without a text (never an empty one), marked, for the server to transcribe', () => {
  const p = fakePage();
  p.state('armed', 'handsfree');
  p.take();
  const clip = { event: 'utterance', reason: 'handsfree', label: '', wav, live: '', seconds: 2, peak: 0.2, onsetAt: p.now() - 2000, endAt: p.now(), level: 0.05, voicedMs: 1500, aec: true, bargeIn: false };
  p.mic.on({ ...clip, timedOut: true });
  let notes = p.take().at(-1)[1].notes;
  assert.equal('final' in notes, false, 'no text goes: an empty one reads as "nothing was said"');
  assert.equal(notes.timedOut, true);
  // An older app said it inside an empty text: the same.
  p.raw({ ...clip, final: { text: '', timedOut: true } });
  notes = p.take().at(-1)[1].notes;
  assert.deepEqual(['final' in notes, notes.timedOut], [false, true]);
  // In time: the text, and no mark. Apple hearing nothing is still its (empty) answer.
  p.mic.on({ ...clip, final: { text: 'open the calendar', ms: 80, locale: 'en-US', words: [] } });
  notes = p.take().at(-1)[1].notes;
  assert.deepEqual([notes.final.text, 'timedOut' in notes], ['open the calendar', false]);
  p.mic.on({ ...clip, final: { text: '', ms: 80, locale: 'en-US', words: [] } });
  assert.equal(p.take().at(-1)[1].notes.final.text, '');
});

test('the server is down as a sentence ends: with its text in hand it is kept and sent once more after 2 s', async () => {
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  let calls = 0;
  const flaky = async () => { if (++calls === 1) throw new TypeError('Failed to fetch'); return 'sent'; };
  assert.equal(await sendWithRetry(flaky, true, wait), 'sent');
  assert.deepEqual([calls, waits], [2, [RETRY_MS]]);
  assert.equal(RETRY_MS, 2000);
  // Still down: only then is it said (the caller shows the line).
  calls = 0;
  const down = async () => { calls++; throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendWithRetry(down, true, wait), /Failed to fetch/);
  assert.equal(calls, 2, 'once more, not for ever');
  // No text in hand: as before, no second try.
  calls = 0;
  await assert.rejects(sendWithRetry(down, false, wait));
  assert.equal(calls, 1);
  // The server answered: never sent twice.
  calls = 0;
  assert.equal(await sendWithRetry(async () => { calls++; return 'ok'; }, true, wait), 'ok');
  assert.equal(calls, 1);
  const app = pageSource();
  assert.match(app, /res = await sendWithRetry\(\(\) => fetch\('\/api\/utterance', \{ method: 'POST', headers, body: wav \}\), Boolean\(notes\.final\?\.text\)\);\n\s+\} catch \{\n\s+addMsg\('error', NOT_SENT_LINE\);/);
  assert.match(app, /out\.reason === 'stt_timeout' \|\| out\.reason === 'stt_unavailable'\) liveCap\.note\(NO_TEXT_LINE\)/, 'no text and no engine to make one: said so, not "blank"');
});

test('one table of the app\'s events: the page reads only fields the app sends, and handles every event and reason', () => {
  const src = fs.readFileSync(path.join(root, 'public', 'nativemic.js'), 'utf8');
  const cls = src.slice(src.indexOf('export class AppMic'));
  // Each event the app sends has its case in AppMic.on, and there is no case for one it doesn't.
  const cases = [...cls.slice(cls.indexOf('  on(e) {'), cls.indexOf('  /** @param {boolean} overEcho')).matchAll(/^      case '(\w+)':/gm)].map((m) => m[1]);
  assert.deepEqual([...cases].sort(), Object.keys(EVENTS.events).sort());
  // Every field the page reads off an event is one the table lists (`e.event` names it).
  const all = new Set(Object.values(EVENTS.events).flatMap((s) => [...s.fields, ...s.optional]));
  const read = [...new Set([...cls.matchAll(/\be\??\.([a-zA-Z]+)/g)].map((m) => m[1]))].filter((f) => f !== 'event');
  assert.ok(read.length > 15, 'the scan found the reads');
  assert.deepEqual(read.filter((f) => !all.has(f)), [], 'read by the page, never sent by the app');
  const utter = new Set([...EVENTS.events.utterance.fields, ...EVENTS.events.utterance.optional]);
  const delivered = cls.slice(cls.indexOf('  delivered(e) {'));
  assert.deepEqual([...new Set([...delivered.matchAll(/\be\??\.([a-zA-Z]+)/g)].map((m) => m[1]))].filter((f) => !utter.has(f)), [], 'a sentence\'s fields');
  assert.deepEqual([...delivered.matchAll(/e\.final\??\.([a-zA-Z]+)/g)].map((m) => m[1]).filter((f) => !EVENTS.final.includes(f) && f !== 'timedOut'), [], "Apple's text");
  // A full event of every kind goes through the page without a hitch.
  const p = fakePage();
  const value = (f) => ({ state: 'armed', reason: 'handsfree', arm: 'handsfree', permission: 'allowed', wav, final: { text: 'hello there', ms: 80, locale: 'en-US', words: [{ word: 'hello', p: 0.9 }] } }[f] ?? (/^(running|echo|bargeIn|manual|aec|appleReady|voiceProcessing|timedOut)$/.test(f) ? true : /^(text|live|label|what|message)$/.test(f) ? 'words' : 1));
  for (const [name, spec] of Object.entries(EVENTS.events)) {
    assert.doesNotThrow(() => p.mic.on({ event: name, ...Object.fromEntries([...spec.fields, ...spec.optional].map((f) => [f, value(f)])) }), name);
  }
  // Every way in has its mode for the server, and every drop reason its line (or, on purpose, none).
  for (const r of EVENTS.reasons) assert.match(clipMode(r, 'follow'), /^(push-to-talk|wake|follow|run|hands-free)$/, r);
  for (const d of EVENTS.drops) assert.equal(typeof dropLine(d, 'ptt'), 'string', d);
  assert.deepEqual(EVENTS.drops.filter((d) => !dropLine(d, 'ptt')), ['not_wake']);
  // The app builds its events in one place (MicEvent), which the Swift checks hold to the same table.
  const mic = fs.readFileSync(path.join(root, 'macos', 'Sources', 'NativeMic.swift'), 'utf8');
  assert.doesNotMatch(mic, /"event":/, 'no event is put together by hand in the mic');
  const math = fs.readFileSync(path.join(root, 'macos', 'Sources', 'VoiceMath.swift'), 'utf8');
  const built = [...math.slice(math.indexOf('enum MicEvent')).matchAll(/"event": "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...built].sort(), Object.keys(EVENTS.events).sort());
});

test('talking over Echo in any armed state: lowered at once, stopped on words, and the sentence is sent', async () => {
  for (const reason of ['handsfree', 'window', 'run']) {
    const p = fakePage();
    p.state('armed', reason);
    p.take();
    p.mic.on({ event: 'onset', reason, echo: true, bargeIn: true });
    assert.deepEqual(names(p.take()), ['duck:true', `heard:${reason}`], `${reason}: her voice drops, nothing is thrown away`);
    assert.equal(p.mic.hearing, true);
    p.mic.on({ event: 'partial', text: 'um' });
    assert.deepEqual(names(p.take()), ['words:um'], 'a filler leaves her be');
    p.mic.on({ event: 'partial', text: 'wait stop' });
    assert.deepEqual(names(p.take()), ['hush', 'duck:false', 'surprised', 'words:wait stop'], 'real words stop her');
    assert.equal(p.mic.barge.holding, true, 'the rest of that reply stays quiet');
    p.mic.on({ event: 'utterance', reason, label: 'answer', wav, seconds: 1.4, peak: 0.2, bargeIn: true, endAt: p.now() - 300 });
    const sent = p.take();
    assert.deepEqual(names(sent), [`ended:${reason}`, 'send']);
    assert.equal(sent.at(-1)[1].notes.bargeIn, true);
    assert.equal(sent.at(-1)[1].notes.sinceReplyMs, 4700, 'timed from when the sentence ended, not when its text was ready');
    assert.equal(sent.at(-1)[1].notes.mode, reason === 'handsfree' ? 'hands-free' : reason === 'run' ? 'run' : 'answer');
    await new Promise((r) => setImmediate(r));
    assert.equal(p.mic.barge.holding, false, 'your words are in: she may talk again');
  }
  // A cough: lowered, then dropped by the app as too short: her voice comes back, nothing is said about it.
  const p = fakePage();
  p.state('armed', 'handsfree');
  p.mic.on({ event: 'onset', reason: 'handsfree', echo: true, bargeIn: true });
  p.take();
  p.mic.on({ event: 'dropped', reason: 'too_short', arm: 'handsfree' });
  assert.deepEqual(names(p.take()), ['duck:false', 'clearWords', 'ended:handsfree']);
  // No live words at all: the timer decides (she stops), unless words came meanwhile.
  p.mic.on({ event: 'onset', reason: 'handsfree', echo: true, bargeIn: true });
  p.take();
  p.timers.at(-1).fn();
  assert.deepEqual(names(p.take()), ['hush', 'duck:false', 'surprised']);
  // She wasn't speaking: nothing to lower.
  p.mic.on({ event: 'onset', reason: 'handsfree', echo: false });
  assert.deepEqual(names(p.take()), ['heard:handsfree']);
  // Barge-in switched off in Settings.
  const q = fakePage({ bargeOn: () => false });
  q.state('armed', 'run');
  q.take();
  q.mic.on({ event: 'onset', reason: 'run', echo: true, bargeIn: true });
  assert.deepEqual(names(q.take()), ['heard:run']);
});

test('"Hey Echo": room talk changes nothing on the page; the wake word stops Echo and lights up', () => {
  const p = fakePage();
  p.state('armed', 'wake');
  p.take();
  p.mic.on({ event: 'onset', reason: 'wake', echo: true, bargeIn: false });
  assert.deepEqual(p.take(), [], 'talk that may not be for Echo never lowers her voice');
  assert.equal(p.mic.hearing, false, 'and is not shown as hearing you');
  p.mic.on({ event: 'dropped', reason: 'not_wake', arm: 'wake' });
  assert.deepEqual(names(p.take()), ['clearWords', 'ended:wake'], 'not for Echo: no note');
  p.mic.on({ event: 'onset', reason: 'wake', echo: true, bargeIn: false });
  p.mic.on({ event: 'wake' });
  assert.deepEqual(names(p.take()), ['hush', 'sfx:wake']);
  assert.equal(p.mic.awake, true);
  assert.equal(p.mic.hearing, true);
  p.mic.on({ event: 'utterance', reason: 'wake', wav, seconds: 3, peak: 0.2, final: { text: 'hey echo check the build', ms: 80, locale: 'en-US', words: [{ word: 'hey', p: 0.9 }] } });
  const sent = p.take().at(-1)[1];
  assert.equal(sent.notes.mode, 'wake');
  assert.deepEqual(sent.notes.final, { text: 'hey echo check the build', ms: 80, words: [{ word: 'hey', p: 0.9 }] }, "Apple's text goes with the clip");
  assert.equal(p.mic.awake, false);
  // "Hey Echo", then nothing for 6 s: said so.
  p.mic.on({ event: 'dropped', reason: 'silent', arm: 'wake' });
  assert.ok(p.take().some(([k, v]) => k === 'note' && /Hey Echo/.test(v)));
});

test('the plan goes to the app only when it changes', () => {
  const p = fakePage();
  const base = { available: true, setting: true, serverEngine: true, wakeWord: true };
  p.mic.plan(base);
  p.mic.plan(base);
  assert.equal(p.take().length, 1);
  p.mic.plan({ ...base, speaking: true });
  assert.equal(p.take()[0][1].echo, true);
  p.mic.plan({ ...base, speaking: true }, true);
  assert.equal(p.take().length, 1, 'forced: the app is asked to report again');
});

test('the page wires the engine in: in the app its mic is the only one, the page\'s own is the fallback', () => {
  const app = pageSource();
  assert.match(app, /nativeMic: \(e\) => \{[\s\S]{0,200}appMic\.on\(e\);/);
  assert.match(app, /const inApp = \(\) => appAvailable\(\) && nativeEngine\(\) && appMic\.usable;/);
  // Space, the mic button and hands-free go to the app; getUserMedia is never reached then.
  assert.match(app, /async function startListening\(\) \{[\s\S]{0,400}if \(inApp\(\)\) \{[\s\S]{0,200}appMic\.pttBegin\(spaceHeld\);\n\s+return;\n\s+\}\n\s+hush\(\);/);
  assert.match(app, /const wakeOn = \(\) => wakeWanted\(\) && !inApp\(\) && !appPending\(\);/, 'the window listens for "Hey Echo" only when the app cannot');
  assert.match(app, /if \(!els\.handsFree\.checked && !inApp\(\) && !appPending\(\)\) \{\n\s+autoCapture = true;/, 'an answer window is the app\'s mic, not a second capture');
  assert.match(app, /if \(!inApp\(\) && !appPending\(\)\) on \? startListening\(\) : stopListening\(\);/);
  assert.match(app, /function syncWake\(\) \{\n\s+if \(inApp\(\)\) leavePageMic\(\);/, "the page's mic is let go when the app takes over");
  assert.equal((app.match(/getUserMedia\(/g) || []).length, 1, 'one place opens the page mic: the fallback');
  // Space works in hands-free in the app (the key takes over), and the hint follows.
  // In the Mac app the talk key is the shortcut from anywhere; Space talks only in a browser tab.
  assert.match(app, /e\.code === 'Space' && !typing\(\) && !inApp\(\) && !els\.handsFree\.checked/);
  assert.match(app, /spaceCuts: app \|\| !els\.handsFree\.checked,/);
  assert.match(app, /els\.state\.innerHTML = stateLine\(\{/);
  assert.match(app, /if \(appMic\.barge\.holding\) return;/, 'held speech stays quiet');
  assert.match(app, /send: \(wav, live, notes\) => sendClip\(new Blob\(\[wav\]/, 'the same pipeline as the window mic');
  assert.match(app, /onPress: \(\) => \(inApp\(\) \? setListenMode\([^\n]*'pearl'\) : pttOn\(\) \? stopListening\(\) : startListening\(\)\),/);
  assert.match(app, /outAnalyser\.connect\(voiceGain\)\.connect\(ctx\.destination\);/, "Echo's voice can be lowered");
  // The Labs switches are gone, with their old paths.
  assert.doesNotMatch(app, /settings\.flags\?\.(appMic|appleSpeech|smartEnd|softBarge)|pttViaApp|nativeHearing/);
  const flags = fs.readFileSync(path.join(root, 'lib', 'flags.ts'), 'utf8');
  assert.doesNotMatch(flags, /appMic|appleSpeech|smartEnd|softBarge/);
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  // Only talking over Echo is still a choice; the rest are the same for everyone (lib/settings.js FIXED).
  assert.match(html, /id="setBargeIn"/);
  for (const id of ['setTakeBack', 'setMovePx', 'setNativeMic', 'setDuck', 'setMicOff']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
});

test('take-back, the native mic and ducking are fixed; barge-in is the one setting', () => {
  const s = getSettings();
  assert.equal(s.takeBack, 'pause');
  assert.equal(s.takeBackMovePx, 120);
  assert.equal(s.nativeMic, true);
  assert.equal(s.bargeIn, true);
  assert.equal(s.duckMedia, true);
  const t = saveSettings({ takeBack: 'end', takeBackMovePx: 20, nativeMic: false, duckMedia: false, bargeIn: false });
  assert.deepEqual([t.takeBack, t.takeBackMovePx, t.nativeMic, t.duckMedia], ['pause', 120, true, true], 'saved values are ignored');
  assert.equal(t.bargeIn, false);
  saveSettings({ bargeIn: true });
});

/* ---------- taking back control: the step, not the session ---------- */

test('a click or key mid-step stops only that step: the session stays and listens; Escape ends it', async () => {
  on();
  let pauseDuringDo = false;
  let c;
  const { bridge, seen, does } = fakeApp({
    did: () => {
      if (!pauseDuringDo) return {};
      // The Mac app saw the user's click while acting.
      c.pause('clicked', { runId: c.run.id });
      return { ok: false, error: 'paused', message: 'You took over, so Echo stopped this step.' };
    },
  });
  c = new ComputerUse({ bridge, logFile });
  const paused = [];
  c.on('paused', (p) => paused.push(p));
  const aborted = [];
  c.on('aborted', (a) => aborted.push(a));
  c.isBusy = () => true; // the assistant is working on a request

  assert.equal((await c.act('click', { target: 'Search' })).done, true);
  const runId = c.run?.id;
  assert.equal(seen.at(-1).params.request, 1, 'every step carries its request number');
  pauseDuringDo = true;
  const r = await c.act('click', { target: 'Shorts' });
  assert.equal(r.error, 'paused');
  assert.match(r.message, /NOT done/);
  assert.match(r.message, new RegExp(TAKE_OVER_LINE.replace('.', '\\.')));
  assert.equal(paused.length, 1, 'Echo says "Okay, go ahead" once');
  assert.equal(c.driving, true, 'the session is still on');
  assert.equal(c.run?.id, runId);
  assert.equal(aborted.length, 0, 'not a take-back of the whole session');
  // Nothing more happens in this request...
  pauseDuringDo = false;
  const before = seen.length;
  assert.equal((await c.act('click', { target: 'Home' })).error, 'paused');
  assert.equal(seen.length, before, 'nothing reaches the app');
  // ...until the user says the next thing: "click the MrBeast video".
  c.newTurn();
  assert.equal(c.paused, null);
  assert.equal((await c.act('click', { target: 'MrBeast' })).done, true);
  assert.equal(seen.at(-1).params.request, 2);
  assert.equal(c.run?.id, runId, 'the same session');
  assert.ok(does().length >= 2);

  // Clicking around between requests (nothing under way) is ignored.
  c.isBusy = () => false;
  assert.equal(c.pause('clicked', { runId }), false);
  assert.equal(c.paused, null);
  // An old run's report is ignored.
  c.isBusy = () => true;
  assert.equal(c.pause('clicked', { runId: 'old' }), false);
  // Escape (or Stop) ends the session.
  assert.equal(c.abort('pressed Escape', { runId }), true);
  assert.equal(c.driving, false);
  assert.equal(aborted[0].reason, 'pressed Escape');
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /"event":"took_over"/);
  assert.match(log, /"event":"take_over_ignored"/);
});

test('a step allowed on its card still goes ahead after the click that allowed it', async () => {
  on();
  const { bridge } = fakeApp();
  const c = new ComputerUse({ bridge, logFile });
  c.isBusy = () => true;
  const card = await c.act('click', { target: 'Subscribe' });
  assert.equal(card.waitingForConfirmation, true);
  c.pause('clicked', { runId: c.run?.id });
  assert.ok(c.paused);
  const r = await c.confirm(card.confirmId, true, 'window');
  assert.equal(r.done, true);
  c.end('done');
});

test('the Mac app: take-back policy, the native mic with voice processing, and its permission', () => {
  const src = (f) => fs.readFileSync(path.join(root, 'macos', 'Sources', f), 'utf8');
  const driver = src('Driver.swift');
  assert.match(driver, /policy\.decide\(/);
  assert.match(driver, /case \.pauseAction: self\.pause\(why\)/);
  assert.match(driver, /case \.endSession: self\.abort\(why\)/);
  assert.match(driver, /"type": "pause"/);
  assert.match(driver, /request != pausedRequest/, 'nothing more in a request the user took over');
  const mic = src('NativeMic.swift');
  assert.match(mic, /setVoiceProcessingEnabled\(true\)/, "Apple's echo cancellation and noise suppression");
  assert.match(mic, /AVAudioEngine\(\)/);
  assert.match(mic, /requiresOnDeviceRecognition = true/, 'live words never leave the Mac');
  assert.match(mic, /\/api\/wake/, 'the wake word is checked by local Whisper');
  assert.match(mic, /duck\.restore\(/);
  assert.match(src('main.swift'), /handleNativeMicMessage/);
  assert.match(src('ScreenBridge.swift'), /NativeMic\.shared\.beginPtt\(\)/, 'Control + Option records with the app mic');
  assert.match(src('ScreenBridge.swift'), /ptt\.onCancel = \{ \[weak self\] why in\n\s+DrawLight\.shared\.cancel\(\)\n\s+if native \{ return NativeMic\.shared\.cancelPtt\(why\) \}/, 'a spoiled chord is dropped with its reason');
  assert.match(src('PushToTalk.swift'), /onCancel\?\("spoiled"\)/);
  // One machine decides; the mic only carries it out, and every sentence ends as delivered or dropped.
  assert.match(mic, /private var machine = ListenMachine\(\)/);
  assert.match(mic, /run\(machine\.frame\(level: level, frameMs: Self\.frameMs, echo: echoOn, ducked: duck\.active\)\)/);
  assert.match(mic, /send\(MicEvent\.utterance\(s, /);
  assert.match(mic, /send\(MicEvent\.dropped\(why, s\)\)/);
  assert.match(mic, /timeline\("mic\.cancel", \["reason": why\.rawValue, "arm": s\.reason\.rawValue\]\)/);
  assert.match(mic, /self\.send\(MicEvent\.state\(self\.machine\.state, /);
  // The mic is open only while something listens (or just after a key), never because the app runs.
  assert.match(mic, /let want = !stalled && micOpen\.open\(usable: usable, wanted: wanted, now: now\)/);
  assert.doesNotMatch(mic, /\bwarm\b/);
  // A stalled engine is noticed: the device-change notice, waking, and a watch on the frames in
  // every state that needs the mic; a restart first, then the sentence is dropped and it's said.
  assert.match(mic, /forName: \.AVAudioEngineConfigurationChange, object: engine/);
  assert.match(mic, /NSWorkspace\.didWakeNotification/);
  assert.match(mic, /self\.watch\.tick\(ms: Self\.tickMs, gotFrames: got, listening: expected && self\.machine\.wantsMic\)/);
  assert.match(mic, /case \.giveUp:[\s\S]{0,300}self\.stalled = true\n\s+self\.stop\(\)\n\s+self\.fail\("no_sound"/);
  assert.match(mic, /guard format\.sampleRate > 0, format\.channelCount > 0 else \{ return fail\("no_input"/, 'no input device is said, not silent');
  assert.doesNotMatch(mic, /watchPtt/, 'one watch for every state, not a chain per key press');
  // Closing the engine tells the machine (a sentence under way is dropped, its clip let go), opening re-arms.
  assert.match(mic, /private func stop\(\) \{\n\s+closeEngine\(\)[\s\S]{0,200}self\.run\(self\.machine\.stop\(\)\)/);
  assert.match(mic, /running = true[\s\S]{0,260}self\.run\(self\.machine\.start\(\)\)/);
  // The permission is looked at again every 5 s while the mic is open, and when Echo comes to the front.
  assert.match(mic, /if running, ticks % 10 == 0, NativeMic\.permission != "allowed" \{ sync\(\) \}/);
  const main = src('main.swift');
  assert.match(main, /func applicationDidBecomeActive\(_ note: Notification\) \{[\s\S]{0,120}NativeMic\.shared\.recheck\(\)/);
  // No page, no listening: a new load, a dead web process and the status page all disarm the mic.
  assert.match(main, /didCommit navigation: WKNavigation!\) \{\n\s+CaptionBar\.shared\.reset\(\)\n\s+NativeMic\.shared\.pageGone\(\)/);
  assert.match(main, /func webViewWebContentProcessDidTerminate\(_ webView: WKWebView\) \{[\s\S]{0,200}NativeMic\.shared\.pageGone\(\)/);
  assert.match(main, /func showStatusPage\([\s\S]{0,260}NativeMic\.shared\.pageGone\(\)/);
  assert.match(mic, /func pageGone\(\) \{\n\s+guard enabled else \{ return \}\n\s+configure\(\["enabled": false, "prepare": false\]\)/);
  // The hold is timed by the clock (a mic that had to open first delivers less sound than the hold).
  assert.match(mic, /self\.machine\.pttUp\(heldMs: Date\(\)\.timeIntervalSince\(self\.pttDownAt\) \* 1000\)/);
  assert.doesNotMatch(mic, /appleOn|smartEnd|wakeStash|beginManual/, 'the old second engine is gone');
  const plist = fs.readFileSync(path.join(root, 'macos', 'Info.plist'), 'utf8');
  assert.match(plist, /NSMicrophoneUsageDescription/);
});

/* ---------- routing what's said, and "the first video" ---------- */

test('routing while driving: commands go on, "stop" stops, "that\'s all" ends', () => {
  for (const t of ['click the first video', 'click the MrBeast video', 'the one in the top right corner', 'scroll down', 'go back']) {
    assert.equal(routeSpeech({ text: t, driving: true, busy: false }), 'turn', t);
    assert.equal(routeSpeech({ text: t, driving: true, busy: true }), 'instruct', t);
  }
  assert.equal(routeSpeech({ text: 'stop', driving: true, busy: false }), 'stop');
  assert.equal(routeSpeech({ text: "that's all", driving: true, busy: false }), 'end');
  assert.equal(routeSpeech({ text: 'click the first video', driving: false, busy: false }), 'turn');
});

test('screen references: things the user points at by place or looks', () => {
  for (const t of ['Click the first video', 'click the MrBeast video', 'the one in the top right corner', 'click the one in the corner', 'open the second result', 'play that video', 'click the red button on the left', 'tap the thumbnail at the bottom']) {
    assert.equal(screenReference(t), true, t);
  }
  for (const t of ['scroll down', 'go back', 'search for otters', 'what time is it', 'open Spotify', 'stop', "that's all", 'type hello world']) {
    assert.equal(screenReference(t), false, t);
  }
  const p = computerPrompt({ computerUse: true, pointer: true, screenAware: true });
  assert.match(p, /click the first video/);
  assert.match(p, /look_at_screen with include_image/);
  assert.match(p, /x and y from that same picture/);
  assert.match(p, /always on while you drive/);
});

test('"click the first video" with a mocked screen: look, find it in the picture, click there', async () => {
  on();
  // The screenshot: YouTube results, the first video's thumbnail at (320, 260) in a 1280×800 picture.
  const { bridge, resolves, does } = fakeApp({
    look: () => ({ ok: true, source: 'native', text: 'YouTube\nMrBeast\nI Survived 50 Hours In Antarctica\nMrBeast · 120M views', image: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64'), mime: 'image/jpeg', width: 1280, height: 800, app: 'Google Chrome' }),
    resolve: (p) => (p.x !== undefined ? { label: 'I Survived 50 Hours In Antarctica', role: 'AXImage' } : {}),
  });
  const c = new ComputerUse({ bridge, logFile });
  // The dispatcher tells the assistant to look first when the words point at the screen.
  const tasks = new TaskManager({ queryFn: fakeQuery(() => []).queryFn });
  const d = new Dispatcher(tasks, null, undefined, bridge, c);
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (m) => pushed.push(m), size: 0 });
  c.noteApp('Google Chrome');
  await c.act('press_keys', { keys: 'cmd+l' }); // a session is on
  d.send('click the first video');
  assert.match(pushed.at(-1), /on screen: .*look_at_screen with include_image first/);
  d.setBusy(false);
  d.send('what is on my calendar');
  assert.doesNotMatch(pushed.at(-1), /on screen:/);
  d.setBusy(false);
  // The assistant's loop: look (with the picture), then click by x/y from it.
  const look = await bridge.request('look', { reason: 'find the first video' });
  assert.equal(look.look.image.width, 1280);
  const seen = lookContent(look.look, { includeImage: true }).content;
  assert.ok(seen.some((b) => b.type === 'image'), 'the assistant gets the picture to find it in');
  assert.ok(seen.some((b) => b.type === 'text' && /1280/.test(b.text)), 'with its size, for x/y');
  const r = await c.act('click', { x: 320, y: 260, say: 'Opening it…' });
  assert.equal(r.done, true);
  const res = resolves().at(-1);
  assert.equal(res.params.x, 320);
  assert.equal(res.params.y, 260);
  assert.equal(res.params.app, 'Google Chrome');
  assert.equal(does().at(-1).params.x, 320);
  assert.match(r.did, /Antarctica/);
  c.end('done');
});

/* ---------- the Swift decisions ---------- */

/**
 * The Swift tools to build with: the ones selected on this Mac, else Apple's Command Line Tools
 * (an Xcode whose license isn't accepted yet, after an update, can't build). Null when neither
 * works. These checks hold all the listening rules, so on a Mac that is a failure, never a skip:
 * a skipped test looks like a passed one.
 */
const swiftEnv = (() => {
  for (const dev of ['', '/Library/Developer/CommandLineTools']) {
    const env = dev ? { ...process.env, DEVELOPER_DIR: dev } : process.env;
    try {
      execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '--version'], { env, stdio: 'ignore', timeout: 30000 });
      return env;
    } catch {}
  }
  return null;
})();

test('the listening machine, speech gate, mic events, ducking and take-back policy (Swift)', { skip: process.platform !== 'darwin' && 'the Mac app is only built on a Mac', timeout: 240000 }, async () => {
  assert.ok(swiftEnv, 'Swift can\'t build on this Mac, so the listening rules are NOT checked. Install the Command Line Tools (xcode-select --install) or accept the Xcode license (sudo xcodebuild -license).');
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-voice-')), 'voice-tests');
  const run = promisify(execFile);
  await run('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', path.join(root, 'macos', 'Sources', 'VoiceMath.swift'), path.join(root, 'macos', 'Tests', 'Voice', 'main.swift'), '-o', bin], { env: swiftEnv });
  // The same table of events the page was held to above.
  const r = await run(bin, [path.join(import.meta.dirname, 'fixtures', 'nativemic-events.json')]).catch((e) => e);
  assert.equal(String(r.stdout).trim().split('\n').pop(), 'ok', String(r.stdout));
});

