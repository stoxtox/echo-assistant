import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { config, APP_DIR } from './lib/config.js';
import { TaskManager } from './lib/tasks.js';
import { ApprovalRelay } from './lib/approvals.js';
import { Dispatcher, openTerminal } from './lib/dispatcher.js';
import { listProjects } from './lib/projects.js';
import { synthesize, listVoices, warmUp, wordsHeader, voiceStatus } from './lib/voice.js';
import { getSettings, saveSettings, markFirstRun, PERSONALITIES } from './lib/settings.js';
import { onboardingState, saveOnboarding, wipePersonalData } from './lib/onboarding.js';
import { SelfImprove, audit } from './lib/selfimprove.js';
import { QuickActions } from './lib/quick.js';
import { nowString, friendlyError } from './lib/text.js';
import { addCost, costSummary, backfillWorkerCosts } from './lib/costs.js';
import { transcribe, engines, resolveEngine, startWhisper, sttLanguageFor } from './lib/stt.js';
import { Corrector } from './lib/correct.js';
import { loadVocab, setWords, vocabularyTerms } from './lib/vocab.js';
import { Updater } from './lib/updater.js';
import { saveAttachment, findAttachment, resolveAttachments, MAX_ATTACHMENT_BYTES } from './lib/attachments.js';

const RESTART_CODE = 75;
// A fresh install (or one just reset) opens with the setup wizard, and its projects folder exists.
markFirstRun();
if (!fs.existsSync(config.roots[0])) fs.mkdirSync(config.roots[0], { recursive: true });
const tasks = new TaskManager();
const selfImprove = new SelfImprove(tasks);
const quick = new QuickActions();
const dispatcher = new Dispatcher(tasks, selfImprove, quick);
let restarting = false;
backfillWorkerCosts(tasks.list());
const updater = new Updater({
  getSettings,
  restart: (reason) => gracefulRestart(reason),
  isBusy: () => tasks.list().some((t) => tasks.isLive(t.id) || t.status === 'queued'),
});
updater.on('status', (status) => broadcast({ type: 'update', status }));
const corrector = new Corrector();
corrector.on('cost', (usd) => broadcast({ type: 'costs', costs: addCost('assistant', usd) }));

/* ---------- conversation log (for reviewing and improving Echo) ---------- */
const convoDir = path.join(config.dataDir, 'conversations');
fs.mkdirSync(convoDir, { recursive: true });
const recent = []; // last few lines, as context for fixing mishearings
function logConvo(who, textIn) {
  if (who === 'User' || who === 'Assistant') {
    recent.push(`${who}: ${String(textIn).slice(0, 300)}`);
    if (recent.length > 8) recent.shift();
  }
  const d = new Date();
  const file = path.join(convoDir, `${d.toLocaleDateString('en-CA', { timeZone: config.timezone })}.md`);
  const time = d.toLocaleTimeString('en-US', { timeZone: config.timezone });
  fs.appendFileSync(file, `**[${time}] ${who}:** ${String(textIn).replace(/\n+/g, ' ')}\n\n`);
}

/* ---------- HTTP ---------- */
const PUBLIC = path.join(APP_DIR, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const ALLOWED_ORIGINS = new Set([`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
// Blocks other websites open in your browser from driving Echo.
const originOk = (req) => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
const readBody = (req, limit = 15 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('Upload too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
const sendJson = (res, data, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (req.method !== 'GET' && !originOk(req)) return sendJson(res, { error: 'Forbidden origin' }, 403);
  if (route.startsWith('GET /api/attachments/')) {
    const a = findAttachment(decodeURIComponent(url.pathname.slice('/api/attachments/'.length)));
    if (!a) return sendJson(res, { error: 'Not found' }, 404);
    res.writeHead(200, { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(a.path).pipe(res);
    return;
  }
  switch (route) {
    case 'POST /api/attachments': {
      // One image per request, body = the file; the page shrinks it first.
      const a = saveAttachment(await readBody(req, MAX_ATTACHMENT_BYTES + 1), req.headers['content-type']);
      return sendJson(res, { id: a.id, url: a.url, bytes: a.bytes });
    }
    case 'GET /api/health':
      return sendJson(res, { ok: !restarting && Boolean(dispatcher.input), tasks: tasks.list().length, pid: process.pid });
    case 'POST /api/tts': {
      const s = getSettings();
      const { text, provider = s.ttsProvider, voice = s.voice, speed = s.speed } = await readJson(req);
      const audio = await synthesize({ text, provider, voice, speed });
      const words = wordsHeader(audio.words);
      return res.writeHead(200, { 'Content-Type': audio.mime, 'Cache-Control': 'no-store', ...(words && { 'X-Echo-Words': words }) }).end(audio.data);
    }
    case 'GET /api/voices':
      return sendJson(res, { providers: await listVoices(), personalities: Object.entries(PERSONALITIES).map(([id, p]) => ({ id, label: p.label })) });
    case 'GET /api/settings':
      return sendJson(res, getSettings());
    case 'POST /api/settings': {
      const before = getSettings();
      // The projects folder is checked and created by setup (POST /api/onboarding).
      const { projectsDir, onboarded, ...patch } = await readJson(req);
      const next = saveSettings(patch);
      if (['assistantName', 'userName', 'personality', 'beginnerMode', 'interests'].some((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))) dispatcher.reload();
      broadcast({ type: 'settings', settings: next });
      return sendJson(res, next);
    }
    case 'GET /api/onboarding':
      return sendJson(res, onboardingState(selfImprove));
    case 'POST /api/onboarding': {
      const before = getSettings();
      const out = saveOnboarding(await readJson(req), { selfImprove });
      const next = out.settings;
      broadcast({ type: 'settings', settings: next });
      if (before.projectsDir !== next.projectsDir) broadcast({ type: 'projects', projects: listProjects() });
      if (next.onboarded && (!before.onboarded || before.projectsDir !== next.projectsDir || before.beginnerMode !== next.beginnerMode || before.userName !== next.userName)) dispatcher.reload();
      broadcastSelf();
      return sendJson(res, { ok: true, ...out, hasPin: selfImprove.hasPin() });
    }
    case 'POST /api/permissions/test': {
      const { kind } = await readJson(req);
      return sendJson(res, await quick.testPermission(kind));
    }
    case 'POST /api/permissions/open': {
      const { pane } = await readJson(req);
      return sendJson(res, await quick.openPrivacySettings(pane));
    }
    case 'POST /api/reset': {
      // Wipes this install's personal data, then restarts into the setup wizard.
      const { confirm, pin } = await readJson(req);
      if (confirm !== 'RESET') return sendJson(res, { error: 'Type RESET to confirm.' }, 400);
      if (!selfImprove.checkPin(pin)) return sendJson(res, { error: 'Wrong PIN.' }, 403);
      sendJson(res, { ok: true, restarting: true });
      resetAndRestart();
      return;
    }
    case 'POST /api/utterance': {
      // Audio from the page (16 kHz mono WAV) -> text -> corrections -> Echo.
      const s = getSettings();
      const engine = resolveEngine(s.sttEngine);
      if (engine === 'browser') return sendJson(res, { error: 'Browser recognition runs in the page' }, 400);
      const heard = await transcribe(await readBody(req), { engine, language: s.sttLanguage });
      if (!heard.text) return sendJson(res, { empty: true, engine, ms: heard.ms });
      const out = await handleUtterance(heard.text, { uncertain: heard.uncertain, engine, sttMs: heard.ms });
      return sendJson(res, out);
    }
    case 'GET /api/stt': {
      const s = getSettings();
      const active = resolveEngine(s.sttEngine);
      // browserLang: what the page sets recognition.lang to (always English).
      return sendJson(res, { engines: engines(), active, choice: s.sttEngine, language: s.sttLanguage, browserLang: sttLanguageFor('browser', s.sttLanguage), engineLang: sttLanguageFor(active, s.sttLanguage) });
    }
    case 'GET /api/vocabulary':
      return sendJson(res, { ...loadVocab(), terms: vocabularyTerms() });
    case 'POST /api/vocabulary': {
      const body = await readJson(req);
      if (Array.isArray(body.words)) setWords(body.words);
      if (body.removeCorrection) {
        const v = loadVocab();
        delete v.corrections[String(body.removeCorrection).toLowerCase()];
        fs.writeFileSync(path.join(config.dataDir, 'vocabulary.json'), JSON.stringify(v, null, 2));
      }
      return sendJson(res, { ...loadVocab(), terms: vocabularyTerms() });
    }
    case 'GET /api/assets':
      // Big downloads Echo fetches by itself on first run, for the setup wizard's progress bar.
      return sendJson(res, { voice: voiceStatus(), whisper: { ready: engines().whisper.available } });
    case 'GET /api/update':
      return sendJson(res, updater.status());
    case 'POST /api/update/check':
      return sendJson(res, await updater.check());
    case 'POST /api/update/apply': {
      // Answers once the new version is downloaded, verified and swapped in; then Echo restarts.
      const out = await updater.apply({ restart: false });
      sendJson(res, { ok: true, ...out });
      if (out.updated) gracefulRestart(`to install Echo ${out.to}`);
      return;
    }
    case 'POST /api/update/rollback': {
      const { pin } = await readJson(req);
      if (!selfImprove.checkPin(pin)) return sendJson(res, { error: 'Wrong PIN.' }, 403);
      const out = updater.rollback({ restart: false });
      sendJson(res, { ok: true, ...out });
      gracefulRestart(`to go back to Echo ${out.to}`);
      return;
    }
    case 'GET /api/self/status':
      return sendJson(res, selfImprove.status());
    case 'POST /api/self/confirm': {
      const task = await selfImprove.confirmUnlock(await readJson(req));
      dispatcher.notify(`The user confirmed self-improve mode in the window. Self-improvement task ${task.id} has started on a separate branch.`);
      return sendJson(res, { ok: true, taskId: task.id });
    }
    case 'POST /api/self/cancel':
      selfImprove.cancelRequest();
      return sendJson(res, { ok: true });
    case 'POST /api/self/lock':
      selfImprove.lock();
      return sendJson(res, { ok: true });
    case 'POST /api/self/pin': {
      const { newPin, currentPin } = await readJson(req);
      selfImprove.setPin(newPin, currentPin);
      broadcastSelf();
      return sendJson(res, { ok: true });
    }
    case 'GET /api/self/diff': {
      const t = tasks.get(url.searchParams.get('taskId'));
      if (!t?.self?.review) return sendJson(res, { error: 'No review for that task' }, 404);
      return sendJson(res, t.self.review);
    }
    case 'POST /api/self/merge': {
      const { taskId, pin } = await readJson(req);
      const result = await selfImprove.approveMerge(taskId, { pin });
      sendJson(res, { ok: true, ...result });
      gracefulRestart(`to apply self-improvement ${taskId}`);
      return;
    }
    case 'POST /api/self/discard': {
      const { taskId } = await readJson(req);
      await selfImprove.discard(taskId);
      return sendJson(res, { ok: true });
    }
    default:
      return sendJson(res, { error: 'Not found' }, 404);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => {
      console.error('[api]', e.message);
      if (!res.headersSent) sendJson(res, { error: e.message }, 400);
    });
    return;
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, verifyClient: ({ req }) => originOk(req) });
const slim = (t) => ({
  ...t,
  log: undefined,
  result: undefined,
  logTail: t.log.slice(-60),
  steps: t.log.filter((e) => e.kind === 'tool').length,
  files: tasks.filesTouched(t).slice(0, 12),
  live: tasks.isLive(t.id),
  self: t.self ? { ...t.self, review: t.self.review ? { ...t.self.review, diff: undefined } : null } : null,
});
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
};
const broadcastSelf = () => broadcast({ type: 'self_status', status: selfImprove.status() });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', tasks: tasks.list().map(slim), projects: listProjects(), busy: dispatcher.busy, self: selfImprove.status(), costs: costSummary(), messageConfirms: quick.pendingList(), update: updater.status() }));
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'user_text': {
          // Typed text (with any attached images) goes straight through; browser-recognized
          // speech gets corrected first.
          const images = msg.typed ? resolveAttachments(msg.images) : [];
          const typedText = String(msg.text || '').trim();
          if (msg.typed && (typedText || images.length)) {
            broadcast({ type: 'heard', text: typedText, typed: true, images: images.map((i) => i.url) });
            logConvo('User', typedText + (images.length ? ` _(attached: ${images.map((i) => i.path).join(', ')})_` : ''));
            dispatcher.send(typedText, {}, images);
          } else if (!msg.typed && msg.text?.trim()) {
            await handleUtterance(msg.text.trim(), { engine: 'browser', lowOverall: typeof msg.confidence === 'number' && msg.confidence < 0.6 });
          }
          break;
        }
        case 'interrupt':
          dispatcher.interrupt();
          break;
        case 'new_conversation':
          dispatcher.newConversation();
          broadcast({ type: 'say', text: 'Starting a fresh conversation.' });
          break;
        case 'approve':
          // approvalId (optional) names the request the user saw; a click on an already
          // answered or replaced request is ignored quietly.
          try {
            tasks.resolveApproval(msg.taskId, msg.allow, { similar: msg.similar, scope: msg.scope, approvalId: msg.approvalId, by: 'window' });
          } catch (e) {
            if (e.code !== 'stale') throw e;
            ws.send(JSON.stringify({ type: 'approval_stale', taskId: msg.taskId, approvalId: msg.approvalId ?? null }));
          }
          break;
        case 'approve_many': {
          // A grouped card: [{ taskId, approvalId }]. Answers each one that's still pending.
          const items = (Array.isArray(msg.items) ? msg.items : []).filter((i) => i && i.taskId != null);
          const r = tasks.resolveMany(items, Boolean(msg.allow), { similar: msg.similar, scope: msg.scope, by: 'window' });
          for (const s of r.skipped) ws.send(JSON.stringify({ type: 'approval_stale', taskId: s.taskId, approvalId: items.find((i) => i.taskId === s.taskId)?.approvalId ?? null }));
          break;
        }
        case 'message_confirm':
          // The Send / Cancel card for a quick iMessage.
          try {
            await quick.resolvePending(String(msg.id), Boolean(msg.send), 'window');
          } catch (e) {
            if (e.code !== 'stale') throw e;
            ws.send(JSON.stringify({ type: 'message_resolved', id: msg.id, stale: true }));
          }
          break;
        case 'stop_task':
          await tasks.stop(msg.taskId);
          break;
        case 'follow_up':
          tasks.followUp(msg.taskId, msg.text);
          break;
        case 'open_file': {
          // Only files this task actually created or saved can be opened.
          const t = tasks.get(msg.taskId);
          const file = t && tasks.filesTouched(t).find((f) => f.path === msg.path);
          if (file) execFile('open', [file.path]);
          break;
        }
        case 'open_terminal': {
          const t = tasks.get(msg.taskId);
          if (t) openTerminal(t.cwd, `tail -n 200 -f ${JSON.stringify(tasks.logPath(t.id))}`);
          break;
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', text: e.message }));
    }
  });
});

/* ---------- speech: correct, log, dispatch ---------- */
const sttLog = path.join(config.dataDir, 'stt-log.jsonl');
/**
 * @param {string} raw
 * @param {{ uncertain?: Array<{ word: string, confidence: number }>, engine?: string, sttMs?: number, lowOverall?: boolean }} [opts]
 */
async function handleUtterance(raw, { uncertain = [], engine, sttMs = 0, lowOverall = false } = {}) {
  const s = getSettings();
  const fixed = await corrector.correct(raw, { uncertain, recent, smart: s.smartCorrection });
  const entry = { at: new Date().toISOString(), engine, sttMs, fixMs: fixed.ms, raw, text: fixed.text, changes: fixed.changes, unsure: fixed.unsure, smart: fixed.smart, timedOut: Boolean(fixed.timedOut) };
  fs.appendFileSync(sttLog, JSON.stringify(entry) + '\n');
  broadcast({ type: 'heard', text: fixed.text, raw: fixed.text !== raw ? raw : null, unsure: fixed.unsure, engine, ms: sttMs + fixed.ms });
  logConvo('User', fixed.text !== raw ? `${fixed.text}  _(heard: "${raw}")_` : raw);
  dispatcher.send(fixed.text, { raw, unsure: fixed.unsure, lowOverall });
  return entry;
}

/* ---------- wiring ---------- */
let replyBuf = '';
dispatcher.on('say', (text) => {
  logConvo('Assistant', text);
  broadcast({ type: 'say', text });
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
  broadcast({ type: 'say_end' });
});
dispatcher.on('speak', (text) => broadcast({ type: 'speak', text }));
dispatcher.on('activity', (text) => broadcast({ type: 'activity', text }));
dispatcher.on('busy', (busy) => broadcast({ type: 'busy', busy }));
dispatcher.on('cost', (usd) => broadcast({ type: 'costs', costs: addCost('assistant', usd) }));
tasks.on('cost', (t, usd) => broadcast({ type: 'costs', costs: addCost('workers', usd) }));
dispatcher.on('error', (e) => {
  console.error('[dispatcher]', e.message);
  const plain = friendlyError(e.message);
  broadcast({ type: 'error', text: plain === e.message ? `Assistant error: ${e.message}` : plain });
});

const notifyTask = (t, textIn) => {
  logConvo('Event', textIn);
  dispatcher.notify(textIn);
};
tasks.on('update', (t) => broadcast({ type: 'task', task: slim(t) }));
tasks.on('log', (t, entry) => broadcast({ type: 'task_log', taskId: t.id, entry }));
// Approvals are relayed after a short pause, grouped, and only if still unanswered (lib/approvals.js).
// Answering one in the window sends nothing to the assistant.
new ApprovalRelay(tasks, (textIn, opts) => {
  logConvo('Event', textIn);
  dispatcher.notify(textIn, opts);
});
tasks.on('approval_resolved', (t, r) => broadcast({ type: 'approval_resolved', taskId: t.id, approvalId: r.id, allowed: r.allowed, by: r.by }));
tasks.on('finished', (t) => {
  if (t.kind === 'self') return; // announced once the review is ready
  const files = tasks.outputFiles(t).slice(0, 5).map((f) => f.file);
  notifyTask(
    t,
    `Task ${t.id} (${t.project}) ${t.status === 'done' ? 'finished' : 'failed'}. Spoken summary: ${t.summary}` +
      (files.length ? ` Saved files: ${files.join(', ')}.` : '') +
      ' Full details are available with get_task.'
  );
});

quick.on('confirm_request', (request) => broadcast({ type: 'message_confirm', request }));
quick.on('confirm_resolved', (r) => {
  broadcast({ type: 'message_resolved', ...r });
  if (r.by === 'voice') return; // the assistant already knows
  const what = r.sent ? 'was sent' : r.error ? `failed to send: ${r.error}` : r.by === 'expired' ? 'expired unanswered and was not sent' : 'was cancelled in the window, not sent';
  notifyTask(null, `The message to ${r.to} (${r.masked}) ${what}.${r.sent ? ' Confirm it in a few words.' : ''}`);
});

selfImprove.on('unlock_request', (request) => broadcast({ type: 'self_unlock_request', request }));
selfImprove.on('status', broadcastSelf);
selfImprove.on('review', (t) => {
  broadcast({ type: 'task', task: slim(t) });
  broadcastSelf();
  const r = t.self.review;
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
  if (process.env.VOICEOPS_SUPERVISED) {
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
  const out = fs.openSync(path.join(config.logDir, 'voiceops.log'), 'a');
  spawn(process.execPath, ['supervisor.js'], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, VOICEOPS_WAIT_PORT_FREE: '1' },
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
  if (checkpointed.length) console.log(`[voiceops] paused tasks ${checkpointed.join(', ')}; they'll resume on the next start`);
  process.exit(signal === 'SIGINT' ? 130 : 0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* ---------- startup ---------- */
server.listen(config.port, '127.0.0.1', () => {
  dispatcher.start();
  warmUp();
  const s = getSettings();
  if (resolveEngine(s.sttEngine) === 'whisper') startWhisper().then(() => console.log('[stt] local Whisper ready')).catch((e) => console.error('[stt]', e.message));
  if (s.smartCorrection) corrector.warmUp();
  tasks.backfillTitles();
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
});
