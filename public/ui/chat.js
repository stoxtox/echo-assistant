// The conversation's own cards (split out of public/app.js): chat lines, the Undo chip after a send
// or delete Echo did, the Send / Cancel card for a quick message, and compact task updates with
// Approve / Deny.
import { $, el, button } from './dom.js';
import { send } from './socket.js';

/** Where a chip's short note goes (the live caption under the voice), set by app.js. */
let note = (_text) => {};
/** @param {(text: string) => void} fn */
export const setChatNote = (fn) => void (note = fn);
const els = { transcript: $('transcript'), taskList: $('taskList'), chatEmpty: $('chatEmpty') };

export function scrollDown() { els.transcript.scrollTop = els.transcript.scrollHeight; }
export function addMsg(kind, text) {
  els.chatEmpty.hidden = true;
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  els.transcript.append(div);
  scrollDown();
  return div;
}

/* ---------- Undo chips ---------- */
// After a send or delete Echo did, one small chip for a few seconds: "Sent · Undo 8".
const undoChips = new Map();
/** @param {{ id: string, label: string, what: string, detail?: string, expiresAt: string }} o */
export function showUndo(o) {
  if (!o?.id || undoChips.has(o.id)) return;
  const row = addMsg('undo-chip', '');
  row.setAttribute('role', 'status');
  // Done without a card (the user's own words asked for it): the chip also says what was done.
  const label = el('span', { className: 'undo-label' }, o.detail ? `${o.label || 'Done'}: ${o.detail}` : o.label || 'Done');
  const btn = el('button', { type: 'button', className: 'undo-btn' }, 'Undo');
  const left = el('span', { className: 'undo-left' });
  btn.title = o.what || '';
  row.append(label, btn, left);
  const tick = () => {
    const s = Math.max(0, Math.round((Date.parse(o.expiresAt) - Date.now()) / 1000));
    left.textContent = s ? String(s) : '';
    if (!s) settleUndo(o.id, '');
  };
  tick();
  const timer = setInterval(tick, 1000);
  undoChips.set(o.id, { row, btn, timer });
  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = 'Undoing…';
    send({ type: 'computer_undo', id: o.id });
  };
  note(`${o.label || 'Done'} · tap Undo in the window`);
}
export function settleUndo(id, text) {
  const c = undoChips.get(id);
  if (!c) return;
  clearInterval(c.timer);
  undoChips.delete(id);
  c.btn.remove();
  c.row.classList.add('settled');
  if (text) c.row.querySelector('.undo-left').textContent = text;
  setTimeout(() => c.row.classList.add('gone'), 2500);
}

/* ---------- Quick message confirmation card ---------- */
const confirmCards = new Map();
export function showMessageConfirm(r) {
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
  // The payload, all of it: a picture going with the message shows by name.
  if (r.attachment) body.append(el('div', { className: 'confirm-attachment' }, `📎 ${r.attachment}`));
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
export function settleMessageConfirm(r) {
  const c = confirmCards.get(r.id);
  if (!c) return;
  clearInterval(c.timer);
  confirmCards.delete(r.id);
  c.cancel.remove();
  c.sendBtn.remove();
  // (a file that did not attach is not shown as a clean send)
  c.card.classList.add(r.sent && r.fileAttached !== false ? 'is-sent' : 'is-cancelled');
  c.left.textContent = r.stale ? 'Already handled' : r.sent ? (r.label || 'Sent ✓') : r.error ? `Not sent: ${r.error}` : r.by === 'expired' ? 'Expired, not sent' : 'Cancelled';
}

/* ---------- Explanation card ---------- */
// While Echo explains something on screen piece by piece (lib/explain.js), the chat shows ONE card
// for the whole explanation, updated in place as it moves: this piece's few words large, its
// sentence small, "2 of 4", and every piece's title listed with the current one marked. The user
// sees the outline while hearing one piece.
const explainCards = new Map(); // explanation id -> its card's parts
/** @param {{ id: string, keys: string[], index: number, total: number, say?: string, found?: boolean, done?: boolean, stopped?: boolean }} m */
export function showExplain(m) {
  if (!m?.id || !Array.isArray(m.keys) || !m.keys.length) return;
  let c = explainCards.get(m.id);
  if (!c) {
    els.chatEmpty.hidden = true;
    const card = el('div', { className: 'msg explain-card' });
    card.setAttribute('role', 'group');
    c = { card, count: el('div', { className: 'explain-count' }), key: el('div', { className: 'explain-key' }), say: el('div', { className: 'explain-say' }), outline: el('ol', { className: 'explain-outline' }) };
    c.outline.append(...m.keys.map((k) => el('li', {}, k)));
    card.append(c.count, c.key, c.say, c.outline);
    explainCards.set(m.id, c);
    els.transcript.append(card);
    scrollDown();
  }
  const at = Math.min(Math.max(0, Number(m.index) || 0), m.keys.length - 1);
  const total = m.total || m.keys.length;
  c.card.setAttribute('aria-label', m.done ? 'Explanation' : `Explanation, part ${at + 1} of ${total}: ${m.keys[at]}`);
  // Over: the outline stays as a record of what was covered; nothing is marked as current.
  c.card.classList.toggle('done', Boolean(m.done));
  c.count.textContent = m.done ? (m.stopped ? `Stopped at ${at + 1} of ${total}` : `${total} of ${total} · done`) : `${at + 1} of ${total}${m.found === false ? ' · not on screen' : ''}`;
  c.key.textContent = m.keys[at];
  c.say.textContent = m.say || '';
  [...c.outline.children].forEach((li, i) => {
    li.classList.toggle('on', !m.done && i === at);
    li.classList.toggle('seen', m.done ? i <= at || !m.stopped : i < at);
    if (!m.done && i === at) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  if (m.done) explainCards.delete(m.id);
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
export function addTaskCard(ev) {
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
export function settleTaskCard(approvalId, allowed) {
  const c = approvalId && taskCards.get(approvalId);
  if (!c) return;
  taskCards.delete(approvalId);
  c.actions.remove();
  c.card.classList.remove('waiting', 'sending');
  c.card.classList.add('handled', allowed === false ? 'denied' : 'allowed');
  c.status.textContent = allowed === null ? 'Already answered' : allowed ? 'Approved ✓' : 'Denied';
}
/** After a reconnect: cards for approvals still waiting, and handled ones collapsed. */
export function syncTaskCards(list) {
  const waiting = new Set();
  for (const t of list || []) {
    const a = t.pendingApproval;
    if (!a) continue;
    waiting.add(a.id);
    addTaskCard({ kind: 'approval', taskId: t.id, title: t.title, where: t.project, text: a.reason, approvalId: a.id, level: a.level });
  }
  for (const id of [...taskCards.keys()]) if (!waiting.has(id)) settleTaskCard(id, null);
}
