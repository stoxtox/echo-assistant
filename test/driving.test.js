// Driving across apps: focus handling (the target app is brought forward before every action, a
// miss is retried once and then reported without ending the session), driving sessions that carry
// on across requests, routing what the user says mid-run and between requests, the direct paths
// (music, opening a found file), and the caption bar's feed. A fake "Mac app" answers every
// request; nothing touches a real screen, mouse or keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, wait, pageSource } from './helpers.js';

const dirs = sandbox('driving');
const { ComputerUse, routeSpeech, isEndCommand, isStopCommand, targetApp, computerPrompt } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { QuickActions } = await import('../lib/quick.js');
const { saveSettings, getSettings, setFixedForTest } = await import('../lib/settings.js');
const { captionStatus, captionMode, captionLine, createCaptionFeed, CAPTION_MAX_CHARS } = await import('../public/caption.js');

const root = path.join(import.meta.dirname, '..');
const logFile = path.join(dirs.data, 'computer-log.jsonl');
const on = () => (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));

/**
 * A bridge whose "Mac app" answers resolve with `resolve(params, n)` (n: which resolve this is)
 * and does every action.
 * @param {{ resolve?: (p: any, n: number) => object, did?: (p: any) => object }} [o]
 */
function fakeApp(o = {}) {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  let resolves = 0;
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') {
      resolves++;
      out = { ok: true, found: true, token: `t${seen.length}`, label: p.target || '', role: 'AXTextField', app: p.app || 'Google Chrome', window: 'New Tab', ...(o.resolve?.(p, resolves) || {}) };
    } else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'events', app: p.app || 'Google Chrome', window: 'New Tab', ...(o.did?.(p) || {}) };
    else if (r.kind === 'wait') out = { ok: true, found: true, via: 'accessibility' };
    else if (r.kind === 'look') out = { text: 'Results', app: 'Google Chrome' };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const resolvesOf = () => seen.filter((r) => r.kind === 'act' && r.params.step === 'resolve');
  const does = () => seen.filter((r) => r.kind === 'act' && r.params.step === 'do');
  return { bridge, seen, resolvesOf, does };
}

const newComputer = (bridge, o = {}) => new ComputerUse({ bridge, logFile, focusRetryMs: 5, ...o });

/* ---------- focus ---------- */

test('every action names the session app and asks the Mac app to bring it forward', async () => {
  on();
  const { bridge, resolvesOf, does } = fakeApp();
  const c = newComputer(bridge);
  c.noteApp('Google Chrome'); // open_app opened it
  await c.act('press_keys', { keys: 'cmd+t' });
  await c.act('type_text', { text: 'MrBeast' });
  for (const r of resolvesOf()) {
    assert.equal(r.params.app, 'Google Chrome', 'the session app, though the assistant named none');
    assert.equal(r.params.activate, true);
  }
  assert.equal(does().length, 2);
  // Naming another app switches the session to it.
  await c.act('click', { target: 'Search', app: 'Safari' });
  assert.equal(resolvesOf().at(-1)?.params.app, 'Safari');
  assert.equal(c.run?.app, 'Safari');
  assert.equal(c.appContext, 'Safari');
  c.end('done');
});

test('Echo is never the target app: the session app (or the front one) is used instead', () => {
  assert.equal(targetApp('Echo', 'Google Chrome'), 'Google Chrome');
  assert.equal(targetApp('', 'Google Chrome'), 'Google Chrome');
  assert.equal(targetApp('Notes', 'Google Chrome'), 'Notes');
  assert.equal(targetApp('', 'echo'), '');
  assert.equal(targetApp(undefined, undefined), '');
  const c = newComputer(null);
  c.noteApp('Echo');
  assert.equal(c.appContext, '', "Echo's own window never becomes the session app");
});

test('a focus miss is retried once, then the action goes ahead (the live Chrome bug)', async () => {
  on();
  fs.rmSync(logFile, { force: true });
  // Sept 28: Chrome's address bar resolved fine, but Echo's window was behind it, so it looked
  // "in Echo" and the whole run stopped. Now: bring Chrome forward and look again.
  const { bridge, resolvesOf, does } = fakeApp({ resolve: (p, n) => (n === 1 ? { inEcho: true, label: 'Address and search bar' } : {}) });
  const c = newComputer(bridge);
  c.noteApp('Google Chrome');
  const r = await c.act('type_text', { text: 'MrBeast', into: 'Address and search bar' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(resolvesOf().length, 2, 'resolved again after the retry');
  assert.equal(resolvesOf()[1].params.retry, true);
  assert.equal(does().length, 1);
  assert.match(fs.readFileSync(logFile, 'utf8'), /"event":"focus_retry"/);
  c.end('done');
});

test('the app not coming forward is retried once, then reported, and the session carries on', async () => {
  on();
  const { bridge, resolvesOf, does } = fakeApp({ resolve: () => ({ ok: false, error: 'focus', message: "Couldn't bring Google Chrome to the front." }) });
  const c = newComputer(bridge);
  c.noteApp('Google Chrome');
  await c.act('scroll', { direction: 'down' }).catch(() => {});
  const runId = c.run?.id;
  const r = await c.act('type_text', { text: 'otters' });
  assert.equal(r.error, 'focus');
  assert.equal(r.done, false);
  assert.match(r.message, /Google Chrome/);
  assert.match(r.message, /open_app/);
  assert.equal(resolvesOf().length, 4, 'two tries per action, no more');
  assert.equal(does().length, 0, 'nothing typed anywhere');
  assert.equal(c.driving, true, 'the session is not aborted');
  assert.equal(c.run?.id, runId);
  assert.equal(c.blocked, null);
  c.end('done');
});

test('the Mac app losing focus right before acting is reported the same way', async () => {
  on();
  const { bridge } = fakeApp({ did: () => ({ ok: false, error: 'focus', message: "Echo's own window has the keyboard, so nothing was typed." }) });
  const c = newComputer(bridge);
  const r = await c.act('press_keys', { keys: 'cmd+l', app: 'Google Chrome' });
  assert.equal(r.error, 'focus');
  assert.equal(c.driving, true);
  c.end('done');
});

test("something really in Echo's own window is refused, but only that step", async () => {
  on();
  const { bridge, does } = fakeApp({ resolve: () => ({ app: 'Echo', inEcho: true, label: 'Stop' }) });
  const c = newComputer(bridge);
  c.ensureRun();
  const r = await c.act('click', { target: 'Stop' });
  assert.equal(r.refused, true);
  assert.equal(r.category, 'echo');
  assert.equal(does().length, 0);
  assert.equal(c.driving, true, 'the session goes on in the other app');
  // Secrets still hand control back at once.
  const s = await c.act('type_text', { text: ['hunter', '2'].join(''), target: 'Password' });
  assert.equal(s.refused, true);
  assert.equal(c.driving, false);
});

test('the Mac app brings the app forward before every action and only refuses what is really in Echo', () => {
  const src = (f) => fs.readFileSync(path.join(root, 'macos', 'Sources', f), 'utf8');
  const driver = src('Driver.swift');
  assert.match(driver, /func bringForward\(/);
  assert.match(driver, /yieldActivation\(to: app\)/, 'Echo in front hands the focus over');
  assert.match(driver, /openApplication\(at: url, configuration: cfg\)/, 'the second try, like open -a');
  assert.match(driver, /PointMath\.topWindowOwner/, "Echo's window only counts where it's really in front");
  assert.match(driver, /focusedElement\(in: /, "keys go to the target app's focus, not Echo's");
  assert.match(driver, /guard NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier != me/);
  // Nothing pulls Echo's window forward mid-drive.
  assert.match(src('main.swift'), /if !ComputerDriver\.shared\.driving \{ showWindow\(\) \}/);
  assert.match(src('ScreenBridge.swift'), /if ComputerDriver\.shared\.driving \{ return \}/);
  assert.match(src('PointMath.swift'), /static func topWindowOwner/);
});

/* ---------- sessions ---------- */

test('a driving session carries on across requests, in the same app, with a fresh step budget', async () => {
  on();
  const { bridge } = fakeApp();
  const c = newComputer(bridge);
  const states = [];
  c.on('state', (s) => states.push(s));
  c.noteApp('Google Chrome');
  await c.act('press_keys', { keys: 'cmd+t' });
  await c.act('type_text', { text: 'MrBeast' });
  const run = c.run;
  assert.equal(run?.steps, 2);
  assert.equal(states.at(-1)?.app, 'Google Chrome', 'the caption can say "Driving: Google Chrome"');
  // "Now search for something else".
  c.newTurn();
  assert.equal(c.driving, true);
  assert.equal(c.run?.id, run?.id, 'same session');
  assert.equal(c.run?.steps, 0, 'fresh budget');
  assert.equal(c.run?.requests, 2);
  assert.equal(c.run?.app, 'Google Chrome');
  await c.act('press_keys', { keys: 'cmd+l' });
  assert.equal(c.run?.steps, 1);
  c.end('done');
  assert.equal(c.driving, false);
});

test('a quiet minute ends the session, but never while a request is being worked on', async () => {
  on();
  const { bridge } = fakeApp();
  const c = newComputer(bridge, { sessionIdleMs: 40 });
  let busy = true;
  c.isBusy = () => busy;
  const idle = [];
  c.on('session_idle', () => idle.push(1));
  await c.act('press_keys', { keys: 'cmd+t', app: 'Google Chrome' });
  await wait(70);
  assert.equal(c.driving, true, 'still busy: not idle');
  busy = false;
  c.touch();
  await wait(25);
  c.instruct('scroll down'); // the user talking counts as activity
  await wait(25);
  assert.equal(c.driving, true);
  await wait(60);
  assert.equal(c.driving, false);
  assert.equal(idle.length, 1);
});

test('a session never outlasts its cap', async () => {
  on();
  let now = 1_000_000;
  const { bridge } = fakeApp();
  const c = newComputer(bridge, { now: () => now, sessionMaxMs: 1000 });
  await c.act('press_keys', { keys: 'cmd+t', app: 'Google Chrome' });
  now += 2000;
  c.newTurn();
  assert.equal(c.driving, false);
});

/* ---------- routing what the user says ---------- */

test('"that\'s all" closes the session; stop still stops; everything else continues', () => {
  for (const t of ["that's all", 'That’s all.', 'thanks, that’s all', "okay that's it", "I'm done", 'we are done', 'all done', 'nothing else', 'done', "that'll be all, thanks"]) assert.ok(isEndCommand(t), t);
  for (const t of ["that's all the results?", 'done with the search, now open Spotify', 'search for done deals', 'what is it', '']) assert.ok(!isEndCommand(t), t);
  assert.equal(routeSpeech({ text: "that's all", driving: true, busy: false }), 'end');
  assert.equal(routeSpeech({ text: "that's all", driving: true, busy: true }), 'stop', 'mid-step it ends like a stop');
  assert.equal(routeSpeech({ text: "that's all", driving: false, busy: false }), 'turn');
  assert.equal(routeSpeech({ text: 'now search for cats', driving: true, busy: false }), 'turn');
  assert.equal(routeSpeech({ text: 'go back', driving: true, busy: true }), 'instruct');
  assert.equal(routeSpeech({ text: 'scroll down', driving: true, busy: true }), 'instruct');
  assert.equal(routeSpeech({ text: 'read me the top result', driving: true, busy: false }), 'turn');
  assert.ok(isStopCommand('stop'));
});

test('the dispatcher: chained requests stay in the session, mid-run words go to the next step, "that\'s all" ends it', async () => {
  on();
  const { bridge } = fakeApp();
  const tasks = new TaskManager({ queryFn: fakeQuery(() => []).queryFn });
  const c = newComputer(bridge);
  const d = new Dispatcher(tasks, null, undefined, bridge, c);
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (m) => pushed.push(m), size: 0 });
  const spoken = [];
  d.on('speak', (t) => spoken.push(t));
  // Request 1, mid-run.
  d.setBusy(true);
  await c.act('press_keys', { keys: 'cmd+t', app: 'Google Chrome' });
  const runId = c.run?.id;
  assert.equal(d.send('no, search for otters instead'), 'instruct');
  assert.equal(pushed.length, 0);
  // The reply ends before the assistant got to it: the instruction goes in as the next request.
  const result = { type: 'result', subtype: 'success', total_cost_usd: 0, session_id: 's' };
  d.onMessage(result);
  assert.equal(pushed.length, 1);
  assert.equal(c.driving, true);
  // That reply ends too; the session stays open, listening.
  d.onMessage(result);
  assert.equal(d.busy, false);
  assert.equal(c.driving, true);
  assert.ok(c.idleTimer, 'the quiet minute starts');
  // Request 3: "now search for something else" continues the same session.
  assert.equal(d.send('now search for something else'), 'turn');
  assert.equal(pushed.length, 2);
  assert.equal(c.run?.id, runId);
  assert.equal(c.run?.app, 'Google Chrome');
  // Done.
  d.setBusy(false);
  assert.equal(d.send("thanks, that's all"), 'end');
  assert.equal(c.driving, false);
  assert.ok(spoken.includes('Okay, all yours.'));
  assert.equal(c.blocked, null, 'ending is not a take-back: the next request may drive again');
});

test('open_app and media_control set the app the session works in', async () => {
  on();
  const calls = [];
  const exec = async (file, args, input) => {
    calls.push({ file, args, input });
    return file === 'osascript' ? 'none' : '';
  };
  const quick = new QuickActions({ exec });
  const c = newComputer(fakeApp().bridge);
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quick, null, c);
  /** @type {Record<string, any>} */
  const tools = Object.fromEntries(d.quickTools().map((t) => [t.name, t]));
  await tools.open_app.handler({ name: 'Google Chrome' }, {});
  assert.equal(c.appContext, 'Google Chrome');
  await tools.media_control.handler({ app: 'Spotify', action: 'search_play', query: 'Blinding Lights' }, {});
  assert.equal(c.appContext, 'Spotify');
  assert.deepEqual(calls.at(-1)?.args, ['spotify:search:Blinding%20Lights']);
});

/* ---------- direct paths ---------- */

test('media_control: play and pause by AppleScript, search_play from the Music library or an open search', async () => {
  const calls = [];
  let library = 'playing:Blinding Lights — The Weeknd';
  const exec = async (file, args, input) => {
    calls.push({ file, args, input });
    if (file === 'osascript') return input.includes('search library') ? library : input.includes('player state') ? 'Song — Artist' : '';
    return '';
  };
  const q = new QuickActions({ exec });
  const paused = /** @type {any} */ (await q.mediaControl({ app: 'Spotify', action: 'pause' }));
  assert.equal(paused.did, 'pause');
  assert.match(calls[0].input, /tell application "Spotify" to pause/);
  const next = /** @type {any} */ (await q.mediaControl({ app: 'Music', action: 'next' }));
  assert.equal(next.did, 'next');
  assert.match(calls.at(-1)?.input, /next track/);
  const hit = await q.mediaControl({ app: 'Music', action: 'search_play', query: 'Blinding Lights' });
  assert.equal(hit.playing, 'Blinding Lights — The Weeknd');
  assert.deepEqual(calls.at(-1)?.args.slice(-1), ['Blinding Lights'], 'the words go in as an argument, never into the script');
  assert.doesNotMatch(calls.at(-1)?.input, /Blinding/);
  library = 'none';
  const miss = await q.mediaControl({ app: 'Music', action: 'search_play', query: 'Some "odd" song' });
  assert.equal(miss.playing, null);
  assert.match(calls.at(-1)?.args[0], /^music:\/\/music\.apple\.com\/search\?term=Some%20%22odd%22%20song$/);
  await assert.rejects(q.mediaControl({ app: 'Winamp', action: 'play' }), /Apple Music or Spotify/);
  await assert.rejects(q.mediaControl({ app: 'Spotify', action: 'delete' }), /not "delete"/);
  await assert.rejects(q.mediaControl({ app: 'Spotify', action: 'search_play', query: ' ' }), /which song/);
});

test('open_app with a file opens only the user\'s own documents', async () => {
  const calls = [];
  const q = new QuickActions({ exec: async (file, args) => { calls.push({ file, args }); return ''; } });
  const home = path.join(dirs.root, 'home');
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.secret'), { recursive: true });
  const sheet = path.join(home, 'Documents', 'budget.xlsx');
  fs.writeFileSync(sheet, 'x');
  fs.writeFileSync(path.join(home, 'Documents', 'run.command'), 'x');
  fs.writeFileSync(path.join(home, '.secret', 'a.txt'), 'x');
  const r = await q.openFile(sheet, 'Microsoft Excel', { home });
  assert.equal(r.opened, 'budget.xlsx');
  assert.deepEqual(calls.at(-1)?.args, ['-a', 'Microsoft Excel', sheet]);
  await assert.rejects(q.openFile(path.join(home, 'Documents', 'run.command'), '', { home }), /not programs/);
  await assert.rejects(q.openFile(path.join(home, '.secret', 'a.txt'), '', { home }), /home folder/);
  await assert.rejects(q.openFile('/etc/hosts', '', { home }), /home folder/);
  await assert.rejects(q.openFile('Documents/budget.xlsx', '', { home }), /home folder/);
  await assert.rejects(q.openFile(path.join(home, 'Documents', 'missing.xlsx'), '', { home }), /no file/);
  await assert.rejects(q.openFile(sheet, 'Excel; rm', { home }), /app name/);
  assert.equal(calls.length, 1);
});

test('the dispatcher prompt: act when asked to do something, sessions, and app recipes', () => {
  const p = computerPrompt({ computerUse: true, pointer: true });
  assert.match(p, /act instead of answering from memory/);
  assert.match(p, /Driving is a session, not one command/);
  assert.match(p, /don't call stop_driving/);
  assert.match(p, /youtube\.com\/results\?search_query=/);
  assert.match(p, /media_control/);
  assert.match(p, /Claude desktop app/);
  assert.match(p, /waits for the user's yes/);
  assert.match(p, /Excel or Numbers/);
  assert.match(p, /Finder/);
  assert.match(p, /Notes/);
  assert.match(p, /brings it to the front before each step/);
});

/* ---------- the caption bar ---------- */

test('the caption status line', () => {
  assert.equal(captionStatus({ driving: true, app: 'Google Chrome' }), 'Driving: Google Chrome');
  assert.equal(captionStatus({ driving: true, app: 'Chrome', waitingForConfirm: true, listening: true }), 'Waiting for you to confirm');
  assert.equal(captionStatus({ listening: true }), 'Listening…');
  assert.equal(captionStatus({ driving: true, listening: true }), 'Listening… say “stop” anytime');
  assert.equal(captionStatus({ hearing: true, driving: true }), 'Hearing you…');
  assert.equal(captionStatus({ busy: true }), 'Thinking…');
  assert.equal(captionStatus({}), '');
  assert.equal(captionMode({ hearing: true, speaking: true }), 'hearing');
  assert.equal(captionMode({ speaking: true, busy: true }), 'speaking');
  assert.equal(captionMode({ busy: true, listening: true }), 'thinking');
  assert.equal(captionMode({ listening: true }), 'listening');
  assert.equal(captionMode({}), '');
  assert.equal(captionLine('  a   b '), 'a b');
  const long = captionLine('word '.repeat(100));
  assert.ok(long.length <= CAPTION_MAX_CHARS && long.startsWith('…'), 'the newest words are kept');
});

test('the caption feed posts changes to the app, throttled and without repeats', async () => {
  const posts = [];
  let enabled = true;
  const feed = createCaptionFeed({ post: (m) => posts.push(m), enabled: () => enabled, throttleMs: 20 });
  feed.update({ driving: true, app: 'Google Chrome' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].type, 'caption');
  assert.equal(posts[0].status, 'Driving: Google Chrome');
  assert.equal(posts[0].active, true);
  assert.equal(posts[0].mode, '', 'the pill knows what leads: nothing yet');
  assert.equal(posts[0].confirm, false);
  feed.update({ user: 'search for' });
  feed.update({ user: 'search for MrBeast' });
  assert.equal(posts.length, 1, 'throttled');
  await wait(40);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].user, 'search for MrBeast');
  feed.update({ user: 'search for MrBeast' });
  await wait(40);
  assert.equal(posts.length, 2, 'no change, no post');
  feed.update({ echo: 'Opening Chrome…' });
  await wait(40);
  assert.equal(posts.at(-1)?.echo, 'Opening Chrome…');
  enabled = false;
  feed.refresh();
  assert.equal(posts.at(-1)?.enabled, false, 'the setting reaches the app at once');
  feed.update({ driving: false });
  await wait(40);
  feed.update({ driving: true });
  await wait(40);
  assert.equal(posts.at(-1)?.user, '', 'a new session starts clean');
});

test("the caption pill offers a reply field when Echo ends on a question, and it clears once answered", async () => {
  const posts = [];
  const timers = [];
  const feed = createCaptionFeed({ post: (m) => posts.push(m), throttleMs: 0, askMs: 50,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; }, clearTimer: (t) => clearTimeout(t) });
  feed.update({ busy: true });
  feed.update({ busy: false, echo: 'Which address should I use?' });
  assert.equal(posts.at(-1)?.asks, false);
  feed.update({ asks: true });
  assert.equal(posts.at(-1)?.asks, true, 'the app opens the field');
  assert.equal(posts.at(-1)?.active, true, 'the pill stays up while Echo waits');
  feed.update({ hearing: true });
  assert.equal(posts.at(-1)?.asks, false, 'answering out loud closes the offer');
  feed.update({ hearing: false, asks: true });
  feed.update({ busy: true });
  assert.equal(posts.at(-1)?.asks, false, 'a new turn (typed anywhere) closes it too');
  feed.update({ busy: false, asks: true });
  await wait(90);
  assert.equal(posts.at(-1)?.asks, false, 'unanswered, it goes back to the orb after a while');
  assert.equal(posts.at(-1)?.active, false);
  for (const t of timers) clearTimeout(t);

  const app = pageSource();
  assert.match(app, /const offer = awaits \|\| typedLast;\n\s*caption\.update\(\{ asks: offer,/, "Echo's question (reply_end awaitsReply) reaches the pill, and so does a reply to something typed");
  const send = app.slice(app.indexOf('captionSend:'), app.indexOf('captionSend:') + 400);
  assert.match(send, /send\(\{ type: 'user_text', text: t, typed: true \}\)/, 'Enter sends it exactly like a typed chat message');
  const reply = fs.readFileSync(path.join(root, 'macos', 'Sources', 'ReplyField.swift'), 'utf8');
  assert.match(reply, /\.nonactivatingPanel/, 'never brings Echo forward');
  assert.match(reply, /insertNewline[\s\S]{0,200}onSend\?\(text\)/, 'Enter sends');
  assert.match(reply, /cancelOperation[\s\S]{0,80}collapse\(giveBack: true\)/, 'Escape collapses and gives the keyboard back');
  const offer = reply.slice(reply.indexOf('func setAsking'), reply.indexOf('@objc private func chipClicked'));
  assert.doesNotMatch(offer, /focus\(\)|makeKey/, "an offered field doesn't take the keyboard");
  assert.match(reply, /PillMath\.replyField\(pill:/, 'placed from the pill (above it, on its screen)');
  const bar = fs.readFileSync(path.join(root, 'macos', 'Sources', 'Caption.swift'), 'utf8');
  assert.match(bar, /ReplyField\.shared\.setAsking\(b\["asks"\]/);
  assert.match(bar, /ReplyField\.shared\.follow\(pill: pill/, 'it follows the pill');
  const driver = fs.readFileSync(path.join(root, 'macos', 'Sources', 'Driver.swift'), 'utf8');
  assert.match(driver, /captionSend\?\.\(/);
});

test('the caption bar is always on (no setting), and the Mac app draws it click-through on every Space', () => {
  assert.equal(getSettings().captionBar, true);
  // Switched from the menu bar menu (Show Caption), so it is a saved setting.
  assert.equal(saveSettings({ captionBar: false }).captionBar, false);
  saveSettings({ captionBar: true });
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="setCaption"/);
  const app = pageSource();
  assert.match(app, /caption\.update\(\{ user: /, 'the live transcript');
  assert.match(app, /caption\.update\(\{ echo: item\.text \}\)/, "Echo's current line");
  assert.match(app, /captionStop:/);
  const bar = fs.readFileSync(path.join(root, 'macos', 'Sources', 'Caption.swift'), 'utf8');
  assert.match(bar, /\.nonactivatingPanel/, 'never takes focus');
  assert.match(bar, /\.canJoinAllSpaces, \.fullScreenAuxiliary/, 'every Space, full-screen apps too');
  assert.match(bar, /ignoresMouseEvents = true/, 'click-through');
  assert.match(bar, /PillMath\.frame\(/, 'moves out of the way');
  assert.match(bar, /FirstClickButton/, 'Stop works on the first click without taking focus');
  const art = fs.readFileSync(path.join(root, 'macos', 'Sources', 'PillArt.swift'), 'utf8');
  assert.match(art, /MarkArt\.glass\.cg\(0\.86\)/, 'near-black glass');
  assert.match(art, /RGB\.white\.cg\(MarkArt\.hairline\)/, 'a hairline white border');
  const driver = fs.readFileSync(path.join(root, 'macos', 'Sources', 'Driver.swift'), 'utf8');
  assert.match(driver, /case "caption":/);
  assert.match(driver, /CaptionBar\.shared\.avoid\(f\)/);
});

test('the island: black and white under the menu bar, the pearl alive at its left, a card when Echo needs an OK', () => {
  const swift = (f) => fs.readFileSync(path.join(root, 'macos', 'Sources', f), 'utf8');
  const bar = swift('Caption.swift'), art = swift('PillArt.swift'), mark = swift('Companion.swift'), math = swift('PointMath.swift');
  // Where it sits: top centre of the screen you are on, never over the menu bar or beside a notch.
  assert.match(math, /y: visible\.maxY - top - h/, 'just under the menu bar');
  assert.match(bar, /PillMath\.usable\(visible: s\.visibleFrame, screen: s\.frame, safeTop: s\.safeAreaInsets\.top\)/);
  assert.match(bar, /ScreenLook\.screen\(for: FrontApp\.target\(\)\)/, 'on the screen with your focus');
  // The look: no colour anywhere in the island's drawing or the overlays but the answer's gradient (the pearl's rim).
  for (const f of ['PillArt.swift', 'Caption.swift', 'Overlays.swift', 'ReplyField.swift']) {
    assert.doesNotMatch(swift(f), /honey|amber|coral|tangerine|Sunset\./, `${f}: black, white and grey only`);
  }
  assert.doesNotMatch(swift('Pointer.swift').replace(/enum Sunset \{[^}]*\}/, ''), /honey|amber|coral|tangerine|Sunset\./, 'the pointer too');
  assert.match(mark, /static let answer = \[RGB\(r: 71, g: 128, b: 255\), RGB\(r: 168, g: 102, b: 255\), RGB\(r: 255, g: 102, b: 158\), RGB\(r: 255, g: 184, b: 102\)\]/, 'the answer gradient: #4780FF, #A866FF, #FF669E, #FFB866');
  assert.match(math, /static let corner: CGFloat = 22/);
  assert.match(art, /static let text = font\(14\.5, \.regular\)/);
  // The pearl sits at the island's left end and follows the voice level the app is already given.
  assert.match(art, /pearl\.draw\(in: ctx, at: PillMath\.slotCenter\(r\)/);
  assert.match(math, /static let padLeft: CGFloat = 7,[^\n]*\n[^\n]*\n  static let mark: CGFloat = 32/, '32 pt, with 7 pt of glass all round it');
  assert.match(swift('Pointer.swift'), /CaptionBar\.shared\.setVoice\(voice, level: v\)/, 'the level reaches the island');
  assert.match(mark, /PearlMath\.pose\(mood, level: level, age: now - moodAt, t: now/);
  assert.doesNotMatch(mark + math, /MarkMath|final class MarkArt/, 'the three bars are the logo now, not the presence');
  // What it says while Echo works on the Mac.
  assert.match(bar, /PillMath\.working\(app: driving \? PillMath\.app\(fromStatus: pageStatus\) : "", step: StepMath\.counter\(step: step, of: steps\), what: doing \?\? ""\)/);
  // The card: the page's confirm and question as before, plus an optional detail and button labels.
  for (const key of ['detail', 'action', 'cancel']) assert.match(bar, new RegExp(`${key} = PillMath\\.clean\\(b\\["${key}"\\] as\\? String\\)`), key);
  assert.match(bar, /action: action\.isEmpty \? "Yes" : action, cancel: cancel\.isEmpty \? "Cancel" : cancel/, 'today\'s page (no labels) still gets two buttons');
  assert.match(bar, /@objc private func yesClicked\(\) \{ onConfirm\?\(true\) \}/);
  assert.match(bar, /@objc private func noClicked\(\) \{ onConfirm\?\(false\) \}/);
  assert.match(art, /PillMath\.card\(questionLines: t\.question\.count, detailLines: t\.detail\.count/, 'laid out by the pure function');
  // The eyes are back (the owner missed them): the pearl draws them from one pure function.
  assert.match(mark, /let eyes = PearlMath\.eyes\(radius: R, open: pose\.open, blink: blink, happy: pose\.happy, look: pose\.look\)/);
  assert.doesNotMatch(mark, /drawEyes|ripples|drop\(/, 'the old orb\'s drawing stays gone');
});

test('idle, the pill gets no text and closes to the orb; its words are drawn above the glass', async () => {
  const posts = [];
  const feed = createCaptionFeed({ post: (m) => posts.push(m), throttleMs: 0 });
  feed.update({ busy: true, user: '  \n ', echo: '\t' });
  assert.equal(posts.at(-1)?.user, '', 'blank words are no words');
  assert.equal(posts.at(-1)?.echo, '');
  feed.update({ busy: false });
  const idle = posts.at(-1);
  assert.equal(idle?.active, false, 'nothing going on: the app hides it');
  assert.equal(idle?.status, '', 'no stale status holds it open');
  const bar = fs.readFileSync(path.join(root, 'macos', 'Sources', 'Caption.swift'), 'utf8');
  // The live bug: a bare CALayer added to the root view's layer ended up under the blur, so the
  // pill was an empty tinted bar that never showed any words.
  assert.doesNotMatch(bar, /root\.layer\?\.addSublayer/, 'no raw sublayer beside the views');
  assert.match(bar, /root\.addSubview\(pillView, positioned: \.above, relativeTo: glass\)/, 'the drawing is a subview above the glass');
  assert.match(bar, /recompose\(force: true\)/, 'the first show sizes the pill even with nothing to say');
  assert.match(bar, /PillMath\.clean\(b\["status"\]/, 'blank status is no text');
});

test("the caption feed carries Echo's word timings, and a new line starts without them", async () => {
  const { captionTimes } = await import('../public/caption.js');
  assert.equal(captionTimes(null, 1000), null);
  assert.equal(captionTimes([], 1000), null);
  assert.deepEqual(captionTimes([{ s: 0 }, { s: 0.3141 }, { s: -1 }], 1000.4), { at: 1000, starts: [0, 314, 0] });
  const posts = [];
  const feed = createCaptionFeed({ post: (m) => posts.push(m), throttleMs: 0 });
  feed.update({ speaking: true, echo: 'Sure. I will write to Priya.' });
  assert.equal(posts.at(-1)?.echoTimes, undefined, 'no timings until the voice has them');
  const times = captionTimes([{ s: 0 }, { s: 0.4 }, { s: 0.6 }, { s: 0.9 }, { s: 1.1 }, { s: 1.3 }], 5000);
  feed.update({ echoTimes: times });
  assert.deepEqual(posts.at(-1)?.echoTimes, times);
  feed.update({ echo: 'Sure. I will write to Priya.' });
  assert.deepEqual(feed.state.echoTimes, times, 'the same line keeps them');
  feed.update({ echo: 'Done.' });
  assert.equal(feed.state.echoTimes, null, 'a new line drops the old timings');
  assert.equal(posts.at(-1)?.echoTimes, undefined);
  const app = pageSource();
  assert.match(app, /caption\.update\(\{ echoTimes: captionTimes\(times \|\| estimateTimings/, 'from the voice, or an estimate at its real length');
  assert.match(app, /u\.onstart = \(\) => \{\n\s+voiceStarted\(item\.trace, Date\.now\(\)\);\n\s+caption\.update\(\{ echoTimes:/, 'the browser voice gets an estimate');
});

test('each action tells the Mac app its step number and the expected total, for the pill', async () => {
  const { stepCounter } = await import('../lib/computer.js');
  const run = { steps: 0, total: 0 };
  assert.deepEqual(stepCounter(run, undefined, 20), { stepNo: 1, stepsOf: 0 }, 'no guess: no total');
  assert.deepEqual(stepCounter(run, 3, 20), { stepNo: 1, stepsOf: 3 });
  run.steps = 1;
  assert.deepEqual(stepCounter(run, undefined, 20), { stepNo: 2, stepsOf: 3 }, 'the guess carries on');
  run.steps = 3;
  assert.deepEqual(stepCounter(run, undefined, 20), { stepNo: 4, stepsOf: 4 }, 'a short guess grows, never "4 of 3"');
  assert.deepEqual(stepCounter(run, 99, 20), { stepNo: 4, stepsOf: 20 }, 'capped at the step limit');
  assert.deepEqual(stepCounter({ steps: 0, total: 0 }, 'x', 20), { stepNo: 1, stepsOf: 0 }, 'nonsense is ignored');
});
