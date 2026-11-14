// The page's WebSocket (split out of server.js): the snapshot a page gets when it connects, and
// what it sends: clicks on cards and buttons, typed text and speech (handed to ./speech.js),
// approvals, and the Stop and Undo buttons.
import { execFile } from 'node:child_process';
import { openTerminal } from '../dispatcher.js';
import { listProjects } from '../projects.js';
import { costSummary } from '../costs.js';
import { record as timeline, ingest as timelineIngest } from '../timeline.ts';

/** Window messages that come from a click on Echo's own window. */
const ECHO_CLICKS = new Set(['computer_confirm', 'computer_undo', 'computer_stop', 'message_confirm', 'approve', 'approve_many', 'stop_task', 'open_file', 'new_conversation']);

/**
 * A task as the page shows it: no full log or result, the last 60 log lines, files touched.
 * @param {import('../tasks.js').TaskManager} tasks @param {any} t
 */
export const slimTask = (tasks, t) => ({
  ...t,
  log: undefined,
  result: undefined,
  logTail: t.log.slice(-60),
  steps: t.log.filter((e) => e.kind === 'tool').length,
  files: tasks.filesTouched(t).slice(0, 12),
  live: tasks.isLive(t.id),
  self: t.self ? { ...t.self, review: t.self.review ? { ...t.self.review, diff: undefined } : null } : null,
});

/**
 * Handles one page's WebSocket from connection to close.
 * @param {{ voice?: import('../voicestate.js').VoiceState, tasks: import('../tasks.js').TaskManager, selfImprove: import('../selfimprove.js').SelfImprove, quick: import('../quick.js').QuickActions, screen: import('../screen.js').ScreenBridge, dispatcher: import('../dispatcher.js').Dispatcher, computer: import('../computer.js').ComputerUse, updater: import('../updater.js').Updater, speech: ReturnType<typeof import('./speech.js').speechIntake>, broadcast: (msg: object) => void, notifyTask: (t: any, text: string, opts?: object) => void, nativePages: Set<any> }} ctx
 * @returns {(ws: import('ws').WebSocket) => void}
 */
export function pageConnection({ voice, tasks, selfImprove, quick, screen, dispatcher, computer, updater, speech, broadcast, notifyTask, nativePages }) {
  const slim = (t) => slimTask(tasks, t);
  return (ws) => {
    const since = Date.now();
    timeline('server', 'page.ws.open');
    ws.send(JSON.stringify({ type: 'snapshot', quietMode: dispatcher.textOnly === true, tasks: tasks.list().map(slim), projects: listProjects(), busy: dispatcher.busy, self: selfImprove.status(), costs: costSummary(), messageConfirms: quick.pendingList(), computerConfirms: computer.pendingList(), driving: computer.driving, update: updater.status() }));
    ws.on('message', async (raw, isBinary) => {
      // Audio streamed while you talk (public/sttstream.js).
      if (isBinary) return void speech.audio(ws, /** @type {Buffer} */ (raw));
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      // A click in Echo's own window (a card, Undo, a task button) that the Mac app also saw is
      // talking to Echo, not taking over the step under way (lib/computer.js pause).
      if (ECHO_CLICKS.has(msg.type)) computer.noteEchoInput();
      try {
        switch (msg.type) {
          case 'user_text':
            await speech.userText(ws, msg);
            break;
          case 'circled':
            // The user drew round part of their screen with Echo's light (the Mac app, TalkLayer.swift): that is what "this" means for a while.
            dispatcher.circle(msg.box);
            break;
          case 'stt_stream':
            speech.streamMessage(ws, msg);
            break;
          case 'onset':
            // Speech began again (the app's mic): a short sentence being held waits for it (lib/server/speech.js).
            speech.onset(msg);
            break;
          case 'probably_done':
            // The sentence being said looks finished: get ahead while the app makes sure (lib/server/speech.js).
            speech.probablyDone(msg);
            break;
          case 'tl':
            // What the page noted for the timeline: playback, reconnects, errors (lib/timeline.ts).
            timelineIngest('page', msg.events);
            break;
          case 'interrupt':
            // Stop or Escape in the window: the user ended the reply on purpose (never an error to show).
            dispatcher.stopByUser();
            break;
          case 'voice_started':
            // Echo's voice became audible for this turn (the page's clock): its first sound, timed.
            dispatcher.noteFirstSound(String(msg.trace || ''), Number(msg.at));
            break;
          case 'voice':
            // Echo's voice started or ended a line, or went quiet (lib/voicestate.js): what waits on it goes on.
            voice?.event(msg, ws);
            break;
          case 'hello':
            // The Mac app's page says so: it can look at the screen and point by itself.
            if (msg.native) nativePages.add(ws);
            break;
          case 'screen_cancel':
            // The user said no on the browser's "share your screen" card.
            screen.cancel(String(msg.id || ''), 'declined');
            break;
          case 'voice_busy':
            // The page is speaking or hearing the user: task events wait (lib/dispatcher.js).
            dispatcher.setVoiceBusy(ws, Boolean(msg.busy));
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
          case 'computer_stop':
            // The Stop button on the "Echo is driving" banner, or the guide's step card.
            computer.abort('stopped in the window');
            break;
          case 'computer_confirm':
            // Allow / Cancel on a risky computer-use action's card.
            await computer.confirm(String(msg.id || ''), Boolean(msg.allow), 'window').then((r) => {
              if (msg.allow && r && !r.error) notifyTask(null, `The user allowed "${r.did || 'the action'}" in the window, and it was done. Check the screen and carry on.`);
              else if (r?.error && r.error !== 'stale') notifyTask(null, `The user allowed the action in the window, but it didn't happen: ${r.message || r.error}`);
            });
            break;
          case 'computer_undo': {
            // The Undo chip after a send or delete Echo did (lib/computer.js undo).
            const r = await computer.undo(String(msg.id || ''));
            if (r?.done) notifyTask(null, `The user tapped Undo on "${r.did || 'the last send or delete'}", and it was undone.`);
            else ws.send(JSON.stringify({ type: 'undo_failed', id: msg.id, message: r?.message || "Couldn't undo it." }));
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
    ws.on('close', (code) => {
      timeline('server', 'page.ws.close', { code, ms: Date.now() - since });
      speech.closed(ws);
      dispatcher.setVoiceBusy(ws, false);
      voice?.gone(ws);
      nativePages.delete(ws);
    });
  };
}
