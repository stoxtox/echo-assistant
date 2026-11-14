// Shared test setup: every test file runs in its own process with throwaway folders,
// so tests never touch the real data/, logs/ or projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `echo-${name}-`));
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
    ECHO_DATA_DIR: dirs.data,
    ECHO_LOG_DIR: dirs.logs,
    ECHO_ROOTS: dirs.projects,
    ECHO_RESEARCH_DIR: dirs.research,
    ECHO_WORKTREE_DIR: dirs.worktrees,
    ECHO_TZ: 'America/New_York',
    ECHO_TITLES: 'off', // no model calls from tests
    ECHO_APP_DIRS: '', // no installed app names in the vocabulary (lib/vocab.js installedAppNames)
    ECHO_SECOND_LISTEN: 'off', // no real Whisper run on test sentences (lib/secondlisten.js secondListenOn)
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

/**
 * server.js and the parts split out of it (lib/server/*.js) as one text, for tests that check how
 * the server is wired: they keep working when code moves between those files.
 */
export function serverSource() {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = path.join(root, 'lib', 'server');
  const files = [path.join(root, 'server.js'), ...fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(dir, f))];
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

/** public/app.js and the views split out of it (public/ui/*.js) as one text, like serverSource(). */
export function pageSource() {
  const pub = path.resolve(import.meta.dirname, '..', 'public');
  const dir = path.join(pub, 'ui');
  const files = [path.join(pub, 'app.js'), ...fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(dir, f))];
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}
