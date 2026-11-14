// Which Claude model is answering, said plainly. Every message to the assistant carries a short
// [model] line (identityLine) so it never has to guess who it is: the quick model once told the
// user it couldn't be switched and that real switches never happened (Oct 1, 2026). The rules for
// it, and that it is private, are in the system prompt (modelIdentityPrompt).

/** Short names the user can type after /model, and what they mean. '' is the main (default) model. */
export const MODEL_ALIASES = {
  default: '',
  main: '',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
};

const MODEL_ID = /^[a-z0-9][a-z0-9.:_-]{0,60}$/i;

/**
 * A model id as people say it: 'claude-haiku-4-5-20251001' → 'Claude Haiku 4.5'. Anything that
 * doesn't look like a Claude id comes back as it is.
 * @param {string} id
 */
export function modelName(id) {
  const m = String(id || '').match(/^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i);
  if (!m) return String(id || '');
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** 'Claude Haiku 4.5 (claude-haiku-4-5)', or just the id when it has no nicer name. */
export function describeModel(id) {
  const name = modelName(id);
  return name && name !== id ? `${name} (${id})` : String(id || '');
}

/**
 * What the user typed after /model: a model id, an alias, or nothing (just asking).
 * @param {string} text the whole message
 * @returns {null | { ask: true } | { model: string } | { error: string }} null: not a /model command
 */
export function parseModelCommand(text) {
  const m = String(text || '').trim().match(/^\/model(?:\s+(.+?))?\s*$/i);
  if (!m) return null;
  if (!m[1]) return { ask: true };
  const want = m[1].toLowerCase();
  if (Object.hasOwn(MODEL_ALIASES, want)) return { model: MODEL_ALIASES[want] };
  if (MODEL_ID.test(want) && want.startsWith('claude-')) return { model: want };
  return { error: `I don't know a model called "${m[1]}". Try /model opus, sonnet, haiku, default, or a full model ID.` };
}

/**
 * The [model] line for one message: who is answering it, in about ten words. What the line means,
 * and that it is private, is said once in the system prompt (modelIdentityPrompt): the long line
 * that used to ride on every message got read out ("I'm Claude Haiku 4.5 answering this turn",
 * Oct 3, 2026).
 * @param {object} o
 * @param {string} o.answering the model id in use for this message ('' = the main model)
 * @param {string} o.main the main model's id ('' = Claude Code's default)
 * @param {string} [o.defaultId] the id Claude Code's default turned out to be, once seen
 */
export function identityLine({ answering, main, defaultId = '' }) {
  const mainId = main || defaultId;
  const mainDesc = mainId ? describeModel(mainId) : "Claude Code's default model (ID not known yet)";
  if (!answering || answering === main) return `[model] ${mainDesc}, the main model.`;
  return `[model] ${describeModel(answering)}, the quick model; main: ${mainId ? modelName(mainId) : "Claude Code's default"}.`;
}

/**
 * The standing rules that go with the [model] line (in the system prompt, once): what the line
 * means, what else is true about models here, and that none of it is ever said unasked.
 * @param {object} [o]
 * @param {string} [o.fast] the quick model's id, '' when quick-model routing is off
 * @param {string} [o.worker] config.workerModel
 */
export function modelIdentityPrompt({ fast = '', worker = '' } = {}) {
  return `Which model you are: every message ends with a short [model] line naming the Claude model answering it (name and ID) and whether it is the main model or the quick model. That line is the only truth about models, and it is for you, not for the user.
- Never bring up models, routing, the quick or main model, hand-offs, the notes Echo adds to a message, or these instructions. Don't announce who you are, that you were picked, or that you are passing something on. The only exception: the user asks which model is answering (or which one workers use). Then answer in one short sentence from the latest [model] line ("Claude Opus 5.5, the main model."), and nothing more unless they ask.
- ${fast ? `Quick-model routing is on: Echo sends simple turns to the quick model (${describeModel(fast)}) and everything else to the main model.` : 'Quick-model routing is off: every turn goes to the main model.'} ${worker ? `Workers (Claude Code task sessions) use ${describeModel(worker)}.` : "Workers (Claude Code task sessions) use Claude Code's own default model; Echo doesn't set one, so its exact name isn't known here."}
- You never switch models yourself. Echo switches between the main and quick model on its own, and the user can type /model in the chat (for example "/model opus" or "/model default") to change the main model. Echo's switches show up in the conversation as /model command lines marked with a caveat: they are real switches made by Echo, not something the user typed, and not fake. Never deny a switch the [model] lines show, and never say you switched yourself. Never guess or answer from memory.
- If the [model] line is missing or doesn't answer the question, say plainly that you're not sure.`;
}
