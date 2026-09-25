// The native Mac app (macos/) and the launcher it starts Echo with. The launcher runs against a
// throwaway Echo folder with a fake supervisor, on free ports; nothing real is started or stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox } from './helpers.js';

const dirs = sandbox('macapp');
const { APP_DIR } = await import('../lib/config.js');
const { productFiles, INCLUDE } = await import('../scripts/package.js');
const run = promisify(execFile);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });

/** A local server answering /api/health with the given status and body. */
const fakeEcho = (port, status, body) =>
  new Promise((resolve) => {
    const s = http.createServer((req, res) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });

// A fake Echo folder: the real launcher, and a supervisor that counts its starts and answers health.
const echo = path.join(dirs.root, 'echo');
fs.mkdirSync(path.join(echo, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(APP_DIR, 'scripts', 'launcher.sh'), path.join(echo, 'scripts', 'launcher.sh'));
fs.writeFileSync(path.join(echo, '.echo-node'), process.execPath + '\n');
fs.writeFileSync(
  path.join(echo, 'supervisor.js'),
  `const fs = require('node:fs');
fs.appendFileSync(__dirname + '/starts', 'x');
require('node:http').createServer((q, r) => r.end('{"ok":true}')).listen(Number(process.env.VOICEOPS_PORT), '127.0.0.1');
`
);
const starts = () => (fs.existsSync(path.join(echo, 'starts')) ? fs.readFileSync(path.join(echo, 'starts'), 'utf8').length : 0);

/** @param {number} port @param {string[]} [args] */
const launch = async (port, args = []) => {
  const env = { ...process.env, VOICEOPS_PORT: String(port), ECHO_NO_BROWSER: '1', ECHO_START_WAIT: '2' };
  try {
    const r = await run('/bin/bash', [path.join(echo, 'scripts', 'launcher.sh'), ...args, echo], { env });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { code: e.code, out: String(e.stdout) + String(e.stderr) };
  }
};

test('the launcher only opens Echo when it already answers', async () => {
  const port = await freePort();
  const s = await fakeEcho(port, 200, { ok: true });
  const r = await launch(port);
  s.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ready at http:\/\/localhost:\d+/);
  assert.equal(starts(), 0, 'nothing started');
  assert.ok(!fs.existsSync(path.join(echo, 'logs', 'echo-launcher.pid')));
});

test('the launcher never starts a second server when something else holds the port', async () => {
  const port = await freePort();
  const s = await fakeEcho(port, 503, { ok: false });
  const r = await launch(port);
  s.close();
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Something else is using port/);
  assert.equal(starts(), 0, 'nothing started');
});

test('the launcher starts Echo once, reuses it, and stops only its own copy', async () => {
  const port = await freePort();
  let r = await launch(port);
  assert.equal(r.code, 0, r.out);
  assert.equal(starts(), 1);
  r = await launch(port);
  assert.equal(r.code, 0, r.out);
  assert.equal(starts(), 1, 'the running copy is reused');
  r = await launch(port, ['--stop']);
  assert.match(r.out, /Echo stopped/);
  r = await launch(port, ['--stop']);
  assert.match(r.out, /isn't running from this launcher/);
});

test('the app asks for the microphone and speech, and ships its sources in the package', () => {
  const plist = fs.readFileSync(path.join(APP_DIR, 'macos', 'Info.plist'), 'utf8');
  for (const key of ['NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription', 'NSAllowsLocalNetworking', 'local.echo.app']) {
    assert.ok(plist.includes(key), key);
  }
  const main = fs.readFileSync(path.join(APP_DIR, 'macos', 'Sources', 'main.swift'), 'utf8');
  assert.match(main, /requestMediaCapturePermissionFor/, 'the page gets the mic without asking every time');
  assert.match(main, /mediaTypesRequiringUserActionForPlayback = \[\]/, 'speech and piano can play');
  assert.ok(INCLUDE.includes('macos/'));
  const files = productFiles();
  for (const f of ['macos/Info.plist', 'macos/Sources/main.swift', 'macos/Echo.icns', 'scripts/build-app.sh']) assert.ok(files.includes(f), f);
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['build-app'], /build-app\.sh/);
  const install = fs.readFileSync(path.join(APP_DIR, 'scripts', 'install.sh'), 'utf8');
  assert.match(install, /build-app\.sh --out/, 'the installer builds the Mac app');
  assert.match(install, /xcode-select --install/, 'and offers Apple\'s tools when they are missing');
});

const swiftTools = (() => {
  try {
    const dev = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return fs.existsSync(path.join(dev, 'usr/bin/swiftc')) || fs.existsSync(path.join(dev, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'));
  } catch {
    return false;
  }
})();

test('the Swift sources compile', { skip: !swiftTools && 'no Swift build tools on this Mac' }, async () => {
  const src = path.join(APP_DIR, 'macos', 'Sources');
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.swift')).map((f) => path.join(src, f));
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  await run('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-typecheck', '-swift-version', '5', '-target', `${arch}-apple-macos13.0`, ...files]);
});
