// What a tool hands back to the assistant: a value as text, or a failure as a sentence to say.
// Compact JSON: every tool result stays in the conversation's context, so its whitespace costs on
// every later call (about a fifth of a typical result).
export const text = (value) => ({
  content: [{ type: /** @type {const} */ ('text'), text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
export const fail = (message) => ({ content: [{ type: /** @type {const} */ ('text'), text: String(message) }], isError: true });

/** What a tool says when a yes to something that can't be undone came in too soft to be sure of (dispatcher.clearYes). */
export const TOO_QUIET = 'NOT DONE: that yes was too quiet to be sure it was the user\'s. Nothing was approved. Ask once, in a few words, what exactly they are saying yes to, and wait for their answer; then call this again.';
