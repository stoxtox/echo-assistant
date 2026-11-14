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
// Paths in commands are quoted, as a worker would, so these pass from a folder with a space in its name.
const APP = `"${APP_DIR}"`;
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
    catLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `tail -n 50 ${APP}/logs/echo.log | grep -i error` } }, 'id', { signal })),
    gitLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `git -C ${APP} log --oneline -5` } }, 'id', { signal })),
  }));
  assert.deepEqual(out, { readRepo: 'allow', grepLogs: 'allow', readData: 'allow', outside: 'allow', catLog: 'none', gitLog: 'none' });
  assert.deepEqual(approvals, [], 'nothing asked');
});

test('a self-improvement worker still cannot write outside its worktree, read secrets, or change the live app unasked', async () => {
  const { out, approvals } = await probe('self', async ({ guard, bash }) => ({
    editLive: decision(await guard({ tool_name: 'Edit', tool_input: { file_path: path.join(APP_DIR, 'server.js') } }, 'id', { signal })),
    env: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(APP_DIR, '.env') } }, 'id', { signal })),
    pin: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(config.dataDir, 'self', 'pin.json') } }, 'id', { signal })),
    rm: decision(await bash({ tool_name: 'Bash', tool_input: { command: `rm ${APP}/data/tasks.json` } }, 'id', { signal })),
    post: decision(await bash({ tool_name: 'Bash', tool_input: { command: `curl -X POST http://localhost:${config.port}/api/self/lock` } }, 'id', { signal })),
  }));
  assert.deepEqual(out, { editLive: 'deny', env: 'deny', pin: 'deny', rm: 'deny', post: 'deny' });
  assert.equal(approvals.length, 2, 'the rm and the POST asked (and were denied)');
});

test('ordinary workers cannot read Echo until you allow it, and never write to it', async () => {
  const { out, approvals } = await probe('code', async ({ guard, bash, canUseTool }) => ({
    readRepo: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(APP_DIR, 'server.js') } }, 'id', { signal })),
    catLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `cat ${APP}/logs/echo.log` } }, 'id', { signal })),
    outside: (await canUseTool('Read', { file_path: '/etc/hosts' }, { signal, blockedPath: '/etc/hosts' })).behavior,
  }));
  assert.deepEqual(out, { readRepo: 'deny', catLog: 'deny', outside: 'deny' });
  assert.equal(approvals.length, 3, 'the read, the cat and the outside read asked (and were denied)');
});

/** Like probe, but approves the first request (a read of Echo's code) and denies the rest. */
async function probeApproved(fn, { grantFirst = false } = {}) {
  let out;
  const fq = fakeQuery(async (turn, text, options) => {
    const hook = (m) => options.hooks.PreToolUse.find((h) => h.matcher.split('|').includes(m)).hooks[0];
    out = await fn({ guard: hook('Read'), bash: hook('Bash'), canUseTool: options.canUseTool });
    return [result('ok')];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const approvals = [];
  tm.on('approval', (t) => {
    approvals.push({ level: t.pendingApproval.level, reason: t.pendingApproval.reason });
    tm.resolveApproval(t.id, approvals.length === 1 && !grantFirst);
  });
  const t = tm.create({ project: 'Demo', cwd: project, instruction: 'x' });
  if (grantFirst) tm.grants.grant({ taskId: t.id, kind: 'echo_read' });
  await until(() => t.status === 'done', 3000, 'done');
  return { out, approvals, tm, t };
}

test("once you approve reading Echo's code, an ordinary task reads the repo, logs and data without more prompts", async () => {
  const { out, approvals, tm, t } = await probeApproved(async ({ guard, bash, canUseTool }) => ({
    firstRead: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(APP_DIR, 'server.js') } }, 'id', { signal })),
    grepCode: decision(await guard({ tool_name: 'Grep', tool_input: { pattern: 'x', path: path.join(APP_DIR, 'lib') } }, 'id', { signal })),
    globData: decision(await guard({ tool_name: 'Glob', tool_input: { pattern: '*.json', path: config.dataDir } }, 'id', { signal })),
    readSettings: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(config.dataDir, 'settings.json') } }, 'id', { signal })),
    outsideRead: (await canUseTool('Read', { file_path: path.join(APP_DIR, 'README.md') }, { signal, blockedPath: path.join(APP_DIR, 'README.md') })).behavior,
    lsCat: decision(await bash({ tool_name: 'Bash', tool_input: { command: `cd ${APP} && ls -la && ls lib docs 2>/dev/null | head -100 && wc -l lib/*.js server.js` } }, 'id', { signal })),
    gitLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `cd ${APP} && git log --oneline | head -60 && git branch -a && cat package.json` } }, 'id', { signal })),
    tailLog: decision(await bash({ tool_name: 'Bash', tool_input: { command: `tail -n 50 ${config.logDir}/echo.log` } }, 'id', { signal })),
  }));
  assert.deepEqual(out, { firstRead: 'allow', grepCode: 'allow', globData: 'allow', readSettings: 'allow', outsideRead: 'allow', lsCat: 'none', gitLog: 'none', tailLog: 'none' });
  assert.equal(approvals.length, 1, 'asked once');
  assert.equal(approvals[0].level, 'echo_read');
  assert.equal(tm.grants.describe(t.id).task?.echoRead, true);
  assert.equal(tm.grants.describe(t.id + 1).task, null, 'the grant stays with its task');
});

test("with read access to Echo granted, writes, deletes, secrets, the live port and git push stay gated", async () => {
  const { out, approvals } = await probeApproved(async ({ guard, bash }) => ({
    editLive: decision(await guard({ tool_name: 'Edit', tool_input: { file_path: path.join(APP_DIR, 'server.js') } }, 'id', { signal })),
    writeData: decision(await guard({ tool_name: 'Write', tool_input: { file_path: path.join(config.dataDir, 'tasks.json') } }, 'id', { signal })),
    env: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(APP_DIR, '.env') } }, 'id', { signal })),
    pin: decision(await guard({ tool_name: 'Read', tool_input: { file_path: path.join(config.dataDir, 'self', 'pin.json') } }, 'id', { signal })),
    catEnv: decision(await bash({ tool_name: 'Bash', tool_input: { command: `cat ${APP}/.env` } }, 'id', { signal })),
    rm: decision(await bash({ tool_name: 'Bash', tool_input: { command: `rm ${APP}/data/tasks.json` } }, 'id', { signal })),
    redirect: decision(await bash({ tool_name: 'Bash', tool_input: { command: `echo x > ${APP}/lib/x.js` } }, 'id', { signal })),
    sedInPlace: decision(await bash({ tool_name: 'Bash', tool_input: { command: `sed -i '' s/a/b/ ${APP}/server.js` } }, 'id', { signal })),
    health: decision(await bash({ tool_name: 'Bash', tool_input: { command: `curl -s http://localhost:${config.port}/api/health` } }, 'id', { signal })),
    post: decision(await bash({ tool_name: 'Bash', tool_input: { command: `curl -X POST http://localhost:${config.port}/api/self/lock` } }, 'id', { signal })),
    push: decision(await bash({ tool_name: 'Bash', tool_input: { command: `git -C ${APP} push origin main` } }, 'id', { signal })),
  }), { grantFirst: true });
  assert.deepEqual(out, { editLive: 'deny', writeData: 'deny', env: 'deny', pin: 'deny', catEnv: 'deny', rm: 'deny', redirect: 'deny', sedInPlace: 'deny', health: 'deny', post: 'deny', push: 'deny' });
  assert.deepEqual(approvals.map((a) => a.level), ['risky', 'risky', 'risky', 'risky', 'risky', 'risky', 'risky'], 'every shell change asked as risky (and was denied); file writes and secrets were refused outright');
});
