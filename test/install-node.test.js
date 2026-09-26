// scripts/install-node.sh: installs Node.js from a nodejs.org-style dist folder, checks the
// SHA-256, and never needs git. Uses a fake dist on disk (file:// URLs), so no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'install-node.sh');

/** A dist folder with index.tab, and for each version a tarball holding a stand-in bin/node. */
function fakeDist(dir, { lts = 'v22.99.0', current = 'v23.1.0', corrupt = false } = {}) {
  const dist = path.join(dir, 'dist');
  const rows = ['version\tdate\tfiles\tnpm\tv8\tuv\tzlib\topenssl\tmodules\tlts\tsecurity'];
  rows.push(`${current}\t2026-09-01\tlinux-x64,osx-arm64-tar,osx-x64-tar\t-\t-\t-\t-\t-\t-\t-\tfalse`);
  rows.push(`${lts}\t2026-08-01\tlinux-x64,osx-arm64-tar,osx-x64-tar\t-\t-\t-\t-\t-\t-\tJod\tfalse`);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.tab'), rows.join('\n') + '\n');
  for (const v of [lts, current]) {
    const name = `node-${v}-darwin-arm64`;
    const stage = path.join(dir, 'stage', v);
    fs.mkdirSync(path.join(stage, name, 'bin'), { recursive: true });
    const major = v.slice(1).split('.')[0];
    fs.writeFileSync(path.join(stage, name, 'bin', 'node'), `#!/bin/sh\ncase "$1" in -v) echo ${v} ;; -p) echo ${major} ;; esac\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(dist, v), { recursive: true });
    const tgz = path.join(dist, v, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', tgz, '-C', stage, name]);
    let sum = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
    if (corrupt) sum = sum.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    fs.writeFileSync(path.join(dist, v, 'SHASUMS256.txt'), `${'a'.repeat(64)}  node-${v}.tar.gz\n${sum}  ${name}.tar.gz\n`);
  }
  return dist;
}

/** Runs the script with a PATH that has no node and a git that fails loudly if it's ever used. */
function run(dir, dist, extraEnv = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho called >> "${dir}/git-called"\nexit 1\n`, { mode: 0o755 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync('/bin/bash', [SCRIPT], {
    encoding: 'utf8',
    env: { HOME: home, TMPDIR: dir, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, ECHO_NODE_DIST: `file://${dist}`, ECHO_NODE_ARCH: 'arm64', ...extraEnv },
  });
}

test('installs the latest LTS into ~/.echo/node after checking its SHA-256, without git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-node-'));
  const dist = fakeDist(dir);
  const r = run(dir, dist);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const node = path.join(dir, 'home', '.echo', 'node', 'bin', 'node');
  assert.equal(r.stdout.trim().split('\n').pop(), node);
  assert.match(r.stdout, /v22\.99\.0/);
  assert.match(r.stdout, /Download verified/);
  assert.equal(execFileSync(node, ['-v'], { encoding: 'utf8' }).trim(), 'v22.99.0');
  assert.equal(fs.existsSync(path.join(dir, 'git-called')), false);

  // Running it again keeps what's there (no download: the dist is gone).
  fs.rmSync(dist, { recursive: true });
  const again = run(dir, dist);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), node);
  assert.doesNotMatch(again.stdout, /Downloading/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses a download that does not match SHASUMS256.txt and leaves nothing behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-node-'));
  const dist = fakeDist(dir, { corrupt: true });
  const r = run(dir, dist);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /doesn't match its published checksum/);
  assert.equal(fs.existsSync(path.join(dir, 'home', '.echo', 'node')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--check reports a missing install; a pinned version replaces one that is too old', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-node-'));
  const dist = fakeDist(dir);
  const check = spawnSync('/bin/bash', [SCRIPT, '--check'], { encoding: 'utf8', env: { HOME: path.join(dir, 'nohome'), PATH: '/usr/bin:/bin' } });
  assert.equal(check.status, 1);
  const own = path.join(dir, 'home', '.echo', 'node', 'bin');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'node'), '#!/bin/sh\necho 18\n', { mode: 0o755 });
  const r = run(dir, dist, { ECHO_NODE_VERSION: '23.1.0' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(execFileSync(path.join(own, 'node'), ['-v'], { encoding: 'utf8' }).trim(), 'v23.1.0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the installer uses install-node.sh, not nvm or git, and checks the Command Line Tools early', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
  assert.match(sh, /scripts\/install-node\.sh/);
  assert.doesNotMatch(sh, /nvm install|nvm-sh\/nvm/);
  assert.ok(sh.indexOf('xcode-select -p') < sh.indexOf('step "checking for Node.js"'), 'Command Line Tools are checked before Node.js');
  assert.match(sh, /wait_for_clt/);
  const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'launcher.sh'), 'utf8');
  assert.match(launcher, /\.echo\/node/);
});
