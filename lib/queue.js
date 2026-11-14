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
   * @param {{ isStale?: () => boolean, expiresAt?: number, onDrop?: () => void, onRead?: () => void }} [opts]
   *   onRead: called when the session reads it (so a queue's wait can be told from the model's)
   */
  push(text, priority, { isStale, expiresAt, onDrop, onRead } = {}) {
    if (this.closed) return;
    const msg = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    };
    const item = { msg, isStale, expiresAt, onDrop, onRead };
    if (expired(item)) return void onDrop?.();
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /**
   * Hand the messages nobody has read yet to `next` (a new session's queue), so a rotation or a
   * reload never loses what the user just said. Stale ones are dropped on the way.
   * @param {InputQueue} next
   */
  handOver(next) {
    for (const item of this.items.splice(0)) {
      if (expired(item)) item.onDrop?.();
      else if (!next.closed) {
        const waiter = next.waiters.shift();
        if (waiter) waiter(item);
        else next.items.push(item);
      }
    }
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
      try {
        next.onRead?.();
      } catch {}
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
