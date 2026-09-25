// End-to-end: a self-update that breaks Echo is rolled back automatically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('supervisor');
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supervisor.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });

const GOOD = `import http from 'node:http';
http.createServer((req, res) => res.end(JSON.stringify({ ok: true, version: 'good' }))).listen(process.env.VOICEOPS_PORT, '127.0.0.1');\n`;
const BAD = `throw new Error('broken update');\n`;

test('a self-update that fails its health check is rolled back', { timeout: 60000 }, async () => {
  const app = path.join(dirs.root, 'app');
  fs.mkdirSync(app);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: app, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, 'server.js'), GOOD);
  git('add', '-A');
  git('commit', '-qm', 'good');
  const good = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(app, 'server.js'), BAD);
  git('commit', '-qam', 'bad self-update');
  const bad = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(dirs.data, 'self'), { recursive: true });
  fs.writeFileSync(path.join(dirs.data, 'self', 'pending-restart.json'), JSON.stringify({ lastGood: good, head: bad, taskId: 9 }));

  const port = await freePort();
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, VOICEOPS_APP_DIR: app, VOICEOPS_PORT: String(port), VOICEOPS_HEALTH_TIMEOUT_MS: '4000' },
    stdio: 'pipe',
  });
  let output = '';
  sup.stdout.on('data', (d) => (output += d));
  sup.stderr.on('data', (d) => (output += d));
  try {
    await until(() => fs.existsSync(path.join(dirs.data, 'self', 'rollback-notice.json')), 30000, 'rollback');
    assert.equal(git('rev-parse', 'HEAD'), good, 'back on the last good commit');
    await until(async () => {
      try {
        return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).version === 'good';
      } catch {
        return false;
      }
    }, 15000, 'good version serving');
    const events = fs.readFileSync(path.join(dirs.data, 'self', 'audit.log'), 'utf8');
    assert.match(events, /"rolled_back"/);
    assert.ok(!fs.existsSync(path.join(dirs.data, 'self', 'pending-restart.json')));
  } catch (e) {
    console.log(output);
    throw e;
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
  }
});

// The 11:22 PM false rollback: the old version aborted (SIGABRT) while exiting to apply an
// update. That's the old version's exit, not the new version failing, so apply the update.
test('the old version dying while restarting applies the update instead of rolling back', { timeout: 60000 }, async () => {
  const app = path.join(dirs.root, 'app2');
  const data = path.join(dirs.root, 'data2');
  fs.mkdirSync(app);
  fs.mkdirSync(path.join(data, 'self'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: app, encoding: 'utf8' }).trim();
  const server = (version) => `import http from 'node:http';
http.createServer((req, res) => res.end(JSON.stringify({ ok: true, version: '${version}', pid: process.pid }))).listen(process.env.VOICEOPS_PORT, '127.0.0.1');\n`;
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, 'server.js'), server('old'));
  git('add', '-A');
  git('commit', '-qm', 'old');
  const old = git('rev-parse', 'HEAD');

  const port = await freePort();
  const health = async () => {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    } catch {
      return null;
    }
  };
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, VOICEOPS_APP_DIR: app, VOICEOPS_DATA_DIR: data, VOICEOPS_PORT: String(port), VOICEOPS_HEALTH_TIMEOUT_MS: '8000' },
    stdio: 'pipe',
  });
  let output = '';
  sup.stdout.on('data', (d) => (output += d));
  sup.stderr.on('data', (d) => (output += d));
  try {
    await until(async () => (await health())?.version === 'old', 15000, 'old version serving');
    const { pid } = await health();
    // Merge the update, then the old process dies abnormally on its way out.
    fs.writeFileSync(path.join(app, 'server.js'), server('new'));
    git('commit', '-qam', 'update');
    const head = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(data, 'self', 'pending-restart.json'), JSON.stringify({ lastGood: old, head, taskId: 21, at: new Date().toISOString() }));
    process.kill(pid, 'SIGABRT');
    await until(async () => (await health())?.version === 'new', 15000, 'new version serving');
    await until(() => !fs.existsSync(path.join(data, 'self', 'pending-restart.json')), 15000, 'health verified');
    assert.equal(git('rev-parse', 'HEAD'), head, 'update kept');
    assert.ok(!fs.existsSync(path.join(data, 'self', 'rollback-notice.json')));
  } catch (e) {
    console.log(output);
    throw e;
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
  }
});

// The flip side: after the old version's exit, a new version that really is broken still
// gets rolled back.
test('a broken update is still rolled back after the old version dies while restarting', { timeout: 60000 }, async () => {
  const app = path.join(dirs.root, 'app3');
  const data = path.join(dirs.root, 'data3');
  fs.mkdirSync(app);
  fs.mkdirSync(path.join(data, 'self'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: app, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, 'server.js'), GOOD.replace('version: \'good\'', 'version: \'good\', pid: process.pid'));
  git('add', '-A');
  git('commit', '-qm', 'good');
  const good = git('rev-parse', 'HEAD');

  const port = await freePort();
  const health = async () => {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    } catch {
      return null;
    }
  };
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, VOICEOPS_APP_DIR: app, VOICEOPS_DATA_DIR: data, VOICEOPS_PORT: String(port), VOICEOPS_HEALTH_TIMEOUT_MS: '4000' },
    stdio: 'pipe',
  });
  let output = '';
  sup.stdout.on('data', (d) => (output += d));
  sup.stderr.on('data', (d) => (output += d));
  try {
    await until(async () => (await health())?.version === 'good', 15000, 'good version serving');
    const { pid } = await health();
    fs.writeFileSync(path.join(app, 'server.js'), BAD);
    git('commit', '-qam', 'bad update');
    const bad = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(data, 'self', 'pending-restart.json'), JSON.stringify({ lastGood: good, head: bad, taskId: 22, at: new Date().toISOString() }));
    process.kill(pid, 'SIGABRT');
    await until(() => fs.existsSync(path.join(data, 'self', 'rollback-notice.json')), 30000, 'rollback');
    assert.equal(git('rev-parse', 'HEAD'), good, 'back on the last good commit');
    await until(async () => (await health())?.version === 'good', 15000, 'good version serving again');
  } catch (e) {
    console.log(output);
    throw e;
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
  }
});

/* ---------- planned restarts are never crashes ---------- */

// A stand-in server that can exit the ways a real Echo restart does.
const RESTARTABLE = (version) => `import http from 'node:http';
http.createServer((req, res) => {
  if (req.url === '/exit75') return res.end('bye', () => process.exit(75));
  // gracefulRestart: tell the supervisor, then die abnormally before the exit code gets out.
  if (req.url === '/ipc-then-signal') return res.end('bye', () => process.send({ type: 'restart' }, () => process.kill(process.pid, 'SIGKILL')));
  res.end(JSON.stringify({ ok: true, version: '${version}', pid: process.pid }));
}).listen(process.env.VOICEOPS_PORT, '127.0.0.1');\n`;

async function supervised(name, { timeoutMs = 8000 } = {}) {
  const app = path.join(dirs.root, `${name}-app`);
  const data = path.join(dirs.root, `${name}-data`);
  fs.mkdirSync(app);
  fs.mkdirSync(path.join(data, 'self'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: app, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, 'server.js'), RESTARTABLE('v1'));
  git('add', '-A');
  git('commit', '-qm', 'v1');
  const port = await freePort();
  const health = async () => {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    } catch {
      return null;
    }
  };
  const hit = (p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.text()).catch(() => '');
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, VOICEOPS_APP_DIR: app, VOICEOPS_DATA_DIR: data, VOICEOPS_PORT: String(port), VOICEOPS_HEALTH_TIMEOUT_MS: String(timeoutMs) },
    stdio: 'pipe',
  });
  const out = { text: '' };
  sup.stdout.on('data', (d) => (out.text += d));
  sup.stderr.on('data', (d) => (out.text += d));
  const stop = async () => {
    if (sup.exitCode === null) {
      sup.kill('SIGTERM');
      await new Promise((r) => sup.once('exit', r));
    }
  };
  return { app, data, git, port, health, hit, sup, out, stop };
}

/** Wait for a server process other than `pid` to answer the health check. */
const newPid = async (s, pid, label) => {
  await until(async () => {
    const h = await s.health();
    return h && h.pid !== pid;
  }, 15000, label);
  return (await s.health()).pid;
};

test('planned restarts (exit 75, or a restart message then a signal) never count as crashes', { timeout: 90000 }, async () => {
  const s = await supervised('planned');
  try {
    await until(async () => (await s.health())?.version === 'v1', 15000, 'serving');
    let pid = (await s.health()).pid;
    // More planned restarts in a row than the crash limit (5 in two minutes) allows.
    for (let i = 0; i < 7; i++) {
      await s.hit(i % 2 ? '/ipc-then-signal' : '/exit75');
      pid = await newPid(s, pid, `restart ${i + 1}`);
    }
    assert.equal(s.sup.exitCode, null, 'supervisor still running');
    assert.doesNotMatch(s.out.text, /Echo exited|keeps crashing|rolling back/, 'none counted as a crash');
    assert.equal((s.out.text.match(/restart requested/g) || []).length, 7);
    assert.ok(!fs.existsSync(path.join(s.data, 'self', 'rollback-notice.json')));
  } catch (e) {
    console.log(s.out.text);
    throw e;
  } finally {
    await s.stop();
  }
});

test('a graceful restart into a healthy update clears the pending update and keeps it', { timeout: 60000 }, async () => {
  const s = await supervised('graceful');
  try {
    await until(async () => (await s.health())?.version === 'v1', 15000, 'serving');
    const { pid } = await s.health();
    const lastGood = s.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(s.app, 'server.js'), RESTARTABLE('v2'));
    s.git('commit', '-qam', 'v2');
    const head = s.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(s.data, 'self', 'pending-restart.json'), JSON.stringify({ lastGood, head, taskId: 30, at: new Date().toISOString() }));
    await s.hit('/exit75');
    await newPid(s, pid, 'new version');
    await until(() => !fs.existsSync(path.join(s.data, 'self', 'pending-restart.json')), 15000, 'pending cleared');
    assert.equal((await s.health()).version, 'v2');
    assert.equal(s.git('rev-parse', 'HEAD'), head);
    assert.match(fs.readFileSync(path.join(s.data, 'self', 'audit.log'), 'utf8'), /"health_ok"/);
    assert.doesNotMatch(s.out.text, /Echo exited|rolling back/);
  } catch (e) {
    console.log(s.out.text);
    throw e;
  } finally {
    await s.stop();
  }
});

test('a real crash (no restart requested, no update pending) is counted and restarted', { timeout: 60000 }, async () => {
  const s = await supervised('crash');
  try {
    await until(async () => (await s.health())?.version === 'v1', 15000, 'serving');
    const { pid } = await s.health();
    process.kill(pid, 'SIGKILL');
    await newPid(s, pid, 'restarted after crash');
    assert.match(s.out.text, /Echo exited \(SIGKILL\); restarting in 1s/);
    assert.equal(s.git('log', '--oneline').split('\n').length, 1, 'no rollback without a pending update');
  } catch (e) {
    console.log(s.out.text);
    throw e;
  } finally {
    await s.stop();
  }
});
