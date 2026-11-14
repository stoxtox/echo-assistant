// Tells the assistant about approvals worth asking about, without reading out stale ones.
//
// Approvals are collected for a short window (debounced) before anything is said:
//   - ones already answered in the window by then are dropped (the user handled them),
//   - read-only web lookups from several tasks become ONE question,
//   - a task asking to read Echo's own code is asked about on its own (one yes covers the task),
//   - risky ones are relayed one by one, never grouped; one that carries `covers` (a job's first
//     write to a file outside its folder) is asked as one question covering what a yes approves.
// After that the assistant is not to bring a waiting approval up again (the digest marks it,
// lib/digest.js). If it is still waiting remindMs later, one reminder goes out at a quiet moment,
// and then nothing: the window shows it all along.
// Each relayed event goes stale as soon as everything it mentions is answered, so the
// assistant never asks about something the user already clicked.
import { LOW_RISK, APPROVAL_REMIND_MS } from './tasks.js';
import { flagOn } from './flags.ts';

export class ApprovalRelay {
  /**
   * @param {import('./tasks.js').TaskManager} tasks
   * @param {(text: string, opts: { isStale: () => boolean, fyi?: boolean }) => void} notify
   * @param {{ delayMs?: number, maxDelayMs?: number, remindMs?: number }} [opts]
   */
  constructor(tasks, notify, { delayMs = 1800, maxDelayMs = 5000, remindMs = APPROVAL_REMIND_MS } = {}) {
    this.tasks = tasks;
    this.notify = notify;
    this.delayMs = delayMs;
    this.maxDelayMs = maxDelayMs;
    this.remindMs = remindMs;
    /** @type {Array<{ taskId: number, approvalId: string, level: string, reason: string, project: string, covers?: string }>} */
    this.waiting = [];
    /** @type {Set<NodeJS.Timeout>} */
    this.reminders = new Set();
    this.timer = null;
    this.firstAt = 0;
    tasks.on('approval', (t) => this.add(t));
  }

  add(task) {
    const a = task.pendingApproval;
    if (!a) return;
    this.waiting.push({ taskId: task.id, approvalId: a.id, level: a.level, reason: a.reason, project: task.project, covers: a.covers?.text });
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
    for (const i of items) this.remindLater(i, this.remindMs);
    const low = items.filter((i) => LOW_RISK.has(i.level));
    const echoRead = items.filter((i) => i.level === 'echo_read');
    const risky = items.filter((i) => !LOW_RISK.has(i.level) && i.level !== 'echo_read');
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
    for (const i of echoRead) {
      this.notify(
        `Task ${i.taskId} (${i.project}) wants read-only access to Echo's own code, logs and settings: ${i.reason}. ` +
          'Ask plainly whether it may read them. A yes (resolve_approval with this task_id) lets it read Echo for the rest of the task; ' +
          'it still can never change Echo, its data or its port.',
        { isStale: staleWhenAnswered([i]) }
      );
    }
    // Stage 2 (policy flag): several waiting at once are ONE question, not a spoken turn each.
    // Each still has its own card, so nothing is approved without being shown.
    if (risky.length > 1 && flagOn('policy')) {
      const list = risky.map((i) => `task ${i.taskId} (${i.project}) wants to ${i.covers || i.reason}`).join('; ');
      this.notify(
        `${risky.length} tasks need the user's OK: ${list}. Ask ONCE, naming each in a few words ("Two tasks need you: … Okay to both?"). ` +
          `A clear yes to all: call resolve_approval once with task_ids [${risky.map((i) => i.taskId).join(', ')}] and approve true. If they pick some, resolve only those. Never approve one they didn't clearly agree to.`,
        { isStale: staleWhenAnswered(risky) }
      );
      return;
    }
    for (const i of risky) {
      if (i.covers) {
        // One question for the job, not one per step: the yes covers what the sentence says.
        this.notify(
          `Task ${i.taskId} (${i.project}) needs the user's OK: it wants to ${i.covers}. Ask ONCE, in one sentence that says all of it ` +
            `("It wants to ${i.covers}. Okay?"). A clear yes (resolve_approval with this task_id) covers exactly that for the rest of this task: ` +
            'changing those same files again and looking at the result won\'t ask again. Deletes and anything else still ask. Never group this with other approvals.',
          { isStale: staleWhenAnswered([i]) }
        );
        continue;
      }
      this.notify(
        `Task ${i.taskId} (${i.project}) wants to do something risky and needs the user's OK: ${i.reason}. ` +
          'Say plainly what it wants to do and ask. Never group this with other approvals or auto-approve it.',
        { isStale: staleWhenAnswered([i]) }
      );
    }
  }

  /**
   * One reminder for an approval the assistant was shown `remindMs` ago and that is still waiting.
   * It goes out as background news (said at a quiet moment, or with the next reply). Whichever
   * comes first, this or a message whose digest is due to carry the reminder, is the only one
   * (TaskManager.approvalMention answers 'remind' once).
   */
  remindLater(item, ms) {
    const timer = setTimeout(() => {
      this.reminders.delete(timer);
      const told = this.tasks.approvalTold(item.taskId, item.approvalId);
      if (!told || told.remindedAt) return; // answered, or already reminded
      const left = told.toldAt ? told.toldAt + this.remindMs - Date.now() : this.remindMs;
      if (left > 0) return this.remindLater(item, left + 20); // shown later than it was relayed, or not yet
      if (this.tasks.approvalMention(item.taskId) !== 'remind') return;
      this.notify(
        `Task ${item.taskId} (${item.project}) is still waiting for the user's OK to ${item.covers || item.reason}. One short reminder, then say nothing more about it unless they ask.`,
        { isStale: () => !this.pending(item), fyi: true }
      );
    }, ms);
    timer.unref?.();
    this.reminders.add(timer);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.reminders) clearTimeout(t);
    this.reminders.clear();
  }
}
