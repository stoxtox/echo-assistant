// Tells the assistant about approvals worth asking about, without reading out stale ones.
//
// Approvals are collected for a short window (debounced) before anything is said:
//   - ones already answered in the window by then are dropped (the user handled them),
//   - read-only web lookups from several tasks become ONE question,
//   - risky ones are relayed one by one, never grouped.
// Each relayed event goes stale as soon as everything it mentions is answered, so the
// assistant never asks about something the user already clicked.
import { LOW_RISK } from './tasks.js';

export class ApprovalRelay {
  /**
   * @param {import('./tasks.js').TaskManager} tasks
   * @param {(text: string, opts: { isStale: () => boolean }) => void} notify
   * @param {{ delayMs?: number, maxDelayMs?: number }} [opts]
   */
  constructor(tasks, notify, { delayMs = 1800, maxDelayMs = 5000 } = {}) {
    this.tasks = tasks;
    this.notify = notify;
    this.delayMs = delayMs;
    this.maxDelayMs = maxDelayMs;
    /** @type {Array<{ taskId: number, approvalId: string, level: string, reason: string, project: string }>} */
    this.waiting = [];
    this.timer = null;
    this.firstAt = 0;
    tasks.on('approval', (t) => this.add(t));
  }

  add(task) {
    const a = task.pendingApproval;
    if (!a) return;
    this.waiting.push({ taskId: task.id, approvalId: a.id, level: a.level, reason: a.reason, project: task.project });
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    clearTimeout(this.timer);
    // Debounce, but never hold the first one longer than maxDelayMs.
    const wait = Math.max(0, Math.min(this.delayMs, this.firstAt + this.maxDelayMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  pending(item) {
    return this.tasks.isApprovalPending(item.taskId, item.approvalId);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const items = this.waiting.splice(0).filter((i) => this.pending(i));
    const low = items.filter((i) => LOW_RISK.has(i.level));
    const risky = items.filter((i) => !LOW_RISK.has(i.level));
    const staleWhenAnswered = (group) => () => !group.some((i) => this.pending(i));

    if (low.length === 1) {
      const [i] = low;
      this.notify(
        `Task ${i.taskId} (${i.project}) wants to run a read-only web lookup: ${i.reason}. Ask briefly whether it's okay.`,
        { isStale: staleWhenAnswered(low) }
      );
    } else if (low.length > 1) {
      const list = low.map((i) => `task ${i.taskId} (${i.project}): ${i.reason}`).join('; ');
      this.notify(
        `${low.length} tasks want to run read-only web lookups: ${list}. Ask once whether to allow them all. ` +
          `If yes, call resolve_approval once with task_ids [${low.map((i) => i.taskId).join(', ')}] and approve true.`,
        { isStale: staleWhenAnswered(low) }
      );
    }
    for (const i of risky) {
      this.notify(
        `Task ${i.taskId} (${i.project}) wants to do something risky and needs the user's OK: ${i.reason}. ` +
          'Say plainly what it wants to do and ask. Never group this with other approvals or auto-approve it.',
        { isStale: staleWhenAnswered([i]) }
      );
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
