// The conversation window, shown (public/convwindow.js): the same window the server decides with
// (lib/session.ts), the ring and its words under the orb, the caption bar, the chimes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, serverSource, pageSource } from './helpers.js';

sandbox('convwindow');
const W = await import('../public/convwindow.js');
const S = await import('../lib/session.ts');
const { captionStatus, createCaptionFeed } = await import('../public/caption.js');
const root = path.resolve(import.meta.dirname, '..');
const NOW = 5_000_000;

test('one window for the server and the page: same numbers, same answer', () => {
  assert.deepEqual([S.FOLLOW_MS, S.FOLLOW_QUESTION_MS, S.TALK_IDLE_MS, S.TALK_MAX_MS], [W.FOLLOW_MS, W.FOLLOW_QUESTION_MS, W.TALK_IDLE_MS, W.TALK_MAX_MS]);
  assert.deepEqual([W.FOLLOW_MS, W.FOLLOW_QUESTION_MS, W.TALK_IDLE_MS, W.TALK_MAX_MS], [8000, 15000, 30000, 1800000], 'the decided numbers');
  for (const s of [{ sinceReplyMs: 3000 }, { sinceReplyMs: 12000, asked: true }, { sinceReplyMs: 9000 }, { working: true }, { closed: true, sinceReplyMs: 1000 }, { talk: { since: NOW - 1000, lastAt: NOW - 1000 } }]) {
    const page = W.windowState({ asked: false, talk: null, closed: false, working: false, now: NOW, ...s });
    const server = S.sessionWindow({ asked: false, talk: null, closed: false, working: false, now: NOW, ...s });
    assert.deepEqual({ open: page.open, why: page.why }, server, JSON.stringify(s));
  }
});

test('how long it has left, and the words next to the ring', () => {
  const f = W.windowState({ sinceReplyMs: 2500, now: NOW });
  assert.deepEqual(f, { open: true, why: 'follow', leftMs: 5500, totalMs: 8000 });
  assert.equal(W.windowLabel(f), 'Listening · 6 s');
  const q = W.windowState({ sinceReplyMs: 1000, asked: true, now: NOW });
  assert.equal(W.windowLabel(q), 'Your turn · 14 s');
  assert.equal(W.windowLabel(W.windowState({ working: true })), 'Listening while I work · just talk');
  const t = W.windowState({ talk: { since: NOW - 60_000, lastAt: NOW - 10_000 }, now: NOW });
  assert.deepEqual([t.why, t.leftMs, t.totalMs], ['talk', 20_000, 30_000]);
  assert.equal(W.windowLabel(t), 'Talk mode · just talk');
  assert.equal(W.windowLabel(W.windowState({ sinceReplyMs: 20_000 })), '', 'closed: nothing shown');
  assert.equal(W.windowState({ sinceReplyMs: NaN }).open, false);
});

test('the caption bar shows the window, but not over Echo speaking or thinking', () => {
  assert.equal(captionStatus({ windowLabel: 'Listening · 6 s' }), 'Listening · 6 s');
  assert.equal(captionStatus({ windowLabel: 'Listening · 6 s', speaking: true }), 'Speaking…');
  assert.equal(captionStatus({ windowLabel: 'Listening · 6 s', busy: true }), 'Thinking…');
  assert.equal(captionStatus({ windowLabel: 'Listening · 6 s', hearing: true }), 'Hearing you…');
  const sent = [];
  const feed = createCaptionFeed({ post: (m) => sent.push(m), throttleMs: 0, setTimer: (fn) => (fn(), 0), clearTimer: () => {} });
  feed.update({ windowLabel: 'Talk mode · just talk' });
  assert.equal(sent.at(-1)?.status, 'Talk mode · just talk');
  assert.equal(sent.at(-1)?.active, true, 'the bar shows while the window is open');
});

test('the page shows it only when the mic is really listening, and chimes softly', () => {
  const app = pageSource();
  assert.match(app, /import \{ windowState, windowLabel, windowEndsAt \} from '\/convwindow\.js';/);
  assert.match(app, /const show = w\.open && micLive\(\) && \(w\.why === 'working' \|\| \(!speaking && !busy\)\);/);
  // In the Mac app "listening" is what its mic reports, never a guess that it could listen
  // (the ring used to say "Listening · 8 s" with no mic open when the wake word was off).
  assert.match(app, /return inApp\(\) \? appMic\.live : !micOff && \(els\.handsFree\.checked \|\| autoListen\.isOpen\);/);
  assert.match(app, /const w = convWindow\(\);[\s\S]{0,600}engaged: w\.open,/, "the app's mic follows the same window");
  assert.match(app, /windowOpen: \[\[740, 0\], \[988, 0\.06\]\]/);
  assert.match(app, /windowClose: \[\[587, 0\], \[440, 0\.09\]\]/);
  assert.match(app, /case 'listen_state': listenServer = /);
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /id="convWindow" role="status" aria-live="polite" hidden/);
  const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.cw-left/);
  const server = serverSource();
  assert.match(server, /flags: flagsNow\(\), flagInfo: flagInfo\(\), listen: speech\.listenState/);
  assert.match(server, /broadcast\(\{ type: 'listen_state', talk: listenState\.talk, closed: listenState\.closed \}\)/);
});

test("when the window runs out, on the wall clock: the Mac app's mic closes it by itself", () => {
  const replyAt = 1_000_000;
  const follow = W.windowState({ sinceReplyMs: 2000, now: replyAt + 2000 });
  assert.equal(W.windowEndsAt(follow, { replyAt }), replyAt + W.FOLLOW_MS, 'the same moment however late it is asked (so the plan sent to the app does not change)');
  assert.equal(W.windowEndsAt(W.windowState({ sinceReplyMs: 6000, now: replyAt + 6000 }), { replyAt }), replyAt + W.FOLLOW_MS);
  assert.equal(W.windowEndsAt(W.windowState({ sinceReplyMs: 2000, asked: true }), { replyAt }), replyAt + W.FOLLOW_QUESTION_MS);
  const talk = { since: replyAt - 60_000, lastAt: replyAt };
  assert.equal(W.windowEndsAt(W.windowState({ talk, now: replyAt + 5000 }), { replyAt, talk }), replyAt + W.TALK_IDLE_MS);
  assert.equal(W.windowEndsAt(W.windowState({ working: true }), { replyAt }), 0, 'while Echo works it does not run out');
  assert.equal(W.windowEndsAt(W.windowState({ sinceReplyMs: 60_000 }), { replyAt }), 0, 'closed');
  assert.equal(W.windowEndsAt(follow, {}), 0, 'nothing known about the reply');
});
