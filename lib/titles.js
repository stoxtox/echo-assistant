// Short human titles for task tiles, written by a small, cheap model in the background.
// Tiles show a rule-based title (text.js shortTitle) until this fills in a better one.
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

const MODEL = process.env.VOICEOPS_TITLE_MODEL || 'claude-haiku-4-5';

/**
 * @param {Array<{ id: number, instruction: string }>} items
 * @param {(params: { prompt: any, options: any }) => AsyncIterable<any>} [queryFn]
 * @returns {Promise<Record<string, string>>} id -> title
 */
export async function writeTitles(items, queryFn = sdkQuery) {
  if (!items.length || process.env.VOICEOPS_TITLES === 'off') return {};
  const list = items.map((t) => `#${t.id}: ${t.instruction.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n\n');
  const prompt = `Write a short title (3 to 7 words, sentence case, no period) for each task below, saying what the task actually does, like "Find entry-level supply chain jobs" or "Turn job list into Excel sheet". Ignore boilerplate such as "small task" or tool instructions. Reply with only a JSON object mapping each task number to its title, e.g. {"3": "Find entry-level supply chain jobs"}.\n\n${list}`;
  let text = '';
  for await (const msg of queryFn({
    prompt,
    options: { model: MODEL, tools: [], maxTurns: 1, persistSession: false, settingSources: [], permissionMode: 'dontAsk', systemPrompt: 'You write concise task titles.', thinking: { type: 'disabled' } },
  })) {
    if (msg.type === 'result' && msg.subtype === 'success') text = msg.result;
  }
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return {};
  const out = {};
  for (const [id, title] of Object.entries(JSON.parse(json[0]))) {
    if (typeof title === 'string' && title.trim()) out[String(id).replace('#', '')] = title.trim().replace(/[.]+$/, '').slice(0, 70);
  }
  return out;
}
