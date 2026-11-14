// A small model on this Mac, for the quick judgements that shouldn't wait for the cloud: "is
// this speech for Echo?" when the rules aren't sure (addressee v1's 0.4–0.8 band).
//
// Tried in order, each with a short time limit, and never required:
// 1. Apple's on-device model (Foundation Models, macOS 26+) through the Echo Mac app ("local"
//    requests, macos/Sources/LocalModel.swift).
// 2. A local Ollama model (e.g. a small Qwen) at ECHO_LOCAL_MODEL_URL (http://127.0.0.1:11434)
//    with ECHO_LOCAL_MODEL (default qwen3.5:2b).
// When neither answers in time the rules' own decision stands, so it can only make things better.
// Nothing leaves the Mac: both run locally, and only the transcript and a few flags go in.

/** How long the local model may take before the rules' decision stands. */
export const LOCAL_MODEL_MS = 900;

const PROMPT = (o) => `You decide whether speech picked up by a voice assistant's microphone is addressed to the assistant (named Echo) or is other talk (a TV, a video, a side conversation).
Answer with JSON only: {"directed": number between 0 and 1}.
Heard: "${String(o.text).replace(/"/g, "'").slice(0, 300)}"
The assistant is ${o.driving ? 'controlling the computer for the user right now' : 'idle'}.${o.pendingQuestion ? ' It just asked the user a question.' : ''}${o.mediaPlaying ? ' Audio or video is playing on the Mac.' : ''}
Recent conversation: ${(o.context || []).slice(-4).join(' | ').slice(0, 600) || 'none'}`;

/** A number from 0 to 1 out of whatever the model said, or null. */
export function parseDirected(text) {
  const m = String(text || '').match(/"?directed"?\s*:\s*([01](?:\.\d+)?|\.\d+)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * Ask the local model how likely this speech is for Echo. Null when no local model answered.
 * @param {{ text: string, driving?: boolean, pendingQuestion?: boolean, mediaPlaying?: boolean, context?: string[] }} o
 * @param {{ bridge?: any, url?: string, model?: string, fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number }} [deps]
 * @returns {Promise<{ directed: number, via: 'apple' | 'ollama' } | null>}
 */
export async function localDirected(o, deps = {}) {
  // It has not answered in time, several times running (on Oct 3: never, in 103 tries, each one
  // costing the user 900 ms of silence): it is left alone for a while, and tried again later.
  const now = (deps.now || Date.now)();
  if (misses.count >= GIVE_UP_AFTER && now < misses.until) return null;
  const r = await askLocal(o, deps);
  if (r) misses.count = 0;
  else if (deps.bridge?.native || deps.url || process.env.ECHO_LOCAL_MODEL_URL) {
    misses.count++;
    if (misses.count >= GIVE_UP_AFTER) misses.until = now + GIVE_UP_MS;
  }
  return r;
}
/** After this many unanswered asks in a row, the local model is not asked for GIVE_UP_MS. */
export const GIVE_UP_AFTER = 3;
export const GIVE_UP_MS = 10 * 60 * 1000;
const misses = { count: 0, until: 0 };
/** For tests: forget the misses. */
export const resetLocalMisses = () => Object.assign(misses, { count: 0, until: 0 });

/**
 * @param {any} o @param {any} [deps]
 * @returns {Promise<{ directed: number, via: 'apple' | 'ollama' } | null>}
 */
async function askLocal(o, { bridge = null, url = process.env.ECHO_LOCAL_MODEL_URL || '', model = process.env.ECHO_LOCAL_MODEL || 'qwen3.5:2b', fetchImpl = fetch, timeoutMs = LOCAL_MODEL_MS } = {}) {
  const prompt = PROMPT(o);
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), timeoutMs).unref?.())]);
  if (bridge?.native) {
    const r = await within(bridge.request('local', { task: 'directed', prompt }).catch(() => null));
    const v = r?.ok ? parseDirected(r.text) : null;
    if (v !== null) return { directed: v, via: 'apple' };
  }
  if (url) {
    try {
      const res = await within(fetchImpl(`${url.replace(/\/$/, '')}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0 } }),
        signal: AbortSignal.timeout(timeoutMs),
      }));
      const body = res ? await res.json() : null;
      const v = parseDirected(body?.response);
      if (v !== null) return { directed: v, via: 'ollama' };
    } catch {}
  }
  return null;
}

/**
 * The rules were unsure ("ask"): let the local model settle it when it's confident either way.
 * @param {{ decision: string, confidence: number, why: string }} judged
 * @param {{ directed: number } | null} local
 */
export function settle(judged, local) {
  if (!local || judged.decision !== 'ask') return judged;
  if (local.directed >= 0.85) return { ...judged, decision: 'accept', why: `${judged.why}+local` };
  if (local.directed <= 0.15) return { ...judged, decision: 'ignore', why: `${judged.why}+local` };
  return judged;
}
