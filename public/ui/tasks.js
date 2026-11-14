// The Workers tab (split out of public/app.js): every task with its live line, log, files and
// approvals; the shared answer for several read-only lookups; and today's usage.
import { $, el, toast, escapeHtml, postJson } from './dom.js';
import { send } from './socket.js';

/** Every task the page knows, by id. */
export const tasks = new Map();
/** @type {Array<() => void>} */
const changedHooks = [];
/** Call `fn` whenever the number of active or waiting tasks may have changed. */
export const onTasksChanged = (fn) => void changedHooks.push(fn);
/** What a self-improve task's Review and Merge buttons do (public/ui/selfimprove.js). */
const review = { diff: (_id) => {}, merge: (_id) => {} };
/** @param {{ diff: (id: number) => void, merge: (id: number) => void }} r */
export const setReviewActions = (r) => void Object.assign(review, r);
/** Today's costs from the server. */
export function setCosts(c) {
  costs = c;
  renderCosts();
}
const els = { taskList: $('taskList'), emptyTasks: $('emptyTasks'), taskCount: $('taskCount'), tpl: $('taskTpl'), usageToday: $('usageToday'), tabCount: $('tabCount'), approvalGroup: $('approvalGroup'), approvalGroupTitle: $('approvalGroupTitle'), approvalGroupSub: $('approvalGroupSub'), groupAllow: $('groupAllow'), groupDeny: $('groupDeny') };

export let costs = null;
let costWarnedDay = '';
export function renderCosts() {
  if (!costs) return;
  const t = costs.today;
  const convo = Number(t.dispatcher || 0);
  els.usageToday.textContent = `$${t.total.toFixed(2)} today`;
  // A soft heads-up, once a day.
  const day = new Date().toDateString();
  if (costs.overWarn && costWarnedDay !== day) {
    costWarnedDay = day;
    toast(`Heads-up: the assistant has cost about $${convo.toFixed(2)} today, past your $${costs.warnAt} warning.`);
  }
}

const ACTIVE = ['running', 'queued', 'waiting_approval'];
export function activeCount() { return [...tasks.values()].filter((t) => ACTIVE.includes(t.status)).length; }
export function updateMeta() {
  const active = activeCount();
  const waiting = [...tasks.values()].filter((t) => t.pendingApproval).length;
  els.taskCount.textContent = tasks.size ? `${active} active · ${tasks.size} total` : '';
  els.tabCount.textContent = waiting || active || '';
  els.tabCount.classList.toggle('attention', waiting > 0);
  renderApprovalGroup();
  for (const fn of changedHooks) fn();
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

/* ---------- Tasks ---------- */
const SELF_LABEL = { review: 'Ready to review', no_changes: 'No changes', merged: 'Merged', discarded: 'Discarded', error: 'Review failed', stopped: 'Stopped' };
const STATUS_LABEL = { queued: 'Queued', running: 'Running', waiting_approval: 'Needs your OK', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };
const STATUS_CLASS = { queued: 'queued', running: 'running', waiting_approval: 'waiting', done: 'done', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
const SELF_CLASS = { review: 'waiting', no_changes: 'stopped', merged: 'done', discarded: 'stopped', error: 'failed', stopped: 'stopped' };
const APPROVAL_TITLE = { network_read: 'Wants to run a read-only web lookup', echo_read: "Wants to read Echo's own code (read-only)", network_site: 'Wants to send a request to a website', risky: 'Wants to do something that needs your OK' };

export function upsertTask(t) {
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
    node.querySelector('.act-diff').onclick = () => review.diff(t.id);
    node.querySelector('.act-merge').onclick = () => review.merge(t.id);
    node.querySelector('.act-discard').onclick = () => postJson('/api/self/discard', { taskId: t.id });
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
    // Allowing a read of Echo's code already covers the rest of the task.
    node.querySelector('.act-allow-similar').hidden = pa.level === 'risky' || pa.level === 'echo_read';
  }
  // A stopped self task keeps its branch until you discard it (or ask Echo to continue it).
  // (Not "review": that is the module's own review actions, which the card's buttons call.)
  const reviewBox = node.querySelector('.review');
  const stoppedSelf = selfState === 'stopped' && !ACTIVE.includes(t.status);
  reviewBox.hidden = selfState !== 'review' && !stoppedSelf;
  reviewBox.classList.toggle('stopped', stoppedSelf);
  node.querySelector('.review-head strong').textContent = stoppedSelf ? 'Stopped before it finished' : 'Ready for your review';
  node.querySelector('.act-diff').hidden = node.querySelector('.act-merge').hidden = stoppedSelf;
  if (stoppedSelf) {
    reviewBox.querySelector('.review-checks').textContent = 'Ask Echo to continue it, or discard its branch.';
    reviewBox.querySelector('.review-stat').textContent = '';
  }
  if (selfState === 'review') {
    reviewBox.querySelector('.review-stat').textContent = t.self.review.stat;
    reviewBox.querySelector('.review-checks').innerHTML = Object.entries(t.self.review.checks)
      .map(([k, v]) => `<span class="${v.ok ? 'pass' : 'fail'}">${escapeHtml(k)} ${v.ok ? '✓' : v.timedOut ? '✗ timed out' : '✗ failed'}</span>`)
      .join(' · ');
    // The checks timed out or couldn't run: say so, but the changes are still ready to review.
    if (t.self.review.note) reviewBox.querySelector('.review-checks').append(el('div', { className: 'review-note' }, t.self.review.note));
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
export function appendLog(id, entry) {
  const log = els.taskList.querySelector(`[data-id="${id}"] .task-log`);
  if (!log) return;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(fmtLog(entry));
  while (log.childNodes.length > 300) log.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
  setLive(log.closest('.task'), entry);
}
