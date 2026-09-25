// Async-iterable queue of user messages, used as streaming input for a long-lived Agent SDK query().
//
// Items can expire: `isStale()` is checked (and `expiresAt` compared) when an item is handed
// out, so an event that stopped mattering while it sat in the queue is silently dropped.
export class InputQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  /**
   * @param {string | Array<object>} text plain text, or content blocks (text and images)
   * @param {string} [priority] e.g. 'next'
   * @param {{ isStale?: () => boolean, expiresAt?: number, onDrop?: () => void }} [opts]
   */
  push(text, priority, { isStale, expiresAt, onDrop } = {}) {
    if (this.closed) return;
    const msg = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    };
    const item = { msg, isStale, expiresAt, onDrop };
    if (expired(item)) return void onDrop?.();
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /** How many items are waiting (stale ones included until they're dequeued). */
  get size() {
    return this.items.length;
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const next = this.items.length
        ? this.items.shift()
        : await new Promise((resolve) => this.waiters.push(resolve));
      if (next === null) return;
      if (expired(next)) {
        next.onDrop?.();
        continue;
      }
      yield next.msg;
    }
  }
}

function expired(item) {
  if (item.expiresAt && Date.now() > item.expiresAt) return true;
  try {
    return Boolean(item.isStale?.());
  } catch {
    return false;
  }
}
