// Shared test setup: every test file runs in its own process with throwaway folders,
// so tests never touch the real data/, logs/ or projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `voiceops-${name}-`));
  const dirs = {
    root,
    data: path.join(root, 'data'),
    logs: path.join(root, 'logs'),
    projects: path.join(root, 'projects'),
    research: path.join(root, 'projects', '_research'),
    worktrees: path.join(root, 'worktrees'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  Object.assign(process.env, {
    VOICEOPS_DATA_DIR: dirs.data,
    VOICEOPS_LOG_DIR: dirs.logs,
    VOICEOPS_ROOTS: dirs.projects,
    VOICEOPS_RESEARCH_DIR: dirs.research,
    VOICEOPS_WORKTREE_DIR: dirs.worktrees,
    VOICEOPS_TZ: 'America/New_York',
    VOICEOPS_TITLES: 'off', // no model calls from tests
  });
  return dirs;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 3000, label = 'condition') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await wait(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * A stand-in for the Agent SDK's query(). `script(turn, prompt, options)` returns the
 * messages for each user turn (or a promise of them). Honors the abort signal.
 */
export function fakeQuery(script) {
  const calls = [];
  const queryFn = ({ prompt, options }) => {
    const call = { options, prompts: [] };
    calls.push(call);
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: `session-${calls.length}` };
      let turn = 0;
      for await (const msg of prompt) {
        if (options.abortController?.signal.aborted) throw new Error('aborted');
        const text = typeof msg.message.content === 'string' ? msg.message.content : '';
        call.prompts.push(text);
        const out = await Promise.race([
          script(turn++, text, options, call),
          new Promise((_, reject) => options.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')))),
        ]);
        for (const m of out || []) yield m;
      }
    })();
  };
  return { queryFn, calls };
}

export const say = (text) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: Math.random().toString(36), content: [{ type: 'text', text }] } });
export const result = (text, cost = 0.01) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: cost });
export const bg = (tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
