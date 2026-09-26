// A compact, always-fresh digest of every task, added to each message the assistant gets, so
// "where are we?" is answered straight away without a tool call.
//
//   Tasks (fresh as of this message):
//   #14 running · Research · "Find entry-level supply chain jobs" · 2 min ago: Searching LinkedIn for…
//   #12 needs OK (risky) · Budget2 · "Fix the totals row" · wants to: git push to origin
//   #11 done 40 min ago · Research · "Movie times tonight": Three showings after 8…
//   Recent: 2 min ago #14 started · 40 min ago #11 finished · 1 h ago #10 approval answered (allowed)

const STALE_DONE_MS = 24 * 60 * 60 * 1000; // finished tasks drop out of the digest after a day
const MAX_ROWS = 10;

const ago = (iso, now) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const ACTIVE = new Set(['running', 'queued', 'waiting_approval']);

/** The last line worth reading out from a task's log (what it's doing, or what it said). */
function lastLine(t) {
  for (let i = (t.log?.length || 0) - 1; i >= 0; i--) {
    const e = t.log[i];
    if (['claude', 'note', 'tool', 'ask'].includes(e.kind) && e.text?.trim()) return e;
  }
  return null;
}

/**
 * @param {{ list(): any[], isLive(id: number): boolean, isApprovalPending?(taskId: number, approvalId?: string): boolean }} tasks
 * @param {{ now?: number, events?: Array<{ at: string, text: string }> }} [opts]
 * @returns {string} '' when there are no tasks worth mentioning
 */
export function taskDigest(tasks, { now = Date.now(), events = [] } = {}) {
  const all = tasks.list();
  const shown = all
    .filter((t) => ACTIVE.has(t.status) || tasks.isLive(t.id) || now - Date.parse(t.finishedAt || t.updatedAt) < STALE_DONE_MS || (t.kind === 'self' && t.self?.state === 'review'))
    .sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.id - a.id);
  if (!shown.length && !events.length) return '';
  const rows = shown.slice(0, MAX_ROWS).map((t) => {
    const where = t.kind === 'research' ? 'Research' : t.kind === 'self' ? 'Echo itself' : t.project;
    const title = `"${clip(t.title, 60)}"`;
    const pending = t.pendingApproval && (tasks.isApprovalPending ? tasks.isApprovalPending(t.id, t.pendingApproval.id) : true) ? t.pendingApproval : null;
    if (pending) return `#${t.id} needs OK (${pending.level === 'risky' ? 'risky' : 'read-only lookup'}) · ${where} · ${title} · wants to: ${clip(pending.reason, 110)}`;
    if (t.kind === 'self' && t.self?.state === 'review') return `#${t.id} ready for review in the window · ${where} · ${title}`;
    if (ACTIVE.has(t.status) || tasks.isLive(t.id)) {
      const line = lastLine(t);
      const status = t.status === 'queued' ? 'queued' : tasks.isLive(t.id) ? 'running' : `${t.status} (worker not running)`;
      return `#${t.id} ${status} · ${where} · ${title} · ${ago(t.lastActivityAt || t.updatedAt, now)}${line ? `: ${clip(line.text, 110)}` : ''}`;
    }
    const outcome = t.summary ? `: ${clip(t.summary, 120)}` : '';
    return `#${t.id} ${t.status} ${ago(t.finishedAt || t.updatedAt, now)} · ${where} · ${title}${outcome}`;
  });
  if (shown.length > MAX_ROWS) rows.push(`(${shown.length - MAX_ROWS} more; list_tasks has them all)`);
  const recent = events.slice(-5).reverse().map((e) => `${ago(e.at, now)} ${clip(e.text, 80)}`);
  return [`Tasks (fresh as of this message; use get_task only for details):`, ...(rows.length ? rows : ['none active']), ...(recent.length ? [`Recent: ${recent.join(' · ')}`] : [])].join('\n');
}

/** A small ring of recent task events for the digest's "Recent:" line. */
export class EventLog {
  constructor(max = 12) {
    this.max = max;
    /** @type {Array<{ at: string, text: string }>} */
    this.items = [];
  }

  add(text, at = new Date().toISOString()) {
    this.items.push({ at, text });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  list() {
    return this.items.slice();
  }
}
