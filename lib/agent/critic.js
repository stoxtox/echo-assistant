// The critic (Stage 6, "Echo says done only when a check passes"). On Oct 1 Echo said an XD page
// was done, and better, when it wasn't; the user had to look and say so. Now a job on the Mac with
// several steps starts with what "done" means (a goal and the points it must meet, said back to
// the user in a sentence), and before Echo says it's done, a separate model looks at the screen and
// judges each point. It never sees what the assistant claimed, only the goal, the points and the
// screen, and it's told to be skeptical: a point is met only when it can see it.
//
// critique() is pure apart from the model call (queryFn, swappable for tests).
import { MODEL_ALIASES } from '../models.js';

/** The critic's model: a strong one, since judging a design from a picture is the hard part. */
export const CRITIC_MODEL = MODEL_ALIASES.sonnet;

export const CRITIC_SYSTEM = `You check whether a job done on a Mac is really finished, from a picture of the screen and the text on it.
You never see what the assistant said it did: only the goal, the points it must meet, and the screen.
Be skeptical. A point is met only when you can see it on the screen now. If you can't tell (it's off screen, too small to read, hidden behind something), it is not met, and you say what you'd need to see.
For design work, judge what you can see: alignment, even spacing, readable contrast, a consistent font and colour use, nothing overlapping or cut off.
Answer with JSON only: {"points":[{"point":"<the point, as given>","met":true|false,"why":"<one short sentence about what you see>"}]}`;

/** @typedef {{ point: string, met: boolean, why: string }} Judged */

/**
 * The goal as the critic gets it: trimmed, at most 8 points.
 * @param {string} goal @param {string[]} points
 */
export function contract(goal, points) {
  const g = String(goal || '').trim().slice(0, 300);
  const p = (Array.isArray(points) ? points : []).map((x) => String(x || '').trim().slice(0, 200)).filter(Boolean).slice(0, 8);
  return { goal: g, points: p.length ? p : g ? [g] : [] };
}

/**
 * The critic's answer, read leniently but judged strictly: a point it didn't answer is not met.
 * @param {string} text the model's reply
 * @param {string[]} points
 * @returns {{ pass: boolean, points: Judged[] }}
 */
export function readVerdict(text, points) {
  let said = [];
  try {
    const json = String(text || '').match(/\{[\s\S]*\}/);
    said = json ? JSON.parse(json[0]).points || [] : [];
  } catch {}
  const judged = points.map((p, i) => {
    const s = said.find((x) => x && typeof x.point === 'string' && x.point.trim().toLowerCase() === p.toLowerCase()) || said[i];
    return { point: p, met: Boolean(s && s.met === true), why: s && typeof s.why === 'string' ? s.why.slice(0, 240) : 'The check gave no answer for this point.' };
  });
  return { pass: judged.length > 0 && judged.every((j) => j.met), points: judged };
}

/**
 * Judge the points from the screen.
 * @param {{ goal: string, points: string[], look: { text?: string, image?: string, mime?: string, app?: string, window?: string }, queryFn: Function, model?: string }} o
 * @returns {Promise<{ pass: boolean, points: Judged[], usd: number }>}
 */
export async function critique({ goal, points, look, queryFn, model = CRITIC_MODEL }) {
  const where = [look.app, look.window].filter(Boolean).join(', ');
  const ask = `Goal: ${goal}\nPoints to check:\n${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nThe screen${where ? ` (${where})` : ''}: the picture above, and its text below.\n---\n${String(look.text || '').slice(0, 6000)}\n---\nJSON only.`;
  /** @type {any[]} */
  const content = [];
  if (look.image) content.push({ type: 'image', source: { type: 'base64', media_type: look.mime || 'image/jpeg', data: look.image } });
  content.push({ type: 'text', text: ask });
  const prompt = (async function* () {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
  })();
  let text = '';
  let usd = 0;
  for await (const msg of queryFn({
    prompt,
    options: { model, tools: [], maxTurns: 1, persistSession: false, settingSources: [], permissionMode: 'dontAsk', systemPrompt: CRITIC_SYSTEM, thinking: { type: 'disabled' } },
  })) {
    if (msg.type === 'result') {
      if (msg.subtype === 'success') text = msg.result || '';
      usd = Number(msg.total_cost_usd) || 0;
    }
  }
  return { ...readVerdict(text, points), usd };
}
