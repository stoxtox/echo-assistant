import { vizStateFor } from '/ui/mark.js';
import { createCompanion, sorryLine, firstToday, dayKey } from '/ui/companion.js';
import { createKaraoke, speechBounds, alignTimings, pieceGap, playPlan, estimateTimings } from '/karaoke.js';
import { createWizard, suggestionsFor, signInSummary, STEPS } from '/onboarding.js';
import { WakeListener } from '/wake.js';
import { StreamClient, downsample, wavBytes } from '/sttstream.js';
import { createScreenClient, pointAtElement, nativeApp, toApp } from '/screen.js';
import { createComputerClient } from '/computer.js';
import { AutoListen, awaitsAnswer, autoListenMs } from '/autolisten.js';
import { createCaptionFeed, captionTimes } from '/caption.js';
import { createLiveCaption, trulyEmpty, showPttHint } from '/livecaption.js';
import { createTalkView } from '/ui/talkview.js';
import { createSky } from '/ui/sky.js';
import { yesOrNo } from '/yesno.js';
import { AppMic, stateLine, dropLine, sendWithRetry, BARGE_CONFIRM_MS, NO_TEXT_LINE, NOT_SENT_LINE } from '/nativemic.js';
import { HandsFreeWatch, watchPauseMs } from '/handsfreewatch.js';
import { createSettingsPanel } from '/settings.js';
import { windowState, windowLabel, windowEndsAt } from '/convwindow.js';
import { $, el, button, actionButton, step, toast, escapeHtml, escapeRe, postJson } from '/ui/dom.js';
import { pref } from '/ui/prefs.js';
import { ws, send, openSocket, timeline } from '/ui/socket.js';
import { openModal, closeModal } from '/ui/modal.js';
import { addMsg, scrollDown, showUndo, settleUndo, showMessageConfirm, settleMessageConfirm, addTaskCard, settleTaskCard, syncTaskCards, setChatNote, showExplain } from '/ui/chat.js';
import { tasks, setCosts, updateMeta, upsertTask, appendLog } from '/ui/tasks.js';
import { selfStatus, setSelfStatus, showUnlock, setAssistantName } from '/ui/selfimprove.js';
import { setUpdateStatus, checkForUpdates, setRestartScreen } from '/ui/updates.js';
import { imageGrid, putInComposer, setOnTyped } from '/ui/composer.js';
import { renderRules } from '/ui/rules.js';
import { renderSkills } from '/ui/skills.js';
import '/ui/report.js';
import { createTimelineView, tagTurn } from '/ui/timelineview.js';
import '/ui/topbar.js';
import { activity } from '/ui/activity.js';
import { greeting } from '/ui/home.js';
const els = {
  dot: $('connDot'), mic: $('mic'), state: $('state'), viz: $('viz'),
  assistantName: $('assistantName'), transcript: $('transcript'), typeForm: $('typeForm'), typeInput: $('typeInput'),
  handsFree: $('handsFree'), speakOut: $('speakOut'), newConvo: $('newConvo'),
  taskList: $('taskList'), emptyTasks: $('emptyTasks'), taskCount: $('taskCount'), tpl: $('taskTpl'),
  settings: $('settings'), openSettings: $('openSettings'), closeSettings: $('closeSettings'),
  setName: $('setName'), setUser: $('setUser'), personalities: $('personalities'),
  setVoice: $('setVoice'), setSpeed: $('setSpeed'), speedVal: $('speedVal'), setSounds: $('setSounds'),
  previewVoice: $('previewVoice'),
  selfBadge: $('selfBadge'), selfTimer: $('selfTimer'), modal: $('modal'), modalTitle: $('modalTitle'),
  modalBody: $('modalBody'), modalActions: $('modalActions'), restartOverlay: $('restartOverlay'),
  setPause: $('setPause'), setWake: $('setWake'),
  chatEmpty: $('chatEmpty'), tabCount: $('tabCount'), toast: $('toast'), main: document.querySelector('main'),
  setHandsFree: $('setHandsFree'),
  attachBtn: $('attachBtn'), fileInput: $('fileInput'), attachTray: $('attachTray'), dropVeil: $('dropVeil'),
  approvalGroup: $('approvalGroup'), approvalGroupTitle: $('approvalGroupTitle'), approvalGroupSub: $('approvalGroupSub'),
  groupAllow: $('groupAllow'), groupDeny: $('groupDeny'), sendBtn: $('sendBtn'),
  suggestions: $('suggestions'), setSafe: $('setSafe'),
  resetEcho: $('resetEcho'), restartText: $('restartText'), restartSub: $('restartSub'),
};


let settings = { assistantName: 'Ops', ttsProvider: 'kokoro', voice: 'af_heart', speed: 1.05, sounds: true, personality: 'friendly' };
// The floating caption bar in the Mac app (public/caption.js, macos/Sources/Caption.swift).
const caption = createCaptionFeed({ post: toApp, enabled: () => settings.captionBar !== false });
/** @type {{ providers: any[], personalities: any[], budget?: Record<string, any> }} */
let voiceCatalog = { providers: [], personalities: [] };
// Your words as you say them, under the voice (public/livecaption.js), and its short notes.
const liveCap = createLiveCaption($('live'));
// Over a conversation your words are the next bubble in the thread (public/ui/talkview.js).
createTalkView({ transcript: $('transcript'), live: $('live'), mic: $('mic'), input: /** @type {HTMLTextAreaElement} */ ($('typeInput')), chatEmpty: $('chatEmpty'), handsFree: /** @type {HTMLInputElement} */ ($('handsFree')), scrollDown });
// "release Space to send": shown while you hold the key the first few times, then never again.
const pttHint = {
  show: () => showPttHint(pref.get('pttHintUses', 0)),
  used: () => { const n = pref.get('pttHintUses', 0); if (showPttHint(n)) pref.set('pttHintUses', n + 1); },
};

/* ---------- Connection ---------- */
let projects = [];
/** The last lesson step the orb reacted to (`lesson id:step`), so it reacts once. */
let lessonMoment = '';
/** The questions waiting for your OK (confirmation cards, by id): the companion tilts and nudges while there are any. */
const asks = new Set();
/** A card was answered: it stops asking, and a yes makes it happy. @param {string} id @param {unknown} yes */
function answered(id, yes) {
  // You said yes to what it asked: pleased, without the hop (this can happen many times in a minute).
  if (asks.delete(id) && yes === true) viz.moment('content');
  renderOrb();
}

function connect() {
  openSocket({
    // Connected is the normal state, so it shows nothing; only a lost connection gets a pill.
    onOpen: () => {
      els.dot.hidden = true;
      if (voiceBusySent) reportVoiceBusy(true);
      // The Mac app's page can look at the screen and point by itself (public/screen.js).
      if (nativeApp()) send({ type: 'hello', native: true });
    },
    onClose: () => { els.dot.hidden = false; },
    onMessage: handle,
  });
}

let liveBubble = null;
// Brief voice: the details that come after the answer (steps, a list, numbers) are shown under
// its bubble in a block of their own, closed until clicked. Never inside the bubble.
const detailBlocks = new WeakMap();
function addDetails(bubble, text) {
  let body = detailBlocks.get(bubble);
  if (!body) {
    const box = document.createElement('details');
    box.className = 'msg-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    body = document.createElement('div');
    body.className = 'msg-details-body';
    box.append(summary, body);
    bubble.after(box);
    detailBlocks.set(bubble, body);
  }
  body.append(text);
}
function handle(msg) {
  switch (msg.type) {
    case 'snapshot':
      screenClient.clearLooks(); // the line is back: a screen_done may have been missed while it was down
      quietMode = msg.quietMode === true;
      projects = msg.projects;
      tasks.clear();
      els.taskList.querySelectorAll('.task').forEach((n) => n.remove());
      msg.tasks.slice().reverse().forEach(upsertTask);
      els.emptyTasks.hidden = msg.tasks.length > 0;
      setBusy(msg.busy);
      updateMeta();
      setSelfStatus(msg.self);
      setCosts(msg.costs);
      if (!resetting) els.restartOverlay.hidden = true;
      for (const r of msg.messageConfirms || []) showMessageConfirm(r);
      for (const r of msg.computerConfirms || []) computerClient.confirm(r);
      computerClient.state({ driving: Boolean(msg.driving) });
      activity.driving({ driving: Boolean(msg.driving) });
      syncRunListen(Boolean(msg.driving));
      caption.update({ driving: Boolean(msg.driving), waitingForConfirm: (msg.computerConfirms || []).length > 0, question: computerClient.question() });
      syncTaskCards(msg.tasks);
      asks.clear();
      for (const r of [...(msg.messageConfirms || []), ...(msg.computerConfirms || [])]) asks.add(r.id);
      for (const t of msg.tasks) if (t.pendingApproval) asks.add(t.pendingApproval.id);
      renderOrb();
      if (msg.update) setUpdateStatus(msg.update);
      break;
    case 'update': setUpdateStatus(msg.status, msg.notice); break;
    case 'self_status': setSelfStatus(msg.status); break;
    case 'costs': setCosts(msg.costs); break;
    case 'self_unlock_request': showUnlock(msg.request); sfx('attention'); break;
    case 'restarting': showRestarting('Applying update and restarting…'); break;
    case 'resetting': beginResetWait(lastPid); break;
    case 'projects': projects = msg.projects || []; updateMeta(); break;
    case 'stt_partial': onStreamPartial(msg); break;
    case 'stt_ready': onStreamReady(msg); break;
    case 'heard_fix': {
      // A second listen heard it better (lib/secondlisten.js): your last words are put right in place.
      const mine = [...document.querySelectorAll('.msg.you:not(.live-bubble)')].at(-1);
      if (mine) mine.innerHTML = `${escapeHtml(msg.text)}<span class="heard">first heard as: “${escapeHtml(msg.was || '')}”</span>`;
      caption.update({ user: msg.text });
      lastSaid = String(msg.text || '');
      viz.moment('wink'); // it put your words right
      break;
    }
    case 'heard': {
      screenClient.clearLooks(); // a new turn: no "Looking" chip is left over from the one before
      heardAt = Date.now();
      typedLast = Boolean(msg.typed);
      showQuickReplies([]);
      // A new turn of yours: whatever is still being read out from the one before stops now.
      // (Oct 8, 2026: one turn in nine waited 10 to 30 seconds behind the old answer's voice.)
      if (playing || speechQueue.length || sources.size) { timeline('play.cut', { queued: speechQueue.length }, msg.trace); hush(); }
      const bubble = addMsg('you', '');
      // Underline words the recognizer wasn't sure about; show what was originally heard.
      let html = escapeHtml(msg.text);
      for (const w of msg.unsure || []) html = html.replace(new RegExp(`\\b(${escapeRe(escapeHtml(w))})\\b`, 'i'), '<span class="unsure" title="Not sure I heard this right">$1</span>');
      bubble.innerHTML = html + (msg.raw ? `<span class="heard">heard: “${escapeHtml(msg.raw)}”</span>` : '');
      caption.update({ user: msg.text });
      // Kept for "Send anyway", should Echo decide these words weren't for it (the quiet chip).
      lastSaid = msg.typed ? '' : String(msg.text || '');
      appMic.releaseBarge(); // your words are in: she may talk again
      if (msg.images?.length) bubble.prepend(imageGrid(msg.images));
      scrollDown();
      break;
    }
    case 'say_start': gapFiller.stop(); liveBubble = addMsg('ai streaming', ''); karaoke.hold(liveBubble); break;
    case 'say_delta':
      if (!liveBubble) { liveBubble = addMsg('ai streaming', ''); karaoke.hold(liveBubble); }
      // msg.details: what the reply put after its "---" line goes under the bubble, never in it.
      if (msg.details) addDetails(liveBubble, msg.text);
      else karaoke.append(liveBubble, msg.text);
      scrollDown();
      break;
    case 'say_end': liveBubble?.classList.remove('streaming'); karaoke.release(liveBubble); liveBubble = null; break;
    // Sentences of the reply being streamed arrive after their text, so they highlight in its bubble.
    // (Echo's own yes or no, as it starts to say it: its light, if it is out, nods or shakes with it. See nodWith.)
    case 'speak': gapFiller.stop(); tagTurn(liveBubble, msg.trace); nodWith(msg); speak(msg.text, liveBubble, { prev: msg.prev, trace: msg.trace, line: msg.id, last: true }); break;
    // msg.speak: the spoken part when Brief voice is on. msg.details: the rest, under the bubble.
    case 'say': {
      gapFiller.stop();
      const bubble = addMsg('ai', msg.text);
      if (msg.details) addDetails(bubble, msg.details);
      tagTurn(bubble, msg.trace);
      speakAll(msg.speak ?? msg.text, bubble, msg.trace, msg.id);
      break;
    }
    case 'activity': gapFiller.activity(msg.text); activity.say(msg.text); break;
    case 'show_sky': showSky(msg.play === true); break;
    // A line Echo was asked to keep on screen: the Mac app shows it as a small note (TalkLayer.swift).
    case 'pin_note': toApp({ type: 'pinNote', text: String(msg.text || '') }); break;
    // Echo is keeping an eye on a window (lib/watch.js): the Mac app parks a small light on it until the watch ends.
    case 'watch_light': toApp({ type: 'watchLight', id: String(msg.id || ''), app: String(msg.app || ''), on: msg.on === true, done: msg.done === true }); break;
    case 'reply_end':
      skyView.refresh(); // today's constellation may have a new star
      gapFiller.stop();
      replyEnded(Boolean(msg.awaitsReply), Array.isArray(msg.chips) ? msg.chips.slice(0, 3).map(String) : []);
      // It has just asked you something: a tilt of the head while it waits for your answer.
      if (msg.awaitsReply) viz.moment('curious');
      break;
    // (It heard you: a small nod.)
    case 'thinking': screenClient.clearLooks(); heardCue(true); gapFiller.start(); viz.moment('nod'); break;
    case 'hush': hush(); heardCue(false); gapFiller.stop(); break;
    // Quiet mode (you said you can't talk now): nothing is spoken until you speak again; the window says so once.
    case 'quiet_mode': quietMode = msg.on === true; if (quietMode) hush(); if (msg.text) addMsg('ai', msg.text); break;
    case 'busy': if (!msg.busy) gapFiller.stop(); setBusy(msg.busy); break;
    case 'error': addMsg('error', msg.text); sfx('error'); viz.moment('sorry'); break;
    // A sentence was heard but not passed on. The reasons worth telling you about get one short
    // line and the companion's small "sorry"; too faint and heard twice pass without a sign. When
    // Echo chose to stay quiet you spoke and nothing happened at all (six times on Oct 3): now a
    // small chip under your words lets you send them anyway.
    case 'dropped': {
      const line = sorryLine(msg.reason);
      if (line) { liveCap.note(line); viz.moment('sorry'); }
      else if (msg.reason === 'quiet' && lastSaid) { notSureForMe(lastSaid); lastSaid = ''; }
      break;
    }
    // You picked up Echo's light and dropped it on something: shown as what you "said".
    case 'pointed': {
      const what = String(msg.label || msg.role || 'that').slice(0, 80);
      addMsg('you', `Pointed at ${what}${msg.app ? ` in ${String(msg.app).slice(0, 40)}` : ''}`);
      scrollDown();
      break;
    }
    case 'task': {
      const prev = tasks.get(msg.task.id);
      upsertTask(msg.task);
      updateMeta();
      if (prev && prev.status !== msg.task.status) {
        // A worker finished: the companion is pleased, and looks over at the Workers tab for a moment.
        if (msg.task.status === 'done') { sfx('done'); viz.moment('happy'); viz.lookToward(document.querySelector('.tab[data-view="tasks"]'), 1.4); }
        else if (msg.task.status === 'waiting_approval') sfx('attention');
        else if (msg.task.status === 'failed') { sfx('error'); viz.moment('sorry'); }
        else if (msg.task.status === 'running' && prev.status === 'queued') sfx('start');
      }
      break;
    }
    case 'task_log': appendLog(msg.taskId, msg.entry); break;
    case 'settings': applySettings(msg.settings); break;
    case 'voiceBudget': voiceCatalog.budget = msg.budget; break;
    // A sentence set aside as not for Echo (the TV, another language): a "Was that for me?" chip, never silence.
    case 'set_aside': if (msg.heard) wasThatForMe(msg.heard); break;
    // The server changed how Echo listens ("go quiet", its name, three quiet minutes): said in a line, with a blink.
    case 'listen_mode': applyListenMode(msg.mode); if (msg.line) liveCap.note(msg.line); viz.moment('wink'); break;
    case 'listen_state': listenServer = { talk: msg.talk || null, closed: Boolean(msg.closed) }; renderWindow(); syncNativeMic(); break;
    case 'approval_stale': toast('That request was already answered.'); settleTaskCard(msg.approvalId, null); answered(msg.approvalId, null); break;
    case 'task_event':
      addTaskCard(msg.event);
      if (msg.event.kind === 'approval') { sfx('attention'); if (msg.event.approvalId) asks.add(msg.event.approvalId); renderOrb(); }
      break;
    case 'approval_resolved': settleTaskCard(msg.approvalId, msg.allowed); answered(msg.approvalId, msg.allowed); break;
    case 'message_confirm': showMessageConfirm(msg.request); sfx('attention'); asks.add(msg.request.id); renderOrb(); break;
    case 'message_resolved': settleMessageConfirm(msg); answered(msg.id, msg.sent); break;
    case 'screen_request': screenClient.request(msg); break;
    case 'screen_done': screenClient.done(msg.id); break;
    case 'computer_state':
      computerClient.state(msg);
      activity.driving(msg);
      // Busy on the Mac: its eyes go along the work instead of looking up in thought.
      viz.setWorking(Boolean(msg.driving));
      syncRunListen(Boolean(msg.driving));
      caption.update({ driving: Boolean(msg.driving), app: msg.app || '', waitingForConfirm: Boolean(msg.waitingForConfirm) });
      break;
    case 'computer_confirm': computerClient.confirm(msg.request); sfx('attention'); asks.add(msg.request.id); renderOrb(); caption.update({ waitingForConfirm: true, question: computerClient.question() }); break;
    case 'computer_resolved': {
      computerClient.resolved(msg);
      answered(msg.id, msg.allowed);
      const question = computerClient.question();
      caption.update({ waitingForConfirm: Boolean(question), question });
      break;
    }
    case 'lesson_card': {
      // The strip says which step the lesson is on, with Stop; its last card says how it ended.
      activity.guide({ step: msg.step, total: msg.total, say: msg.current, finished: Boolean(msg.finished), done: Boolean(msg.complete) });
      if (lessonOn !== !msg.finished) { lessonOn = !msg.finished; syncNativeMic(); }
      // A lesson step passed: the orb nods; the last one: it celebrates (Mac app, Pointer.swift
      // moment). Once per step: the last step's card comes again when the lesson ends.
      const key = `${msg.id}:${msg.step}`;
      if (msg.state === 'correct' && key !== lessonMoment) {
        lessonMoment = key;
        const moment = msg.step >= msg.total ? 'celebrate' : 'proud';
        viz.moment(moment);
        toApp({ type: 'companion', moment });
      }
      break;
    }
    case 'explain_card': showExplain(msg); break;
    case 'browser': refreshChrome(); break;
    case 'undo_offer': showUndo(msg.offer); break;
    case 'undo_done': settleUndo(msg.id, msg.ok ? 'Undone ✓' : "Couldn't undo"); break;
    case 'undo_failed': settleUndo(msg.id, msg.message || "Couldn't undo"); toast(msg.message || "Couldn't undo it."); break;
  }
}

/* ---------- the gap filler: never a silent wait ---------- */
// About 4 s after she heard you with nothing said yet, one quiet line under the orb says what
// she's doing ("Reading the page…"), from the tool she's using. Nothing is spoken.
const DOING = [
  [/^(look_at_screen)/, 'Looking at your screen…'], [/^(observe_screen)/, 'Reading the page…'], [/^(compose_email)/, 'Writing the email…'],
  [/^(click|act|batch_actions|hover|drag)/, 'Working on the screen…'], [/^(type_text|clear_field)/, 'Typing…'], [/^(find_file|reveal_file)/, 'Searching your files…'],
  [/^(start_task|start_project|start_research|follow_up)/, 'Starting a worker…'], [/^(find_contact|send_imessage)/, 'Getting the message ready…'],
  [/^(WebSearch|web)/i, 'Looking it up…'], [/^(open_url|open_app|open_settings_pane)/, 'Opening it…'], [/^(save_from_url)/, 'Downloading it…'],
];
const GAP_MS = 4000;
const gapFiller = (() => {
  /** @type {any} */
  let timer = 0;
  let doing = '';
  return {
    start() {
      clearTimeout(timer);
      doing = '';
      timer = setTimeout(() => liveCap.note(doing || 'Still on it…'), GAP_MS);
    },
    /** @param {string} text a tool call, "name {args}" */
    activity(text) {
      doing = DOING.find(([re]) => re.test(String(text)))?.[1] || doing;
    },
    stop() {
      clearTimeout(timer);
      timer = 0;
    },
  };
})();

/* ---------- The orb's busy and "heard you" states ---------- */
let busy = false;
/** A lesson is on (you are doing its steps with your own hands). */
let lessonOn = false;
function setBusy(b) {
  const was = busy;
  busy = b;
  // (The mic's end-of-sentence pause depends on whether Echo is in the middle of something.)
  if (was !== b) syncNativeMic();
  if (!b) { heardCue(false); activity.say(''); }
  renderOrb();
}
// The instant "heard you" cue: no words, the mark (and caption bar) goes to thinking at once.
let heard = false;
/** @type {any} */
let heardTimer = 0;
function heardCue(on) {
  clearTimeout(heardTimer);
  heard = on;
  if (on) {
    heardTimer = setTimeout(() => heardCue(false), 30000);
  }
  renderOrb();
}



/* ---------- Audio engine ---------- */
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const outAnalyser = ctx.createAnalyser();
outAnalyser.fftSize = 512;
outAnalyser.smoothingTimeConstant = 0.6;
// Echo's voice goes through its own volume, so a barge-in can lower it at once (soft barge-in).
const voiceGain = ctx.createGain();
outAnalyser.connect(voiceGain).connect(ctx.destination);
/** Lower Echo's voice right away (you may be talking over her), or bring it back. */
const duckVoice = (on) => voiceGain.gain.setTargetAtTime(on ? 0.18 : 1, ctx.currentTime, on ? 0.02 : 0.08);
const unlockAudio = () => ctx.state === 'suspended' && ctx.resume();
// After a long quiet stretch Echo answered in text and nothing was heard, though the page had
// "played" every line (Oct 4, 2026: silent after two and a half hours, no stall, the Mac's
// volume at 94). The sound output can go stale under a context that still says "running" (the
// Mac slept, the output changed, the hardware idled). So before the first line after a quiet
// stretch, and after anything that may have changed the output, the output is opened afresh:
// the context is suspended and resumed, and the voice's own volume is put back to full.
/** A quiet stretch this long, and the output is opened afresh before Echo speaks. */
const QUIET_FRESH_MS = 90_000;
let lastSoundAt = performance.now();
let outputMayBeStale = false;
/** @type {Promise<void> | null} */
let freshening = null;
/** Never longer than this: a line must not wait on the sound system. */
const FRESH_MAX_MS = 600;
function freshOutput(why) {
  if (freshening) return freshening;
  const idleS = Math.round((performance.now() - lastSoundAt) / 1000);
  const before = ctx.state;
  const work = (async () => {
    try { await ctx.suspend(); } catch {}
    try { await ctx.resume(); } catch {}
    try { voiceGain.gain.cancelScheduledValues(ctx.currentTime); voiceGain.gain.setValueAtTime(1, ctx.currentTime); } catch {}
  })();
  freshening = Promise.race([work, new Promise((r) => setTimeout(r, FRESH_MAX_MS))]).then(() => {
    outputMayBeStale = false;
    lastSoundAt = performance.now();
    timeline('audio.fresh', { why, before, after: ctx.state, idleS });
    freshening = null;
  });
  return freshening;
}
/** Is the output due to be opened afresh before this line? (A reply under way is never touched.) */
const outputDue = () => !sources.size && (outputMayBeStale || ctx.state !== 'running' || performance.now() - lastSoundAt > QUIET_FRESH_MS);
const staleOutput = () => { outputMayBeStale = true; };
navigator.mediaDevices?.addEventListener?.('devicechange', staleOutput);
document.addEventListener('visibilitychange', () => { if (!document.hidden) staleOutput(); });
window.addEventListener('pageshow', staleOutput);
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

// Little synthesized sound effects, so the app feels alive without any audio files.
function sfx(kind) {
  if (!settings.sounds || ctx.state !== 'running') return;
  const notes = {
    listen: [[660, 0], [880, 0.07]],
    wake: [[784, 0], [1175, 0.09]], // "Hey Echo" heard
    stop: [[880, 0], [587, 0.07]],
    windowOpen: [[740, 0], [988, 0.06]], // the conversation window opens (just talk)
    windowClose: [[587, 0], [440, 0.09]], // …and closes ("hang up")
    send: [[988, 0]],
    start: [[523, 0], [659, 0.06]],
    done: [[523, 0], [659, 0.08], [784, 0.16], [1047, 0.24]],
    attention: [[880, 0], [880, 0.18]],
    error: [[330, 0], [247, 0.12]],
  }[kind];
  if (!notes) return;
  const t0 = ctx.currentTime;
  for (const [freq, at] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(kind === 'send' ? 0.05 : kind.startsWith('window') ? 0.035 : 0.12, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.25);
  }
}

/* ---------- Speech output ---------- */
// Each piece (one or more whole sentences, lib/speech.js) is fetched as soon as it arrives, so the
// next one is ready while this one plays. Pieces are scheduled on the audio clock with the
// engine's padding trimmed off and a short natural pause between them (a breath after a sentence),
// so there's no dead air and no pieces run together.
const speechQueue = [];
let playing = null;
let speaking = false;
let speechGen = 0;
let playEnd = 0; // audio-clock time when everything scheduled so far has been said
let lastSpoken = ''; // text of the piece scheduled last, for the pause after it
const sources = new Set(); // audio still sounding (the previous piece can overlap the handover)

function splitSentences(text) {
  return (text.match(/[^.!?\n]+[.!?]*["')\]]?/g) || [text]).map((s) => s.trim()).filter((s) => s.length > 1);
}
/** A whole reply at once: grouped the same way as streamed ones (the first sentence on its own, so
 * it's voiced sooner, unless it's a tiny opener; then ~30 words). */
function speakAll(text, bubble = null, trace = undefined, line = undefined) {
  const groups = [];
  let cur = [];
  let words = 0;
  for (const s of splitSentences(text)) {
    const n = s.split(/\s+/).length;
    const full = groups.length === 0 ? cur.length >= 2 || words >= 3 : words >= 8 && words + n > 30;
    if (cur.length && full) {
      groups.push(cur.join(' '));
      cur = [];
      words = 0;
    }
    cur.push(s);
    words += n;
  }
  if (cur.length) groups.push(cur.join(' '));
  let prev = '';
  for (const g of groups) {
    speak(g, bubble, { prev, trace, line, last: g === groups.at(-1) });
    prev = g;
  }
  karaoke.release(bubble);
}

// Word-by-word highlighting of the reply as it's spoken (karaoke.js). The clock is the audio
// context's, shifted by the output latency so the glow lands when you hear the word.
const karaoke = createKaraoke({ now: () => ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) });

/**
 * @param {string} text @param {HTMLElement | null} [bubble]
 * @param {{ prev?: string, soft?: boolean, trace?: string, line?: string, last?: boolean }} [o]  prev: the piece before (the voice carries its
 *   intonation on); soft: quieter, for a "didn't catch that"; trace: the turn it belongs to (its first sound is timed);
 *   line: the server's id for the line this piece belongs to, and last: it is that line's last piece (voiceEvent)
 */
let quietMode = false;
function speak(text, bubble = null, { prev = '', soft = false, trace = undefined, line = undefined, last = false } = {}) {
  if (line) lastLine = line;
  if (quietMode || !els.speakOut.checked || !text.trim()) return;
  // You're holding Space to talk: the rest of the old reply stays quiet (it's in the chat).
  if ((listening && pttRecording) || appMic.ptt) return;
  // You cut in while she was talking: the rest of that reply stays quiet until you've been heard.
  if (appMic.barge.holding) return;
  // fresh: nothing was ahead of it, so its start tells how long the voice takes to start.
  const item = { text, gen: speechGen, chunk: karaoke.bind(bubble, text), words: null, soft, trace, line, last, fresh: !playing && !speechQueue.length && !sources.size };
  voiceEvent('queued', item);
  if (settings.ttsProvider !== 'browser') {
    item.controller = new AbortController();
    item.audio = fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(prev && { previousText: prev }) }),
      signal: item.controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error('tts ' + r.status);
        // Real word timings when the engine has them (ElevenLabs).
        try { item.words = JSON.parse(decodeURIComponent(r.headers.get('X-Echo-Words') || '')) || null; } catch {}
        return r.arrayBuffer();
      })
      .then((buf) => ctx.decodeAudioData(buf));
    item.audio.catch(() => {});
  }
  speechQueue.push(item);
  setSpeaking(true);
  if (!playing) playNext();
  else playing.handOver?.();
}

async function playNext() {
  const item = speechQueue.shift();
  if (!item) {
    playing = null;
    // The last piece may still be sounding after an early handover.
    if (!sources.size) setSpeaking(false);
    return;
  }
  playing = item;
  caption.update({ echo: item.text });
  let browser = false;
  try {
    if (!item.audio) throw new Error('browser voice');
    const buffer = await item.audio;
    if (item.gen !== speechGen) return;
    if (outputDue()) await freshOutput(outputMayBeStale ? 'changed' : ctx.state !== 'running' ? ctx.state : 'quiet');
    if (item.gen !== speechGen) return;
    await new Promise((resolve) => {
      const src = ctx.createBufferSource();
      // Only the speech itself (the engine's padding trimmed), a natural pause after the piece
      // before it; or now, if that pause has already gone by while this piece was being made.
      const { offset, length } = playPlan(speechBounds(buffer.getChannelData(0), buffer.sampleRate), buffer.duration);
      const at = Math.max(ctx.currentTime + 0.02, playEnd + pieceGap(lastSpoken, settings.speed));
      playEnd = at + length;
      lastSpoken = item.text;
      const times = item.words ? alignTimings(item.text, item.words)?.map((t) => ({ s: Math.max(0, t.s - offset), e: Math.max(0, t.e - offset) })) : null;
      if (item.chunk) karaoke.play(item.chunk, { start: at, duration: length, times, bounds: times ? undefined : { lead: 0.02, tail: 0.02 } });
      // The caption pill lights up the same words at the same moments (on the wall clock).
      const heardAt = Date.now() + (at - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
      voiceStarted(item.trace, heardAt);
      caption.update({ echoTimes: captionTimes(times || estimateTimings(item.text, length, { lead: 0.02, tail: 0.02 }), heardAt) });
      src.buffer = buffer;
      if (item.soft) {
        const g = ctx.createGain();
        g.gain.value = 0.55;
        src.connect(g).connect(outAnalyser);
      } else src.connect(outAnalyser);
      sources.add(src);
      let handed = false;
      const handOver = () => { if (!handed) { handed = true; resolve(); } };
      // onended never fires if the context stalls (suspended, device change), which would leave
      // Echo "speaking" forever and everything that waits on her stuck; so cap it on the wall clock.
      const guard = setTimeout(() => { timeline('play.stalled', {}, item.trace); try { src.stop(); } catch {} ended(); }, (playEnd - ctx.currentTime) * 1000 + 3000);
      const ended = () => {
        clearTimeout(guard);
        if (sources.delete(src)) {
          lastSoundAt = performance.now();
          timeline('play.end', {}, item.trace);
          voiceEvent('end', item, Math.round(length * 1000));
        }
        karaoke.finish(item.chunk);
        handOver();
        if (!sources.size && !playing && !speechQueue.length) setSpeaking(false);
      };
      src.onended = ended;
      item.stop = () => { try { src.stop(); } catch {} ended(); };
      // As soon as the next piece is waiting, move on to it: it's scheduled to start exactly
      // when this one ends. (speak() calls handOver when a piece arrives later.)
      item.handOver = handOver;
      if (speechQueue.length) handOver();
      src.start(at, offset, length);
      timeline('play.start', { chars: item.text.length, ms: Math.round(heardAt - Date.now()), soft: Boolean(item.soft), ctx: ctx.state, gain: Math.round(voiceGain.gain.value * 100) / 100 }, item.trace);
      voiceEvent('start', item, Math.round(heardAt - Date.now()));
    });
  } catch {
    if (item.gen !== speechGen) return;
    browser = true;
    const from = Date.now();
    await browserSpeak(item);
    voiceEvent('end', item, Date.now() - from);
  }
  if (browser) karaoke.finish(item.chunk);
  if (item.gen === speechGen) playNext();
  else if (playing === item) playing = null;
}

/** The id of the last line the server asked for, spoken or not. */
let lastLine;
/**
 * Tell the server what the voice is doing with a line it asked for (lib/voicestate.js), so what
 * waits for the line to end waits for the real end: 'queued' (it will be voiced), 'start' (audible
 * in `ms`), 'end' (this piece is over after `ms`; `last`: so is the line). Only ids and numbers.
 */
function voiceEvent(event, item, ms = 0) {
  if (!item.line) return;
  send({ type: 'voice', event, id: item.line, ...(item.trace && { trace: item.trace }), chars: item.text.length, ms: Math.max(0, ms), ...(event === 'end' && item.last && { last: true }), ...(event === 'start' && item.fresh && { fresh: true }) });
}

/** Turns whose first sound has been reported. */
const soundReported = new Set();
/** Echo's voice for this turn becomes audible at `at` (wall clock): told to the server once per turn. */
function voiceStarted(trace, at) {
  if (!trace || soundReported.has(trace)) return;
  soundReported.add(trace);
  if (soundReported.size > 50) soundReported.delete(soundReported.values().next().value);
  send({ type: 'voice_started', trace, at: Math.round(at) });
}

function browserSpeak(item) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(item.text);
    const v = speechSynthesis.getVoices().find((x) => x.name === settings.browserVoice) ||
      speechSynthesis.getVoices().find((x) => /premium|enhanced|siri|samantha/i.test(x.name));
    if (v) u.voice = v;
    u.rate = settings.speed;
    if (item.soft) u.volume = 0.6;
    // Chrome sometimes never fires onend; allow ~2.5 words a second plus slack before giving up.
    const words = item.text.split(/\s+/).length;
    const guard = setTimeout(() => { speechSynthesis.cancel(); resolve(); }, (words / 2.5 / (settings.speed || 1)) * 1000 + 5000);
    u.onend = u.onerror = () => { clearTimeout(guard); resolve(); };
    // The pill has no word timings from the browser's voice up front: an estimate at her pace.
    u.onstart = () => {
      voiceStarted(item.trace, Date.now());
      caption.update({ echoTimes: captionTimes(estimateTimings(item.text, words / 2.6 / (settings.speed || 1)), Date.now()) });
      voiceEvent('start', item);
    };
    u.onboundary = (e) => { if (e.name === 'word' || e.name === undefined) karaoke.boundary(item.chunk, e.charIndex); };
    item.stop = () => { clearTimeout(guard); speechSynthesis.cancel(); resolve(); };
    speechSynthesis.speak(u);
  });
}

// Task events wait while Echo is speaking or hearing you, so they never cut in (the server holds
// them: dispatcher.setVoiceBusy).
let voiceBusySent = false;
function reportVoiceBusy(force = false) {
  // An open answer window counts too, so a task update doesn't talk over your answer.
  const b = Boolean(speaking || hearing || appMic.hearing || appMic.ptt || transcribing || listening && spaceHeld || wakeState === 'awake' || (autoListen.isOpen && autoListen.mode === 'answer'));
  if (b === voiceBusySent && !force) return;
  voiceBusySent = b;
  send({ type: 'voice_busy', busy: b });
}

function setSpeaking(on) {
  if (speaking === on) return;
  speaking = on;
  if (!on) {
    // Nothing is queued or playing: every line the server asked for so far is over.
    send({ type: 'voice', event: 'idle', id: lastLine });
    echoQuietUntil = performance.now() + ECHO_TAIL_MS;
    lastSpokeAt = performance.now();
    lastSpokeWall = Date.now();
    // She asked you something: the mic opens for your answer once her voice has died away, no
    // Space or "Hey Echo" needed (public/autolisten.js). hush() clears lastSpoken and the server's
    // mark first, so a hushed reply doesn't count. Mid-turn (a tool call follows) waits for reply_end.
    const question = !busy && (awaitsAnswer(lastSpoken) || replyAwaits);
    if (!busy) questionOpen = question;
    engagedFrom(lastSpokeAt);
    replyAwaits = false;
    autoListen.speechEnded({ question });
  } else autoListen.speechStarted();
  if (on) pauseHandsFree();
  else resumeHandsFree();
  renderOrb();
}

function hush() {
  speechGen++;
  for (const item of speechQueue.splice(0)) item.controller?.abort();
  playing?.stop?.();
  playing?.controller?.abort();
  playing = null;
  for (const src of sources) { try { src.stop(); } catch {} }
  sources.clear();
  playEnd = 0;
  lastSpoken = '';
  replyAwaits = false;
  speechSynthesis.cancel();
  karaoke.stopAll();
  setSpeaking(false);
  // Whatever she says next starts at full volume (a soft barge-in may have lowered it).
  duckVoice(false);
}

/* ---------- Speech input ---------- */
// Two ways to hear you:
//  - Server engines (local Whisper, Deepgram): this page records your voice, notices when you
//    stop talking, and sends the clip to Echo for transcription + correction.
//  - Browser recognition (Chrome's built-in engine): the fallback. It's also used, display-only,
//    to preview your words live while a server engine does the real transcription.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let sttActive = 'browser'; // resolved engine from the server
let listening = false; // mic open for you
let hearing = false; // you're mid-sentence (hands-free detector)
let transcribing = false;
let micAnalyser = null;
let micReady = null;
let micTrack = null;
let tapLoaded = false;
let micNodes = [];

const serverEngine = () => sttActive !== 'browser';

/* --- the one listening engine --- */
// In the Mac app, its own mic is the only microphone and one state machine there decides
// everything (macos/Sources/NativeMic.swift, VoiceMath.swift ListenMachine): Space, the mic button,
// Control + Option, "Hey Echo", the conversation window, a driving session and hands-free. The
// page says what to listen for (syncNativeMic) and draws the state the app reports (renderOrb,
// renderWindow); public/nativemic.js turns the app's events into what happens here. The page
// never opens its own mic for listening then. Everything below about the page's own mic (the
// loudness detector, the pre-roll, the wake listener, the browser's recognizer) is the fallback
// for a plain browser tab, or for when the app's mic can't be used.
let nativeLevel = { v: 0, at: -Infinity }; // your voice level from the app's mic, for the orb
const appMic = new AppMic({
  post: (msg) => toApp(msg),
  hush: () => hush(),
  duck: (on) => duckVoice(on),
  sfx: (name) => sfx(name),
  surprised: () => { viz.moment('surprised'); toApp({ type: 'companion', moment: 'surprised' }); },
  note: (text) => liveCap.note(text),
  words: (text) => { liveCap.set(text); caption.update({ user: liveCap.text }); },
  clearWords: () => liveCap.clear(),
  level: (v) => { nativeLevel = { v, at: performance.now() }; },
  // The words so far look finished: the server gets ahead while the app makes sure (never a turn by itself).
  probablyDone: (text, notes) => send({ type: 'probably_done', text, ...notes }),
  // The same pipeline as the page's own clips (sendClip → POST /api/utterance).
  send: (wav, live, notes) => sendClip(new Blob([wav], { type: 'audio/wav' }), live, notes),
  bargeOn: () => settings.bargeIn !== false,
  // The browser's own voice can't be lowered: it stops at once instead.
  canDuck: () => settings.ttsProvider !== 'browser',
  confirmMs: () => Math.max(BARGE_CONFIRM_MS, (settings.endSilenceMs || 1300) + 400),
  livePreview: () => settings.livePreview !== false,
  sinceReplyMs: () => sinceReplyMs(),
  followUpMs: () => followUpMs(),
  // The server is told speech has begun (and when it came to nothing): a short sentence it is
  // holding for the rest of the thought waits for this one (lib/server/speech.js onset).
  heard: () => { send({ type: 'onset' }); if (autoListen.isOpen) autoListen.heard(); },
  ended: (reason, delivered, why) => {
    if (!delivered && reason !== 'ptt') send({ type: 'onset', over: true });
    if (reason === 'ptt' && delivered) pttHint.used();
    if (!autoListen.isOpen) return;
    if (delivered) autoListen.answered();
    else if (why === 'too_short') autoListen.notSpeech();
  },
  changed: () => renderOrb(),
});
/** Something can turn the app's sentences into text: Echo's server engine, or Apple's model in the app. */
const nativeEngine = () => serverEngine() || Boolean(appMic.app.appleReady);
/** This is the Mac app, it has a mic of its own, and it hasn't been refused or switched off (Settings). */
const appAvailable = () => Boolean(nativeApp() && macPerms?.nativeMic && settings.nativeMic !== false && appMic.app.permission !== 'denied');
/** The Mac app owns listening: its mic is allowed and its engine answers. The page's mic stays shut. */
const inApp = () => appAvailable() && nativeEngine() && appMic.usable;
/** In the Mac app, before it's known whether its mic can be used: the page's mic waits rather than open too. */
let sttKnown = false;
const appPending = () => Boolean(nativeApp()) && settings.nativeMic !== false && (!macPerms || !sttKnown || (Boolean(macPerms.nativeMic) && (!appMic.app.known || appMic.app.permission === 'ask')));

// A mic stream held for hours can go dead (the Mac slept, the input device changed, or another
// capture took the mic): it keeps delivering silence, so every clip transcribes as "." while the
// live preview, which opens its own capture, still shows your words. So the stream is dropped and
// opened again whenever it's ended, muted or caught sending pure silence.
function dropMic(why) {
  if (!micReady) return;
  console.warn('[mic] reopening:', why);
  micReady = null;
  for (const node of micNodes) try { node.disconnect(); } catch {}
  micNodes = [];
  try { micTrack?.stop(); } catch {}
  micTrack = null;
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!listening) dropMic('input device changed'); });

async function ensureMic() {
  if (micReady && micTrack && (micTrack.readyState !== 'live' || micTrack.muted)) dropMic(`track ${micTrack.readyState}${micTrack.muted ? ', muted' : ''}`);
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  if (micReady) return micReady;
  micReady = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    micTrack = stream.getAudioTracks()[0] || null;
    const source = ctx.createMediaStreamSource(stream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 256;
    source.connect(micAnalyser);
    // Frames of 1024 samples (~21 ms), not the worklet's 128: the mic stays open for the wake word,
    // so fewer, bigger messages keep the page's idle CPU down.
    const tapCode = `class Tap extends AudioWorkletProcessor { constructor() { super(); this.b = new Float32Array(1024); this.n = 0; } process(inputs) { const ch = inputs[0][0]; if (ch) for (let i = 0; i < ch.length; i++) { this.b[this.n++] = ch[i]; if (this.n === 1024) { this.port.postMessage(this.b.slice(0)); this.n = 0; } } return true; } } registerProcessor('tap', Tap);`;
    if (!tapLoaded) await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([tapCode], { type: 'application/javascript' })));
    tapLoaded = true;
    const tap = new AudioWorkletNode(ctx, 'tap');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(tap).connect(mute).connect(ctx.destination); // keeps the tap running, silently
    tap.port.onmessage = (e) => onAudio(e.data);
    micNodes = [source, tap, mute];
  })();
  micReady.catch(() => {
    micReady = null;
    els.state.textContent = 'Microphone blocked — allow it in the address bar.';
  });
  return micReady;
}

/* --- capture + end-of-speech detection --- */
const PRE_ROLL_MS = 350; // keep a little audio from before you started, so first syllables aren't clipped
const PTT_TAIL_MS = 350; // keep recording briefly after you release Space, so last words aren't clipped
let preRoll = [];
let clip = null; // Float32Array chunks of the current utterance
let pttRecording = false;
let noiseFloor = 0.004;

// Transcribe while you talk (public/sttstream.js, lib/sttstream.js): each clip's audio also goes to
// Echo as it's recorded, so local Whisper works through it during your pauses. Its words so far
// show live, and when you stop, the text is usually ready already. The finished clip is still sent
// as before and is what counts.
let streamOn = false; // local Whisper, and not turned off on the server (GET /api/stt)
let streamSource = ''; // 'wake' or 'clip': who started the current stream
const sttStream = new StreamClient({
  rate: ctx.sampleRate,
  sendJson: send,
  sendBinary: (data) => ws?.readyState === 1 && ws.send(data),
  threshold: () => Math.max(0.01, noiseFloor * 3.5),
  // Whisper's words so far only when the browser's own live preview shows none.
  wantPartials: () => settings.livePreview !== false && isBlank(liveText()),
});
/** @param {string} mode @param {Float32Array[]} frames what the clip holds already */
function streamBegin(mode, frames) {
  if (!streamOn || !serverEngine() || ws?.readyState !== 1) return;
  sttStream.begin(mode, frames);
  streamSource = mode === 'wake' ? 'wake' : 'clip';
}
/** Your words so far, from Whisper: shown when the browser's own live preview has none. */
function onStreamPartial(msg) {
  if (msg.id !== sttStream.id || settings.livePreview === false || !isBlank(liveText())) return;
  liveCap.set(msg.text);
  caption.update({ user: liveCap.text });
}
// Transcribed at your pause, and it's an instant command ("stop", "scroll down", "pause"): no need
// to wait out the rest of the end-of-speech pause. If you've started talking again, it waits.
const INSTANT_MAX_WORDS = 4;
function onStreamReady(msg) {
  if (!msg.instant || msg.id !== sttStream.id || !sttStream.paused || msg.words > INSTANT_MAX_WORDS) return;
  if (hearing && !pttRecording) finishClip();
  else if (streamSource === 'wake' && wake.state === 'awake') wake.finish();
  else if (pttRecording && listening && !spaceHeld) stopListening();
}
let voicedMs = 0;
let silentMs = 0;

// Echo's own voice must never become part of what you said. Echo cancellation is asked for (and
// its state saved with each clip), and on top of that the mic ignores everything while Echo speaks
// and for a short tail after (the room and the speakers' latency): the pre-roll is emptied, so a
// clip never starts with the end of Echo's reply, and hands-free doesn't hear her as you.
const ECHO_TAIL_MS = 400;
let echoQuietUntil = 0;
// Hands-free with the wake word on: speech right after Echo's reply is a follow-up, so it doesn't
// need her name (Settings → follow-up window; the server checks: lib/addressed.js addressedToEcho).
const followUpMs = () => (Number(settings.followUpSeconds) || 45) * 1000;
/** How long ago her last reply ended (the server also lets on-topic speech through a while later). */
const sinceReplyMs = () => (Number.isFinite(lastSpokeAt) ? Math.round(performance.now() - lastSpokeAt) : undefined);
let lastSpokeAt = -Infinity;
let lastSpokeWall = NaN; // the same moment on the wall clock, which the Mac app shares
// Conversation mode: after her reply (the follow-up window, reset on every exchange) and for as
// long as her question is still open, the Mac app's mic keeps listening without "Hey Echo", so a
// plain "yeah" reaches her. The server still judges each sentence (lib/addressed.js).
let questionOpen = false; // her last reply asked something, and nothing has answered it yet
let engagedTimer = 0;

/* --- the conversation window, shown (Stage 1 listening, lib/flags.ts session) --- */
/** What the server says about Talk mode and "thanks" (lib/session.ts), kept in step by listen_state. */
let listenServer = { talk: null, closed: false };
/** The window right now, from what this page knows (public/convwindow.js). */
function convWindow() {
  return windowState({ working: Boolean(autoListen.driving), sinceReplyMs: sinceReplyMs(), asked: questionOpen, talk: listenServer.talk, closed: listenServer.closed, now: Date.now() });
}
/** The mic really is taking in everything said (never show "listening" when it isn't): in the Mac app, only when the app says so. */
function micLive() {
  return inApp() ? appMic.live : !micOff && (els.handsFree.checked || autoListen.isOpen);
}
let windowShown = false;
/** The ring and its words under the orb, the caption bar's status, and a soft chime as it opens and closes. */
function renderWindow() {
  const w = convWindow();
  // While Echo speaks or thinks, those states show instead; the window counts from when it stops.
  const show = w.open && micLive() && (w.why === 'working' || (!speaking && !busy));
  const box = $('convWindow');
  box.hidden = !show;
  // The countdown is the app's own, when it counts one (it closes the window, not the page).
  const left = inApp() ? appMic.windowLeftMs() : 0;
  if (left) w.leftMs = Math.min(left, w.totalMs || left);
  if (show) {
    $('cwLabel').textContent = windowLabel(w);
    box.dataset.why = w.why;
    const frac = w.totalMs ? Math.max(0, Math.min(1, w.leftMs / w.totalMs)) : 1;
    $('cwLeft').style.strokeDashoffset = String((1 - frac) * 50.27);
  }
  caption.update({ windowLabel: show ? windowLabel(w) : '' });
  // Chimes: opening after Echo speaks; closing when it runs out or "thanks" closes it (not when
  // Echo starts talking again, which is the conversation going on).
  if (show && !windowShown) sfx('windowOpen');
  else if (!show && windowShown && !speaking && !busy) sfx('windowClose');
  windowShown = show;
}
setInterval(renderWindow, 250);
/** When the follow-up window runs out, the app's mic goes back to waiting for "Hey Echo". */
function engagedFrom(now) {
  clearTimeout(engagedTimer);
  engagedTimer = setTimeout(renderOrb, Math.max(0, lastSpokeAt + followUpMs() - now) + 100);
}

// Auto-listen (public/autolisten.js): after a reply that asks you something, the mic opens for a
// few seconds once she's completely done (her audio ended, plus the echo tail), with a soft pulse
// and a thin "Listening…" line, no chime. Speak and it goes through the usual pipeline (silence
// trimming, the server's phantom and own-voice filters); stay quiet and it closes by itself.
// While she drives the Mac (computer use), it stays open between her words: "stop" ends the run,
// anything else reaches her next step. Only the mic listens: no key or mouse input, so it never
// counts as taking back control.
let replyAwaits = false; // the server marked the current reply as waiting for an answer
let autoCapture = false; // the page is capturing for auto-listen itself (not hands-free or push-to-talk)
const autoListen = new AutoListen({
  windowMs: autoListenMs(undefined),
  tailMs: ECHO_TAIL_MS + 50,
  canOpen: (mode) => canAutoListen(mode),
  onOpen: () => autoOpened(),
  onClose: (reason) => autoClosed(reason),
});
/** @param {'answer' | 'run'} mode */
function canAutoListen(mode) {
  if (micOff || wizard.isOpen() || !els.modal.hidden) return false;
  if (!SR && !serverEngine()) return false;
  // The page can't hear until you've clicked once (the Mac app's own mic can).
  if (ctx.state !== 'running' && !inApp()) return false;
  if (pttRecording || spaceHeld || appMic.ptt || wakeState === 'awake') return false;
  if (listening && !els.handsFree.checked) return false;
  if (echoing()) return false;
  if (mode === 'run') return settings.listenDuringRuns !== false;
  return autoListen.windowMs > 0;
}
function autoOpened() {
  // Hands-free is listening already; the window only lets your answer through without "Echo".
  // In the Mac app its mic is armed for the window (nativeMicPlan); the page doesn't capture.
  if (!els.handsFree.checked && !inApp() && !appPending()) {
    autoCapture = true;
    ensureMic().catch(() => autoListen.close('no_mic'));
    wake.reset();
    startRec();
  }
  renderOrb();
}
/** @param {string} reason */
function autoClosed(reason) {
  const was = autoCapture;
  // Echo started talking while you were mid-sentence: what you said so far still goes through
  // (her voice isn't in it: the clip stops before her audio starts).
  if (was && hearing && reason === 'speaking') finishClip();
  autoCapture = false;
  if (was) {
    hearing = false;
    clip = null;
    sttStream.cancel();
    silentMs = 0;
    voicedMs = 0;
    if (!listening) {
      clearTimeout(silenceTimer);
      stopRec();
      resetLive();
      if (!els.handsFree.checked && !wakeOn()) dropMic('auto-listen closed');
    }
  }
  renderOrb();
}
/** When you last circled something with the light, and when Echo last heard or read something from you. */
let drewAt = 0, heardAt = 0;
/** Nothing heard this long after a drawing: you said nothing, so the box to type in opens. */
const DRAW_BOX_AFTER_MS = 1400;
/** Was your last message typed (in the window, or in the island's reply field) rather than spoken? */
let typedLast = false;
/** How long the island offers its reply field after a reply to something you typed. */
const TYPED_OFFER_MS = 30000;
/** The likely answers to Echo's question, as buttons above the composer (only while you are typing). @param {string[]} chips */
function showQuickReplies(chips) {
  const box = $('quickReplies');
  box.replaceChildren(...chips.map((c) => {
    const b = el('button', { type: 'button' }, c);
    b.onclick = () => { showQuickReplies([]); caption.update({ asks: false }); sfx('send'); send({ type: 'user_text', text: c, typed: true }); };
    return b;
  }));
  box.hidden = chips.length === 0;
}
/** The server's word on whether the reply that just ended waits for an answer. */
function replyEnded(awaits, chips = []) {
  // Ending on a question: the caption pill offers its reply field, for typing from another app.
  // And when your last message was typed, you are likely to answer by typing: the field is
  // offered for half a minute after any reply, and a question's likely answers come as chips.
  const offer = awaits || typedLast;
  caption.update({ asks: offer, chips: (awaits ? chips : []).join('\n'), ...(awaits ? {} : { offerMs: TYPED_OFFER_MS }) });
  showQuickReplies(awaits && typedLast ? chips : []);
  questionOpen = Boolean(awaits);
  renderOrb();
  if (!awaits) return;
  // Still speaking: checked when she finishes (setSpeaking). Already done (or not speaking out
  // loud at all): open now.
  if (speaking || speechQueue.length) replyAwaits = true;
  else if (autoListen.state === 'closed' && (quietMode || !els.speakOut.checked || performance.now() - lastSpokeAt < 3000)) autoListen.speechEnded({ question: true });
}
/** Echo is (or stopped) driving the Mac: keep listening for "stop" and new instructions meanwhile. */
function syncRunListen(driving) {
  autoListen.setDriving(driving && settings.listenDuringRuns !== false);
}

// Click-to-talk (the mic button or the Mac menu, not Space held) ends by itself: after a pause once
// you've spoken, or after a while with no speech at all, so an open mic doesn't record the room.
const CLICK_NO_SPEECH_MS = 8000;
let tap = { ms: 0, voicedMs: 0, silentMs: 0, spoke: false };
function clickAutoEnd(frame, frameMs) {
  if (!listening) return;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const loud = Math.sqrt(sum / frame.length) > Math.max(0.01, noiseFloor * 3.5);
  tap.ms += frameMs;
  if (loud) {
    tap.voicedMs += frameMs;
    tap.silentMs = 0;
    if (tap.voicedMs > 200) tap.spoke = true;
  } else {
    tap.voicedMs = Math.max(0, tap.voicedMs - frameMs);
    tap.silentMs += frameMs;
  }
  if ((tap.spoke && tap.silentMs >= Math.max(settings.endSilenceMs || 1300, 2000)) || (!tap.spoke && tap.ms > CLICK_NO_SPEECH_MS)) stopListening();
}
const echoing = () => speaking || sources.size > 0 || performance.now() < echoQuietUntil;

function onAudio(frame) {
  const frameMs = (frame.length / ctx.sampleRate) * 1000;
  const echo = echoing();
  if (echo) preRoll.length = 0;
  else {
    preRoll.push(frame);
    while (preRoll.length * frameMs > PRE_ROLL_MS) preRoll.shift();
  }
  // Push-to-talk records until the tail after you let go (listening is already off by then).
  if (pttRecording && clip) {
    clip.push(frame);
    sttStream.feed(frame);
    if (!spaceHeld) clickAutoEnd(frame, frameMs);
    return;
  }
  // Auto-listen: the same detector as hands-free, while the window is open (never while she speaks).
  if (autoCapture && !listening) {
    if (serverEngine() && !echo) detectSpeech(frame, frameMs);
    return;
  }
  if (wakeListening()) {
    // Echo's own voice never reaches the wake listener: it's muted while she speaks and just after.
    if (echo) { if (wake.state !== 'idle' || wake.buf) wake.reset(); }
    else {
      wake.feed(frame);
      // After "Hey Echo", your request streams too (the wake word's own burst with it).
      if (wake.state === 'awake') {
        if (!sttStream.active) streamBegin('wake', wake.buf || []);
        else sttStream.feed(frame);
      }
    }
    return;
  }
  if (!serverEngine() || !listening || echo || !els.handsFree.checked) return;
  handsFreeWatch.frame(frame);
  detectSpeech(frame, frameMs);
}

/** Hands-free (and auto-listen): energy detector with an adaptive noise floor. */
function detectSpeech(frame, frameMs) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const level = Math.sqrt(sum / frame.length);
  const threshold = Math.max(0.01, noiseFloor * 3.5);
  if (!hearing && level < threshold) noiseFloor = noiseFloor * 0.995 + level * 0.005;
  if (level > threshold) {
    voicedMs += frameMs;
    silentMs = 0;
    if (!hearing && voicedMs > 120) {
      hearing = true;
      clip = [...preRoll];
      streamBegin(autoCapture && autoListen.isOpen ? autoListen.mode : els.handsFree.checked ? 'hands-free' : 'push-to-talk', clip);
      autoListen.heard();
      renderOrb();
    }
  } else {
    voicedMs = Math.max(0, voicedMs - frameMs);
    if (hearing) silentMs += frameMs;
  }
  if (hearing) {
    clip.push(frame);
    sttStream.feed(frame);
    const clipMs = clip.length * frameMs;
    if (silentMs >= (settings.endSilenceMs || 1300) || clipMs > 30000) finishClip();
  }
}

function finishClip() {
  const chunks = clip || [];
  clip = null;
  // Mic off: push-to-talk still works, and the mic is let go again right after.
  if (micOff && !els.handsFree.checked) dropMic('mic off');
  hearing = false;
  silentMs = 0;
  voicedMs = 0;
  renderOrb();
  // What the live listener showed for this clip; it's the fallback if the clip transcribes blank.
  const live = liveText();
  resetLive();
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  // Said inside an auto-listen window (an answer, or a word to her mid-run): no "Echo" needed.
  const auto = autoListen.isOpen ? autoListen.mode : null;
  const mode = autoCapture && auto ? auto : els.handsFree.checked ? 'hands-free' : 'push-to-talk';
  if (samples / ctx.sampleRate < 0.4) {
    sttStream.cancel();
    // A click or a cough; but if the live listener caught words, the clip was cut short.
    if (live) {
      sendClip(null, live, { seconds: +(samples / ctx.sampleRate).toFixed(2), tooShort: true });
      autoListen.answered();
    } else {
      // Never a silent loss: a tapped key is told so.
      if (mode === 'push-to-talk') liveCap.note(dropLine('too_short', 'ptt'));
      autoListen.notSpeech();
    }
    return;
  }
  autoListen.answered();
  const pcm = new Float32Array(samples);
  let o = 0;
  let peak = 0;
  for (const c of chunks) {
    pcm.set(c, o);
    o += c.length;
  }
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const notes = {
    seconds: +(samples / ctx.sampleRate).toFixed(2), peak: +peak.toFixed(4), rate: ctx.sampleRate, ctxState: ctx.state,
    trackState: micTrack?.readyState, trackMuted: Boolean(micTrack?.muted), mode,
    // Did the browser really turn echo cancellation on? (Some inputs and browsers ignore the ask.)
    aec: micTrack?.getSettings?.().echoCancellation ?? null, echoTailMs: ECHO_TAIL_MS,
    followUp: Boolean(auto) || performance.now() - lastSpokeAt < followUpMs(), sinceReplyMs: sinceReplyMs(),
    // A quiet room (no TV or music under the voice): a clear direct question needs no "Echo".
    quiet: noiseFloor < 0.006, inApp: nativeApp(),
  };
  // Pure silence from the mic: the stream has gone dead. Open a fresh one for next time.
  if (peak < 0.0005) dropMic('the clip was pure silence');
  sendClip(encodeWav(downsample(pcm, ctx.sampleRate, 16000), 16000), live, notes, sttStream.end());
}

function encodeWav(samples, rate) {
  return new Blob([wavBytes(samples, rate)], { type: 'audio/wav' });
}

const isBlank = (t) => !/[\p{L}\p{N}]/u.test(String(t || ''));

// Nothing was heard, not even by the live listener: nothing goes to Echo. A short note under the
// voice that fades by itself (never over your words: liveCap only shows it with no caption up),
// and the first time in a row she says so, softly; after that, just the note.
let missedOnce = false;
function didntCatch() {
  liveCap.note("Didn't catch that — try again");
  if (!missedOnce) speak("Sorry, I didn't catch that.", null, { soft: true });
  missedOnce = true;
}

// Hands-free dropped something that sounded like a real command (lib/addressed.js): show it
// dimmed in the chat and the caption bar with a hint, so a drop is never silent. Nothing is spoken.
const NOT_FOR_ME_HINT = 'Didn\'t catch that as meant for me — say "Echo…"';
/** @param {{ looksLikeCommand?: boolean, askForMe?: boolean, heard?: string }} out */
function notForMe(out) {
  liveCap.clear({ now: true });
  if (out.askForMe && out.heard) return wasThatForMe(out.heard);
  liveCap.note(out.looksLikeCommand ? NOT_FOR_ME_HINT : 'Not for me? Say "Echo" first.');
  if (!out.looksLikeCommand || !out.heard) return;
  addMsg('missed dropped', `“${out.heard}” · ${NOT_FOR_ME_HINT}`);
  caption.update({ user: `“${out.heard}” · ${NOT_FOR_ME_HINT}` });
}

// Echo wasn't sure it was meant for her (lib/addressed.js judgeAddressee): one small chip, never
// silent. Tap ✓ (or just say it again with "Echo") and it goes through as said; it fades by itself.
const ASK_FOR_ME_MS = 6000;
/** The quiet chip stays a little longer, then goes. */
const NOT_SURE_MS = 8000;
/** What you last said aloud, for the quiet chip's "Send anyway". Never stored or logged. */
let lastSaid = '';
/**
 * The one chip for words that did not go through: what it says, its button, and how long it
 * stays. A tap sends the words on as the user's own say-so (`tapped`), which is never judged again.
 * @param {string} heard @param {{ kind: string, words?: string, button: string, label: string, note: string, ms: number, remove?: boolean }} o
 */
function forMeChip(heard, o) {
  const row = addMsg(`missed ask ${o.kind}`.trim(), '');
  const words = document.createElement('span');
  words.className = 'ask-words';
  words.textContent = o.words ?? `“${heard}”`;
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'ask-yes';
  yes.textContent = o.button;
  yes.setAttribute('aria-label', o.label);
  row.append(words, yes);
  if (o.note) liveCap.note(o.note);
  const done = (sent) => {
    row.classList.add(sent ? 'taken' : 'faded');
    yes.disabled = true;
    if (o.remove) setTimeout(() => row.remove(), sent ? 0 : 600);
  };
  const timer = setTimeout(() => done(false), o.ms);
  yes.addEventListener('click', () => {
    clearTimeout(timer);
    done(true);
    send({ type: 'user_text', text: heard, confidence: 0.9, tapped: true });
  }, { once: true });
  return row;
}
/** @param {string} heard */
function wasThatForMe(heard) {
  forMeChip(heard, { kind: '', button: 'Was that for me? ✓', label: `Yes, "${heard}" was for Echo`, note: 'Was that for me? Tap ✓ in the window', ms: ASK_FOR_ME_MS });
}
/**
 * Echo took your words and chose to stay quiet: a small, calm chip under them, gone after 8 s.
 * "Send anyway" (or saying "yes, that was for you") sends the same words on as a sure sentence.
 * @param {string} heard
 */
function notSureForMe(heard) {
  forMeChip(heard, { kind: 'quiet', words: 'Not sure that was for me', button: 'Send anyway', label: `Send "${heard}" to Echo anyway`, note: '', ms: NOT_SURE_MS, remove: true });
}

/**
 * Send a clip to be transcribed, with what the live listener showed (the server uses it when the
 * transcription comes back blank) and notes on the mic, for finding why. With no clip (cut too
 * short to send), the live text goes as typed-in speech.
 * @param {Blob | null} wav @param {string} live @param {object} notes
 */
async function sendClip(wav, live = '', notes = {}, streamId = null) {
  if (!wav) {
    if (!isBlank(live)) { sfx('send'); send({ type: 'user_text', text: live, confidence: 0.7, mode: notes.mode }); }
    return;
  }
  transcribing = true;
  renderOrb(); // your words stay in the caption while they're transcribed
  sfx('send');
  try {
    const headers = { 'Content-Type': 'audio/wav', 'X-Echo-Clip': encodeURIComponent(JSON.stringify(notes)) };
    // Streamed while you talked: the server may already have the text (lib/sttstream.js).
    if (streamId) headers['X-Echo-Stream'] = streamId;
    if (!isBlank(live)) headers['X-Echo-Live'] = encodeURIComponent(JSON.stringify(live.slice(0, 2000)));
    // The server not answering (it is restarting) with the app's text already in hand: the
    // sentence is kept and sent once more after 2 s before anything is said (public/nativemic.js).
    let res;
    try {
      res = await sendWithRetry(() => fetch('/api/utterance', { method: 'POST', headers, body: wav }), Boolean(notes.final?.text));
    } catch {
      addMsg('error', NOT_SENT_LINE);
      return;
    }
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Transcription failed');
    transcribing = false;
    // Your words make way first, so a note never lands on top of them.
    liveCap.clear({ now: Boolean(out.empty) });
    // Not a turn, and nothing to say about it: talk that wasn't for Echo, or her own voice.
    if (out.reason === 'not_for_echo') notForMe(out);
    else if (out.reason === 'not_a_command') {
      if (out.askForMe && out.heard) wasThatForMe(out.heard);
      else liveCap.note('Ignored while driving. Say “Echo…” or “stop”.');
    }
    else if (out.reason === 'held') liveCap.note('Noted for after this step. To stop now, say “Echo, stop”');
    else if (out.reason === 'next_step') liveCap.note('Got it: I’ll do that right after this step. To stop now, say “stop”.');
    else if (out.reason === 'own_voice') liveCap.note('That was my own voice; ignored');
    else if (out.reason === 'wake_only') liveCap.note('I’m here. Say “Hey Echo” and your request.');
    // The app's own text didn't come in time and nothing here could transcribe the clip: said so, not "blank".
    else if (out.reason === 'stt_timeout' || out.reason === 'stt_unavailable') liveCap.note(NO_TEXT_LINE);
    // "Didn't catch that" only when truly nothing was heard: not when your words showed live.
    else if (out.empty && trulyEmpty({ live, heard: out.heard })) didntCatch();
    else if (!out.empty) {
      missedOnce = false;
      questionOpen = false; // answered
    }
  } catch (e) {
    addMsg('error', `Couldn't transcribe: ${e.message}`);
  } finally {
    transcribing = false;
    liveCap.clear();
    renderOrb();
  }
}

/* --- browser recognition: the fallback engine, and the live preview --- */
let rec = null;
let recOn = false;
let finalBuf = '';
let interimBuf = '';
let lastConfidence = 1;
/** Everything the live listener has shown for the current utterance. */
const liveText = () => (finalBuf + interimBuf).trim();
function resetLive() {
  finalBuf = '';
  interimBuf = '';
}
let silenceTimer = null;
if (SR) {
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-IN'; // English only; the server says which accent model (en-IN or en-US) to use
  rec.onstart = () => { recOn = true; };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        finalBuf += r[0].transcript + ' ';
        lastConfidence = Math.min(lastConfidence, r[0].confidence || 1);
      } else interim += r[0].transcript;
    }
    interimBuf = interim;
    if (serverEngine() && !settings.livePreview) return;
    const shown = (finalBuf + interim).trim();
    liveCap.set(shown);
    caption.update({ user: shown });
    if (!serverEngine() && autoCapture && !listening) autoListen.heard();
    if (!serverEngine() && (els.handsFree.checked || autoCapture)) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(flushBrowser, settings.endSilenceMs || 1300);
    }
    if (serverEngine() && els.handsFree.checked && listening) handsFreeWatch.words(shown);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') els.state.textContent = 'Microphone blocked — allow it in the address bar.';
  };
  rec.onend = () => {
    recOn = false;
    if (!serverEngine() && !els.handsFree.checked) flushBrowser();
    if ((listening || autoCapture) && !speaking && (!serverEngine() || settings.livePreview)) try { rec.start(); } catch {}
  };
}

function flushBrowser() {
  clearTimeout(silenceTimer);
  const text = finalBuf.trim() || (!els.handsFree.checked ? liveCap.text : '');
  const confidence = lastConfidence;
  resetLive();
  lastConfidence = 1;
  liveCap.clear();
  const mode = els.handsFree.checked ? 'hands-free' : autoCapture ? autoListen.mode : 'push-to-talk';
  if (!isBlank(text)) { sfx('send'); send({ type: 'user_text', text, confidence, mode }); }
  if (autoCapture && !listening) autoListen.answered();
}

// Hands-free with a deaf mic (public/handsfreewatch.js): the preview shows your words but the
// detector never hears them, so the turn would never end. At the pause, the words go as the turn,
// and the mic is opened again.
const handsFreeWatch = new HandsFreeWatch({
  pauseMs: () => watchPauseMs(settings.endSilenceMs),
  isHearing: () => hearing,
  onDeaf: (words) => {
    if (!listening || !els.handsFree.checked || speaking) return;
    const text = liveText() || words;
    resetLive();
    liveCap.clear();
    // The recognizer starts over (it restarts by itself), so these words can't come back.
    stopRec();
    sendClip(null, text, { mode: 'hands-free' });
    dropMic('hands-free heard nothing while the live preview heard words');
    ensureMic().catch(() => {});
  },
  // Late words of a clip that's already gone: tidied away, not sent again.
  onStale: () => {
    if (isBlank(liveText())) return;
    resetLive();
    if (!transcribing) liveCap.clear();
  },
});

function startRec() {
  resetLive();
  if (rec && !recOn && (!serverEngine() || settings.livePreview)) try { rec.start(); } catch {}
}
function stopRec() {
  if (rec && recOn) try { serverEngine() ? rec.abort() : rec.stop(); } catch {}
}

/* --- controls shared by both --- */
/** Is push-to-talk (the app's or the window's) recording now? */
const pttOn = () => listening || appMic.ptt;

async function startListening() {
  const cutIn = speaking; // you started while Echo was talking: the companion is startled
  // In the Mac app, its mic records it (the same engine as Control + Option): held Space ends
  // when it's let go, a clicked mic button on your pause.
  if (inApp()) {
    if (autoListen.state !== 'closed') autoListen.close('push_to_talk');
    appMic.pttBegin(spaceHeld);
    return;
  }
  hush();
  if (cutIn) viz.moment('surprised');
  if (!SR && !serverEngine()) {
    els.state.textContent = 'Voice input isn’t available in this browser. You can still type.';
    return;
  }
  const held = spaceHeld;
  try {
    await ensureMic();
  } catch {
    return;
  }
  if (listening) return;
  // The key was let go while the mic was still opening (a quick tap on a cold mic): nothing was
  // recorded, and the mic mustn't stay open waiting for a release that has already happened.
  if (held && !spaceHeld) return liveCap.note(dropLine('too_short', 'ptt'));
  // Push-to-talk (or the mic button) takes over from an open auto-listen window.
  if (!els.handsFree.checked && autoListen.state !== 'closed') autoListen.close('push_to_talk');
  listening = true;
  wake.reset();
  sfx('listen');
  if (serverEngine() && !els.handsFree.checked) {
    pttRecording = true;
    clip = [...preRoll];
    streamBegin('push-to-talk', clip);
    tap = { ms: 0, voicedMs: 0, silentMs: 0, spoke: false };
  }
  startRec();
  renderOrb();
}

function stopListening() {
  if (appMic.ptt) {
    appMic.pttEnd();
    // Mid-run, the window for "stop" is open again once you've let go.
    if (autoListen.driving) setTimeout(() => { if (!appMic.ptt && !speaking && autoListen.state === 'closed') autoListen.open('run'); }, PTT_TAIL_MS + 100);
    return;
  }
  if (!listening) return;
  listening = false;
  if (!els.handsFree.checked) pttHint.used();
  sfx('stop');
  if (serverEngine()) {
    if (pttRecording) {
      // Let go after a quiet moment: what's been said is transcribed now, during the tail.
      if (sttStream.silentMs >= 150) sttStream.pause();
      // Keep the tail, then send.
      setTimeout(() => {
        pttRecording = false;
        finishClip();
      }, PTT_TAIL_MS);
    } else if (hearing) finishClip();
    stopRec();
  } else stopRec();
  renderOrb();
  // Mid-run, listening for "stop" picks up again after you let go.
  if (autoListen.driving) setTimeout(() => { if (!listening && !pttRecording && !speaking && autoListen.state === 'closed') autoListen.open('run'); }, PTT_TAIL_MS + 100);
}

function pauseHandsFree() {
  if (!els.handsFree.checked || !listening) return;
  listening = false;
  hearing = false;
  clip = null;
  sttStream.cancel();
  stopRec();
  if (rec && recOn) try { rec.abort(); } catch {}
}
function resumeHandsFree() {
  // (In the Mac app, hands-free is its mic's, and it never stopped: you can talk over Echo.)
  if (els.handsFree.checked && !speaking && !inApp() && !appPending()) setTimeout(() => !speaking && !inApp() && startListening(), 250);
}

/* --- "Hey Echo": the wake word --- */
// With the wake word on, the mic stays open and public/wake.js watches its loudness. Each burst of
// speech is checked by this Mac's Whisper (POST /api/wake); nothing is sent anywhere else or saved
// before "Hey Echo". Then a chime, the voice lights up, and your request is recorded until you
// pause. Space push-to-talk works as always.
// completely.
let micOff = false; // true in the "off" listening state: the mic opens only for a held key
/**
 * The one listening state (lib/listenmode.js): listening (anything said to Echo), resting (its
 * name only) or off (the mic is off). It is a setting; the server changes it too ("go quiet", its
 * name, three quiet minutes) and says so with a listen_mode message.
 * @type {'listening' | 'resting' | 'off'}
 */
let listenMode = 'resting';
/** The state the screen lock took the mic from ('' when it didn't). */
let lockedFrom = '';
const KEY_NAMES = { 'ctrl-opt': '⌃⌥', 'ctrl-cmd': '⌃⌘', 'opt-cmd': '⌥⌘', 'right-opt': 'right ⌥', fn: 'fn' };
/** What the talk key is called here. */
const talkKey = () => (inApp() ? KEY_NAMES[settings.pttHotkey] || '⌃⌥' : 'Space');
/** Make the page listen the way `mode` says (no saving: applySettings and setListenMode call this). @param {string} mode */
function applyListenMode(mode) {
  if (mode !== 'listening' && mode !== 'resting' && mode !== 'off') return;
  listenMode = mode;
  micOff = mode === 'off';
  const on = mode === 'listening';
  if (els.handsFree.checked !== on) {
    els.handsFree.checked = on;
    pref.set('handsFree', on);
    // In the Mac app its mic is armed for it (syncNativeMic); in a browser tab the page's own opens or closes.
    if (!inApp() && !appPending()) on ? startListening() : stopListening();
  }
  if (micOff && !inApp() && listening && !spaceHeld) stopListening();
  for (const b of $('listenSeg').children) b.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (b).dataset.mode === mode));
  $('listenHint').textContent = mode === 'listening' ? 'Just talk' : mode === 'resting' ? `Say “Echo”, or hold ${talkKey()}` : `Hold ${talkKey()}, or type`;
  syncWake();
  renderOrb();
  syncNativeMic(true);
}
/** You changed how Echo listens (the menu, the pearl, the key): it applies now and is saved. @param {string} mode @param {string} [why] */
function setListenMode(mode, why = '') {
  if (mode === listenMode) return;
  applyListenMode(mode);
  timeline('listen.mode', { mode, why });
  saveSetting({ listenMode: mode });
}
let wakeAvailable = false; // needs local Whisper (GET /api/stt)
let wakeState = 'idle';
const wakeWanted = () => settings.wakeWord !== false && wakeAvailable && serverEngine() && !micOff && !els.handsFree.checked;
// The Mac app's own mic listens for "Hey Echo" when it can (from any app); the page's is the fallback.
const wakeOn = () => wakeWanted() && !inApp() && !appPending();
const wakeListening = () => wakeOn() && !listening && !pttRecording && !autoCapture;
const wake = new WakeListener({
  rate: ctx.sampleRate,
  check: async (samples) => {
    const res = await fetch('/api/wake', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(downsample(samples, ctx.sampleRate, 16000), 16000), signal: AbortSignal.timeout(5000) });
    return res.ok ? res.json() : { wake: false };
  },
  onWake: () => {
    hush();
    sfx('wake');
  },
  onTurn: (samples, info) => {
    const notes = {
      seconds: +(samples.length / ctx.sampleRate).toFixed(2), rate: ctx.sampleRate, ctxState: ctx.state, trackState: micTrack?.readyState,
      trackMuted: Boolean(micTrack?.muted), mode: 'wake', followUp: info.followUp, aec: micTrack?.getSettings?.().echoCancellation ?? null, echoTailMs: ECHO_TAIL_MS,
    };
    sendClip(encodeWav(downsample(samples, ctx.sampleRate, 16000), 16000), '', notes, streamSource === 'wake' ? sttStream.end() : null);
  },
  onCancel: (why) => { if (why === 'no_request') sfx('stop'); },
  onState: (st) => {
    wakeState = st;
    // Back to waiting without a request (reset, no request): drop the stream. A finished request
    // resets first and hands over its clip right after, so this waits a moment.
    if (st !== 'awake') queueMicrotask(() => { if (wake.state !== 'awake' && streamSource === 'wake') sttStream.cancel(); });
    renderOrb();
  },
});
/** Open or let go of the mic to match the wake-word setting, hands-free and the mic-off button. */
function syncWake() {
  if (inApp()) leavePageMic();
  else if (!wakeOn()) {
    wake.reset();
    if (!listening && !els.handsFree.checked) dropMic('wake word off');
  } else ensureMic().catch(() => {});
}
/** The Mac app's mic has taken over: whatever the page's own mic was doing stops, and it's let go. */
function leavePageMic() {
  if (listening || pttRecording || autoCapture) {
    listening = false;
    pttRecording = false;
    autoCapture = false;
    hearing = false;
    clip = null;
    sttStream.cancel();
    stopRec();
    resetLive();
  }
  wake.reset();
  dropMic('the Mac app listens');
}
/**
 * Who listens is settled (the Mac app has answered, or this is a browser tab): the page's own
 * always-on listening starts or stops to match. In the app, hands-free and "Hey Echo" are its mic's.
 */
function syncEngine() {
  syncWake();
  if (!inApp() && !appPending() && els.handsFree.checked && !listening && !speaking) startListening();
  renderOrb();
}
/* ---------- Orb + voice visual ---------- */
function renderOrb() {
  viz.setState(vizState());
  viz.setNeeds(asks.size > 0);
  els.setHandsFree.checked = els.handsFree.checked;
  reportVoiceBusy();
  // In the Mac app everything here follows the state its mic reports, and nothing else.
  const app = inApp();
  const ptt = appMic.ptt;
  const heardNow = hearing || appMic.hearing;
  els.mic.classList.toggle('listening', listening || ptt);
  els.mic.classList.toggle('speaking', speaking);
  els.mic.classList.toggle('thinking', (busy || transcribing || heard) && !listening && !ptt && !speaking);
  // The soft auto-listen cue: the voice gently pulses, and a thin "Listening…" line. Only while
  // the mic really is open for what you say (an answer window, or a run).
  const autoOpen = app ? appMic.live && appMic.app.reason !== 'handsfree' : autoListen.isOpen;
  caption.update({ listening: listening || autoOpen || ptt, hearing: heardNow, speaking, busy: busy || transcribing || heard });
  document.body.classList.toggle('auto-listening', autoOpen && !heardNow && !speaking);
  // Plain words only (no engine names). Holding the key shows how to send the first few times
  // (pttHint), then just "Listening". While Echo speaks, only the ways to cut in that work now
  // are offered (public/nativemic.js stateLine).
  // "Hands-free: just talk" is a hint for Home. Under a conversation that is going on it only sat
  // there as stale text, so there the line is left empty.
  els.state.innerHTML = stateLine({
    transcribing,
    awake: wakeState === 'awake' || appMic.awake,
    hearing: heardNow,
    ptt: ptt || listening,
    pttHint: (ptt ? !appMic.clicked : !els.handsFree.checked && spaceHeld) && pttHint.show(),
    // (The Mac app's shortcut isn't Space, so there it's "let go to send".)
    byShortcut: ptt ? !spaceHeld : pttByShortcut,
    open: !autoOpen ? '' : app ? (appMic.app.reason === 'run' ? 'run' : 'answer') : autoListen.mode,
    speaking,
    spaceCuts: app || !els.handsFree.checked,
    talkCuts: app && appMic.live && settings.bargeIn !== false,
    busy,
    handsFree: app ? appMic.app.reason === 'handsfree' : els.handsFree.checked,
    wake: app ? appMic.app.reason === 'wake' : wakeWanted(),
    key: talkKey(), mode: listenMode,
  });
  if (els.chatEmpty.hidden && els.state.textContent === stateLine({ handsFree: true })) els.state.textContent = '';
  reportToMac();
  reportCompanion();
  syncNativeMic();
}

// The Mac app (macos/) drives listening and hands-free from its menu bar item, and shows their state.
/** @param {boolean} [force] */
function reportToMac(force) {
  const state = { type: 'state', listening: listening || appMic.ptt, handsFree: els.handsFree.checked, listenMode };
  const key = JSON.stringify(state);
  if (key === reportToMac.last && !force) return;
  reportToMac.last = key;
  /** @type {any} */ (window).webkit?.messageHandlers?.echoApp?.postMessage(state);
}
reportToMac.last = '';

// The Mac app's companion orb (macos/Sources/Pointer.swift) breathes, listens, thinks and speaks
// along with the voice: its state, and while listening or speaking the level, ~12 times a second.
/** @type {Uint8Array | null} */
let companionBuf = null;
/** @type {any} */
let companionTimer = 0;
function companionLevel() {
  const node = speaking ? outAnalyser : listening || wakeState === 'awake' || (autoCapture && hearing) ? micAnalyser : null;
  if (!node) return 0;
  if (!companionBuf || companionBuf.length !== node.fftSize) companionBuf = new Uint8Array(node.fftSize);
  node.getByteTimeDomainData(companionBuf);
  let sum = 0;
  for (const v of companionBuf) sum += ((v - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / companionBuf.length)) * 2.2);
}
function reportCompanion() {
  if (!nativeApp()) return;
  const voice = vizState();
  if (voice !== reportCompanion.last) {
    reportCompanion.last = voice;
    toApp({ type: 'companion', voice });
  }
  const live = voice === 'listening' || voice === 'speaking';
  if (live && !companionTimer) {
    companionTimer = setInterval(() => toApp({ type: 'companion', voice: reportCompanion.last, level: Math.round(companionLevel() * 100) / 100 }), 80);
  } else if (!live && companionTimer) {
    clearInterval(companionTimer);
    companionTimer = 0;
  }
}
reportCompanion.last = '';
/** @type {any} */ (window).echoNative = {
  toggleListening: () => (pttOn() ? stopListening() : startListening()),
  // Drawing with the light (the Mac app, TalkLayer.swift): what was circled goes to Echo as what
  // "this" means. If nothing is heard in the next moment, the app opens its box there to type in.
  /** @param {{ x0: number, y0: number, x1: number, y1: number }} box shares of the screen */
  drew: (box) => {
    const at = Date.now();
    drewAt = at;
    send({ type: 'circled', box });
    setTimeout(() => { if (drewAt === at && heardAt < at) toApp({ type: 'drawBox' }); }, DRAW_BOX_AFTER_MS);
  },
  /** @param {string} text what was typed in the box about what was circled */
  drawAsk: (text) => {
    const t = String(text || '').trim();
    if (!t) return;
    sfx('send');
    send({ type: 'user_text', text: t, typed: true });
  },
  // The one listening state, from the Mac app: a double-tap of the key, its menu, the island's pearl, the screen locking.
  /** @param {string} [why] */
  toggleListenMode: (why = 'key') => setListenMode(listenMode === 'listening' ? 'resting' : 'listening', why),
  /** @param {string} mode @param {string} [why] */
  setListenMode: (mode, why = 'menu') => setListenMode(mode, why),
  /** @param {boolean} locked */
  screenLocked: (locked) => {
    if (locked && listenMode !== 'off') { lockedFrom = listenMode; setListenMode('off', 'lock'); }
    else if (!locked && lockedFrom) { lockedFrom = ''; if (listenMode === 'off') setListenMode('resting', 'unlock'); }
  },
  /** @param {boolean} on */
  setHandsFree: (on) => { if (els.handsFree.checked !== Boolean(on)) els.handsFree.click(); },
  report: () => reportToMac(true),
  // The Mac app's "Check for Updates…" menu item.
  checkForUpdates: () => { openSettings('you'); checkForUpdates(); },
  // Push-to-talk from anywhere (macos/Sources/PushToTalk.swift) when the app's own mic can't
  // record it: works like holding Space. (When it can, the app records it itself and the page
  // follows its state: appMic.)
  pttStart: () => {
    if (els.handsFree.checked || wizard.isOpen() || spaceHeld) return;
    unlockAudio();
    spaceHeld = true;
    pttByShortcut = true;
    startListening();
  },
  pttStop: () => {
    if (spaceHeld) { spaceHeld = false; stopListening(); }
  },
  // The chord turned out to be a shortcut (a key was pressed): what was recorded is dropped, and said so.
  pttCancel: () => {
    if (!spaceHeld) return;
    spaceHeld = false;
    cancelListening();
    liveCap.note(dropLine('spoiled', 'ptt'));
  },
  /** @param {any} e what the Mac app's own mic says (macos/Sources/NativeMic.swift) */
  nativeMic: (e) => {
    const was = inApp();
    const waiting = appPending();
    appMic.on(e);
    // Who owns the mic changed (the app's was allowed, or refused): the page's own follows.
    if (e?.event === 'state' && (was !== inApp() || waiting !== appPending())) syncEngine();
  },
  /** @param {any} st */
  permissions: (st) => { macPerms = st; renderPermsRow(); syncNativeMic(true); syncEngine(); window.dispatchEvent(new CustomEvent('echo-permissions', { detail: st })); },
  // The caption bar's stop button (macos/Sources/Caption.swift): like Stop on the banner, and hush.
  captionStop: () => { hush(); send({ type: 'interrupt' }); send({ type: 'computer_stop' }); },
  // The pill's close button (x): it's gone until there's something new; stop offering the reply field.
  captionClosed: () => caption.update({ asks: false }),
  /** @param {boolean} allow Yes or No from the caption pill. */
  captionConfirm: (allow) => computerClient.answerLatest(allow),
  /** @param {string} text typed in the caption pill's reply field: exactly like a typed chat message. */
  captionSend: (text) => {
    const t = String(text || '').trim();
    if (!t) return;
    sfx('send');
    caption.update({ asks: false });
    send({ type: 'user_text', text: t, typed: true });
  },
  /** @param {any} p the Mac app's own choices (Summon shortcut, Open at login, Keep working after I quit) */
  appPrefs: (p) => renderAppPrefs(p),
  /** @param {any} r the first-run demo's look (it stays on this Mac) */
  demoLook: (r) => window.dispatchEvent(new CustomEvent('echo-demo-look', { detail: r })),
};

/* --- what the Mac app's mic is asked to listen for (public/nativemic.js nativeMicPlan) --- */
let pttByShortcut = false; // push-to-talk held with the Mac app's shortcut rather than Space
/** @param {boolean} [force] send it even if nothing changed (the app is asked to report its state again) */
function syncNativeMic(force = false) {
  if (!nativeApp() || !macPerms?.nativeMic) return;
  const w = convWindow();
  const answerOpen = autoListen.isOpen && autoListen.mode === 'answer';
  appMic.plan({
    available: appAvailable(), setting: settings.nativeMic !== false, serverEngine: nativeEngine(), micOff,
    handsFree: els.handsFree.checked, blocked: wizard.isOpen(),
    driving: autoListen.driving, listenDuringRuns: settings.listenDuringRuns !== false,
    answerOpen, wakeWord: wakeWanted(), engaged: w.open, resting: listenMode === 'resting',
    // When the window runs out: the app closes it by itself, even if this page is asleep.
    windowUntil: answerOpen ? autoListen.until : windowEndsAt(w, { replyAt: lastSpokeWall, talk: listenServer.talk }),
    speaking: speaking || sources.size > 0, bargeIn: settings.bargeIn !== false, duckMedia: settings.duckMedia !== false,
    endSilenceMs: settings.endSilenceMs, language: settings.sttLanguage,
    // Echo is mid-step or a lesson is on: your hands are busy, so a sentence gets its full pause.
    handsBusy: busy || lessonOn,
  }, force);
}

/** Stop listening without sending anything. */
function cancelListening() {
  if (appMic.ptt) return appMic.pttCancel();
  if (!listening) return;
  listening = false;
  pttRecording = false;
  clip = null;
  sttStream.cancel();
  hearing = false;
  stopRec();
  resetLive();
  liveCap.clear();
  sfx('stop');
  renderOrb();
}

// The companion: Echo's face (see ui/companion.js). Its rings spread with your mic while you talk,
// a comet circles its rim while Echo thinks, and the rim pulses with her voice while she speaks.
// One click on it (or Space / Enter) starts and stops listening: the button over it (#mic) takes
// the click, and the companion tells that from play (quick clicks, petting), which never reaches the mic.
const viz = createCompanion(els.viz, {
  hit: els.mic,
  // A tap on the pearl switches Listening and Resting (from Mic off: Resting). In a browser tab, with no key to hold, it still starts and stops a sentence.
  onPress: () => (inApp() ? setListenMode(listenMode === 'listening' ? 'resting' : listenMode === 'off' ? 'resting' : 'listening', 'pearl') : pttOn() ? stopListening() : startListening()),
  audio: () => (speaking ? outAnalyser : listening || wakeState === 'awake' || (autoCapture && hearing) ? micAnalyser : null),
  // The Mac app's own mic has no analyser in the page: its level comes over the bridge.
  level: () => (performance.now() - nativeLevel.at < 300 ? nativeLevel.v : null),
});
function vizState() {
  return vizStateFor({ speaking, listening: listening || wakeState === 'awake' || (autoCapture && hearing) || appMic.hearing || appMic.ptt, busy: busy || transcribing, heard });
}

// Watchdog: a "speaking" flag left on with nothing playing and nothing queued is cleared.
setInterval(() => { if (speaking && !playing && !speechQueue.length) setSpeaking(false); }, 1000);

/* ---------- Settings (the modal's shell is public/settings.js) ---------- */
function applySettings(s) {
  settings = { ...settings, ...s };
  renderRules(Boolean(settings.flags?.rules));
  renderSkills(Boolean(settings.flags?.skills));
  els.assistantName.textContent = settings.assistantName;
  document.title = `${settings.assistantName} · Echo`;
  els.setName.value = settings.assistantName;
  els.setUser.value = settings.userName || '';
  $('greeting').textContent = greeting(settings.userName);
  viz.setCalm(settings.companionLively === false);
  viz.setReduced(settings.reduceMotion);
  viz.setLook(settings.companionLook);
  els.setSpeed.value = settings.speed;
  els.speedVal.textContent = `${Number(settings.speed).toFixed(2)}×`;
  els.setSounds.checked = settings.sounds;
  $('setDailyBudget').value = String(settings.dailyBudgetUsd ?? 0);
  renderPause();
  els.setWake.checked = settings.wakeWord !== false;
  autoListen.windowMs = autoListenMs(settings.autoListenMs);
  if (s.listenMode && s.listenMode !== listenMode) applyListenMode(s.listenMode);
  syncEngine();
  els.setSafe.checked = Boolean(settings.safeMode);
  // On by default in the developer copy only: the server says whether it's on (keepRecordingsOn).
  $('setKeepRecordings').checked = settings.keepRecordingsOn ?? Boolean(settings.keepRecordings);
  $('setKeepTranscript').checked = settings.keepTranscript !== false;
  $('setSecondListen').checked = settings.secondListen !== false;
  renderScreenSettings();
  renderSuggestions();
  renderVoiceControls();
  loadStt();
  settingsPanel.refresh();
}

/** "How long to wait when you pause": three pauses (lib/settings.js PAUSE_CHOICES). A saved pause in between shows as the nearest. */
const pauseChoices = /** @type {HTMLElement[]} */ ([...els.setPause.querySelectorAll('.chip')]);
function renderPause() {
  const ms = Number(settings.endSilenceMs) || 1300;
  const nearest = pauseChoices.reduce((a, b) => (Math.abs(Number(b.dataset.ms) - ms) < Math.abs(Number(a.dataset.ms) - ms) ? b : a));
  for (const c of pauseChoices) {
    c.classList.toggle('on', c === nearest);
    c.setAttribute('aria-checked', String(c === nearest));
  }
}
for (const c of pauseChoices) c.onclick = () => saveSetting({ endSilenceMs: Number(c.dataset.ms) });

/** A chip in a row of choices where one is on. */
function choiceChip(label, on, pick) {
  const b = el('button', { type: 'button', className: `chip${on ? ' on' : ''}` }, label);
  b.setAttribute('aria-pressed', String(on));
  b.onclick = pick;
  return b;
}

function renderVoiceControls() {
  // Personality: the three ways Echo talks, and Beginner (plain words, the beginnerMode setting),
  // which sits over whichever of the three was picked last.
  const beginner = Boolean(settings.beginnerMode);
  els.personalities.replaceChildren(
    ...voiceCatalog.personalities.map((p) => choiceChip(p.label, !beginner && p.id === settings.personality, () => saveSetting({ personality: p.id, beginnerMode: false }))),
    choiceChip('Beginner', beginner, () => saveSetting({ beginnerMode: true })),
  );
  // One list of voices, grouped by what makes them. Picking one also picks its engine
  // (ttsProvider); a premium engine is listed only when its key is set up (GET /api/voices).
  const groups = voiceCatalog.providers.map((p) => {
    const voices = p.id === 'browser'
      ? speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en')).map((v) => ({ id: v.name, name: v.name }))
      : p.voices || [];
    const g = document.createElement('optgroup');
    g.label = VOICE_GROUPS[p.id] || p.label;
    g.append(...voices.map((v) => new Option(v.name, `${p.id}:${v.id}`)));
    return g;
  }).filter((g) => g.children.length);
  els.setVoice.replaceChildren(...groups);
  els.setVoice.value = `${settings.ttsProvider}:${settings.ttsProvider === 'browser' ? settings.browserVoice || '' : settings.voice}`;
}
const VOICE_GROUPS = { kokoro: 'On this Mac (free)', elevenlabs: 'ElevenLabs (premium)', cartesia: 'Cartesia (premium)', browser: "macOS's own voices" };

async function saveSetting(patch) {
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  applySettings(await res.json());
}

const settingsPanel = createSettingsPanel({
  root: els.settings,
  // Another dialog on top (a confirmation, the setup wizard) keeps Esc and Tab for itself.
  blocked: () => !els.modal.hidden || wizard.isOpen(),
  onOpen: () => { loadClaudeStatus(); toApp({ type: 'permissions' }); toApp({ type: 'appPrefs' }); els.openSettings.setAttribute('aria-expanded', 'true'); showLooks(); },
  onClose: () => { els.openSettings.setAttribute('aria-expanded', 'false'); hideLooks(); },
});
// What happened: in the "more" menu, and the quiet "…" beside each of Echo's replies that opens its
// turn. It shows in the dialog, over whatever is open (public/ui/timelineview.js).
const happenedView = $('happenedView');
const whatHappened = createTimelineView({
  open: () => {
    happenedView.hidden = false;
    openModal('What happened', [happenedView], [button('Close', 'ghost', closeModal)]);
  },
});
$('whatHappened').onclick = () => whatHappened.show();

// The "Look" picker (Settings, Companion): each choice is the real companion in that
// body, blinking and looking around. They live only while Settings is open, and draw only while
// their section is showing (the companion stops by itself when it is off screen).
const lookChoices = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('#setLook input')]);
/** @type {Array<ReturnType<typeof createCompanion>>} */
let lookFaces = [];
function showLooks() {
  hideLooks();
  lookFaces = lookChoices.map((c) => {
    const face = createCompanion(/** @type {HTMLElement} */ (c.parentElement?.querySelector('.pearl')), { sleeps: false });
    face.setLook(c.value);
    face.setReduced(settings.reduceMotion);
    return face;
  });
}
function hideLooks() {
  for (const f of lookFaces) f.destroy();
  lookFaces = [];
}
// The companion in the window changes at once; the setting saves right behind it.
for (const c of lookChoices) c.onchange = () => { viz.setLook(c.value); saveSetting({ companionLook: c.value }); };
/** Section names from before there were five: links and the Mac app's menu still use them. */
const OLD_SECTIONS = { general: 'you', account: 'you', updates: 'you', privacy: 'you', computer: 'mac', music: 'voice' };
/** @param {string} [section] listening, voice, companion, mac or you */
function openSettings(section) { settingsPanel.open(OLD_SECTIONS[section] || section); }
els.openSettings.onclick = () => (settingsPanel.isOpen() ? settingsPanel.close() : openSettings());
// ⌘, (or Ctrl+,) opens Settings, like any Mac app.
document.addEventListener('keydown', (e) => {
  if (e.key === ',' && (e.metaKey || e.ctrlKey) && !wizard.isOpen() && els.modal.hidden) { e.preventDefault(); openSettings(); }
});
els.setHandsFree.onchange = () => { if (els.handsFree.checked !== els.setHandsFree.checked) els.handsFree.click(); };

// You & privacy: the Claude sign-in (GET /api/claude/status), in the words the setup wizard uses.
async function loadClaudeStatus() {
  const dot = $('claudeDot');
  const show = (st) => {
    const sum = signInSummary(st);
    dot.className = `status-dot ${sum.tone}`;
    $('claudeTitle').textContent = sum.title;
    $('claudeDetail').textContent = sum.detail || (st?.signedIn ? 'Echo runs on this Claude account.' : 'Echo runs on your Claude account.');
    $('claudeSignIn').textContent = st?.signedIn ? 'Switch account…' : 'Sign in…';
    $('claudeSignIn').hidden = !st || (!st.installed && !st.signedIn);
  };
  show(null);
  try { show(await fetch('/api/claude/status').then((r) => r.json())); } catch { show({ installed: true, signedIn: false, error: "Couldn't check the sign-in just now." }); }
}
$('claudeSignIn').onclick = () => { settingsPanel.close(); wizard.open('claude', { single: true, canClose: true }); };
els.setName.onchange = () => els.setName.value.trim() && saveSetting({ assistantName: els.setName.value.trim() });
els.setUser.onchange = () => saveSetting({ userName: els.setUser.value.trim() });
els.setSpeed.oninput = () => { els.speedVal.textContent = `${Number(els.setSpeed.value).toFixed(2)}×`; };
els.setSpeed.onchange = () => saveSetting({ speed: Number(els.setSpeed.value) });
els.setSounds.onchange = () => saveSetting({ sounds: els.setSounds.checked });
// The value is "engine:voice" (renderVoiceControls): the voice and the engine it belongs to are saved together.
els.setVoice.onchange = () => {
  const [provider, ...rest] = els.setVoice.value.split(':');
  const voice = rest.join(':');
  saveSetting(provider === 'browser' ? { ttsProvider: provider, browserVoice: voice } : { ttsProvider: provider, voice });
};

const PREVIEW_LINES = [
  "Hey! I'm {name}. Tell me what to build and I'll get the team on it.",
  "Good news: the build is green and the tests pass. Want me to open a pull request?",
  "Heads up, the website task wants to delete some old files. Should I let it?",
];
els.previewVoice.onclick = () => {
  hush();
  unlockAudio();
  speakAll(PREVIEW_LINES[Math.floor(Math.random() * PREVIEW_LINES.length)].replace('{name}', settings.assistantName));
};
speechSynthesis.onvoiceschanged = () => renderVoiceControls();

/* --- which recognizer is in use (GET /api/stt): nothing to choose, the page only follows it --- */
async function loadStt() {
  try {
    const st = await fetch('/api/stt').then((r) => r.json());
    const wasServer = serverEngine();
    sttActive = st.active;
    streamOn = Boolean(st.stream?.on);
    wakeAvailable = Boolean(st.wake?.available);
    sttKnown = true;
    syncEngine();
    if (rec && st.browserLang && rec.lang !== st.browserLang) rec.lang = st.browserLang;
    if (wasServer !== serverEngine() && listening) { stopListening(); }
    renderOrb();
  } catch {}
}
els.setSafe.onchange = () => saveSetting({ safeMode: els.setSafe.checked });
$('setKeepRecordings').onchange = (e) => saveSetting({ keepRecordings: /** @type {HTMLInputElement} */ (e.target).checked });
$('setKeepTranscript').onchange = (e) => saveSetting({ keepTranscript: /** @type {HTMLInputElement} */ (e.target).checked });
$('setSecondListen').onchange = (e) => saveSetting({ secondListen: /** @type {HTMLInputElement} */ (e.target).checked });

/* --- the screen, the pointer and computer use (public/screen.js) --- */
const screenClient = createScreenClient({
  addNode: (node) => { els.transcript.append(node); els.chatEmpty.hidden = true; scrollDown(); },
  toast,
  send,
});
// Computer use (public/computer.js).
const computerClient = createComputerClient({
  addNode: (node) => { els.transcript.append(node); els.chatEmpty.hidden = true; scrollDown(); },
  send,
});
let macPerms = /** @type {any} */ (null); // the Mac app's permissions, when it's the Mac app
const setComputer = /** @type {HTMLInputElement} */ ($('setComputer'));
const setPointer = /** @type {HTMLInputElement} */ ($('setPointer'));
const setBargeIn = /** @type {HTMLInputElement} */ ($('setBargeIn'));
const setLively = /** @type {HTMLInputElement} */ ($('setLively'));
const setStepCaptions = /** @type {HTMLInputElement} */ ($('setStepCaptions'));
const setBackground = /** @type {HTMLInputElement} */ ($('setBackground'));
setBackground.onchange = () => saveSetting({ backgroundCursor: setBackground.checked });
/** Settings only the Mac app can act on stay visible (so you know they exist), but greyed out in a browser. */
function macOnly(mac) {
  for (const row of els.settings.querySelectorAll('[data-mac-only]')) {
    row.classList.toggle('needs-mac', !mac);
    row.title = mac ? '' : 'Needs the Echo Mac app';
    for (const c of row.querySelectorAll('input, select')) /** @type {HTMLInputElement} */ (c).disabled = !mac;
  }
}
function renderScreenSettings() {
  setPointer.checked = settings.pointer !== false;
  setLively.checked = settings.companionLively !== false;
  for (const c of lookChoices) c.checked = c.value === settings.companionLook;
  for (const f of lookFaces) f.setReduced(settings.reduceMotion);
  const mac = Boolean(nativeApp());
  setStepCaptions.checked = settings.stepCaptions !== false;
  // The Mac app applies them too (before the page loads, next time). The ones with no row any
  // more are the same for everyone (lib/settings.js FIXED) and are still sent, so the app follows.
  toApp({ type: 'prefs', screenAware: settings.screenAware !== false, pointer: setPointer.checked, pttHotkey: settings.pttHotkey || 'ctrl-opt', stepCaptions: setStepCaptions.checked,
    orbSize: settings.orbSize || 'medium', reduceMotion: settings.reduceMotion || 'system', companionLook: settings.companionLook || 'auto' });
  setComputer.checked = settings.computerUse === true;
  setBackground.checked = settings.backgroundCursor === true;
  toApp({ type: 'computerPrefs', computerUse: setComputer.checked, takeBack: settings.takeBack || 'pause', takeBackMovePx: settings.takeBackMovePx || 120, background: setBackground.checked });
  setBargeIn.checked = settings.bargeIn !== false;
  macOnly(mac);
  // The step captions only matter while the companion points.
  setStepCaptions.disabled = !mac || !setPointer.checked;
  caption.refresh();
  toApp({ type: 'permissions' });
}
setPointer.onchange = () => saveSetting({ pointer: setPointer.checked });
setStepCaptions.onchange = () => saveSetting({ stepCaptions: setStepCaptions.checked });
setLively.onchange = () => saveSetting({ companionLively: setLively.checked });
setBargeIn.onchange = () => saveSetting({ bargeIn: setBargeIn.checked });
// Echo for Chrome: its pairing code and whether it's connected (lib/browser.js).
/** "Not now" on the pairing prompt: not shown again for the same reason until the window reloads. */
let chromePairDismissed = '';
let chromePairShown = '';
async function refreshChrome() {
  try {
    const b = await (await fetch('/api/browser')).json();
    $('chromeCode').textContent = b.code || '…';
    const on = Boolean(b.extension || b.connected);
    $('chromeDot').classList.toggle('on', on);
    // What the server's socket says, not a guess: the extension only counts once Echo accepted it.
    $('chromeDot').title = on ? `Connected${b.extensionStatus?.version ? ` (extension ${b.extensionStatus.version})` : ''}` : b.cdp ? "Chrome's debugging port is open" : b.detail || 'Not connected';
    // The extension is knocking with no code, or a code this Echo doesn't know: one clear prompt.
    const why = b.extensionStatus?.pairingNeeded ? b.extensionStatus.lastRefused?.why || 'code' : '';
    $('chromePairCode').textContent = b.code || '…';
    $('chromePairWhy').textContent = why === 'unpaired' ? "It's running in Chrome but hasn't been given Echo's code yet." : why ? "It's trying to connect with an old pairing code." : '';
    chromePairShown = on ? '' : why;
    $('chromePair').hidden = on || !why || chromePairDismissed === why;
  } catch {}
}
const copyChromeCode = async () => {
  try {
    await navigator.clipboard.writeText($('chromeCode').textContent || '');
    toast('Pairing code copied. Paste it into the Echo extension in Chrome.');
  } catch {
    toast("Couldn't copy. Select the code and copy it.");
  }
};
$('chromeCopy').onclick = copyChromeCode;
$('chromePairCopy').onclick = copyChromeCode;
$('chromePairClose').onclick = () => {
  chromePairDismissed = chromePairShown;
  $('chromePair').hidden = true;
};
refreshChrome();

setComputer.onchange = () => {
  saveSetting({ computerUse: setComputer.checked });
  // Clicking and typing need Accessibility; taking back control with any key needs Input Monitoring.
  if (setComputer.checked && macPerms && !macPerms.accessibility) toApp({ type: 'requestPermission', kind: 'accessibility' });
  else if (setComputer.checked && macPerms && !macPerms.input) toApp({ type: 'requestPermission', kind: 'input' });
};

/* --- the rows that belong to the Mac app (macos/Sources: Config.swift Prefs, HotKey.swift) ---
 * The page asks with { type: 'appPrefs' } and the app answers window.echoNative.appPrefs({
 * keepWorkingAfterQuit, openAtLogin, hotKey, hotKeys: [{ id, title }] }); a change goes back as
 * { type: 'setAppPref', <key>: value } and the app answers again with what it now is (a shortcut
 * another app holds is refused there). A row shows only once the app has said its value, so in a
 * browser tab, or with an app that doesn't know the call yet, the rows aren't there. */
const PERM_KINDS = ['screen', 'accessibility', 'microphone', 'input'];
/** Permissions: one row; the app's own checklist window does the rest (macos/Sources/Permissions.swift). */
function renderPermsRow() {
  $('permsRow').hidden = !nativeApp() || !macPerms;
  if (!macPerms) return;
  const missing = PERM_KINDS.filter((k) => !macPerms[k]).length;
  $('permsState').textContent = missing ? `${missing} to allow` : 'All allowed';
}
$('permsOpen').onclick = () => toApp({ type: 'showPermissions' });
/** @param {{ keepWorkingAfterQuit?: boolean, openAtLogin?: boolean, hotKey?: string, hotKeys?: Array<{ id: string, title: string }> } | null} p */
function renderAppPrefs(p) {
  const has = (k) => Boolean(nativeApp()) && p != null && p[k] !== undefined;
  $('hotKeyRow').hidden = !has('hotKey') || !Array.isArray(p?.hotKeys);
  $('openAtLoginRow').hidden = !has('openAtLogin');
  $('keepWorkingRow').hidden = !has('keepWorkingAfterQuit');
  if (!$('hotKeyRow').hidden) {
    $('setHotKey').replaceChildren(...(p?.hotKeys || []).map((k) => new Option(k.title, k.id)));
    $('setHotKey').value = String(p?.hotKey);
  }
  $('setOpenAtLogin').checked = Boolean(p?.openAtLogin);
  $('setKeepWorking').checked = Boolean(p?.keepWorkingAfterQuit);
  // The app couldn't do it (a shortcut another app holds, a login item macOS refused): it says why.
  if (p?.error) liveCap.note(String(p.error));
}
const setAppPref = (key, value) => toApp({ type: 'setAppPref', [key]: value });
$('setHotKey').onchange = () => setAppPref('hotKey', $('setHotKey').value);
$('setOpenAtLogin').onchange = () => setAppPref('openAtLogin', $('setOpenAtLogin').checked);
$('setKeepWorking').onchange = () => setAppPref('keepWorkingAfterQuit', $('setKeepWorking').checked);
// Back from System Settings: check again.
window.addEventListener('focus', () => { if (macPerms) toApp({ type: 'permissions' }); });
$('setDailyBudget').onchange = () => saveSetting({ dailyBudgetUsd: Number($('setDailyBudget').value) || 0 });
els.setWake.onchange = () => saveSetting({ wakeWord: els.setWake.checked });

async function loadSettings() {
  try {
    const [cat, s] = await Promise.all([fetch('/api/voices').then((r) => r.json()), fetch('/api/settings').then((r) => r.json())]);
    voiceCatalog = cat;
    if (s.listen) listenServer = { talk: s.listen.talk || null, closed: Boolean(s.listen.closed) };
    applySettings(s);
  } catch {}
}

/* ---------- Controls ---------- */
// Space talks, except while typing or while a control has keyboard focus (then Space presses it).
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) ||
  Boolean(document.activeElement?.closest?.('.controls, .menu') && document.activeElement.matches(':focus-visible'));
let spaceHeld = false;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hush(); send({ type: 'interrupt' }); if (autoListen.mode === 'answer') autoListen.close('escape'); }
  // (In the Mac app the talk key is the shortcut, ⌃⌥ by default, from anywhere; Space is a space.)
  if (e.code === 'Space' && !typing() && !inApp() && !els.handsFree.checked && !wizard.isOpen() && els.modal.hidden && !settingsPanel.isOpen()) {
    e.preventDefault();
    if (!spaceHeld) { spaceHeld = true; pttByShortcut = false; startListening(); }
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHeld) { spaceHeld = false; stopListening(); }
});

els.handsFree.checked = pref.get('handsFree', false);
els.speakOut.checked = pref.get('speakOut', true);
els.setHandsFree.checked = els.handsFree.checked;
// The old switch (Settings, the Mac app's menu) is the same thing as Listening and Resting.
els.handsFree.onchange = () => setListenMode(els.handsFree.checked ? 'listening' : 'resting', 'menu');
for (const b of $('listenSeg').children) /** @type {HTMLElement} */ (b).onclick = () => setListenMode(/** @type {HTMLElement} */ (b).dataset.mode || 'resting', 'menu');
els.speakOut.onchange = () => { pref.set('speakOut', els.speakOut.checked); if (!els.speakOut.checked) hush(); };
els.newConvo.onclick = () => send({ type: 'new_conversation' });
els.suggestions.addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('.suggestion');
  if (b) putInComposer(b.textContent);
});
/** The idea buttons on the empty chat, tailored to what the person said they want help with. */
function renderSuggestions() {
  els.suggestions.replaceChildren(...suggestionsFor(settings).map((t) => el('button', { type: 'button', className: 'suggestion' }, t)));
}
// One pane at a time: Talk or Workers (Settings opens over either, public/settings.js).
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    els.main.dataset.view = tab.dataset.view;
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('on', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    }
    // The Sky draws only while it is the pane in view.
    if (tab.dataset.view === 'sky') { skyView.show(); tab.classList.remove('is-new'); pref.set('skySeen', true); } else skyView.hide();
  };
}
/** The reply whose opening was already checked for a yes or a no. */
let saidYesNoFor = '';
/** Once per reply, at its first words. @param {{ trace?: string, text?: string }} msg */
function nodWith(msg) {
  if (!msg.trace || msg.trace === saidYesNoFor) return;
  saidYesNoFor = msg.trace;
  const m = yesOrNo(msg.text);
  if (m) toApp({ type: 'companion', moment: m });
}
// Sky: your days with Echo as constellations (public/ui/sky.js).
const skyView = createSky($('sky'));
$('skyToday').onclick = () => skyView.today();
if (!pref.get('skySeen', false)) document.querySelector('.tab[data-view="sky"]')?.classList.add('is-new');
/** Open the Sky (Echo was asked to show it), on today, playing it if asked. */
function showSky(play = false) {
  /** @type {any} */ (window).webkit?.messageHandlers?.echoApp?.postMessage({ type: 'showWindow' });
  document.querySelector('.tab[data-view="sky"]')?.dispatchEvent(new Event('click'));
  setTimeout(() => skyView.today({ play }), 700);
}

/* ---------- First-run setup, and Reset ---------- */
let onboarding = null; // GET /api/onboarding: whether setup is needed, and the default folders
const wizard = createWizard({
  applySettings,
  speak: (text) => { hush(); unlockAudio(); speakAll(text); },
  setHandsFree: (on) => { els.handsFree.checked = on; pref.set('handsFree', on); if (!on) stopListening(); syncWake(); renderOrb(); },
  handsFree: () => els.handsFree.checked,
  useExample: putInComposer,
  hush,
  // The "try it" demo and the Mac permissions (public/screen.js).
  isMac: () => Boolean(nativeApp()),
  toApp,
  pointAt: pointAtElement,
  onFinish: () => {
    if (onboarding) onboarding.needed = false;
    syncEngine();
  },
});

els.resetEcho.onclick = () => showReset();

// Reset: wipe what Echo knows about you, restart, and start over with setup.
let resetting = false;
let lastPid; // the server's pid before a reset, to notice the new one
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function showReset() {
  let hasPin = selfStatus.hasPin;
  try { hasPin = (await fetch('/api/self/status').then((r) => r.json())).hasPin; } catch {}
  const list = (cls, title, items) => {
    const box = el('div', { className: `reset-list ${cls}` });
    const ul = el('ul');
    ul.append(...items.map((t) => el('li', {}, t)));
    box.append(el('div', { className: 'reset-list-title' }, title), ul);
    return box;
  };
  const lists = el('div', { className: 'reset-lists' });
  lists.append(
    list('gone', 'Erased', ['Your name and settings', 'What Echo remembers about you', 'Conversations', 'Contact favorites', 'Learned words', 'Task history and costs', 'Logs', 'The safety PIN']),
    list('kept', 'Kept', ['Echo itself', 'Your files in your projects folder'])
  );
  const confirmIn = el('input', { id: 'resetConfirm', autocomplete: 'off', spellcheck: false, placeholder: 'RESET' });
  confirmIn.setAttribute('autocapitalize', 'characters');
  const pinIn = el('input', { type: 'password', inputMode: 'numeric', className: 'pin-in', placeholder: '••••', autocomplete: 'off', id: 'resetPin' });
  const err = el('div', { className: 'err', role: 'alert' });
  const ready = () => confirmIn.value.trim().toUpperCase() === 'RESET';
  const go = actionButton('Reset Echo', 'danger', async () => {
    err.textContent = '';
    if (!ready()) { confirmIn.classList.add('invalid'); err.textContent = 'Type RESET in the box to confirm.'; confirmIn.focus(); return; }
    if (hasPin && !pinIn.value.trim()) { pinIn.classList.add('invalid'); err.textContent = 'Enter your PIN to reset.'; pinIn.focus(); return; }
    try { lastPid = (await fetch('/api/health').then((r) => r.json())).pid; } catch {}
    try {
      await postJson('/api/reset', { confirm: 'RESET', pin: pinIn.value });
    } catch (e) {
      if (/PIN/.test(e.message)) { pinIn.classList.add('invalid'); pinIn.select(); }
      err.textContent = e.message;
      return;
    }
    closeModal();
    beginResetWait(lastPid);
  });
  go.disabled = true;
  confirmIn.addEventListener('input', () => { confirmIn.classList.remove('invalid'); go.disabled = !ready(); });
  pinIn.addEventListener('input', () => pinIn.classList.remove('invalid'));
  const body = [
    el('p', {}, 'This puts Echo back the way it was on day one. It then restarts and walks you through setup again.'),
    lists,
    el('label', { className: 'field', htmlFor: 'resetConfirm' }, 'Type RESET to confirm'),
    confirmIn,
    ...(hasPin ? [el('label', { className: 'field', htmlFor: 'resetPin' }, 'Your PIN'), pinIn] : []),
    err,
  ];
  openModal('Reset Echo?', body, [button('Cancel', 'ghost', closeModal), go], { narrow: true, onEnter: () => go.click(), kind: 'reset' });
  confirmIn.focus();
}

function showRestarting(text, sub = '') {
  els.restartText.textContent = text;
  els.restartSub.textContent = sub;
  els.restartOverlay.hidden = false;
}

// Echo is wiping and restarting (this window asked, or another one did): forget this window's
// preferences too, wait for the new server, then reload into setup.
async function beginResetWait(prevPid) {
  if (resetting) return;
  resetting = true;
  hush();
  if (listening) stopListening();
  wizard.close();
  if (!els.modal.hidden) closeModal();
  showRestarting('Resetting Echo…', 'This takes a few seconds. Your files are safe.');
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('echo.') || k.startsWith('voiceops.')) localStorage.removeItem(k);
  } catch {}
  let dropped = false;
  if (prevPid === undefined) {
    try { prevPid = (await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json())).pid; } catch { dropped = true; }
  }
  const start = Date.now();
  let backAt = 0;
  while (Date.now() - start < 90000) {
    await sleep(800);
    try {
      const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
      if ((prevPid !== undefined && h.pid !== prevPid) || dropped) {
        backAt ||= Date.now();
        // Ready, or up long enough (Claude may still be connecting): either way setup can start.
        if (h.ok || Date.now() - backAt > 15000) break;
      }
    } catch {
      dropped = true;
    }
  }
  location.replace(location.pathname);
}

// Deep links for testing and screenshots: ?setup=<step>, ?settings=1 (or a section: =voice, =mac…), ?reset=1.
async function startOnboarding() {
  try { onboarding = await fetch('/api/onboarding').then((r) => r.json()); } catch {}
  const params = new URLSearchParams(location.search);
  const step = params.get('setup');
  if (step !== null) {
    wizard.open(STEPS.includes(/** @type {any} */ (step)) ? step : 'welcome', { canClose: !onboarding?.needed, state: onboarding });
  } else if (params.has('settings')) {
    openSettings(params.get('settings') || '');
  } else if (params.has('reset')) {
    showReset();
  } else if (onboarding?.needed) {
    wizard.open('welcome', { canClose: false, state: onboarding });
  }
}

// What the views split out into public/ui/ need from here.
setChatNote((text) => liveCap.note(text));
setAssistantName(() => settings.assistantName);
setRestartScreen(showRestarting);
setOnTyped(() => {
  sfx('send');
  questionOpen = false; // answered by typing
});

// The companion glances down at the box when you start typing in it.
els.typeInput.addEventListener('input', () => { if (els.typeInput.value.length === 1) viz.lookToward(els.typeInput); });
// The first time Echo is opened each day it gives a small wave with the greeting.
if (firstToday(pref.get('companionDay', ''))) {
  pref.set('companionDay', dayKey());
  setTimeout(() => viz.moment('wave'), 700);
}

loadSettings();
connect();
renderOrb();
startOnboarding();
syncEngine();
