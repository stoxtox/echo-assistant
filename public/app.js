import { createVoiceViz } from '/voiceviz.js';
import { AmbientPiano, PIANO_MOODS } from '/piano.js';
import { createKaraoke, speechBounds, alignTimings, pieceGap, playPlan } from '/karaoke.js';
import { createWizard, suggestionsFor, friendlyPath, STEPS } from '/onboarding.js';
import { WakeListener } from '/wake.js';

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('connDot'), meta: $('meta'), mic: $('mic'), state: $('state'), interim: $('interim'), viz: $('viz'),
  assistantName: $('assistantName'), transcript: $('transcript'), typeForm: $('typeForm'), typeInput: $('typeInput'),
  handsFree: $('handsFree'), speakOut: $('speakOut'), newConvo: $('newConvo'),
  taskList: $('taskList'), emptyTasks: $('emptyTasks'), taskCount: $('taskCount'), tpl: $('taskTpl'),
  settings: $('settings'), openSettings: $('openSettings'), closeSettings: $('closeSettings'),
  setName: $('setName'), setUser: $('setUser'), personalities: $('personalities'), setProvider: $('setProvider'),
  setVoice: $('setVoice'), setSpeed: $('setSpeed'), speedVal: $('speedVal'), setSounds: $('setSounds'),
  previewVoice: $('previewVoice'), elevenHint: $('elevenHint'),
  selfBadge: $('selfBadge'), selfTimer: $('selfTimer'), modal: $('modal'), modalTitle: $('modalTitle'),
  modalBody: $('modalBody'), modalActions: $('modalActions'), restartOverlay: $('restartOverlay'),
  cost: $('cost'), pinCurrent: $('pinCurrent'),
  setStt: $('setStt'), sttHint: $('sttHint'), setSttLang: $('setSttLang'), sttLangField: $('sttLangField'),
  setPause: $('setPause'), pauseVal: $('pauseVal'), setSmart: $('setSmart'), setPreview: $('setPreview'), setWake: $('setWake'), setWakeSens: $('setWakeSens'), wakeSensVal: $('wakeSensVal'), wakePill: $('wakePill'),
  vocabWords: $('vocabWords'), vocabSave: $('vocabSave'), vocabFixes: $('vocabFixes'), pinNew: $('pinNew'), pinSave: $('pinSave'), pinHint: $('pinHint'),
  chatEmpty: $('chatEmpty'), tabCount: $('tabCount'), toast: $('toast'), main: document.querySelector('main'),
  piano: $('piano'), pianoToggle: $('pianoToggle'), pianoMoodBtn: $('pianoMoodBtn'), pianoMenu: $('pianoMenu'),
  voiceBtn: $('voiceBtn'), voiceLabel: $('voiceLabel'), voiceMenu: $('voiceMenu'), voiceList: $('voiceList'), voiceMore: $('voiceMore'),
  moreBtn: $('moreBtn'), moreMenu: $('moreMenu'),
  attachBtn: $('attachBtn'), fileInput: $('fileInput'), attachTray: $('attachTray'), dropVeil: $('dropVeil'),
  approvalGroup: $('approvalGroup'), approvalGroupTitle: $('approvalGroupTitle'), approvalGroupSub: $('approvalGroupSub'),
  groupAllow: $('groupAllow'), groupDeny: $('groupDeny'), hero: $('hero'), sendBtn: $('sendBtn'),
  suggestions: $('suggestions'), setBeginner: $('setBeginner'), setSafe: $('setSafe'), projectsDirShow: $('projectsDirShow'),
  changeFolder: $('changeFolder'), runSetup: $('runSetup'), resetEcho: $('resetEcho'), restartText: $('restartText'), restartSub: $('restartSub'),
};

const pref = {
  get: (k, d) => { try { const v = localStorage.getItem('voiceops.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('voiceops.' + k, JSON.stringify(v)); } catch {} },
};

let settings = { assistantName: 'Ops', ttsProvider: 'kokoro', voice: 'af_heart', speed: 1.05, sounds: true, personality: 'buddy' };
let voiceCatalog = { providers: [], personalities: [] };

/* ---------- Connection ---------- */
let ws;
let projects = [];
const tasks = new Map();

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  // Connected is the normal state, so it shows nothing; only a lost connection gets a pill.
  ws.onopen = () => { els.dot.hidden = true; if (voiceBusySent) reportVoiceBusy(true); };
  ws.onclose = () => { els.dot.hidden = false; setTimeout(connect, 1500); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

let liveBubble = null;
function handle(msg) {
  switch (msg.type) {
    case 'snapshot':
      projects = msg.projects;
      tasks.clear();
      els.taskList.querySelectorAll('.task').forEach((n) => n.remove());
      msg.tasks.slice().reverse().forEach(upsertTask);
      els.emptyTasks.hidden = msg.tasks.length > 0;
      setBusy(msg.busy);
      updateMeta();
      setSelfStatus(msg.self);
      costs = msg.costs;
      renderCosts();
      if (!resetting) els.restartOverlay.hidden = true;
      for (const r of msg.messageConfirms || []) showMessageConfirm(r);
      syncTaskCards(msg.tasks);
      if (msg.update) setUpdateStatus(msg.update);
      break;
    case 'update': setUpdateStatus(msg.status, msg.notice); break;
    case 'self_status': setSelfStatus(msg.status); break;
    case 'costs': costs = msg.costs; renderCosts(); break;
    case 'self_unlock_request': showUnlock(msg.request); sfx('attention'); break;
    case 'restarting': showRestarting('Applying update and restarting…'); break;
    case 'resetting': beginResetWait(lastPid); break;
    case 'projects': projects = msg.projects || []; updateMeta(); break;
    case 'heard': {
      const bubble = addMsg('you', '');
      // Underline words the recognizer wasn't sure about; show what was originally heard.
      let html = escapeHtml(msg.text);
      for (const w of msg.unsure || []) html = html.replace(new RegExp(`\\b(${escapeRe(escapeHtml(w))})\\b`, 'i'), '<span class="unsure" title="Not sure I heard this right">$1</span>');
      bubble.innerHTML = html + (msg.raw ? `<span class="heard">heard: “${escapeHtml(msg.raw)}”</span>` : '');
      if (msg.images?.length) bubble.prepend(imageGrid(msg.images));
      scrollDown();
      break;
    }
    case 'say_start': liveBubble = addMsg('ai streaming', ''); karaoke.hold(liveBubble); break;
    case 'say_delta':
      if (!liveBubble) { liveBubble = addMsg('ai streaming', ''); karaoke.hold(liveBubble); }
      karaoke.append(liveBubble, msg.text);
      scrollDown();
      break;
    case 'say_end': liveBubble?.classList.remove('streaming'); karaoke.release(liveBubble); liveBubble = null; break;
    // Sentences of the reply being streamed arrive after their text, so they highlight in its bubble.
    case 'speak': speak(msg.text, liveBubble, { prev: msg.prev }); break;
    case 'say': speakAll(msg.text, addMsg('ai', msg.text)); break;
    case 'activity': addMsg('activity', '→ ' + msg.text); break;
    case 'busy': setBusy(msg.busy); break;
    case 'error': addMsg('error', msg.text); sfx('error'); break;
    case 'task': {
      const prev = tasks.get(msg.task.id);
      upsertTask(msg.task);
      updateMeta();
      if (prev && prev.status !== msg.task.status) {
        if (msg.task.status === 'done') sfx('done');
        else if (msg.task.status === 'waiting_approval') sfx('attention');
        else if (msg.task.status === 'failed') sfx('error');
        else if (msg.task.status === 'running' && prev.status === 'queued') sfx('start');
      }
      break;
    }
    case 'task_log': appendLog(msg.taskId, msg.entry); break;
    case 'settings': applySettings(msg.settings); break;
    case 'approval_stale': toast('That request was already answered.'); settleTaskCard(msg.approvalId, null); break;
    case 'task_event': addTaskCard(msg.event); if (msg.event.kind === 'approval') sfx('attention'); break;
    case 'approval_resolved': settleTaskCard(msg.approvalId, msg.allowed); break;
    case 'message_confirm': showMessageConfirm(msg.request); sfx('attention'); break;
    case 'message_resolved': settleMessageConfirm(msg); break;
  }
}

/* ---------- Quick message confirmation card ---------- */
const confirmCards = new Map();
function showMessageConfirm(r) {
  if (confirmCards.has(r.id)) return;
  els.chatEmpty.hidden = true;
  const card = document.createElement('div');
  card.className = 'msg confirm-card';
  const head = document.createElement('div');
  head.className = 'confirm-head';
  head.textContent = `${r.service === 'SMS' ? 'Text (SMS)' : 'iMessage'} to ${r.name} · ${r.masked}`;
  const body = document.createElement('div');
  body.className = 'confirm-text';
  body.textContent = r.text;
  const foot = document.createElement('div');
  foot.className = 'confirm-actions';
  const left = document.createElement('span');
  left.className = 'muted confirm-left';
  const cancel = Object.assign(document.createElement('button'), { className: 'ghost small', textContent: 'Cancel' });
  const sendBtn = Object.assign(document.createElement('button'), { className: 'small', textContent: 'Send' });
  const answer = (yes) => {
    card.classList.add('sent');
    cancel.disabled = sendBtn.disabled = true;
    send({ type: 'message_confirm', id: r.id, send: yes });
  };
  cancel.onclick = () => answer(false);
  sendBtn.onclick = () => answer(true);
  foot.append(left, cancel, sendBtn);
  card.append(head, body, foot);
  els.transcript.append(card);
  scrollDown();
  const tick = () => {
    const s = Math.max(0, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000));
    left.textContent = s ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired';
  };
  tick();
  confirmCards.set(r.id, { card, left, cancel, sendBtn, timer: setInterval(tick, 1000) });
}
function settleMessageConfirm(r) {
  const c = confirmCards.get(r.id);
  if (!c) return;
  clearInterval(c.timer);
  confirmCards.delete(r.id);
  c.cancel.remove();
  c.sendBtn.remove();
  c.card.classList.add(r.sent ? 'is-sent' : 'is-cancelled');
  c.left.textContent = r.stale ? 'Already handled' : r.sent ? 'Sent ✓' : r.error ? `Not sent: ${r.error}` : r.by === 'expired' ? 'Expired, not sent' : 'Cancelled';
}

/* ---------- Task update cards ---------- */
// Task events show in the chat as compact cards, clearly not conversation: a task chip, a status
// colour and one line. Approvals get Approve / Deny right on the card, and collapse once answered
// (here, in the Workers tab, or by voice).
const taskCards = new Map(); // approvalId -> { card, status, actions }
const CARD = {
  approval: ['waiting', 'Needs your OK'],
  done: ['done', 'Done'],
  failed: ['failed', 'Failed'],
  stopped: ['stopped', 'Stopped'],
  review: ['review', 'Ready to review'],
};
function showTask(id) {
  document.querySelector('.tab[data-view="tasks"]')?.dispatchEvent(new Event('click'));
  const node = els.taskList.querySelector(`[data-id="${id}"]`);
  node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  node?.classList.add('flash');
  setTimeout(() => node?.classList.remove('flash'), 1400);
}
/** @param {{ kind: string, taskId: number, title?: string, where?: string, text?: string, approvalId?: string, level?: string }} ev */
function addTaskCard(ev) {
  if (ev.approvalId && taskCards.has(ev.approvalId)) return;
  els.chatEmpty.hidden = true;
  const [tone, label] = CARD[ev.kind] || ['done', 'Update'];
  const card = el('div', { className: `msg task-card ${tone}` });
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `Task update: ${ev.title || `task ${ev.taskId}`}, ${label}`);
  const chip = button(`#${ev.taskId}`, 'task-chip', () => showTask(ev.taskId));
  chip.title = 'Show this task';
  const status = el('span', { className: 'task-card-status' }, ev.kind === 'approval' && ev.level === 'risky' ? 'Needs your OK · risky' : label);
  const head = el('div', { className: 'task-card-head' });
  head.append(chip, el('span', { className: 'task-card-title' }, ev.title || ''), status);
  const line = el('div', { className: 'task-card-line' }, ev.text || '');
  line.title = ev.text || '';
  card.append(head, line);
  if (ev.kind === 'approval' && ev.approvalId) {
    const actions = el('div', { className: 'task-card-actions' });
    const answer = (allow) => {
      card.classList.add('sending');
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      send({ type: 'approve', taskId: ev.taskId, approvalId: ev.approvalId, allow });
    };
    actions.append(button('Deny', 'ghost small', () => answer(false)), button('Approve', 'small', () => answer(true)));
    card.append(actions);
    taskCards.set(ev.approvalId, { card, status, actions });
  }
  els.transcript.append(card);
  scrollDown();
}
/** An approval was answered: the card shrinks to one line saying how. @param {boolean | null} allowed */
function settleTaskCard(approvalId, allowed) {
  const c = approvalId && taskCards.get(approvalId);
  if (!c) return;
  taskCards.delete(approvalId);
  c.actions.remove();
  c.card.classList.remove('waiting', 'sending');
  c.card.classList.add('handled', allowed === false ? 'denied' : 'allowed');
  c.status.textContent = allowed === null ? 'Already answered' : allowed ? 'Approved ✓' : 'Denied';
}
/** After a reconnect: cards for approvals still waiting, and handled ones collapsed. */
function syncTaskCards(list) {
  const waiting = new Set();
  for (const t of list || []) {
    const a = t.pendingApproval;
    if (!a) continue;
    waiting.add(a.id);
    addTaskCard({ kind: 'approval', taskId: t.id, title: t.title, where: t.project, text: a.reason, approvalId: a.id, level: a.level });
  }
  for (const id of [...taskCards.keys()]) if (!waiting.has(id)) settleTaskCard(id, null);
}

let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

let costs = null;
function renderCosts() {
  if (!costs) return;
  const t = costs.today;
  els.cost.textContent = `Today $${t.total.toFixed(2)}`;
  els.cost.title = `Today ≈ $${t.total.toFixed(2)}: assistant $${t.assistant.toFixed(2)}, workers $${t.workers.toFixed(2)}. API-equivalent estimate; with a claude.ai login this counts toward your plan's usage limits, not a bill.`;
}

const ACTIVE = ['running', 'queued', 'waiting_approval'];
function activeCount() { return [...tasks.values()].filter((t) => ACTIVE.includes(t.status)).length; }
function updateMeta() {
  const active = activeCount();
  const waiting = [...tasks.values()].filter((t) => t.pendingApproval).length;
  els.meta.textContent = `${projects.length} projects · ${active ? `${active} working` : 'all quiet'}`;
  els.taskCount.textContent = tasks.size ? `${active} active · ${tasks.size} total` : '';
  els.tabCount.textContent = waiting || active || '';
  els.tabCount.classList.toggle('attention', waiting > 0);
  renderApprovalGroup();
  updatePiano();
}

// Two or more low-risk requests (read-only lookups) waiting at once get one shared answer.
const LOW_RISK = ['network_read', 'network_site'];
function lowRiskPending() {
  return [...tasks.values()].filter((t) => t.pendingApproval && LOW_RISK.includes(t.pendingApproval.level));
}
function renderApprovalGroup() {
  const group = lowRiskPending();
  els.approvalGroup.hidden = group.length < 2;
  if (group.length < 2) return;
  els.approvalGroupTitle.textContent = `${group.length} read-only lookups are waiting`;
  els.approvalGroupSub.textContent = group.map((t) => t.title).join(' · ');
}
function answerGroup(allow) {
  const items = lowRiskPending().map((t) => ({ taskId: t.id, approvalId: t.pendingApproval.id }));
  if (items.length) send({ type: 'approve_many', items, allow });
}
els.groupAllow.onclick = () => answerGroup(true);
els.groupDeny.onclick = () => answerGroup(false);

/* ---------- Transcript ---------- */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scrollDown() { els.transcript.scrollTop = els.transcript.scrollHeight; }
function addMsg(kind, text) {
  els.chatEmpty.hidden = true;
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  els.transcript.append(div);
  scrollDown();
  return div;
}

let busy = false;
function setBusy(b) { busy = b; renderOrb(); }

/* ---------- Tasks ---------- */
const SELF_LABEL = { review: 'Ready to review', no_changes: 'No changes', merged: 'Merged', discarded: 'Discarded', error: 'Review failed', stopped: 'Stopped' };
const STATUS_LABEL = { queued: 'Queued', running: 'Running', waiting_approval: 'Needs approval', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
const STATUS_CLASS = { queued: 'queued', running: 'running', waiting_approval: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
const SELF_CLASS = { review: 'waiting', no_changes: 'stopped', merged: 'done', discarded: 'stopped', error: 'failed', stopped: 'stopped' };
const APPROVAL_TITLE = { network_read: 'Wants to run a read-only web lookup', network_site: 'Wants to send a request to a website', risky: 'Wants to do something that needs your OK' };

function upsertTask(t) {
  tasks.set(t.id, t);
  els.emptyTasks.hidden = true;
  let node = els.taskList.querySelector(`[data-id="${t.id}"]`);
  if (!node) {
    node = els.tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = t.id;
    // Answers name the exact request on screen, so a late click can't approve a newer one.
    const answer = (allow, similar = false) => {
      const cur = tasks.get(t.id)?.pendingApproval;
      if (!cur) return;
      node.querySelector('.approval').classList.add('sent');
      send({ type: 'approve', taskId: t.id, approvalId: cur.id, allow, similar });
    };
    node.querySelector('.act-stop').onclick = () => send({ type: 'stop_task', taskId: t.id });
    node.querySelector('.act-term').onclick = () => send({ type: 'open_terminal', taskId: t.id });
    node.querySelector('.act-allow').onclick = () => answer(true);
    node.querySelector('.act-deny').onclick = () => answer(false);
    node.querySelector('.act-allow-similar').onclick = () => answer(true, true);
    node.querySelector('.act-diff').onclick = () => showDiff(t.id);
    node.querySelector('.act-merge').onclick = () => confirmMerge(t.id);
    node.querySelector('.act-discard').onclick = () => selfApi('/api/self/discard', { taskId: t.id });
    els.emptyTasks.after(node);
    const log = node.querySelector('.task-log');
    (t.logTail || []).forEach((e) => log.append(fmtLog(e)));
    log.scrollTop = log.scrollHeight;
    const last = (t.logTail || []).at(-1);
    if (last) setLive(node, last);
  }
  const selfState = t.kind === 'self' && t.self?.state;
  const selfShown = selfState && selfState !== 'working' && !ACTIVE.includes(t.status);
  const status = node.querySelector('.status');
  status.className = `status ${selfShown ? SELF_CLASS[selfState] || 'stopped' : STATUS_CLASS[t.status] || 'stopped'}`;
  node.querySelector('.status-text').textContent = selfShown ? SELF_LABEL[selfState] || selfState : STATUS_LABEL[t.status] || t.status;
  node.querySelector('.task-kind').textContent = kindLabel(t);
  node.querySelector('.task-kind').title = kindLabel(t);
  node.querySelector('.task-title').textContent = t.title;
  node.querySelector('.task-title').title = t.title;
  node.classList.toggle('is-running', t.status === 'running');
  node.classList.toggle('is-waiting', t.status === 'waiting_approval');
  node.dataset.startedAt = t.startedAt || t.createdAt;
  node.dataset.finishedAt = ACTIVE.includes(t.status) ? '' : t.finishedAt || t.updatedAt;
  node.dataset.costUsd = t.costUsd || 0;
  node.dataset.steps = t.steps || 0;
  node.dataset.taskId = t.id;
  renderMeta(node);
  node.querySelector('.task-live').classList.toggle('on', ['running', 'queued'].includes(t.status));
  if (t.status === 'queued' && !node.dataset.liveAt) node.querySelector('.live-text').textContent = 'Waiting for a free worker slot…';
  node.querySelector('.task-summary').textContent = ACTIVE.includes(t.status) ? '' : t.summary || '';
  node.querySelector('.task-instruction').textContent = t.instruction;
  node.querySelector('.activity-summary').textContent = `Log · ${t.steps || 0} step${t.steps === 1 ? '' : 's'}`;
  const files = node.querySelector('.task-files');
  files.replaceChildren(
    ...(t.files || []).map((f) => {
      const chip = el('button', { className: 'file-chip', type: 'button', title: `Open ${f.path}` }, f.name);
      chip.append(el('span', { className: 'how' }, f.how));
      chip.onclick = () => send({ type: 'open_file', taskId: t.id, path: f.path });
      return chip;
    })
  );
  node.querySelector('.act-stop').hidden = !ACTIVE.includes(t.status);
  node.querySelector('.act-term').hidden = !ACTIVE.includes(t.status);
  const appr = node.querySelector('.approval');
  const pa = t.pendingApproval;
  appr.hidden = !pa;
  if (pa && appr.dataset.approvalId !== pa.id) {
    appr.dataset.approvalId = pa.id;
    appr.classList.remove('sent');
    appr.querySelector('.approval-title').textContent = APPROVAL_TITLE[pa.level] || APPROVAL_TITLE.risky;
    appr.querySelector('.approval-text').textContent = pa.reason;
    node.querySelector('.act-allow-similar').hidden = pa.level === 'risky';
  }
  // A stopped self task keeps its branch until you discard it (or ask Echo to continue it).
  const review = node.querySelector('.review');
  const stoppedSelf = selfState === 'stopped' && !ACTIVE.includes(t.status);
  review.hidden = selfState !== 'review' && !stoppedSelf;
  review.classList.toggle('stopped', stoppedSelf);
  node.querySelector('.review-head strong').textContent = stoppedSelf ? 'Stopped before it finished' : 'Ready for your review';
  node.querySelector('.act-diff').hidden = node.querySelector('.act-merge').hidden = stoppedSelf;
  if (stoppedSelf) {
    review.querySelector('.review-checks').textContent = 'Ask Echo to continue it, or discard its branch.';
    review.querySelector('.review-stat').textContent = '';
  }
  if (selfState === 'review') {
    review.querySelector('.review-stat').textContent = t.self.review.stat;
    review.querySelector('.review-checks').innerHTML = Object.entries(t.self.review.checks)
      .map(([k, v]) => `<span class="${v.ok ? 'pass' : 'fail'}">${escapeHtml(k)} ${v.ok ? '✓' : '✗ failed'}</span>`)
      .join(' · ');
  }
  node.classList.toggle('attention', !!pa || selfState === 'review');
}

const KIND = { code: 'Project', research: 'Research', self: 'Improving Echo' };
function kindLabel(t) {
  if (t.kind === 'self') return KIND.self;
  return `${KIND[t.kind] || 'Project'} · ${t.project}`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayAndTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? clock(iso) : `${d.toLocaleDateString([], { weekday: 'short' })} ${clock(iso)}`;
}
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 5 ? 'now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}
function renderMeta(node) {
  const { startedAt, finishedAt, costUsd, steps, taskId } = node.dataset;
  const parts = [`#${taskId}`, dayAndTime(startedAt)];
  parts.push(finishedAt ? `took ${duration(Date.parse(finishedAt) - Date.parse(startedAt))}` : duration(Date.now() - Date.parse(startedAt)));
  parts.push(`$${Number(costUsd).toFixed(2)}`);
  if (Number(steps) > 0) parts.push(`${steps} steps`);
  node.querySelector('.task-meta').replaceChildren(...parts.map((p) => el('span', {}, p)));
  const liveAt = node.dataset.liveAt;
  if (liveAt) node.querySelector('.live-ago').textContent = ago(liveAt);
}
// Keep elapsed times and "12s ago" ticking.
setInterval(() => els.taskList.querySelectorAll('.task').forEach((n) => !n.dataset.finishedAt && n.dataset.startedAt && renderMeta(n)), 1000);

// The one-line "what it's doing now" under a running task.
const LIVE_KINDS = { tool: '', claude: '', note: '', ask: 'Waiting for you: ', ok: '', deny: '', you: 'You: ', grant: '' };
function setLive(node, e) {
  if (!(e.kind in LIVE_KINDS)) return;
  const text = `${LIVE_KINDS[e.kind]}${e.text.split('\n')[0]}`.slice(0, 240);
  node.querySelector('.live-text').textContent = text;
  node.querySelector('.live-text').title = e.text.slice(0, 600);
  node.dataset.liveAt = e.t;
  node.querySelector('.live-ago').textContent = ago(e.t);
}

function fmtLog(e) {
  const time = new Date(e.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return `${time}  ${e.kind.padEnd(6)} ${e.text.length > 600 ? e.text.slice(0, 600) + '…' : e.text}\n`;
}
function appendLog(id, entry) {
  const log = els.taskList.querySelector(`[data-id="${id}"] .task-log`);
  if (!log) return;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(fmtLog(entry));
  while (log.childNodes.length > 300) log.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
  setLive(log.closest('.task'), entry);
}

/* ---------- Audio engine ---------- */
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const outAnalyser = ctx.createAnalyser();
outAnalyser.fftSize = 512;
outAnalyser.smoothingTimeConstant = 0.6;
outAnalyser.connect(ctx.destination);
const unlockAudio = () => ctx.state === 'suspended' && ctx.resume();
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

// Little synthesized sound effects, so the app feels alive without any audio files.
function sfx(kind) {
  if (!settings.sounds || ctx.state !== 'running') return;
  const notes = {
    listen: [[660, 0], [880, 0.07]],
    wake: [[784, 0], [1175, 0.09]], // "Hey Echo" heard
    stop: [[880, 0], [587, 0.07]],
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
    gain.gain.exponentialRampToValueAtTime(kind === 'send' ? 0.05 : 0.12, t0 + at + 0.015);
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
/** A whole reply at once: sentences grouped the same way as streamed ones (two, then ~30 words). */
function speakAll(text, bubble = null) {
  const groups = [];
  let cur = [];
  let words = 0;
  for (const s of splitSentences(text)) {
    const n = s.split(/\s+/).length;
    const full = groups.length === 0 ? cur.length >= 2 || words >= 14 : words >= 8 && words + n > 30;
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
    speak(g, bubble, { prev });
    prev = g;
  }
  karaoke.release(bubble);
}

// Word-by-word highlighting of the reply as it's spoken (karaoke.js). The clock is the audio
// context's, shifted by the output latency so the glow lands when you hear the word.
const karaoke = createKaraoke({ now: () => ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) });

/**
 * @param {string} text @param {HTMLElement | null} [bubble]
 * @param {{ prev?: string, soft?: boolean }} [o]  prev: the piece before (the voice carries its
 *   intonation on); soft: quieter, for a "didn't catch that"
 */
function speak(text, bubble = null, { prev = '', soft = false } = {}) {
  if (!els.speakOut.checked || !text.trim()) return;
  // You're holding Space to talk: the rest of the old reply stays quiet (it's in the chat).
  if (listening && pttRecording) return;
  const item = { text, gen: speechGen, chunk: karaoke.bind(bubble, text), words: null, soft };
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
  let browser = false;
  try {
    if (!item.audio) throw new Error('browser voice');
    const buffer = await item.audio;
    if (item.gen !== speechGen) return;
    await new Promise((resolve) => {
      const src = ctx.createBufferSource();
      // Only the speech itself (the engine's padding trimmed), a natural pause after the piece
      // before it; or now, if that pause has already gone by while this piece was being made.
      const { offset, length } = playPlan(speechBounds(buffer.getChannelData(0), buffer.sampleRate), buffer.duration);
      const at = Math.max(ctx.currentTime + 0.02, playEnd + pieceGap(lastSpoken, settings.speed));
      playEnd = at + length;
      lastSpoken = item.text;
      if (item.chunk) {
        const times = item.words ? alignTimings(item.text, item.words)?.map((t) => ({ s: Math.max(0, t.s - offset), e: Math.max(0, t.e - offset) })) : null;
        karaoke.play(item.chunk, { start: at, duration: length, times, bounds: times ? undefined : { lead: 0.02, tail: 0.02 } });
      }
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
      const guard = setTimeout(() => { try { src.stop(); } catch {} ended(); }, (playEnd - ctx.currentTime) * 1000 + 3000);
      const ended = () => {
        clearTimeout(guard);
        sources.delete(src);
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
    });
  } catch {
    if (item.gen !== speechGen) return;
    browser = true;
    await browserSpeak(item);
  }
  if (browser) karaoke.finish(item.chunk);
  if (item.gen === speechGen) playNext();
  else if (playing === item) playing = null;
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
    u.onboundary = (e) => { if (e.name === 'word' || e.name === undefined) karaoke.boundary(item.chunk, e.charIndex); };
    item.stop = () => { clearTimeout(guard); speechSynthesis.cancel(); resolve(); };
    speechSynthesis.speak(u);
  });
}

// Task events wait while Echo is speaking or hearing you, so they never cut in (the server holds
// them: dispatcher.setVoiceBusy).
let voiceBusySent = false;
function reportVoiceBusy(force = false) {
  const b = Boolean(speaking || hearing || transcribing || listening && spaceHeld || wakeState === 'awake');
  if (b === voiceBusySent && !force) return;
  voiceBusySent = b;
  send({ type: 'voice_busy', busy: b });
}

function setSpeaking(on) {
  if (speaking === on) return;
  speaking = on;
  if (!on) {
    echoQuietUntil = performance.now() + ECHO_TAIL_MS;
    lastSpokeAt = performance.now();
    // She asked you something: the wake listener takes your answer without "Hey Echo" (hush() clears
    // lastSpoken first, so a hushed reply doesn't count).
    if (/\?["')\s]*$/.test(lastSpoken)) setTimeout(() => { if (wakeListening() && !echoing() && wake.state === 'idle') wake.expectFollowUp(); }, ECHO_TAIL_MS + 50);
  }
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
  speechSynthesis.cancel();
  karaoke.stopAll();
  setSpeaking(false);
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
let voicedMs = 0;
let silentMs = 0;

// Echo's own voice must never become part of what you said. Echo cancellation is asked for (and
// its state saved with each clip), and on top of that the mic ignores everything while Echo speaks
// and for a short tail after (the room and the speakers' latency): the pre-roll is emptied, so a
// clip never starts with the end of Echo's reply, and hands-free doesn't hear her as you.
const ECHO_TAIL_MS = 400;
let echoQuietUntil = 0;
// Hands-free with the wake word on: speech right after Echo's reply is a follow-up, so it doesn't
// need her name (the server checks: lib/heard.js addressesEcho).
const FOLLOW_UP_MS = 15000;
let lastSpokeAt = -Infinity;

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
    if (!spaceHeld) clickAutoEnd(frame, frameMs);
    return;
  }
  if (wakeListening()) {
    // Echo's own voice never reaches the wake listener: it's muted while she speaks and just after.
    if (echo) { if (wake.state !== 'idle' || wake.buf) wake.reset(); }
    else wake.feed(frame);
    return;
  }
  if (!serverEngine() || !listening || echo || !els.handsFree.checked) return;
  // Hands-free: energy detector with an adaptive noise floor.
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
      renderOrb();
    }
  } else {
    voicedMs = Math.max(0, voicedMs - frameMs);
    if (hearing) silentMs += frameMs;
  }
  if (hearing) {
    clip.push(frame);
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
  if (samples / ctx.sampleRate < 0.4) {
    // A click or a cough; but if the live listener caught words, the clip was cut short.
    if (live) sendClip(null, live, { seconds: +(samples / ctx.sampleRate).toFixed(2), tooShort: true });
    return;
  }
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
    trackState: micTrack?.readyState, trackMuted: Boolean(micTrack?.muted), mode: els.handsFree.checked ? 'hands-free' : 'push-to-talk',
    // Did the browser really turn echo cancellation on? (Some inputs and browsers ignore the ask.)
    aec: micTrack?.getSettings?.().echoCancellation ?? null, echoTailMs: ECHO_TAIL_MS,
    followUp: performance.now() - lastSpokeAt < FOLLOW_UP_MS,
  };
  // Pure silence from the mic: the stream has gone dead. Open a fresh one for next time.
  if (peak < 0.0005) dropMic('the clip was pure silence');
  sendClip(encodeWav(downsample(pcm, ctx.sampleRate, 16000), 16000), live, notes);
}

function downsample(pcm, from, to) {
  if (from === to) return pcm;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(pcm.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += pcm[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

const isBlank = (t) => !/[\p{L}\p{N}]/u.test(String(t || ''));

// Nothing was heard, not even by the live listener: nothing goes to Echo. A small note in the
// chat, and the first time in a row she says so, softly; after that, just the note.
let missedOnce = false;
function didntCatch() {
  els.state.textContent = "Didn't catch that — try again.";
  addMsg('missed', "Didn't catch that.");
  if (!missedOnce) speak("Sorry, I didn't catch that.", null, { soft: true });
  missedOnce = true;
}

/**
 * Send a clip to be transcribed, with what the live listener showed (the server uses it when the
 * transcription comes back blank) and notes on the mic, for finding why. With no clip (cut too
 * short to send), the live text goes as typed-in speech.
 * @param {Blob | null} wav @param {string} live @param {object} notes
 */
async function sendClip(wav, live = '', notes = {}) {
  if (!wav) {
    if (!isBlank(live)) { sfx('send'); send({ type: 'user_text', text: live, confidence: 0.7 }); }
    return;
  }
  transcribing = true;
  els.interim.textContent = els.interim.textContent || 'Transcribing…';
  renderOrb();
  sfx('send');
  try {
    const headers = { 'Content-Type': 'audio/wav', 'X-Echo-Clip': encodeURIComponent(JSON.stringify(notes)) };
    if (!isBlank(live)) headers['X-Echo-Live'] = encodeURIComponent(JSON.stringify(live.slice(0, 2000)));
    const res = await fetch('/api/utterance', { method: 'POST', headers, body: wav });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Transcription failed');
    // Not a turn, and nothing to say about it: talk that wasn't for Echo, or her own voice.
    if (out.reason === 'not_for_echo') els.state.textContent = 'Not for me? Say "Echo" first.';
    else if (out.reason === 'own_voice') els.state.textContent = 'That was my own voice; ignored.';
    else if (out.reason === 'wake_only') els.state.textContent = "I'm here. Say \"Hey Echo\" and your request.";
    else if (out.empty) didntCatch();
    else missedOnce = false;
  } catch (e) {
    addMsg('error', `Couldn't transcribe: ${e.message}`);
  } finally {
    transcribing = false;
    els.interim.textContent = '';
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
    els.interim.textContent = (finalBuf + interim).trim();
    if (!serverEngine() && els.handsFree.checked) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(flushBrowser, settings.endSilenceMs || 1300);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') els.state.textContent = 'Microphone blocked — allow it in the address bar.';
  };
  rec.onend = () => {
    recOn = false;
    if (!serverEngine() && !els.handsFree.checked) flushBrowser();
    if (listening && !speaking && (!serverEngine() || settings.livePreview)) try { rec.start(); } catch {}
  };
}

function flushBrowser() {
  clearTimeout(silenceTimer);
  const text = finalBuf.trim() || (!els.handsFree.checked ? els.interim.textContent.trim() : '');
  const confidence = lastConfidence;
  resetLive();
  lastConfidence = 1;
  els.interim.textContent = '';
  if (!isBlank(text)) { sfx('send'); send({ type: 'user_text', text, confidence }); }
}

function startRec() {
  resetLive();
  if (rec && !recOn && (!serverEngine() || settings.livePreview)) try { rec.start(); } catch {}
}
function stopRec() {
  if (rec && recOn) try { serverEngine() ? rec.abort() : rec.stop(); } catch {}
}

/* --- controls shared by both --- */
async function startListening() {
  hush();
  if (!SR && !serverEngine()) {
    els.state.textContent = 'Voice input needs Chrome, Edge or Safari, or the local Whisper engine. You can still type.';
    return;
  }
  try {
    await ensureMic();
  } catch {
    return;
  }
  if (listening) return;
  listening = true;
  wake.reset();
  sfx('listen');
  if (serverEngine() && !els.handsFree.checked) {
    pttRecording = true;
    clip = [...preRoll];
    tap = { ms: 0, voicedMs: 0, silentMs: 0, spoke: false };
  }
  startRec();
  renderOrb();
}

function stopListening() {
  if (!listening) return;
  listening = false;
  sfx('stop');
  if (serverEngine()) {
    if (pttRecording) {
      // Keep the tail, then send.
      setTimeout(() => {
        pttRecording = false;
        finishClip();
      }, PTT_TAIL_MS);
    } else if (hearing) finishClip();
    stopRec();
  } else stopRec();
  renderOrb();
}

function pauseHandsFree() {
  if (!els.handsFree.checked || !listening) return;
  listening = false;
  hearing = false;
  clip = null;
  stopRec();
  if (rec && recOn) try { rec.abort(); } catch {}
}
function resumeHandsFree() {
  if (els.handsFree.checked && !speaking) setTimeout(() => !speaking && startListening(), 250);
}

/* --- "Hey Echo": the wake word --- */
// With the wake word on, the mic stays open and public/wake.js watches its loudness. Each burst of
// speech is checked by this Mac's Whisper (POST /api/wake); nothing is sent anywhere else or saved
// before "Hey Echo". Then a chime, the voice lights up, and your request is recorded until you
// pause. Space push-to-talk works as always. The pill in the toolbar shows it's on and turns the
// mic off completely.
let micOff = pref.get('micOff', false);
let wakeAvailable = false; // needs local Whisper (GET /api/stt)
let wakeState = 'idle';
const wakeOn = () => settings.wakeWord !== false && wakeAvailable && serverEngine() && !micOff && !els.handsFree.checked;
const wakeListening = () => wakeOn() && !listening && !pttRecording;
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
    sendClip(encodeWav(downsample(samples, ctx.sampleRate, 16000), 16000), '', notes);
  },
  onCancel: (why) => { if (why === 'no_request') sfx('stop'); },
  onState: (st) => {
    wakeState = st;
    renderOrb();
  },
});
/** Open or let go of the mic to match the wake-word setting, hands-free and the mic-off button. */
function syncWake() {
  if (!wakeOn()) {
    wake.reset();
    if (!listening && !els.handsFree.checked) dropMic('wake word off');
  } else ensureMic().catch(() => {});
  renderWakePill();
}
function renderWakePill() {
  const show = settings.wakeWord !== false && wakeAvailable && serverEngine() && !els.handsFree.checked;
  els.wakePill.hidden = !show;
  els.wakePill.classList.toggle('off', micOff);
  els.wakePill.classList.toggle('awake', wakeState === 'awake');
  els.wakePill.setAttribute('aria-pressed', String(!micOff));
  els.wakePill.querySelector('.tb-text').textContent = micOff ? 'Mic off' : 'Hey Echo';
  els.wakePill.dataset.tip = micOff ? 'Mic off. Click to listen for "Hey Echo" again (Space still works)' : ctx.state !== 'running' ? 'Click anywhere to start listening for "Hey Echo"' : 'Listening for "Hey Echo" on this Mac. Click to turn the mic off';
}
els.wakePill.onclick = () => {
  micOff = !micOff;
  pref.set('micOff', micOff);
  syncWake();
};
// The page can't hear anything until you've clicked or pressed a key once (browser audio rules).
ctx.addEventListener('statechange', renderWakePill);

/* ---------- Orb + voice visual ---------- */
function renderOrb() {
  viz.setState(vizState());
  reportVoiceBusy();
  heroSize();
  updatePiano();
  els.mic.classList.toggle('listening', listening);
  els.mic.classList.toggle('speaking', speaking);
  els.mic.classList.toggle('thinking', (busy || transcribing) && !listening && !speaking);
  const engineName = { whisper: 'local Whisper', deepgram: 'Deepgram', browser: 'browser' }[sttActive];
  const awake = wakeState === 'awake';
  if (els.wakePill) renderWakePill();
  els.state.innerHTML = transcribing ? 'Transcribing…'
    : awake ? 'Listening… go ahead'
    : hearing ? 'Hearing you…'
    : listening ? (els.handsFree.checked ? `Listening (${engineName})…` : `Listening (${engineName}) · release <kbd>Space</kbd> to send`)
    : speaking ? 'Speaking · <kbd>Esc</kbd> to hush, <kbd>Space</kbd> to cut in'
    : busy ? 'Thinking…'
    : els.handsFree.checked ? 'Hands-free: just talk'
    : wakeOn() ? 'Say “Hey Echo” or hold <kbd>Space</kbd> · <kbd>Esc</kbd> to hush'
    : 'Hold <kbd>Space</kbd> or click to talk · <kbd>Esc</kbd> to hush';
  reportToMac();
}

// The Mac app (macos/) drives listening and hands-free from its menu bar item, and shows their state.
/** @param {boolean} [force] */
function reportToMac(force) {
  const state = { type: 'state', listening, handsFree: els.handsFree.checked };
  const key = JSON.stringify(state);
  if (key === reportToMac.last && !force) return;
  reportToMac.last = key;
  /** @type {any} */ (window).webkit?.messageHandlers?.echoApp?.postMessage(state);
}
reportToMac.last = '';
/** @type {any} */ (window).echoNative = {
  toggleListening: () => (listening ? stopListening() : startListening()),
  /** @param {boolean} on */
  setHandsFree: (on) => { if (els.handsFree.checked !== Boolean(on)) els.handsFree.click(); },
  report: () => reportToMac(true),
  // The Mac app's "Check for Updates…" menu item.
  checkForUpdates: () => { openSettingsDrawer(); $('updatesSection').scrollIntoView({ block: 'start' }); checkForUpdates(); },
};

// The voice: liquid sunset light behind glass. It reads Echo's voice while she speaks and your
// mic while you talk (see voiceviz.js), and morphs smoothly between states.
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const viz = createVoiceViz(els.viz, {
  audio: () => (speaking ? outAnalyser : listening || wakeState === 'awake' ? micAnalyser : null),
  theme: darkScheme.matches ? 'dark' : 'light',
});
darkScheme.addEventListener('change', () => viz.setTheme(darkScheme.matches ? 'dark' : 'light'));
function vizState() {
  return speaking ? 'speaking' : listening || wakeState === 'awake' ? 'listening' : busy || transcribing ? 'thinking' : 'idle';
}

// The voice is full size while Echo speaks, listens or works. After a few quiet seconds it eases
// down (over ~4.5 s) to a small glow at the top and the chat takes the space; it grows back as
// soon as something starts. The easing is CSS (.hero.compact), and reduced motion skips it.
const HERO_IDLE_MS = 2500;
/** @type {any} */
let heroTimer = 0;
function heroSize() {
  // Hands-free keeps the mic open all the time, so there only hearing you counts as listening.
  const active = speaking || busy || transcribing || hearing || wakeState === 'awake' || (listening && !els.handsFree.checked);
  // On the empty welcome screen there's nothing to make room for.
  if (active || !els.chatEmpty.hidden) {
    clearTimeout(heroTimer);
    heroTimer = 0;
    els.hero.classList.remove('compact');
    return;
  }
  if (heroTimer || els.hero.classList.contains('compact')) return;
  heroTimer = setTimeout(() => {
    heroTimer = 0;
    heroSize.check();
  }, HERO_IDLE_MS);
}
heroSize.check = () => {
  const active = speaking || busy || transcribing || hearing || wakeState === 'awake' || (listening && !els.handsFree.checked);
  if (!active && els.chatEmpty.hidden) els.hero.classList.add('compact');
};

/* ---------- Ambient piano ---------- */
// Gentle generative piano while workers run and Echo is quiet; it ducks under her voice
// and while you talk. On/off and the mood are remembered.
const piano = new AmbientPiano(ctx, ctx.destination);
piano.setMood(pref.get('pianoMood', 'upbeat'));
let pianoOn = pref.get('piano', false);
let pianoPreviewUntil = 0; // turning it on with nothing running plays a short preview
// Full duck while Echo speaks or you're actually talking (push-to-talk, or hands-free hearing you).
// An idle hands-free mic between turns only ducks lightly; it stays open all the time, so a full
// duck there would silence the piano for good once Echo had spoken once.
function pianoDuck() {
  if (speaking || hearing || (listening && !els.handsFree.checked)) return true;
  return listening ? 'light' : false;
}
function updatePiano() {
  const audible = pianoOn && (activeCount() > 0 || Date.now() < pianoPreviewUntil);
  if (audible !== piano.playing) piano.setPlaying(audible);
  piano.setDucked(pianoDuck());
  const blocked = audible && ctx.state !== 'running';
  els.piano.classList.toggle('on', pianoOn);
  els.piano.classList.toggle('sounding', piano.sounding);
  els.piano.classList.toggle('waiting', pianoOn && !piano.sounding);
  els.pianoToggle.setAttribute('aria-pressed', String(pianoOn));
  const mood = PIANO_MOODS.find((m) => m.id === piano.mood);
  els.pianoToggle.dataset.tip = !pianoOn ? 'Ambient piano' : `Piano · ${mood?.label || 'on'}${piano.sounding ? ' · playing' : ''}`;
  els.pianoToggle.setAttribute('aria-label', !pianoOn ? 'Ambient piano: plays softly while workers run'
    : blocked ? `Ambient piano on (${mood?.label}), but audio is paused by the browser. Click anywhere to resume.`
    : !audible ? `Ambient piano on (${mood?.label}), waiting: it plays while workers run. Click to turn off.`
    : piano.sounding ? `Ambient piano playing (${mood?.label}). Click to turn off.`
    : `Ambient piano on (${mood?.label}), quiet while Echo speaks or listens. Click to turn off.`);
}
// Watchdog: end a preview, clear a stale "speaking" flag, and let the piano repair a stalled
// scheduler, a suspended context or a duck that never came back up.
setInterval(() => {
  if (pianoPreviewUntil && Date.now() > pianoPreviewUntil) pianoPreviewUntil = 0;
  if (speaking && !playing && !speechQueue.length) setSpeaking(false);
  updatePiano();
  const fixed = piano.watchdog();
  if (fixed.length) console.warn('[piano] watchdog repaired:', fixed.join(', '));
}, 1000);
function setPiano(on) {
  pianoOn = on;
  pref.set('piano', on);
  unlockAudio();
  pianoPreviewUntil = on && !activeCount() ? Date.now() + 20000 : 0;
  updatePiano();
}
function renderPianoMenu() {
  els.pianoMenu.replaceChildren(
    el('div', { className: 'menu-title' }, 'Ambient piano mood'),
    ...PIANO_MOODS.map((m) => {
      const item = el('button', { className: `menu-item${m.id === piano.mood ? ' on' : ''}`, type: 'button', role: 'menuitemradio' });
      item.setAttribute('aria-checked', String(m.id === piano.mood));
      item.append(el('span', { className: 'check' }, '✓'), el('span', {}, m.label), el('span', { className: 'hint' }, m.hint || ''));
      item.onclick = () => {
        closePianoMenu();
        pickMood(m.id);
      };
      return item;
    })
  );
}
const closePianoMenu = () => closeMenus(true);
// Picking a mood also turns the piano on, and plays a short preview when nothing is running.
function pickMood(id) {
  piano.setMood(id);
  pref.set('pianoMood', id);
  if (!pianoOn) setPiano(true);
  else {
    if (!activeCount()) pianoPreviewUntil = Date.now() + 20000;
    updatePiano();
  }
}
els.pianoToggle.onclick = () => setPiano(!pianoOn);

/* ---------- Header menus ---------- */
// The piano mood, voice and "…" menus: one open at a time, closed by a click outside or Esc;
// the arrow keys move between items.
const menus = [];
function popover(btn, menu, render) {
  menus.push({ btn, menu });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !menu.hidden;
    closeMenus();
    if (wasOpen) return;
    render();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    (menu.querySelector('.menu-item.on') || menuItems(menu)[0])?.focus();
  });
}
const menuItems = (menu) => /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.menu-item, .menu-switch input')]);
function closeMenus(refocus = false) {
  for (const { btn, menu } of menus) {
    if (menu.hidden) continue;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }
}
document.addEventListener('click', (e) => { if (!menus.some(({ menu }) => menu.contains(/** @type {Node} */ (e.target)))) closeMenus(); });
document.addEventListener('keydown', (e) => {
  const open = menus.find(({ menu }) => !menu.hidden);
  if (!open) return;
  if (e.key === 'Escape') {
    e.stopImmediatePropagation();
    closeMenus(true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = menuItems(open.menu);
    const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (e.code === 'Space' && open.menu.contains(document.activeElement)) {
    e.stopImmediatePropagation(); // Space picks the item; it doesn't start talking
  }
}, true);

popover(els.pianoMoodBtn, els.pianoMenu, renderPianoMenu);

/** A menu row with a check mark: a toggle (menuitemcheckbox) or one of a set (menuitemradio). */
function menuCheck(label, on, onclick, { role = 'menuitemcheckbox', hint = '', inline = false } = {}) {
  const item = el('button', { className: `menu-item${on ? ' on' : ''}${inline ? ' inline' : ''}`, type: 'button' });
  item.setAttribute('role', role);
  item.setAttribute('aria-checked', String(on));
  item.append(el('span', { className: 'check' }, '✓'), el('span', {}, label));
  if (hint) item.append(el('span', { className: 'hint' }, hint));
  item.onclick = onclick;
  return item;
}

// Voice: read replies aloud or not, and which voice.
function voiceChoices() {
  const current = voiceCatalog.providers.find((p) => p.id === settings.ttsProvider);
  if (settings.ttsProvider === 'browser') {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en')).map((v) => ({ id: v.name, name: v.name }));
    return { voices, selected: settings.browserVoice || '' };
  }
  return { voices: current?.voices || [], selected: settings.voice };
}
const shortVoice = (name) => String(name || '').split(' (')[0];
function renderVoiceButton() {
  const { voices, selected } = voiceChoices();
  const name = shortVoice(voices.find((v) => v.id === selected)?.name) || 'Voice';
  const on = els.speakOut.checked;
  els.voiceLabel.textContent = name;
  els.voiceBtn.classList.toggle('muted', !on);
  els.voiceBtn.dataset.tip = on ? `Voice · ${name}` : 'Replies are silent';
  els.voiceBtn.setAttribute('aria-label', on ? `Voice: ${name}. Replies are read aloud.` : `Voice: ${name}. Replies are silent.`);
}
function renderVoiceMenu() {
  const { voices, selected } = voiceChoices();
  els.voiceList.replaceChildren(
    ...(voices.length ? voices.map((v) =>
      menuCheck(shortVoice(v.name), v.id === selected, () => {
        closeMenus(true);
        saveSetting(settings.ttsProvider === 'browser' ? { browserVoice: v.id } : { voice: v.id });
      }, { role: 'menuitemradio', inline: true, hint: v.name.includes('(') ? v.name.slice(v.name.indexOf('(') + 1, -1) : '' })
    ) : [el('div', { className: 'hint', style: 'padding: 4px 10px 8px' }, 'This engine has no voices to pick.')])
  );
}
popover(els.voiceBtn, els.voiceMenu, renderVoiceMenu);
els.voiceMore.onclick = () => { closeMenus(); openSettingsDrawer(); };

// Narrow windows: the "…" menu holds what doesn't fit in the bar.
function renderMoreMenu() {
  const again = () => renderMoreMenu();
  const newChat = el('button', { className: 'menu-item', type: 'button' });
  newChat.setAttribute('role', 'menuitem');
  newChat.append(el('span', { className: 'icon' }, '+'), el('span', {}, 'New chat'));
  newChat.onclick = () => { closeMenus(); els.newConvo.click(); };
  const settingsItem = el('button', { className: 'menu-item menu-link', type: 'button' });
  settingsItem.setAttribute('role', 'menuitem');
  settingsItem.append(el('span'), el('span', {}, 'Voice & settings…'));
  settingsItem.onclick = () => { closeMenus(); openSettingsDrawer(); };
  els.moreMenu.replaceChildren(
    newChat,
    el('div', { className: 'menu-sep', role: 'separator' }),
    menuCheck('Hands-free', els.handsFree.checked, () => { els.handsFree.click(); again(); }, { hint: 'Talk without holding Space' }),
    menuCheck('Read replies aloud', els.speakOut.checked, () => { els.speakOut.click(); again(); }),
    menuCheck('Ambient piano', pianoOn, () => { setPiano(!pianoOn); again(); }, { hint: 'Plays softly while workers run' }),
    el('div', { className: 'menu-title' }, 'Piano mood'),
    ...PIANO_MOODS.map((m) => menuCheck(m.label, m.id === piano.mood, () => { pickMood(m.id); again(); }, { role: 'menuitemradio' })),
    el('div', { className: 'menu-sep', role: 'separator' }),
    settingsItem
  );
}
popover(els.moreBtn, els.moreMenu, renderMoreMenu);

/* ---------- Settings drawer ---------- */
function applySettings(s) {
  settings = { ...settings, ...s };
  els.assistantName.textContent = settings.assistantName;
  document.title = `${settings.assistantName} · Echo`;
  els.setName.value = settings.assistantName;
  els.setUser.value = settings.userName || '';
  els.setSpeed.value = settings.speed;
  els.speedVal.textContent = `${Number(settings.speed).toFixed(2)}×`;
  els.setSounds.checked = settings.sounds;
  els.setPause.value = settings.endSilenceMs;
  els.pauseVal.textContent = `${(settings.endSilenceMs / 1000).toFixed(1)}s`;
  els.setSmart.checked = settings.smartCorrection;
  els.setPreview.checked = settings.livePreview;
  els.setWake.checked = settings.wakeWord !== false;
  els.setWakeSens.value = String(settings.wakeSensitivity ?? 0.5);
  els.wakeSensVal.textContent = wakeSensLabel(settings.wakeSensitivity ?? 0.5);
  syncWake();
  els.setSttLang.value = settings.sttLanguage || 'en-IN';
  els.setBeginner.checked = Boolean(settings.beginnerMode);
  els.setSafe.checked = Boolean(settings.safeMode);
  $('setAutoUpdate').checked = Boolean(settings.autoUpdate);
  renderProjectsDir();
  renderSuggestions();
  renderVoiceControls();
  loadStt();
}

function renderVoiceControls() {
  els.personalities.innerHTML = '';
  for (const p of voiceCatalog.personalities) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${p.id === settings.personality ? ' on' : ''}`;
    b.textContent = p.label;
    b.onclick = () => saveSetting({ personality: p.id });
    els.personalities.append(b);
  }
  const providers = voiceCatalog.providers;
  els.setProvider.replaceChildren(...providers.map((p) => new Option(p.label, p.id)));
  els.setProvider.value = settings.ttsProvider;
  els.elevenHint.hidden = providers.some((p) => p.id === 'elevenlabs');
  const current = providers.find((p) => p.id === settings.ttsProvider);
  let voices = current?.voices || [];
  if (settings.ttsProvider === 'browser') {
    voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en')).map((v) => ({ id: v.name, name: v.name }));
  }
  els.setVoice.replaceChildren(...voices.map((v) => new Option(v.name, v.id)));
  els.setVoice.value = settings.ttsProvider === 'browser' ? settings.browserVoice || '' : settings.voice;
  renderVoiceButton();
}

async function saveSetting(patch) {
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  applySettings(await res.json());
}

function openSettingsDrawer() { els.settings.hidden = false; loadVocab(); }
els.openSettings.onclick = openSettingsDrawer;
els.closeSettings.onclick = () => { els.settings.hidden = true; };
els.setName.onchange = () => els.setName.value.trim() && saveSetting({ assistantName: els.setName.value.trim() });
els.setUser.onchange = () => saveSetting({ userName: els.setUser.value.trim() });
els.setSpeed.oninput = () => { els.speedVal.textContent = `${Number(els.setSpeed.value).toFixed(2)}×`; };
els.setSpeed.onchange = () => saveSetting({ speed: Number(els.setSpeed.value) });
els.setSounds.onchange = () => saveSetting({ sounds: els.setSounds.checked });
els.setProvider.onchange = () => {
  const p = voiceCatalog.providers.find((x) => x.id === els.setProvider.value);
  const patch = { ttsProvider: p.id };
  if (p.voices?.length && !p.voices.some((v) => v.id === settings.voice)) patch.voice = p.voices[0].id;
  saveSetting(patch);
};
els.setVoice.onchange = () =>
  saveSetting(settings.ttsProvider === 'browser' ? { browserVoice: els.setVoice.value } : { voice: els.setVoice.value });

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
speechSynthesis.onvoiceschanged = () => settings.ttsProvider === 'browser' && renderVoiceControls();

/* --- speech recognition settings --- */
async function loadStt() {
  try {
    const st = await fetch('/api/stt').then((r) => r.json());
    const wasServer = serverEngine();
    sttActive = st.active;
    wakeAvailable = Boolean(st.wake?.available);
    syncWake();
    if (rec && st.browserLang && rec.lang !== st.browserLang) rec.lang = st.browserLang;
    const label = { auto: 'Auto (best available)', whisper: 'Local Whisper (free, private)', deepgram: 'Deepgram Nova-3 (cloud, paid)', browser: 'Browser (basic)' };
    els.setStt.replaceChildren(
      ...['auto', 'whisper', 'deepgram', 'browser'].map((id) => {
        const o = new Option(label[id] + (id !== 'auto' && !st.engines[id].available ? ' — not set up' : ''), id);
        o.disabled = id !== 'auto' && !st.engines[id].available;
        return o;
      })
    );
    els.setStt.value = st.choice;
    const missing = Object.entries(st.engines).filter(([, e]) => !e.available).map(([id, e]) => `${label[id].split(' (')[0]}: ${e.why}`);
    els.sttHint.textContent = `Using ${label[st.active].split(' (')[0]}.` + (missing.length ? ` ${missing.join(' · ')}` : '');
    els.setSttLang.value = st.language || settings.sttLanguage || 'en-IN';
    if (wasServer !== serverEngine() && listening) { stopListening(); }
    renderOrb();
  } catch {}
}
async function loadVocab() {
  const v = await fetch('/api/vocabulary').then((r) => r.json());
  els.vocabWords.value = v.words.join('\n');
  els.vocabFixes.replaceChildren(
    ...Object.entries(v.corrections).map(([heard, meant]) => {
      const chip = el('span', { className: 'fix-chip' }, `${heard} → ${meant}`);
      const x = button('×', '', async () => {
        await selfApi('/api/vocabulary', { removeCorrection: heard });
        loadVocab();
      });
      x.title = 'Forget this correction';
      chip.append(x);
      return chip;
    })
  );
}
els.setStt.onchange = () => saveSetting({ sttEngine: els.setStt.value });
els.setSttLang.onchange = () => saveSetting({ sttLanguage: els.setSttLang.value });
els.setBeginner.onchange = () => saveSetting({ beginnerMode: els.setBeginner.checked });
els.setSafe.onchange = () => saveSetting({ safeMode: els.setSafe.checked });
$('setAutoUpdate').onchange = () => saveSetting({ autoUpdate: /** @type {HTMLInputElement} */ ($('setAutoUpdate')).checked });
els.setPause.oninput = () => { els.pauseVal.textContent = `${(els.setPause.value / 1000).toFixed(1)}s`; };
els.setPause.onchange = () => saveSetting({ endSilenceMs: Number(els.setPause.value) });
els.setSmart.onchange = () => saveSetting({ smartCorrection: els.setSmart.checked });
els.setPreview.onchange = () => saveSetting({ livePreview: els.setPreview.checked });
els.setWake.onchange = () => saveSetting({ wakeWord: els.setWake.checked });
const wakeSensLabel = (v) => (v < 0.34 ? 'strict' : v > 0.66 ? 'loose' : 'normal');
els.setWakeSens.oninput = () => { els.wakeSensVal.textContent = wakeSensLabel(Number(els.setWakeSens.value)); };
els.setWakeSens.onchange = () => saveSetting({ wakeSensitivity: Number(els.setWakeSens.value) });
els.vocabSave.onclick = async () => {
  await selfApi('/api/vocabulary', { words: els.vocabWords.value.split('\n') });
  loadVocab();
};

async function loadSettings() {
  try {
    const [cat, s] = await Promise.all([fetch('/api/voices').then((r) => r.json()), fetch('/api/settings').then((r) => r.json())]);
    voiceCatalog = cat;
    applySettings(s);
  } catch {}
}

/* ---------- Self-improve mode ---------- */
let selfStatus = { unlocked: false, hasPin: false };
let selfTimer = null;
function setSelfStatus(st) {
  if (!st) return;
  selfStatus = st;
  els.selfBadge.hidden = !st.unlocked;
  clearInterval(selfTimer);
  if (st.unlocked) {
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(st.expiresAt) - Date.now()) / 1000));
      els.selfTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    selfTimer = setInterval(tick, 1000);
  }
  if (st.pendingRequest && (els.modal.hidden || (modalKind === 'unlock' && shownRequest !== st.pendingRequest.id))) showUnlock(st.pendingRequest);
  else if (!st.pendingRequest && modalKind === 'unlock' && !els.modal.hidden) closeModal(); // answered or expired elsewhere
  els.pinCurrent.hidden = !st.hasPin;
  els.pinHint.textContent = st.hasPin
    ? 'A PIN is set. Unlocking self-improve mode and merging its changes need it.'
    : 'Optional. When set, unlocking self-improve mode and merging its changes also need this PIN.';
}
els.selfBadge.onclick = () => selfApi('/api/self/lock', {});

async function selfApi(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Modals keep their title and buttons fixed and scroll only the body, so the buttons stay
// reachable in a small window. `onEnter` runs on Enter (except in a multi-line field).
let modalEnter = null;
let modalLocked = false; // Esc doesn't dismiss the unlock prompt; use Cancel
let modalKind = ''; // 'unlock' while the self-improve confirmation is showing
let shownRequest = null;
function openModal(title, bodyNodes, actions, { narrow = false, onEnter = null, locked = false, hint = '', kind = '' } = {}) {
  modalKind = kind;
  els.modalTitle.textContent = title;
  els.modalBody.replaceChildren(...bodyNodes);
  els.modalActions.replaceChildren(...(hint ? [el('span', { className: 'key-hint' }, hint)] : []), ...actions);
  $('modalCard').classList.toggle('narrow', narrow);
  modalEnter = onEnter;
  modalLocked = locked;
  els.modal.hidden = false;
  els.modalBody.scrollTop = 0;
}
// A self-improve confirmation that's still waiting comes back once another dialog closes.
function closeModal() {
  const was = modalKind;
  els.modal.hidden = true;
  modalEnter = null;
  modalLocked = false;
  modalKind = '';
  const req = selfStatus.pendingRequest;
  if (was !== 'unlock' && req && Date.parse(req.expiresAt) > Date.now()) showUnlock(req);
}
els.modal.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !modalEnter || e.isComposing || /** @type {HTMLElement} */ (e.target).tagName === 'TEXTAREA') return;
  if (/** @type {HTMLElement} */ (e.target).tagName === 'BUTTON') return; // let the focused button act
  e.preventDefault();
  modalEnter();
});
const el = (tag, props = {}, text = '') => Object.assign(document.createElement(tag), props, text ? { textContent: text } : {});
const button = (label, cls, onclick) => Object.assign(el('button', { className: cls, type: 'button' }, label), { onclick });
/** A button that shows it's working and can't be double-clicked while `fn` runs. */
function actionButton(label, cls, fn) {
  const b = button(label, cls, async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await fn(); } finally { b.disabled = false; }
  });
  return b;
}

// A row of one-character boxes that fills like a single field: typing moves on, Backspace moves
// back, arrows move, and pasting spreads the characters across the boxes.
function segmentedInput(length, onChange) {
  const wrap = el('div', { className: 'segs', role: 'group' });
  const boxes = Array.from({ length }, (_, i) => {
    const b = el('input', { className: 'seg', maxLength: 1, autocomplete: 'off', spellcheck: false, inputMode: 'text' });
    b.setAttribute('autocapitalize', 'characters');
    b.setAttribute('aria-label', `Character ${i + 1} of ${length}`);
    return b;
  });
  const clean = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (from, text) => {
    let i = from;
    for (const ch of clean(text)) { if (i >= length) break; boxes[i++].value = ch; }
    boxes.forEach((b) => b.classList.toggle('filled', !!b.value));
    boxes[Math.min(i, length - 1)].focus();
    onChange(value());
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      const v = clean(b.value);
      b.value = '';
      if (v) fill(i, v);
      else { b.classList.remove('filled'); onChange(value()); }
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && i > 0) { e.preventDefault(); boxes[i - 1].value = ''; boxes[i - 1].classList.remove('filled'); boxes[i - 1].focus(); onChange(value()); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
      else if (e.key === 'ArrowRight' && i < length - 1) { e.preventDefault(); boxes[i + 1].focus(); }
    });
    b.addEventListener('paste', (e) => { e.preventDefault(); fill(i, e.clipboardData?.getData('text') || ''); });
    b.addEventListener('focus', () => b.select());
  });
  wrap.append(...boxes);
  return { el: wrap, value, focus: () => boxes[Math.min(value().length, length - 1)].focus() };
}

function step(n, title, bodyNodes) {
  const node = el('section', { className: 'step' });
  node.append(el('span', { className: 'step-num' }, String(n)), el('div', { className: 'step-title' }, title), el('div', { className: 'step-body' }));
  node.querySelector('.step-body').append(...bodyNodes);
  return node;
}

// Unlocking needs a human at this screen: type the code shown here (plus the PIN, if set).
// It can't be done by voice, so it can't be triggered by a mishearing or someone overhearing.
function showUnlock(req) {
  const len = req.code.length;
  const codeStatus = el('div', { className: 'step-status' }, `Type the ${len} characters shown above.`);
  const codeShow = el('div', { className: 'code-show' });
  codeShow.setAttribute('aria-label', `Code: ${req.code.split('').join(' ')}`);
  codeShow.append(...req.code.split('').map((ch) => el('span', {}, ch)));
  const segs = segmentedInput(len, (v) => {
    const done = v.length === len;
    const ok = done && v === req.code;
    step1.classList.toggle('done', ok);
    step1.classList.toggle('bad', done && !ok);
    codeStatus.textContent = ok ? 'Code matches.' : done ? "That doesn't match the code above. Check each character." : `Type the ${len} characters shown above.`;
    if (ok) (req.needsPin ? pinIn : confirm).focus();
  });
  const step1 = step(1, 'Type this code', [codeShow, el('label', {}, 'Your entry'), segs.el, codeStatus]);

  const pinIn = el('input', { type: 'password', inputMode: 'numeric', className: 'pin-in', placeholder: '••••', autocomplete: 'off', id: 'unlockPin' });
  const pinStatus = el('div', { className: 'step-status' }, 'The PIN you set in Settings.');
  pinIn.addEventListener('input', () => { pinIn.classList.remove('invalid'); step2.classList.remove('bad'); pinStatus.textContent = 'The PIN you set in Settings.'; });
  const step2 = step(2, 'Enter your PIN', [pinIn, pinStatus]);
  const err = el('div', { className: 'err', role: 'alert' });

  const body = [
    el('p', {}, `${settings.assistantName} wants to edit its own code:`),
    el('div', { className: 'instruction' }, req.instruction),
    el('p', { className: 'hint' }, `It works on a separate branch, and nothing changes until you review the diff and click Merge. The unlock lasts 30 minutes or one task, whichever comes first.${req.firstTime ? ' First time only: Echo will create a git repository with a baseline commit.' : ''}`),
    step1,
    ...(req.needsPin ? [step2] : []),
    err,
  ];
  const submit = async () => {
    err.textContent = '';
    const code = segs.value();
    if (code !== req.code) {
      step1.classList.add('bad');
      codeStatus.textContent = code.length < len ? `Type all ${len} characters of the code.` : "That doesn't match the code above. Check each character.";
      segs.focus();
      return;
    }
    if (req.needsPin && !pinIn.value.trim()) {
      step2.classList.add('bad');
      pinIn.classList.add('invalid');
      pinStatus.textContent = 'Enter your PIN to continue.';
      pinIn.focus();
      return;
    }
    try {
      await selfApi('/api/self/confirm', { requestId: req.id, code, pin: pinIn.value });
      closeModal();
    } catch (e) {
      // The code was checked above, so a rejection here is the PIN (or an expired request).
      if (req.needsPin && /PIN/.test(e.message)) {
        step2.classList.add('bad');
        pinIn.classList.add('invalid');
        pinStatus.textContent = "That PIN isn't right. Too many wrong tries locks self-improve for 15 minutes.";
        pinIn.select();
      } else err.textContent = e.message;
    }
  };
  const confirm = actionButton('Unlock & start', 'ok', submit);
  const cancel = button('Cancel', 'ghost', async () => {
    await selfApi('/api/self/cancel', {}).catch(() => {});
    closeModal();
  });
  openModal('Allow self-improvement?', body, [cancel, confirm], { narrow: true, onEnter: () => confirm.click(), locked: true, hint: 'Enter to confirm', kind: 'unlock' });
  shownRequest = req.id;
  segs.focus();
}

async function showDiff(taskId) {
  const review = await fetch(`/api/self/diff?taskId=${taskId}`).then((r) => r.json());
  const pre = el('pre', { className: 'diff' });
  for (const line of (review.diff || '').split('\n')) {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
    pre.append(el('span', { className: cls }, line + '\n'));
  }
  const checks = Object.entries(review.checks || {}).map(([k, v]) => {
    const d = el('details');
    d.append(el('summary', {}, `${k}: ${v.ok ? 'passed' : 'FAILED'}`), el('pre', { className: 'diff' }, v.output));
    return d;
  });
  openModal(`Self-improvement #${taskId}: changes`, [el('pre', { className: 'review-stat' }, review.stat), ...checks, pre], [
    button('Close', 'ghost', closeModal),
    button('Merge & restart', 'ok', () => confirmMerge(taskId)),
  ]);
}

function confirmMerge(taskId) {
  const t = tasks.get(taskId);
  const failed = Object.entries(t?.self?.review?.checks || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  const pinIn = el('input', { type: 'password', inputMode: 'numeric', className: 'pin-in', placeholder: '••••', autocomplete: 'off', id: 'mergePin' });
  const err = el('div', { className: 'err', role: 'alert' });
  pinIn.addEventListener('input', () => { pinIn.classList.remove('invalid'); err.textContent = ''; });
  const body = [
    el('p', {}, 'This merges the change into the live Echo and restarts it. Running tasks are paused and resumed automatically. If the new version fails its health check, Echo rolls back on its own.'),
    ...(failed.length ? [el('p', { className: 'err' }, `Warning: ${failed.join(' and ')} failed for this change.`)] : []),
    ...(selfStatus.hasPin ? [el('label', { className: 'field', htmlFor: 'mergePin' }, 'Enter your PIN'), pinIn] : []),
    err,
  ];
  const merge = actionButton('Merge & restart', 'ok', async () => {
    if (selfStatus.hasPin && !pinIn.value.trim()) {
      pinIn.classList.add('invalid');
      err.textContent = 'Enter your PIN to merge.';
      pinIn.focus();
      return;
    }
    try {
      await selfApi('/api/self/merge', { taskId, pin: pinIn.value });
      closeModal();
      els.restartOverlay.hidden = false;
    } catch (e) {
      if (/PIN/.test(e.message)) pinIn.classList.add('invalid');
      err.textContent = e.message;
    }
  });
  openModal('Merge and restart?', body, [button('Cancel', 'ghost', closeModal), merge], { narrow: true, onEnter: () => merge.click(), hint: 'Enter to merge' });
  (selfStatus.hasPin ? pinIn : merge).focus();
}

els.pinSave.onclick = async () => {
  try {
    await selfApi('/api/self/pin', { newPin: els.pinNew.value, currentPin: els.pinCurrent.value });
    els.pinNew.value = els.pinCurrent.value = '';
    els.pinHint.textContent = 'PIN saved.';
  } catch (e) {
    els.pinHint.textContent = e.message;
  }
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.modal.hidden && !modalLocked) closeModal(); });

/* ---------- Controls ---------- */
els.mic.onclick = () => (listening ? stopListening() : startListening());
// Space talks, except while typing or while a control has keyboard focus (then Space presses it).
const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) ||
  Boolean(document.activeElement?.closest?.('.controls, .menu') && document.activeElement.matches(':focus-visible'));
let spaceHeld = false;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hush(); send({ type: 'interrupt' }); }
  if (e.code === 'Space' && !typing() && !els.handsFree.checked && !wizard.isOpen() && els.modal.hidden) {
    e.preventDefault();
    if (!spaceHeld) { spaceHeld = true; startListening(); }
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHeld) { spaceHeld = false; stopListening(); }
});

els.handsFree.checked = pref.get('handsFree', false);
els.speakOut.checked = pref.get('speakOut', true);
renderVoiceButton();
els.handsFree.onchange = () => {
  pref.set('handsFree', els.handsFree.checked);
  els.handsFree.checked ? startListening() : stopListening();
  syncWake();
  renderOrb();
};
els.speakOut.onchange = () => { pref.set('speakOut', els.speakOut.checked); if (!els.speakOut.checked) hush(); renderVoiceButton(); };
els.newConvo.onclick = () => send({ type: 'new_conversation' });
els.suggestions.addEventListener('click', (e) => {
  const b = /** @type {HTMLElement} */ (e.target).closest('.suggestion');
  if (b) putInComposer(b.textContent);
});
/** Put text in the message box, ready to edit or send (never sent by itself). */
function putInComposer(text) {
  if (els.main.dataset.view !== 'chat') document.querySelector('.tab[data-view="chat"]')?.dispatchEvent(new Event('click'));
  els.typeInput.value = text;
  syncSend();
  growInput();
  els.typeInput.focus();
  els.typeInput.setSelectionRange(text.length, text.length);
}
/** The idea buttons on the empty chat, tailored to what the person said they want help with. */
function renderSuggestions() {
  els.suggestions.replaceChildren(...suggestionsFor(settings).map((t) => el('button', { type: 'button', className: 'suggestion' }, t)));
}
// The voice floats over the chat; keep the transcript's top padding matched to its height.
new ResizeObserver(([e]) => {
  els.hero.parentElement.style.setProperty('--hero-h', `${Math.round(e.borderBoxSize?.[0]?.blockSize ?? els.hero.offsetHeight)}px`);
}).observe(els.hero);
// Narrow windows show one pane at a time.
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    els.main.dataset.view = tab.dataset.view;
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('on', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    }
  };
}
/* ---------- Composer: text and images ---------- */
// The message box grows with what you type (up to 40% of the window, then scrolls). Enter
// sends, Shift+Enter starts a new line. Images come in by paste, drag and drop or the paperclip;
// each is shrunk in the page (about 1600px, under 1.5MB), uploaded right away and sent with
// the message by reference.
const MAX_EDGE = 1600;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGES = 6;
/** @type {Array<{ key: number, preview: string, id: string | null, failed: boolean, ready: Promise<void>, node: HTMLElement }>} */
let attachments = [];
let attachKey = 0;

// Send is quiet until there's something to send.
function syncSend() {
  els.sendBtn.disabled = !els.typeInput.value.trim() && !attachments.some((a) => !a.failed);
}
function growInput() {
  const t = els.typeInput;
  t.style.height = 'auto';
  const max = Math.round(window.innerHeight * 0.4);
  t.style.height = `${Math.min(t.scrollHeight, max)}px`;
  t.classList.toggle('scrolls', t.scrollHeight > max);
}
els.typeInput.addEventListener('input', () => { syncSend(); growInput(); });
window.addEventListener('resize', growInput);
els.typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.typeForm.requestSubmit();
  }
});

/**
 * Shrink an image to fit MAX_EDGE and MAX_BYTES. Small PNG/WebP/GIF files that already fit are
 * kept as they are (screenshots stay crisp, GIFs keep moving); everything else becomes a JPEG.
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const fits = Math.max(bmp.width, bmp.height) <= MAX_EDGE && file.size <= MAX_BYTES;
  if (fits && /^image\/(png|webp|gif|jpeg)$/.test(file.type)) { bmp.close(); return file; }
  let scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // JPEG has no transparency
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.88, 0.8, 0.7]) {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) { bmp.close(); return blob; }
    }
    scale *= 0.8;
  }
  bmp.close();
  throw new Error('Image is too large');
}

async function uploadImage(blob) {
  const res = await fetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'Upload failed');
  return out;
}

/** @param {Iterable<File>} files */
function addImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return false;
  const room = MAX_IMAGES - attachments.length;
  if (images.length > room) toast(room > 0 ? `Only ${MAX_IMAGES} images per message; added the first ${room}.` : `Only ${MAX_IMAGES} images per message.`);
  for (const file of images.slice(0, Math.max(0, room))) {
    const key = ++attachKey;
    const preview = URL.createObjectURL(file);
    const node = el('div', { className: 'thumb busy' });
    const img = el('img', { src: preview, alt: file.name || 'Pasted image' });
    const rm = el('button', { type: 'button', className: 'rm', title: 'Remove' });
    rm.setAttribute('aria-label', `Remove ${file.name || 'image'}`);
    rm.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    rm.onclick = () => removeAttachment(key);
    node.append(img, rm);
    const item = { key, preview, id: null, failed: false, node, ready: null };
    item.ready = shrinkImage(file)
      .then(uploadImage)
      .then((out) => { item.id = out.id; node.classList.remove('busy'); })
      .catch((e) => {
        item.failed = true;
        node.classList.remove('busy');
        node.classList.add('failed');
        node.title = `Couldn't attach: ${e.message}`;
        toast(`Couldn't attach ${file.name || 'that image'}: ${e.message}`);
        syncSend();
      });
    attachments.push(item);
    els.attachTray.append(node);
  }
  els.attachTray.hidden = !attachments.length;
  syncSend();
  return true;
}
function removeAttachment(key) {
  const item = attachments.find((a) => a.key === key);
  if (!item) return;
  attachments = attachments.filter((a) => a !== item);
  item.node.remove();
  URL.revokeObjectURL(item.preview);
  els.attachTray.hidden = !attachments.length;
  syncSend();
  els.typeInput.focus();
}
function clearAttachments() {
  for (const a of attachments) { a.node.remove(); URL.revokeObjectURL(a.preview); }
  attachments = [];
  els.attachTray.hidden = true;
}

els.attachBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = () => { addImages(els.fileInput.files || []); els.fileInput.value = ''; els.typeInput.focus(); };
els.typeInput.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) {
    // Pasting a screenshot attaches it; any text in the clipboard still pastes as text.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addImages(files);
  }
});
// Drag images anywhere over the chat.
const convo = els.hero.parentElement;
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
convo.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; els.dropVeil.hidden = false; });
convo.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
convo.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropVeil.hidden = true; } });
convo.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropVeil.hidden = true;
  if (!addImages(e.dataTransfer.files)) toast('Only images can be attached.');
  els.typeInput.focus();
});

let sending = false;
els.typeForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = els.typeInput.value.trim();
  if (sending || (!text && !attachments.some((a) => !a.failed))) return;
  sending = true;
  try {
    await Promise.all(attachments.map((a) => a.ready));
    const images = attachments.filter((a) => a.id).map((a) => a.id);
    if (!text && !images.length) return;
    sfx('send');
    send({ type: 'user_text', text, typed: true, ...(images.length ? { images } : {}) });
    els.typeInput.value = '';
    clearAttachments();
  } finally {
    sending = false;
    syncSend();
    growInput();
  }
};

/** Images in a chat bubble; each opens full size in a new tab. */
function imageGrid(urls) {
  const grid = el('div', { className: `msg-images${urls.length === 1 ? ' one' : ''}` });
  grid.style.setProperty('--cols', String(Math.min(3, urls.length)));
  for (const url of urls) {
    const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
    a.append(el('img', { src: url, alt: 'Attached image' }));
    grid.append(a);
  }
  return grid;
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
  onFinish: () => {
    if (onboarding) onboarding.needed = false;
    if (els.handsFree.checked) startListening();
  },
});

function renderProjectsDir() {
  const dir = settings.projectsDir || onboarding?.defaults?.projectsDir || '';
  els.projectsDirShow.textContent = friendlyPath(dir, onboarding?.defaults?.home) || 'Not set yet';
  els.projectsDirShow.title = dir;
}
els.changeFolder.onclick = () => { els.settings.hidden = true; wizard.open('files', { single: true, canClose: true }); };
els.runSetup.onclick = () => { els.settings.hidden = true; wizard.open('welcome', { canClose: true }); };
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
      await selfApi('/api/reset', { confirm: 'RESET', pin: pinIn.value });
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
    for (const k of Object.keys(localStorage)) if (k.startsWith('voiceops.')) localStorage.removeItem(k);
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

// Deep links for testing and screenshots: ?setup=<step>, ?settings=1 (or =help), ?reset=1.
async function startOnboarding() {
  try { onboarding = await fetch('/api/onboarding').then((r) => r.json()); } catch {}
  renderProjectsDir();
  const params = new URLSearchParams(location.search);
  const step = params.get('setup');
  if (step !== null) {
    wizard.open(STEPS.includes(/** @type {any} */ (step)) ? step : 'welcome', { canClose: !onboarding?.needed, state: onboarding });
  } else if (params.has('settings')) {
    openSettingsDrawer();
    if (params.get('settings') === 'help') els.settings.scrollTop = $('helpSafety').offsetTop - 24;
  } else if (params.has('reset')) {
    showReset();
  } else if (onboarding?.needed) {
    wizard.open('welcome', { canClose: false, state: onboarding });
  }
}

loadSettings();
connect();
renderOrb();
startOnboarding();
if (els.handsFree.checked) startListening();

/* ---------- Updates (lib/updater.js) ---------- */
let updateStatus = null;
let pageVersion = null; // the version this page was loaded from; a newer server means reload
const PHASES = { checking: 'Checking…', downloading: 'Downloading…', verifying: 'Checking the download…', installing: 'Installing…', restarting: 'Restarting…' };
function setUpdateStatus(st, notice) {
  if (!st) return;
  if (pageVersion && st.current !== pageVersion) { location.reload(); return; }
  pageVersion ||= st.current;
  updateStatus = st;
  $('updVersion').textContent = `Echo ${st.current}`;
  const hint = $('updHint');
  const state = $('updState');
  $('autoUpdateRow').hidden = st.developer || !st.configured;
  $('updCheck').hidden = st.developer || !st.configured;
  const back = $('updRollback');
  back.hidden = st.developer || !st.previous;
  back.textContent = st.previous ? `Go back to ${st.previous}` : 'Go back';
  if (st.developer) {
    state.textContent = '· Developer copy';
    hint.textContent = 'This copy is a git checkout, so it updates through git and self-improve, not from releases.';
  } else if (!st.configured) {
    state.textContent = '';
    hint.textContent = "Updates aren't set up for this copy.";
  } else {
    const pct = st.phase === 'downloading' && typeof st.progress === 'number' ? ` ${Math.round(st.progress * 100)}%` : '';
    state.textContent = PHASES[st.phase] ? `· ${PHASES[st.phase]}${pct}` : st.available ? `· ${st.latest.version} is available` : st.checkedAt ? '· Up to date' : '';
    hint.textContent = st.error || (st.checkedAt ? `Last checked ${new Date(st.checkedAt).toLocaleString()}.` : 'Echo checks for updates once a day.');
  }
  const card = $('updateCard');
  const dismissed = pref.get('updateLater', '') === st.latest?.version;
  card.hidden = !(st.available && (!dismissed || PHASES[st.phase] || st.phase === 'error'));
  card.classList.toggle('is-working', Boolean(PHASES[st.phase]));
  if (st.available) {
    $('updateTitle').textContent = `Update available: v${st.latest.version}`;
    $('updateSub').textContent = PHASES[st.phase] ? `${PHASES[st.phase]}${st.phase === 'downloading' && typeof st.progress === 'number' ? ` ${Math.round(st.progress * 100)}%` : ''}` : st.phase === 'error' ? st.error : `You have ${st.current}.`;
    $('updateNotes').textContent = st.latest.notes || 'No notes for this release.';
    $('updateNotesWrap').hidden = !st.latest.notes;
  }
  if (notice?.kind === 'updated') toast(`Echo was updated to ${notice.to}.`);
  if (notice?.kind === 'rolled_back') toast(`The update to ${notice.from} didn't start properly, so Echo went back to ${notice.to}.`);
}
async function checkForUpdates() {
  try {
    const res = await fetch('/api/update/check', { method: 'POST' });
    const st = await res.json();
    if (!res.ok) throw new Error(st.error || 'Check failed');
    pref.set('updateLater', '');
    setUpdateStatus(st);
    if (!st.developer && !st.available) toast(`Echo ${st.current} is up to date.`);
  } catch (e) {
    toast(e.message);
  }
}
async function installUpdate() {
  try {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Update failed');
    if (out.updated) showRestarting(`Installing Echo ${out.to}…`, 'Running tasks pause and pick up where they left off.');
    else toast('Echo is already up to date.');
  } catch (e) {
    toast(e.message);
  }
}
async function rollbackUpdate() {
  const st = updateStatus;
  if (!st?.previous) return;
  const pinIn = el('input', { type: 'password', inputMode: 'numeric', className: 'pin-in', placeholder: '••••', autocomplete: 'off' });
  const err = el('div', { className: 'err', role: 'alert' });
  const go = actionButton(`Go back to ${st.previous}`, 'danger', async () => {
    try {
      await selfApi('/api/update/rollback', { pin: pinIn.value });
      closeModal();
      showRestarting(`Going back to Echo ${st.previous}…`);
    } catch (e) {
      err.textContent = e.message;
    }
  });
  const body = [el('p', {}, `Echo ${st.current} is replaced by the version you had before (${st.previous}). Your data and settings stay as they are.`)];
  if (selfStatus.hasPin) body.push(el('label', { className: 'field' }, 'Your PIN'), pinIn);
  body.push(err);
  openModal('Go back to the previous version?', body, [button('Cancel', 'ghost', closeModal), go], { narrow: true, onEnter: () => go.click() });
}
$('updCheck').onclick = checkForUpdates;
$('updRollback').onclick = rollbackUpdate;
$('updateNow').onclick = installUpdate;
$('updateLater').onclick = () => { pref.set('updateLater', updateStatus?.latest?.version || ''); $('updateCard').hidden = true; };
