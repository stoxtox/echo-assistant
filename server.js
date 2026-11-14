import { migrateLegacyLog, LOG } from './lib/legacy.js'; // first: VOICEOPS_* settings still work
import { fromBroadcast as conversationLog } from './lib/transcript.ts';
import { recentTerms } from './lib/recentterms.js';
import { secondListenOn } from './lib/secondlisten.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { config, APP_DIR } from './lib/config.js';
import { TaskManager } from './lib/tasks.js';
import { ApprovalRelay } from './lib/approvals.js';
import { Dispatcher, QUIET_MODE_LINE } from './lib/dispatcher.js';
import { modeLine, shouldRest, onlyDidntCatch, UNCLEAR_RESTS_AFTER } from './lib/listenmode.js';
import { quickReplies } from './lib/quickreplies.js';
import { heardNote } from './lib/heardreport.js';
import { warmUp, prewarmPhrases, voiceBudget } from './lib/voice.js';
import { WHY as VOICE_WHY } from './lib/voicebudget.js';
import { getSettings, saveSettings, markFirstRun } from './lib/settings.js';
import { wipePersonalData } from './lib/onboarding.js';
import { SelfImprove, audit } from './lib/selfimprove.js';
import { QuickActions } from './lib/quick.js';
import { nowString, friendlyError } from './lib/text.js';
import { addCost, backfillWorkerCosts } from './lib/costs.js';
import { resolveEngine, startWhisper } from './lib/stt.js';
import { bodyToken, tokenOk } from './lib/bodylink.ts';
import { record as timeline, ingest as timelineIngest } from './lib/timeline.ts';
import { pruneDroppedWords } from './lib/droplog.js';
import { dropRetiredCorrections } from './lib/vocab.js';
import { ScreenBridge, sweepScreenShots } from './lib/screen.js';
import { Updater } from './lib/updater.js';
import { ClaudeAuth } from './lib/claudeauth.js';
import { TAKE_OVER_LINE } from './lib/computer.js';
import { Sheets } from './lib/sheets.js';
import { pairingCode, extensionRefusal } from './lib/browser.js';
import { xdToken, xdRefusal } from './lib/xd.js';
import { sendJson, originOk, serveStatic } from './lib/server/http.js';
import { speechIntake } from './lib/server/speech.js';
import { apiHandler } from './lib/server/routes.js';
import { quitAfter } from './lib/server/quit.js';
import { pageConnection, slimTask } from './lib/server/window.js';
import { voice } from './lib/voicestate.js';

const RESTART_CODE = 75;
// A fresh install (or one just reset) opens with the setup wizard, and its projects folder exists.
markFirstRun();
if (!fs.existsSync(config.roots[0])) fs.mkdirSync(config.roots[0], { recursive: true });
const tasks = new TaskManager();
const selfImprove = new SelfImprove(tasks);
const quick = new QuickActions();
const screen = new ScreenBridge();
const dispatcher = new Dispatcher(tasks, selfImprove, quick, screen);
const computer = dispatcher.computer;
// Excel and Numbers through their own scripting (lib/sheets.js), on the AppleScript runner the quick actions use.
computer.sheets = new Sheets({ run: (script, args, opts) => quick.osa(script, args, opts), escape: (app) => computer.sheetEscape(app) });
// Mistaken learned corrections from earlier versions go (lib/vocab.js RETIRED_CORRECTIONS).
for (const id of dropRetiredCorrections()) console.log(`[vocab] dropped the retired correction ${id}`);
let restarting = false;
backfillWorkerCosts(tasks.list());
const updater = new Updater({
  getSettings,
  restart: (reason) => gracefulRestart(reason),
  isBusy: () => tasks.list().some((t) => tasks.isLive(t.id) || t.status === 'queued'),
});
updater.on('status', (status) => broadcast({ type: 'update', status }));
const claudeAuth = new ClaudeAuth();

/* ---------- the page's WebSocket, and telling every page ---------- */
const wss = new WebSocketServer({ noServer: true, verifyClient: ({ req }) => originOk(req) });
const broadcast = (msg) => {
  // What is said to and by Echo, word for word, for reading a session back (lib/transcript.ts).
  conversationLog(msg, () => replyBuf.trim());
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
};
const broadcastSelf = () => broadcast({ type: 'self_status', status: selfImprove.status() });
const slim = (t) => slimTask(tasks, t);

/* ---------- listening (lib/server/speech.js) and the API (lib/server/routes.js) ---------- */
/**
 * The one listening state (lib/listenmode.js): kept as a setting, and every page and the Mac app
 * are told when it changes and why ("you said my name", "three quiet minutes").
 * @param {'listening' | 'resting' | 'off'} mode @param {string} [why]
 */
function setListenMode(mode, why = '') {
  if (getSettings().listenMode === mode) return false;
  const next = saveSettings({ listenMode: mode });
  timeline('server', 'listen.mode', { mode, why });
  broadcast({ type: 'settings', settings: { listenMode: next.listenMode } });
  broadcast({ type: 'listen_mode', mode, why, line: modeLine(mode, why) });
  return true;
}
const speech = speechIntake({ dispatcher, quick, screen, broadcast, setListenMode });
// Listening rests by itself after three quiet minutes (never in the middle of a job, a reply or a question).
// The three minutes count from when it last began to listen, however that came about.
let listenSince = Date.now(), listenWas = getSettings().listenMode;
setInterval(() => {
  if (getSettings().listenMode !== listenWas) { listenWas = getSettings().listenMode; listenSince = Date.now(); }
  const lastAt = Math.max(dispatcher.lastUserAt || 0, dispatcher.lastSpokeAt || 0, dispatcher.lastSpeechEnd || 0, listenSince);
  if (shouldRest({ mode: getSettings().listenMode, now: Date.now(), lastAt, busy: dispatcher.busy, working: computer.driving && dispatcher.busy, waiting: computer.pending.size > 0 || quick.pendingList().length > 0 || Boolean(computer.lesson?.active) || Boolean(computer.play) })) setListenMode('resting', 'quiet');
}, 15 * 1000).unref();

const { logConvo, handleUtterance } = speech;
/** A task or Mac event for the assistant, also kept in the conversation log. */
const notifyTask = (t, textIn, opts = {}) => {
  logConvo('Event', textIn);
  dispatcher.notify(textIn, opts);
};
const api = apiHandler({ tasks, selfImprove, quick, screen, dispatcher, computer, updater, claudeAuth, speech, broadcast, broadcastSelf, prewarmVoice, gracefulRestart, resetAndRestart, shutDown: quit, isRestarting: () => restarting });

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => {
      console.error('[api]', e.message);
      if (!res.headersSent) sendJson(res, { error: e.message }, 400);
    });
    return;
  }
  serveStatic(res, url);
});
// The Echo Chrome extension (extension/, lib/browser.js) connects on its own path, with its
// pairing code; only a Chrome extension's origin gets in, never a web page.
const browserWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
browserWss.on('connection', (ws) => dispatcher.browser.extension?.attach(ws));
dispatcher.browser.extension?.on('status', (st) => broadcast({ type: 'browser', ...st }));
// Connected, dropped, turned away: on the timeline, so "the extension never connected" can be told
// from "it kept being refused" or "it dropped when Echo restarted" after the fact.
dispatcher.browser.extension?.on('link', (e) => timeline('server', `browser.${e.event}`, e.why ? { why: String(e.why).slice(0, 60) } : {}));
// The Echo panel in Adobe XD (integrations/xd-bridge, lib/xd.js) on its own path, with its token.
const xdWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
xdWss.on('connection', (ws) => dispatcher.xd.attach(ws));
xdToken(); // made now, so the file is there to copy into the panel before XD ever connects
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url || '/', 'http://localhost');
  if (pathname === '/ws/body') {
    // The Mac app's own line: only with the token from data/self/body-token, and never a web page.
    if (req.headers.origin || !tokenOk(searchParams.get('token'), bodyToken())) {
      // On the timeline (lib/timeline.ts), so "Echo has no hands" can be told from "the app never tried".
      timeline('server', 'body.refused', { reason: req.headers.origin ? 'origin' : 'token' });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    bodyWss.handleUpgrade(req, socket, head, (ws) => bodyWss.emit('connection', ws, req));
    return;
  }
  if (pathname === '/ws/browser') {
    const refusal = extensionRefusal({ origin: req.headers.origin, url: req.url }, pairingCode());
    if (refusal) {
      // Remembered, so "not connected" can say the code was wrong rather than guess.
      dispatcher.browser.extension?.refused(refusal);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit('connection', ws, req));
    return;
  }
  if (pathname === '/ws/xd') {
    // Only the plugin: the token from data/self/xd-token, and never a web page (anything with an Origin).
    const refusal = xdRefusal({ origin: req.headers.origin, url: req.url }, xdToken());
    if (refusal) {
      dispatcher.xd.refused(refusal);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    xdWss.handleUpgrade(req, socket, head, (ws) => xdWss.emit('connection', ws, req));
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});


// Screen looks and pointing go to the Mac app's page when it's open (it can capture on its own);
// otherwise every page shows a "share your screen" card (lib/screen.js).
const nativePages = new Set();
screen.nativeClients = () => [...nativePages].filter((c) => c.readyState === 1).length + bodyClients().length;
/** The Mac app's own lines to the server (/ws/body, lib/bodylink.ts): requests go straight to it. */
const bodyWss = new WebSocketServer({ noServer: true });
const bodyClients = () => [...bodyWss.clients].filter((c) => c.readyState === 1);
// When the line came up and went (how long it lasted), and what the app noted meanwhile: key
// presses, the mic opening, speech starting and ending (lib/timeline.ts decides what is kept).
bodyWss.on('connection', (ws) => {
  const since = Date.now();
  timeline('server', 'body.connect');
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type === 'tl') timelineIngest('app', msg.events);
    } catch {}
  });
  ws.on('close', (code) => timeline('server', 'body.drop', { code, ms: Date.now() - since }));
});
screen.on('request', (r) => {
  const data = JSON.stringify({ type: 'screen_request', ...r });
  // Straight to the Mac app when its own line is up, and then ONLY there (so nothing runs twice);
  // otherwise through its page, as before (an older app).
  const body = r.native ? bodyClients() : [];
  if (body.length) {
    body[0].send(data);
    // The page still shows its "Looking" chip (until screen_done): told, never asked to do it.
    if (r.kind === 'look') for (const c of nativePages) if (c.readyState === 1) c.send(JSON.stringify({ type: 'screen_request', id: r.id, kind: r.kind, notice: true }));
    return;
  }
  for (const c of wss.clients) if (c.readyState === 1 && (!r.native || nativePages.has(c))) c.send(data);
});
screen.on('done', ({ id }) => broadcast({ type: 'screen_done', id }));
// The light is let go, or held to ask (docs/firefly-protocol.md): to the Mac app, the way its requests go.
screen.on('firefly', (m) => {
  const data = JSON.stringify({ type: 'firefly', ...m });
  const body = bodyClients();
  for (const c of body.length ? [body[0]] : nativePages) if (c.readyState === 1) c.send(data);
});
wss.on('connection', pageConnection({ voice, tasks, selfImprove, quick, screen, dispatcher, computer, updater, speech, broadcast, notifyTask, nativePages }));

/* ---------- wiring ---------- */
let replyBuf = '';
dispatcher.on('say', (text, { speak = text, trace = undefined } = {}) => {
  logConvo('Assistant', text);
  // speak: what's said out loud, when it isn't the text as written.
  // id: the line's name for the voice tracker (lib/voicestate.js): the page says when it starts and ends.
  broadcast({ type: 'say', id: voice.line(speak), text, ...(speak !== text ? { speak } : {}), ...(trace && { trace }) });
});
dispatcher.on('say_start', () => {
  replyBuf = '';
  broadcast({ type: 'say_start' });
});
dispatcher.on('say_delta', (text) => {
  replyBuf += text;
  broadcast({ type: 'say_delta', text });
});
dispatcher.on('say_end', () => {
  if (replyBuf.trim()) logConvo('Assistant', replyBuf.trim());
  // The names in it are what the user is likely to say next (lib/recentterms.js).
  recentTerms.noteReply(replyBuf);
  broadcast({ type: 'say_end' });
});
// `prev`: the piece of the same reply spoken just before, so the voice carries its intonation on.
// `id`: the line's name for the voice tracker; whoever waits for the line to end gave it one already (lib/computer.js speak).
// The lines of the reply being spoken, by their voice ids: at the user's next message the assistant
// is told which of them were never heard (lib/heardreport.js).
/** @type {{ trace: string, lines: Array<{ id: string, text: string }> }} */
let spokenReply = { trace: '', lines: [] };
dispatcher.on('speak', (text, { prev = '', trace = undefined, id = voice.line(text) } = {}) => {
  if (String(trace || '') !== spokenReply.trace) spokenReply = { trace: String(trace || ''), lines: [] };
  spokenReply.lines.push({ id, text: String(text) });
  broadcast({ type: 'speak', id, text, ...(prev && { prev }), ...(trace && { trace }) });
});
dispatcher.heardReport = () => {
  const lines = spokenReply.lines.map((l) => ({ text: l.text, fate: voice.fate(l.id) }));
  spokenReply = { trace: '', lines: [] };
  return voice.silent ? '' : heardNote(lines);
};
dispatcher.on('activity', (text) => broadcast({ type: 'activity', text }));
// The reply ended waiting for an answer: the page listens for it briefly (public/autolisten.js).
// A reply that ends on a question with a small set of answers carries them as chips (lib/quickreplies.js),
// for when the user is typing. Never while a card waits for a yes: that has its own buttons.
// Two replies in a row that only say "I didn't catch that": Echo is hearing something that is not
// for it, so it rests until its name (lib/listenmode.js).
let unclearRun = 0;
dispatcher.on('reply_end', ({ awaitsReply }) => {
  unclearRun = onlyDidntCatch(dispatcher.lastReply) ? unclearRun + 1 : 0;
  if (unclearRun >= UNCLEAR_RESTS_AFTER && getSettings().listenMode === 'listening') {
    unclearRun = 0;
    setListenMode('resting', 'unclear');
  }
  const chips = awaitsReply && !computer.pending.size && !quick.pendingList().length ? quickReplies(dispatcher.lastReply) : [];
  broadcast({ type: 'reply_end', awaitsReply, ...(chips.length ? { chips } : {}) });
});
// "Stop" while Echo drives: she stops talking too.
dispatcher.on('thinking', () => broadcast({ type: 'thinking' }));
dispatcher.on('hush', () => broadcast({ type: 'hush' }));
// The assistant decided a sentence wasn't for Echo and stayed quiet: the page shows it, like any other drop.
dispatcher.on('dropped', ({ reason, trace }) => broadcast({ type: 'dropped', reason, ...(trace && { trace }) }));
dispatcher.on('busy', (busy) => broadcast({ type: 'busy', busy }));
dispatcher.on('cost', (usd) => broadcast({ type: 'costs', costs: addCost('dispatcher', usd) }));
tasks.on('cost', (t, usd) => broadcast({ type: 'costs', costs: addCost('workers', usd) }));
dispatcher.on('error', (e) => {
  console.error('[dispatcher]', e.message);
  const plain = friendlyError(e.message);
  broadcast({ type: 'error', text: plain === e.message ? `Assistant error: ${e.message}` : plain });
});

tasks.on('update', (t) => broadcast({ type: 'task', task: slim(t) }));
tasks.on('log', (t, entry) => broadcast({ type: 'task_log', taskId: t.id, entry }));
// Approvals are relayed after a short pause, grouped, and only if still unanswered (lib/approvals.js).
// Answering one in the window sends nothing to the assistant.
new ApprovalRelay(tasks, (textIn, opts) => {
  logConvo('Event', textIn);
  dispatcher.notify(textIn, opts);
});
// Compact "task update" cards in the chat (approvals get Approve / Deny right on the card).
const firstSentence = (s) => (String(s || '').replace(/\s+/g, ' ').trim().match(/^.{1,160}?[.!?](?=\s|$)/)?.[0] || String(s || '').trim().slice(0, 160));
const taskCard = (t, kind, extra = {}) =>
  broadcast({ type: 'task_event', event: { kind, taskId: t.id, title: t.title, where: t.kind === 'research' ? 'Research' : t.kind === 'self' ? 'Echo' : t.project, at: new Date().toISOString(), ...extra } });
tasks.on('approval', (t) => {
  const a = t.pendingApproval;
  if (a) taskCard(t, 'approval', { approvalId: a.id, level: a.level, text: a.reason });
});
tasks.on('finished', (t) => {
  if (t.kind !== 'self') taskCard(t, t.status, { text: firstSentence(t.summary) || (t.status === 'done' ? 'Finished.' : 'Stopped with an error.') });
});
tasks.on('stopped', (t) => taskCard(t, 'stopped', { text: t.overBudget ? 'Stopped at its cost limit.' : 'Stopped.' }));
// A task stopped at its cost limit (Settings): the user decides whether it goes on.
tasks.on('budget', (t, limit) => notifyTask(t, `Task ${t.id} (${t.project}) stopped at the $${limit} limit for one task (Settings → Account & AI). Tell the user in a sentence and ask whether to continue it (follow_up goes on from where it stopped).`));
// A worker's temporary screenshot goes as soon as its task ends (lib/screen.js).
tasks.on('finished', (t) => screen.releaseTask(t.id));
tasks.on('stopped', (t) => screen.releaseTask(t.id));
tasks.on('approval_resolved', (t, r) => broadcast({ type: 'approval_resolved', taskId: t.id, approvalId: r.id, allowed: r.allowed, by: r.by }));
tasks.on('finished', (t) => {
  if (t.kind === 'self') return; // announced once the review is ready
  const files = tasks.outputFiles(t).slice(0, 5).map((f) => f.file);
  notifyTask(
    t,
    `Task ${t.id} (${t.project}) ${t.status === 'done' ? 'finished' : 'failed'}. Spoken summary: ${t.summary}` +
      (files.length ? ` Saved files: ${files.join(', ')}.` : '') +
      ' Full details are available with get_task.',
    // Just for the user's information: with the policy flag it waits for a natural moment.
    { fyi: true },
  );
});

quick.on('confirm_request', (request) => broadcast({ type: 'message_confirm', request }));

// Lessons and computer use (lib/computer.js).
computer.on('state', (st) => {
  // The app Echo is working in has words of its own to expect ("pivot table" in Excel).
  recentTerms.setApp(st.app || '');
  broadcast({ type: 'computer_state', ...st });
});
// The critic's model calls (lib/agent/critic.js) count with the assistant's.
computer.on('cost', (usd) => broadcast({ type: 'costs', costs: addCost('assistant', usd) }));
computer.on('lesson_card', (c) => broadcast({ type: 'lesson_card', ...c }));
// An explanation on screen moved on (lib/explain.js): its one card in the chat follows.
computer.on('explain_card', (c) => broadcast({ type: 'explain_card', ...c }));
computer.on('confirm_request', (request) => broadcast({ type: 'computer_confirm', request }));
computer.on('undo_offer', (offer) => broadcast({ type: 'undo_offer', offer }));
computer.on('undo_done', (r) => broadcast({ type: 'undo_done', ...r }));
computer.on('confirm_resolved', (r) => {
  broadcast({ type: 'computer_resolved', ...r });
  if (r.by === 'window' && !r.allowed) notifyTask(null, `The user cancelled "${r.what}" in the window. Don't do it.`);
});
// Play-along (lib/computer.js playAlong): the user clicked in the game, so Echo looks and takes
// its turn. One call waits at a time, and it is dropped if the game ended meanwhile.
computer.on('play_move', async ({ what, retry }) => {
  // The board is looked at here and sent along, so Echo's move is one call, not a look and then a move.
  const board = await computer.playSnapshot();
  if (!computer.play) return;
  dispatcher.notify(
    board
      ? `[play-along] ${retry ? `The user clicked while you were making your move in ${what}, so your move may not have gone in` : `The user just clicked in ${what}: probably their move`}. The board as it is right now is shown with this message (its text and its picture), so do NOT look again: act from it. If it is your turn, take it with ONE action and say a few words at most about your own move, or nothing. If nothing changed, or it is still their turn, stay quiet as for an event that needs no word. If the game is over, say the result in one line. No advice, no hints about your plan, and never ask them to say or type anything.`
      : `[play-along] ${retry ? `The user clicked while you were making your move in ${what}, so your move may not have gone in` : `The user just clicked in ${what}: probably their move`}. Look once (look_at_screen, with the picture if the board has no labels). If it is your turn, take it with ONE action and say a few words at most about your own move, or nothing. If nothing changed, or it is still their turn, stay quiet as for an event that needs no word. If the game is over, say the result in one line. No advice, no hints about your plan, and never ask them to say or type anything.`,
    { key: 'play', ttlMs: 60 * 1000, isStale: () => !computer.play, onStart: () => computer.playTurn(), ...(board ? { blocks: board } : {}) },
  );
});
dispatcher.on('show_sky', (play) => broadcast({ type: 'show_sky', play: play === true }));
// A watch began or ended: the Mac app parks a small light on that window, or takes it away.
dispatcher.on('watch_light', (w) => broadcast({ type: 'watch_light', id: String(w.id), app: String(w.app).slice(0, 60), on: w.on === true, done: w.done === true }));
dispatcher.on('pin_note', (text) => broadcast({ type: 'pin_note', text: String(text).slice(0, 160) }));
dispatcher.on('quiet_mode', (on) => {
  // Quiet mode: the pages speak nothing (and stop what they were saying), and no step waits for a voice.
  voice.silent = on;
  if (on) broadcast({ type: 'hush' });
  broadcast({ type: 'quiet_mode', on, ...(on ? { text: QUIET_MODE_LINE } : {}) });
});
computer.on('paused', (e) => {
  // Playing along, their click was a move: the step is tried again by itself, and nothing is said.
  if (e?.play) return;
  // She stops talking about the step, says so in three words, and listens for what's next.
  broadcast({ type: 'hush' });
  broadcast({ type: 'speak', id: voice.line(TAKE_OVER_LINE), text: TAKE_OVER_LINE });
  logConvo('Assistant', TAKE_OVER_LINE);
});
computer.on('aborted', ({ reason }) => {
  broadcast({ type: 'computer_state', driving: false, aborted: true, reason });
  // They stopped it themselves (said stop, Esc, the window's Stop, Settings): nothing to tell them,
  // so no turn and no "okay, I've stopped". The assistant hears it with their next message.
  logConvo('Event', `Echo stopped using the computer (${reason}).`);
  dispatcher.noteForNext(`(Echo stopped using the computer because the user stopped it (${reason}). Don't carry on with it unless they ask again.)`);
});
quick.on('confirm_resolved', (r) => {
  broadcast({ type: 'message_resolved', ...r });
  if (r.by === 'voice') return; // the assistant already knows
  const what = r.sent ? `was handed to Messages (${r.delivery || "sent; delivery can't be checked from here"})` : r.error ? `failed to send: ${r.error}` : r.by === 'expired' ? 'expired unanswered and was not sent' : 'was cancelled in the window, not sent';
  notifyTask(null, `The message to ${r.to} (${r.masked}) ${what}.${r.sent ? ' Say that in a few words; only "delivered" means they got it.' : ''}`);
});

selfImprove.on('unlock_request', (request) => broadcast({ type: 'self_unlock_request', request }));
selfImprove.on('status', broadcastSelf);
selfImprove.on('review', (t) => {
  broadcast({ type: 'task', task: slim(t) });
  broadcastSelf();
  const r = t.self.review;
  taskCard(t, t.self.state === 'review' ? 'review' : 'done', { text: t.self.state === 'review' ? `Ready to review: ${r.files.length} file${r.files.length === 1 ? '' : 's'} changed. Open the Workers tab to merge or discard.` : firstSentence(t.summary) });
  if (t.self.state === 'review') {
    const checks = Object.entries(r.checks).map(([k, v]) => `${k} ${v.ok ? 'passed' : 'FAILED'}`).join(', ');
    notifyTask(t, `Self-improvement task ${t.id} is ready for review in the Echo window. It changed ${r.files.length} file(s): ${r.files.slice(0, 6).join(', ')}. Checks: ${checks}. Worker summary: ${t.summary} Tell the user to review the diff and click Merge or Discard in the window.`);
  } else if (t.self.state === 'no_changes') {
    notifyTask(t, `Self-improvement task ${t.id} finished without changing any files. Worker summary: ${t.summary}`);
  } else if (t.self.state === 'error') {
    notifyTask(t, `Self-improvement task ${t.id} couldn't prepare its review: ${t.self.error}`);
  }
});

/* ---------- graceful restart ---------- */
async function gracefulRestart(reason) {
  if (restarting) return;
  restarting = true;
  audit('restart_begin', { reason });
  broadcast({ type: 'restarting', reason });
  broadcast({ type: 'say', text: "Applying the update. I'll be right back." });
  tasks.paused = true;
  const idle = await tasks.waitForIdle(60000);
  const checkpointed = idle ? [] : await tasks.checkpointAll();
  tasks.saveNow();
  audit('restart_checkpointed', { waitedForAll: idle, checkpointed });
  restartProcess();
}

/** Exit so the supervisor starts a fresh copy (or hand over to a new supervisor if there isn't one). */
function restartProcess() {
  if (process.env.ECHO_SUPERVISED) {
    // Tells the supervisor this exit is a restart even if the exit status gets lost
    // (a native module aborting during exit once turned a restart into a false rollback).
    // Exit once the message is out (or after a second, whichever comes first).
    const exit = () => process.exit(RESTART_CODE);
    setTimeout(exit, 1000);
    if (process.send) process.send({ type: 'restart' }, undefined, {}, exit);
    else exit();
    return;
  }
  // Started without the supervisor (e.g. plain `node server.js`): hand over to one.
  const out = fs.openSync(path.join(config.logDir, LOG), 'a');
  spawn(process.execPath, ['supervisor.js'], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ECHO_WAIT_PORT_FREE: '1' },
  }).unref();
  process.exit(0);
}

/* ---------- Reset Echo: wipe personal data, start over with setup ---------- */
async function resetAndRestart() {
  if (restarting) return;
  restarting = true;
  broadcast({ type: 'resetting' });
  tasks.paused = true;
  const live = tasks.list().filter((t) => tasks.isLive(t.id) || t.status === 'queued');
  await Promise.allSettled(live.map((t) => tasks.stop(t.id)));
  dispatcher.input?.close();
  dispatcher.q?.close?.();
  // Let pending saves land first, so nothing is written back after the wipe.
  await new Promise((r) => setTimeout(r, 400));
  clearTimeout(tasks.saveTimer);
  const wiped = wipePersonalData();
  console.log(`[reset] removed ${wiped.data} data item(s), ${wiped.logs} log(s), ${wiped.attachments} attachment(s), ${wiped.transcripts} Claude transcript(s)`);
  fs.mkdirSync(config.logDir, { recursive: true });
  restartProcess();
}

// Ctrl+C or a kill: pause running tasks so they resume on the next start.
async function shutdown(signal) {
  if (restarting) return;
  restarting = true;
  const checkpointed = await tasks.checkpointAll();
  if (checkpointed.length) console.log(`[echo] paused tasks ${checkpointed.join(', ')}; they'll resume on the next start`);
  process.exit(signal === 'SIGINT' ? 130 : 0);
}
/**
 * Quit Echo in the Mac app (POST /api/shutdown): pause running tasks like a kill does, then stop
 * for good. The app has already been told "ok", so nothing may stop this: not a restart that is
 * under way (Echo came back instead of quitting), not a task that can't be paused.
 */
async function quit() {
  restarting = true;
  await quitAfter(async () => {
    const checkpointed = await tasks.checkpointAll();
    if (checkpointed.length) console.log(`[echo] quit: paused tasks ${checkpointed.join(', ')}; they'll resume on the next start`);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/** Fixed lines Echo says (taking over), rendered ahead in the chosen voice so they play instantly. */
function prewarmVoice(s = getSettings()) {
  // With a premium voice, Kokoro is the backup, so its voice is the one to have ready.
  const voice = s.ttsProvider === 'kokoro' ? s.voice : ['elevenlabs', 'cartesia'].includes(s.ttsProvider) ? s.fallbackVoice : null;
  if (!voice) return;
  prewarmPhrases([TAKE_OVER_LINE], { voice, speed: s.speed }).catch(() => {});
}

/**
 * The premium voice ran out of free characters (or came back): Settings updates, and the
 * assistant mentions it once. Failures and a refused key show in Settings without a mention,
 * except a refused key, which you'd need to fix.
 */
voiceBudget.onChange = (provider, { why, prevWhy, until }) => {
  broadcast({ type: 'voiceBudget', budget: voiceBudget.status() });
  if (getSettings().ttsProvider !== provider) return;
  const name = provider === 'elevenlabs' ? 'ElevenLabs' : 'Cartesia';
  const when = until ? new Date(until).toLocaleString('en-US', { timeZone: config.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  if (why === 'free_used_up' || why === 'quota') {
    dispatcher.notify(`The premium voice (${name}) has used up its free characters for this period, so you're now speaking with the free local voice (Kokoro)${when ? ` until about ${when}, when they come back` : ''}. Nothing is being charged. Mention this briefly when the user is next around.`);
  } else if (why === 'bad_key') {
    dispatcher.notify(`The premium voice (${name}) refused its API key, so you're speaking with the free local voice (Kokoro). The key in the .env file may be wrong or revoked. Mention this briefly.`);
  } else if (!why && (prevWhy === 'free_used_up' || prevWhy === 'quota')) {
    dispatcher.notify(`The premium voice (${name}) has its free characters again, so you're speaking with it again. Mention it briefly if it comes up.`);
  }
  console.log(`[voice] ${provider} ${why ? `resting: ${VOICE_WHY[why] || why}` : 'back'}`);
};

/* ---------- startup ---------- */
/**
 * Start listening. Run as a program (node server.js, the supervisor) it starts by itself with
 * everything; a test imports server.js and calls start({ port: 0, boot: false }): a free port,
 * and no Whisper, voice, task resumes or update checks (lib's own tests cover those).
 * @param {{ port?: number, boot?: boolean }} [o]
 * @returns {Promise<number>} the port it listens on
 */
export function start({ port = config.port, boot = true } = {}) {
  // The token the Mac app's own line presents (lib/bodylink.ts): there before it connects.
  bodyToken();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (boot) bootUp();
      else dispatcher.start();
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

/** Stop a server a test started: no new connections, the assistant's session closed. */
export async function stop() {
  for (const c of wss.clients) c.terminate();
  for (const c of bodyWss.clients) c.terminate();
  for (const c of browserWss.clients) c.terminate();
  for (const c of xdWss.clients) c.terminate();
  dispatcher.input?.close();
  await new Promise((r) => server.close(() => r(undefined)));
}

/** Everything a full start does once Echo is listening. */
function bootUp() {
  migrateLegacyLog(config.logDir);
  dispatcher.start();
  warmUp();
  const s = getSettings();
  prewarmVoice(s);
  // (Also when Apple's recognizer is the one in use: Whisper gives each sentence a second listen.)
  if (resolveEngine(s.sttEngine) === 'whisper' || secondListenOn(s)) startWhisper().then(() => console.log('[stt] local Whisper ready')).catch((e) => console.error('[stt]', e.message));
  tasks.backfillTitles();
  // Temporary screenshots left over from before (a crash, or past their time) are deleted.
  sweepScreenShots();
  setInterval(() => sweepScreenShots(), 5 * 60 * 1000).unref();
  // Dropped-speech notes (debug) expire after a week, even with the setting since turned off.
  pruneDroppedWords(config.dataDir);
  setInterval(() => pruneDroppedWords(config.dataDir), 60 * 60 * 1000).unref();
  const resumed = tasks.resumeCheckpointed();
  const recent = (t) => Date.now() - Date.parse(t.updatedAt) < 24 * 3600 * 1000;
  const interrupted = tasks.list().filter((t) => t.status === 'interrupted' && recent(t) && !resumed.includes(t.id));
  const notes = [];
  if (resumed.length) notes.push(`Echo restarted and automatically resumed task(s) ${resumed.join(', ')} where they left off.`);
  if (interrupted.length) {
    notes.push(`These tasks were interrupted earlier and are not running: ${interrupted.slice(0, 5).map((t) => `task ${t.id} (${t.project}: ${t.title})`).join('; ')}. Before offering to resume, check get_task for saved output.`);
  }
  const noticeFile = path.join(config.dataDir, 'self', 'rollback-notice.json');
  if (fs.existsSync(noticeFile)) {
    const n = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
    notes.push(`The last self-update (task ${n.taskId}) ${n.why}, so Echo automatically rolled back to the previous version. Tell the user.`);
    fs.rmSync(noticeFile);
  } else if (fs.existsSync(path.join(config.dataDir, 'self', 'pending-restart.json'))) {
    notes.push('Echo just restarted with a self-update. If the user is around, tell them the update is live.');
  }
  // The supervisor confirms a release update once this process answers its health check.
  let polls = 0;
  const noticeTimer = setInterval(() => {
    const n = updater.takeNotice();
    if (n || ++polls > 60) clearInterval(noticeTimer);
    if (n?.kind === 'updated') dispatcher.notify(`Echo was updated from version ${n.from} to ${n.to}. Mention it briefly when the user is next around.`);
    else if (n?.kind === 'rolled_back') dispatcher.notify(`An update to Echo ${n.from} ${n.why}, so Echo went back to version ${n.to} automatically. Tell the user briefly.`);
    else if (n?.kind === 'went_back') dispatcher.notify(`Echo went back to version ${n.to}, as the user asked.`);
    if (n) broadcast({ type: 'update', status: updater.status(), notice: n });
  }, 2000);
  noticeTimer.unref();
  updater.startSchedule();
  if (notes.length) dispatcher.notify(notes.join(' ') + ' Mention this briefly when the user is next around.');
  console.log(`Echo running at http://localhost:${config.port}  (${nowString()}; projects from ${config.roots.join(', ')})`);
}

// Run as a program: start. Imported (a test): wait to be started.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) start();

export { server, dispatcher, tasks, computer, screen, quick, handleUtterance };
