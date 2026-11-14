// The server's HTTP API (split out of server.js): settings and setup, sign-in and permissions, the
// voice, updates and self-improve, and the Mac app's answers. Listening's own routes (POST
// /api/utterance and the rest) are in ./speech.js. Each route is 'METHOD /path': handler.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '../config.js';
import { listProjects } from '../projects.js';
import { synthesize, listVoices, wordsHeader, voiceStatus, voiceBudget } from '../voice.js';
import { getSettings, saveSettings, PERSONALITIES } from '../settings.js';
import { onboardingState, saveOnboarding } from '../onboarding.js';
import { costSummary } from '../costs.js';
import { engines } from '../stt.js';
import { allFlags } from '../flags.ts';
import { loadRules, removeRule } from '../rules.js';
import { loadSkills, removeSkill } from '../skills.js';
import { buildReport, reportFile } from '../diagnostics.js';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { saveAttachment, findAttachment, MAX_ATTACHMENT_BYTES } from '../attachments.js';
import { appSigning } from '../appsign.js';
import { pairingCode } from '../browser.js';
import { bodyToken, tokenOk } from '../bodylink.ts';
import { cleanPointed, pointedLine } from '../computer.js';
import { record as timeline, readTimeline, limits as timelineLimits } from '../timeline.ts';
import { turnsView, sinceWhen } from '../timelineview.ts';
import { originOk, readJson, readBody, sendJson } from './http.js';
import { sky, skyDay } from '../sky.ts';
import { readTranscript } from '../transcript.ts';

/** Which core flags are on (lib/flags.ts), for the page. */
export const flagsNow = () => Object.fromEntries(allFlags().map((f) => [f.name, f.on]));
/** Every flag with its name, description and where its value comes from, for Settings → Labs. */
export const flagInfo = () => allFlags().map(({ name, on, source, label, about, envName }) => ({ name, on, source, label, about, envName }));

/**
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<unknown>} Route
 * @typedef {{
 *   tasks: import('../tasks.js').TaskManager, selfImprove: import('../selfimprove.js').SelfImprove, quick: import('../quick.js').QuickActions,
 *   screen: import('../screen.js').ScreenBridge, dispatcher: import('../dispatcher.js').Dispatcher, computer: import('../computer.js').ComputerUse,
 *   updater: import('../updater.js').Updater, claudeAuth: import('../claudeauth.js').ClaudeAuth, speech: ReturnType<typeof import('./speech.js').speechIntake>,
 *   broadcast: (msg: object) => void, broadcastSelf: () => void, prewarmVoice: (s?: ReturnType<typeof getSettings>) => void,
 *   gracefulRestart: (reason: string) => unknown, resetAndRestart: () => unknown, isRestarting: () => boolean, shutDown: () => unknown,
 * }} Ctx
 */

/**
 * The API's routes.
 * @param {Ctx} ctx
 * @returns {Record<string, Route>}
 */
export function apiRoutes({ tasks, selfImprove, quick, screen, dispatcher, computer, updater, claudeAuth, speech, broadcast, broadcastSelf, prewarmVoice, gracefulRestart, resetAndRestart, isRestarting, shutDown }) {
  /** @type {any} the diagnostics report last shown (Settings → Privacy & safety) */
  let shownReport = null;
  return {
      'POST /api/attachments': async (req, res) => {
        // One image per request, body = the file; the page shrinks it first.
        const a = saveAttachment(await readBody(req, MAX_ATTACHMENT_BYTES + 1), req.headers['content-type']);
        return sendJson(res, { id: a.id, url: a.url, bytes: a.bytes });
      },
      'POST /api/screen/result': async (req, res) => {
        // The Mac app's answer to a look or point request (macos/Sources/Screen.swift), or the
        // browser's shared picture. Only answers to a request that's waiting are taken.
        const body = JSON.parse(String(await readBody(req, 9 * 1024 * 1024)) || '{}');
        return sendJson(res, { ok: screen.deliver(String(body.id || ''), body) });
      },
      'POST /api/computer/event': async (req, res) => {
        // The Mac app says the user took back control (Escape, or their own mouse or keys) while
        // Echo was driving (macos/Sources/Driver.swift). It can only ever stop a run.
        const body = await readJson(req);
        // The app's light left for a request's target, landed on it, or went back to the pearl
        // (docs/firefly-protocol.md, section 5): a step's held words are spoken as it lands. Only the Mac app can say so: its token,
        // and no Origin, as for a drop of the light.
        if (body.type === 'arrived' || body.type === 'departed' || body.type === 'home') {
          if (req.headers.origin || !tokenOk(req.headers['x-echo-token'], bodyToken())) return sendJson(res, { error: 'Forbidden' }, 403);
          return sendJson(res, { ok: computer.light(body) });
        }
        if (body.type === 'abort') computer.abort(String(body.reason || 'user input'), { runId: body.runId ? String(body.runId) : undefined });
        // A real click or key press mid-step: only that step stops; the session keeps listening.
        // A click on Echo's own window (a card, Undo) is never a take-over (inEcho, or just after one).
        if (body.type === 'pause') computer.pause(String(body.reason || 'user input'), { runId: body.runId ? String(body.runId) : undefined, inEcho: body.inEcho === true, app: typeof body.app === 'string' ? body.app.slice(0, 80) : '' });
        return sendJson(res, { ok: true });
      },
      'POST /api/computer/pointed': async (req, res) => {
        // The user picked up Echo's light and dropped it on something to say "this one"
        // (docs/firefly-protocol.md). Only the Mac app can say so: it presents its token
        // (lib/bodylink.ts), and a web page (any Origin) never can. The assistant gets it at once:
        // on its next step if a turn is under way, else as a turn; the chat shows a small "You
        // pointed at …" line (the page renders the `pointed` message). The timeline gets the kind
        // of thing and the app, never its name.
        if (req.headers.origin || !tokenOk(req.headers['x-echo-token'], bodyToken())) return sendJson(res, { error: 'Forbidden' }, 403);
        let body = null;
        try {
          body = JSON.parse(String(await readBody(req, 16 * 1024)) || '{}');
        } catch {}
        const p = cleanPointed(body);
        if (!p) return sendJson(res, { error: 'Nothing was pointed at: give a label, a role or what is near.' }, 400);
        const via = dispatcher.pointed(pointedLine(p));
        timeline('server', 'point.back', { role: p.role, app: p.app });
        broadcast({ type: 'pointed', label: p.label, role: p.kind, app: p.app, via });
        return sendJson(res, { ok: true, via });
      },
      'GET /api/browser': async (req, res) => {
        // The Echo Chrome extension: connected?, and the pairing code to paste into it (this page only).
        if (!originOk(req)) return sendJson(res, { error: 'Forbidden origin' }, 403);
        return sendJson(res, { ...(await dispatcher.browser.status()), code: pairingCode(), extensionFolder: path.join(APP_DIR, 'extension') });
      },
      // browser: is the Echo Chrome extension connected (no code, no detail: anything on this Mac may ask).
      'GET /api/health': async (req, res) => sendJson(res, { ok: !isRestarting() && Boolean(dispatcher.input), tasks: tasks.list().length, pid: process.pid, browser: { connected: Boolean(dispatcher.browser?.extension?.connected) } }),
      'POST /api/shutdown': async (req, res) => {
        // Quit Echo in the Mac app: the server stops too, however it was started (running tasks
        // pause and resume on the next start). Only the app can ask: it presents the token from
        // data/self/body-token (lib/bodylink.ts), and a web page (any Origin) never can.
        if (req.headers.origin || !tokenOk(req.headers['x-echo-token'], bodyToken())) return sendJson(res, { error: 'Forbidden' }, 403);
        const { ifIdle } = await readJson(req);
        const working = tasks.list().filter((t) => tasks.isLive(t.id)).length;
        // ifIdle: the app asks first, so it can check with the user before pausing running tasks.
        if (ifIdle && working) return sendJson(res, { ok: false, working });
        sendJson(res, { ok: true, working });
        // A light still waiting on a lesson step or a card is let go before Echo stops.
        computer?.letGo();
        shutDown();
        return;
      },
      'POST /api/tts': async (req, res) => {
        const s = getSettings();
        const { text, provider = s.ttsProvider, voice = s.voice, speed = s.speed, previousText } = await readJson(req);
        const audio = await synthesize({ text, provider, voice, speed, previousText, fallbackVoice: s.fallbackVoice });
        const words = wordsHeader(audio.words);
        return res.writeHead(200, {
          'Content-Type': audio.mime,
          'Cache-Control': 'no-store',
          'X-Echo-Voice': audio.provider,
          ...(audio.fellBack && { 'X-Echo-Fallback': audio.fellBack }),
          ...(words && { 'X-Echo-Words': words }),
        }).end(audio.data);
      },
      'GET /api/voices': async (req, res) => sendJson(res, { providers: await listVoices(), budget: voiceBudget.status(), personalities: Object.entries(PERSONALITIES).map(([id, p]) => ({ id, label: p.label })) }),
      'GET /api/settings': async (req, res) => sendJson(res, { ...getSettings(), keepRecordingsOn: speech.recordingOn(), flags: flagsNow(), flagInfo: flagInfo(), listen: speech.listenState }),
      'POST /api/settings': async (req, res) => {
        const before = getSettings();
        // The projects folder is checked and created by setup (POST /api/onboarding).
        const { projectsDir, onboarded, ...patch } = await readJson(req);
        const next = saveSettings(patch);
        if (['assistantName', 'userName', 'personality', 'beginnerMode', 'interests', 'computerUse', 'pointer'].some((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))) dispatcher.reload();
        if (['ttsProvider', 'voice', 'speed'].some((k) => before[k] !== next[k])) prewarmVoice(next);
        if (before.dispatcherCostWarnUsd !== next.dispatcherCostWarnUsd) broadcast({ type: 'costs', costs: costSummary() });
        // Switching computer use off stops a run straight away.
        if (before.computerUse && !next.computerUse) computer.abort('turned off in Settings');
        broadcast({ type: 'settings', settings: { ...next, keepRecordingsOn: speech.recordingOn(), flags: flagsNow(), flagInfo: flagInfo() } });
        return sendJson(res, { ...next, keepRecordingsOn: speech.recordingOn(), flags: flagsNow(), flagInfo: flagInfo() });
      },
      // Rules the user gave Echo (lib/rules.js): Settings lists them, each with a Remove button.
      'GET /api/rules': async (req, res) => sendJson(res, { rules: loadRules() }),
      'POST /api/rules/remove': async (req, res) => {
        const { id } = await readJson(req);
        const gone = removeRule(String(id || ''));
        if (gone) dispatcher.reload();
        return sendJson(res, { ok: Boolean(gone), rules: loadRules() });
      },
      // Skills Echo has learned (lib/skills.js): Settings lists them, each with a Remove button.
      'GET /api/skills': async (req, res) => sendJson(res, { skills: loadSkills() }),
      'POST /api/skills/remove': async (req, res) => {
        const { id } = await readJson(req);
        const gone = removeSkill(String(id || ''));
        if (gone) dispatcher.reload();
        return sendJson(res, { ok: Boolean(gone), skills: loadSkills() });
      },
      // A report for whoever helps you (lib/diagnostics.js): shown in full, saved to Downloads, never sent.
      // What's saved is exactly what was shown (kept here, by when it was made), not a newer one.
      'GET /api/diagnostics': async (req, res) => sendJson(res, (shownReport = buildReport())),
      'GET /api/timeline': async (req, res, url) => {
        // Settings → What happened: the recent turns in plain English, newest first, each with where
        // its time went and its events (lib/timelineview.ts, the same wording `npm run timeline`
        // prints). `since` is 10m, 1h or today; `turn` picks one (a reply's "…" in the chat), looked
        // for over the last day unless `since` says otherwise. The timeline holds no words and no
        // screen content, so neither does this. This page only.
        if (!originOk(req)) return sendJson(res, { error: 'Forbidden origin' }, 403);
        const turn = url.searchParams.get('turn') || '';
        const since = url.searchParams.get('since') || (turn ? '1d' : '10m');
        const now = Date.now();
        const from = sinceWhen(since, now);
        if (!Number.isFinite(from) || (turn && !/^[\w-]{1,40}$/.test(turn))) return sendJson(res, { error: 'since is 10m, 1h or today; turn is a turn id.' }, 400);
        // A little earlier is read too: a turn's listening happens before the turn starts.
        const rows = readTimeline(undefined, Math.max(from, now - timelineLimits.days * 86_400_000) - 90_000, now);
        return sendJson(res, { since, turns: turnsView(rows, turn || undefined).filter((t) => Date.parse(t.at) >= from) });
      },
      'GET /api/sky': async (req, res) => {
        // The Sky pane (public/ui/sky.js, lib/sky.ts): every day as a constellation, from the
        // timeline's times and counts. What was said at a star comes from the conversation log,
        // when that is kept, and goes to this page only.
        if (!originOk(req)) return sendJson(res, { error: 'Forbidden origin' }, 403);
        const now = Date.now();
        const nights = sky(readTimeline(undefined, now - timelineLimits.days * 86_400_000, now), { now });
        const words = getSettings().keepTranscript !== false;
        // By the turn's id; a line with none (typed ones had none for a while) by its time.
        /** @type {Map<string, string>} */
        const said = new Map();
        /** @type {Array<{ at: number, text: string }>} */
        const loose = [];
        if (words) for (const l of readTranscript(undefined, now - 31 * 86_400_000, now)) {
          if (l.who !== 'you' || l.kind === 'unanswered') continue;
          if (l.trace && !said.has(l.trace)) said.set(l.trace, l.text.slice(0, 160));
          else if (!l.trace) loose.push({ at: Date.parse(l.ts), text: l.text.slice(0, 160) });
        }
        const wordsAt = (/** @type {{ trace: string, t: number }} */ s) => said.get(s.trace) ?? loose.find((l) => Math.abs(l.at - s.t) < 4000)?.text;
        return sendJson(res, { today: skyDay(now), words, nights: nights.map((n) => ({ ...n, stars: n.stars.map((s) => ({ ...s, ...(wordsAt(s) ? { said: wordsAt(s) } : {}) })) })) });
      },
      'POST /api/diagnostics/save': async (req, res) => {
        const { made } = /** @type {any} */ (await readJson(req).catch(() => ({})));
        if (!shownReport || shownReport.made !== made) return sendJson(res, { error: 'That report is out of date: open it again to see what will be saved.' }, 409);
        const file = reportFile();
        fs.writeFileSync(file, JSON.stringify(shownReport, null, 2) + '\n');
        execFile('open', ['-R', file], () => {});
        return sendJson(res, { ok: true, file: file.replace(os.homedir(), '~') });
      },
      'GET /api/onboarding': async (req, res) => sendJson(res, onboardingState(selfImprove)),
      'POST /api/onboarding': async (req, res) => {
        const before = getSettings();
        const out = saveOnboarding(await readJson(req), { selfImprove });
        const next = out.settings;
        broadcast({ type: 'settings', settings: next });
        if (before.projectsDir !== next.projectsDir) broadcast({ type: 'projects', projects: listProjects() });
        if (next.onboarded && (!before.onboarded || before.projectsDir !== next.projectsDir || before.beginnerMode !== next.beginnerMode || before.userName !== next.userName)) dispatcher.reload();
        broadcastSelf();
        return sendJson(res, { ok: true, ...out, hasPin: selfImprove.hasPin() });
      },
      'GET /api/claude/status': async (req, res) => sendJson(res, await claudeAuth.status()),
      'POST /api/claude/login': async (req, res) => {
        // Opens the Claude sign-in in the browser; the wizard polls GET /api/claude/status.
        const { method } = await readJson(req);
        return sendJson(res, { ok: true, login: claudeAuth.startLogin(method === 'api' ? 'api' : 'subscription') });
      },
      'POST /api/claude/login/cancel': async (req, res) => {
        claudeAuth.cancelLogin();
        return sendJson(res, { ok: true });
      },
      'POST /api/claude/test': async (req, res) => sendJson(res, await claudeAuth.test()),
      'POST /api/permissions/test': async (req, res) => {
        const { kind } = await readJson(req);
        return sendJson(res, await quick.testPermission(kind));
      },
      // How Echo.app is signed: a stable identity keeps the Mac permissions across rebuilds (lib/appsign.js).
      'GET /api/permissions/app': async (req, res) => sendJson(res, await appSigning()),
      'POST /api/permissions/open': async (req, res) => {
        const { pane } = await readJson(req);
        return sendJson(res, await quick.openPrivacySettings(pane));
      },
      'POST /api/reset': async (req, res) => {
        // Wipes this install's personal data, then restarts into the setup wizard.
        const { confirm, pin } = await readJson(req);
        if (confirm !== 'RESET') return sendJson(res, { error: 'Type RESET to confirm.' }, 400);
        if (!selfImprove.checkPin(pin)) return sendJson(res, { error: 'Wrong PIN.' }, 403);
        sendJson(res, { ok: true, restarting: true });
        resetAndRestart();
        return;
      },
      // Big downloads Echo fetches by itself on first run, for the setup wizard's progress bar.
      'GET /api/assets': async (req, res) => sendJson(res, { voice: voiceStatus(), whisper: { ready: engines().whisper.available } }),
      'GET /api/update': async (req, res) => sendJson(res, updater.status()),
      'POST /api/update/check': async (req, res) => sendJson(res, await updater.check()),
      'POST /api/update/apply': async (req, res) => {
        // Answers once the new version is downloaded, verified and swapped in; then Echo restarts.
        const out = await updater.apply({ restart: false });
        sendJson(res, { ok: true, ...out });
        if (out.updated) gracefulRestart(`to install Echo ${out.to}`);
        return;
      },
      'POST /api/update/rollback': async (req, res) => {
        const { pin } = await readJson(req);
        if (!selfImprove.checkPin(pin)) return sendJson(res, { error: 'Wrong PIN.' }, 403);
        const out = updater.rollback({ restart: false });
        sendJson(res, { ok: true, ...out });
        gracefulRestart(`to go back to Echo ${out.to}`);
        return;
      },
      'GET /api/self/status': async (req, res) => sendJson(res, selfImprove.status()),
      'POST /api/self/confirm': async (req, res) => {
        const task = await selfImprove.confirmUnlock(await readJson(req));
        dispatcher.notify(`The user confirmed self-improve mode in the window. Self-improvement task ${task.id} has started on a separate branch.`);
        return sendJson(res, { ok: true, taskId: task.id });
      },
      'POST /api/self/cancel': async (req, res) => {
        selfImprove.cancelRequest();
        return sendJson(res, { ok: true });
      },
      'POST /api/self/lock': async (req, res) => {
        selfImprove.lock();
        return sendJson(res, { ok: true });
      },
      'POST /api/self/pin': async (req, res) => {
        const { newPin, currentPin } = await readJson(req);
        selfImprove.setPin(newPin, currentPin);
        broadcastSelf();
        return sendJson(res, { ok: true });
      },
      'GET /api/self/diff': async (req, res, url) => {
        const t = tasks.get(url.searchParams.get('taskId'));
        if (!t?.self?.review) return sendJson(res, { error: 'No review for that task' }, 404);
        return sendJson(res, t.self.review);
      },
      'POST /api/self/merge': async (req, res) => {
        const { taskId, pin } = await readJson(req);
        const result = await selfImprove.approveMerge(taskId, { pin });
        sendJson(res, { ok: true, ...result });
        gracefulRestart(`to apply self-improvement ${taskId}`);
        return;
      },
      'POST /api/self/discard': async (req, res) => {
        const { taskId } = await readJson(req);
        await selfImprove.discard(taskId);
        return sendJson(res, { ok: true });
      },
  };
}

/**
 * Answers one /api/ request: an attachment, or a route from apiRoutes or listening's own.
 * @param {Ctx} ctx
 */
export function apiHandler(ctx) {
  /** @type {Record<string, Route>} */
  const routes = { ...apiRoutes(ctx), ...ctx.speech.routes };
  /** @type {Route} */
  return async (req, res, url) => {
    const route = `${req.method} ${url.pathname}`;
    if (req.method !== 'GET' && !originOk(req)) return sendJson(res, { error: 'Forbidden origin' }, 403);
    if (route.startsWith('GET /api/attachments/')) {
      const a = findAttachment(decodeURIComponent(url.pathname.slice('/api/attachments/'.length)));
      if (!a) return sendJson(res, { error: 'Not found' }, 404);
      res.writeHead(200, { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(a.path).pipe(res);
      return;
    }
    const handle = Object.hasOwn(routes, route) ? routes[route] : null;
    if (!handle) return sendJson(res, { error: 'Not found' }, 404);
    return handle(req, res, url);
  };
}
