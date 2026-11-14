// The page's WebSocket to Echo's server (split out of public/app.js): `send` for every view, and
// `ws` for the few that stream audio over it. It also carries the page's notes for the timeline
// (lib/timeline.ts): when the voice started and ended, a reconnect, an error.

/** @type {WebSocket | undefined} */
export let ws;
/** @param {object} msg */
export const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

/* ---------- the timeline: noted here, sent in batches ---------- */
const RING = 300; // the newest notes kept while the line is down
const BATCH = 200; // the most the server takes in one message
/** @type {Array<{ type: string, f: object, cts: number, cseq: number, trace?: string }>} */
const notes = [];
let cseq = 0;
/** When the line dropped (ms), until it's back. */
let downSince = 0;

/**
 * Note something for the timeline: a type and a few numbers or names. Never what was said or shown.
 * @param {string} type @param {object} [f] @param {string} [trace] the turn it belongs to
 */
export function timeline(type, f = {}, trace) {
  notes.push({ type, f, cts: Date.now(), cseq: ++cseq, ...(trace ? { trace } : {}) });
  if (notes.length > RING) notes.shift();
}

/** Send what's been noted, if the line is up. */
export function flushTimeline() {
  while (notes.length && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'tl', events: notes.splice(0, BATCH) }));
}
/** @type {any} */ (setInterval(flushTimeline, 2000)).unref?.(); // (unref: only a test under Node has it)
// An error in the page: which kind (TypeError…), never its message, which can quote the page.
globalThis.addEventListener?.('error', (e) => timeline('page.error', { kind: e.error?.name || 'Error' }));
globalThis.addEventListener?.('unhandledrejection', (e) => timeline('page.error', { kind: e.reason?.name || 'Rejection' }));

/**
 * Connect, and reconnect 1.5 s after the line drops.
 * @param {{ onOpen: () => void, onClose: () => void, onMessage: (msg: any) => void }} on
 */
export function openSocket(on) {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    if (downSince) timeline('page.ws.reconnect', { ms: Date.now() - downSince });
    downSince = 0;
    flushTimeline();
    on.onOpen();
  };
  ws.onclose = () => { downSince ||= Date.now(); on.onClose(); setTimeout(() => openSocket(on), 1500); };
  ws.onmessage = (e) => on.onMessage(JSON.parse(e.data));
}
