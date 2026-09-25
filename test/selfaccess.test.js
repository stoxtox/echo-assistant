// Self-improvement workers may read the live Echo (repo, logs, data) without asking;
// writes, deletes, kills and POSTs still wait for approval, and ordinary workers stay out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, result, until } from './helpers.js';

const dirs = sandbox('selfaccess');
const { TaskManager } = await import('../lib/tasks.js');
const { APP_DIR, config } = await import('../lib/config.js');
const worktree = path.join(dirs.worktrees, 'self-test');
fs.mkdirSync(worktree, { recursive: true });
const project = path.join(dirs.projects, 'Demo');
fs.mkdirSync(project, { recursive: true });
const signal = new AbortController().signal;

/** Run one task whose worker calls `probe(hooks)` and returns what it saw. */
async function probe(kind, fn) {
  let out;
  const fq = fakeQuery(async (turn, text, options) => {
    const hook = (m) => options.hooks.PreToolUse.find((h) => h.matcher.split('|').includes(m)).hooks[0];
    out = await fn({ guard: hook('Read'), bash: hook('Bash'), canUseTool: options.canUseTool });
    return [result('ok')];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const approvals = [];
  tm.on('approval', (t) => {
    approvals.push(t.pendingApproval.reason);
    tm.resolveApproval(t.id, false);
  });
  const t = tm.create(kind === 'self' ? { kind: 'self', project: 'Echo (self)', cwd: worktree, instruction: 'x', self: { state: 'working' } } : { project: 'Demo', cwd: project, instruction: 'x' });
  await until(() => t.status === 'done', 3000, 'done');
  return { out, approvals };
}

const decision = (r) => r?.hookSpecificOutput?.permissionDecision || 'none';

test('a self-improvement worker reads the live repo, logs and data without prompts', async () => {
  const { out, approvals } = await probe('self', async ({ guard, bash, canUseTool }) => ({
    readRepo: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(APP_DIR, 'server.js') } }, 'id', { signal })),
    grepLogs: decision(await guard({ tool_name: 'Grep', tool_input: { pattern: 'error', path: config.logDir } }, 'id', { signal })),
    readData: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(config.dataDir, 'tasks.json') } }, 'id', { signal })),
    outside: (await canUseTool('Read', { file_path: path.join(APP_DIR, 'README.md') }, { signal, blockedPath: path.join(APP_DIR, 'README.md') })).behavior,
    catLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `tail -n 50 ${APP_DIR}/logs/voiceops.log | grep -i error` } }, 'id', { signal })),
    gitLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `git -C ${APP_DIR} log --oneline -5` } }, 'id', { signal })),
  }));
  assert.deepEqual(out, { readRepo: 'allow', grepLogs: 'allow', readData: 'allow', outside: 'allow', catLog: 'none', gitLog: 'none' });
  assert.deepEqual(approvals, [], 'nothing asked');
});

test('a self-improvement worker still cannot write outside its worktree, read secrets, or change the live app unasked', async () => {
  const { out, approvals } = await probe('self', async ({ guard, bash }) => ({
    editLive: decision(await guard({ tool_name: 'Edit', tool_input: { file_path: path.join(APP_DIR, 'server.js') } }, 'id', { signal })),
    env: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(APP_DIR, '.env') } }, 'id', { signal })),
    pin: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(config.dataDir, 'self', 'pin.json') } }, 'id', { signal })),
    rm: decision(await bash({ tool_name: 'Bash', tool_input: { command: `rm ${APP_DIR}/data/tasks.json` } }, 'id', { signal })),
    post: decision(await bash({ tool_name: 'Bash', tool_input: { command: `curl -X POST http://localhost:${config.port}/api/self/lock` } }, 'id', { signal })),
  }));
  assert.deepEqual(out, { editLive: 'deny', env: 'deny', pin: 'deny', rm: 'deny', post: 'deny' });
  assert.equal(approvals.length, 2, 'the rm and the POST asked (and were denied)');
});

test('ordinary workers are unchanged: Echo stays off-limits, even to read', async () => {
  const { out, approvals } = await probe('code', async ({ guard, bash, canUseTool }) => ({
    readRepo: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(APP_DIR, 'server.js') } }, 'id', { signal })),
    catLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `cat ${APP_DIR}/logs/voiceops.log` } }, 'id', { signal })),
    outside: (await canUseTool('Read', { file_path: '/etc/hosts' }, { signal, blockedPath: '/etc/hosts' })).behavior,
  }));
  assert.deepEqual(out, { readRepo: 'deny', catLog: 'deny', outside: 'deny' });
  assert.equal(approvals.length, 2, 'the cat and the outside read asked');
});
