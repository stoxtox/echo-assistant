// The local UI grounder: the last rung of the ladder, for apps with no usable Accessibility
// labels (a canvas, a game, a remote desktop). A small vision model running on this Mac (the plan's
// UI-Venus-1.5-2B, or any Qwen-VL-style grounder) looks at the screenshot and says where "the
// rectangle tool" or "the blue Share button" is; Echo clicks there, and checks the click like any
// other.
//
// Setup (optional): serve the model with an OpenAI-compatible endpoint on this Mac, e.g.
//   pip install mlx-vlm
//   python -m mlx_vlm.server --model mlx-community/UI-Venus-1.5-2B-4bit --port 8765
// and set ECHO_GROUNDER_URL=http://127.0.0.1:8765 (ECHO_GROUNDER_MODEL for the model name,
// ECHO_GROUNDER_COORDS=norm1000 | pixels | fraction for how it gives positions; Qwen-VL
// grounders use 0–1000). Without it, the tool says it isn't set up. The screenshot never leaves the
// Mac: the endpoint must be on 127.0.0.1 or localhost.

/** How long the grounder may think. */
export const GROUNDER_MS = 6000;

/**
 * A point out of what the model said: "(512, 300)", "[512,300]", "x=512 y=300", or a box
 * "[100, 200, 300, 400]" (its centre). Numbers in the model's own scale.
 * @param {string} text
 * @returns {{ x: number, y: number } | null}
 */
export function parsePoint(text) {
  const nums = (String(text || '').match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  if (nums.length >= 4 && /\[\s*-?\d/.test(String(text)) && String(text).split(',').length >= 4) return { x: (nums[0] + nums[2]) / 2, y: (nums[1] + nums[3]) / 2 };
  if (nums.length >= 2) return { x: nums[0], y: nums[1] };
  return null;
}

/**
 * The model's point as pixels in the picture it was shown.
 * @param {{ x: number, y: number }} p @param {{ width: number, height: number }} size
 * @param {'norm1000' | 'pixels' | 'fraction'} coords
 */
export function toImagePixels(p, { width, height }, coords = 'norm1000') {
  const k = coords === 'fraction' || (p.x <= 1 && p.y <= 1) ? [width, height] : coords === 'norm1000' ? [width / 1000, height / 1000] : [1, 1];
  const x = coords === 'pixels' ? p.x : p.x * k[0];
  const y = coords === 'pixels' ? p.y : p.y * k[1];
  if (!(x >= 0 && y >= 0 && x <= width && y <= height)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Only a model on this Mac may see the screen. */
export function localEndpoint(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Where is `description` in this screenshot? Asks the local grounder.
 * @param {string} description
 * @param {{ image: string, mime?: string, width: number, height: number }} shot base64 JPEG and its size
 * @param {{ url?: string, model?: string, coords?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [o]
 * @returns {Promise<{ x: number, y: number, raw: string } | { error: string, message: string }>}
 */
export async function ground(description, shot, { url = process.env.ECHO_GROUNDER_URL || '', model = process.env.ECHO_GROUNDER_MODEL || 'ui-venus', coords = process.env.ECHO_GROUNDER_COORDS || 'norm1000', fetchImpl = fetch, timeoutMs = GROUNDER_MS } = {}) {
  if (!url) return { error: 'not_set_up', message: 'The local UI grounder is not set up (ECHO_GROUNDER_URL). Use look_at_screen with a grid instead, then click a cell.' };
  if (!localEndpoint(url)) return { error: 'not_local', message: 'The grounder must run on this Mac (127.0.0.1): the screenshot never leaves it.' };
  if (!shot?.image || !shot.width || !shot.height) return { error: 'no_picture', message: 'No screenshot to look at.' };
  const prompt = `Locate this UI element in the screenshot and answer with its center point only, as (x, y) in 0-1000 coordinates: ${String(description).slice(0, 200)}`;
  let raw = '';
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 40,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${shot.mime || 'image/jpeg'};base64,${shot.image}` } }] }],
      }),
    });
    const body = await res.json();
    raw = String(body?.choices?.[0]?.message?.content ?? body?.text ?? '');
  } catch (e) {
    return { error: 'grounder_failed', message: `The local grounder didn't answer: ${String(e?.message || e).slice(0, 120)}` };
  }
  const p = parsePoint(raw);
  const px = p && toImagePixels(p, shot, /** @type {any} */ (coords));
  if (!px) return { error: 'not_found', message: `The grounder couldn't place "${description}" on the screen.` };
  return { ...px, raw: raw.slice(0, 80) };
}
