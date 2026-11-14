// Quit means quit, and a caption that cannot get stuck: the server's shutdown endpoint (only the
// Mac app may ask), stopping under the real supervisor without being restarted, the page's caption
// heartbeat, and the app's pure rules (macos/Sources/PointMath.swift, checked in macos/Tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { sandbox, until, wait, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('lifecycle');
const ROOT = path.resolve(import.meta.dirname, '..');
const { apiHandler } = await import('../lib/server/routes.js');
const { bodyToken } = await import('../lib/bodylink.ts');
const { createCaptionFeed, CAPTION_BEAT_MS } = await import('../public/caption.js');
// The command line tools build without Xcode's license having been accepted.
const swiftEnv = { ...process.env, ...(fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/swiftc') ? { DEVELOPER_DIR: '/Library/Developer/CommandLineTools' } : {}) };
const swift = (f) => fs.readFileSync(path.join(ROOT, 'macos', 'Sources', f), 'utf8');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });

/** The real API handler over a stand-in task list; counts how often it was asked to shut down. */
async function fakeServer(live) {
  let shutDowns = 0;
  const tasks = { list: () => live.map((id) => ({ id })), isLive: () => true };
  const api = apiHandler(/** @type {any} */ ({ tasks, speech: { routes: {} }, shutDown: () => shutDowns++ }));
  const server = http.createServer((req, res) => {
    api(req, res, new URL(req.url || '/', 'http://localhost')).catch((e) => res.writeHead(400).end(e.message));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  const post = (headers, body = {}) =>
    fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { post, close: () => server.close(), shutDowns: () => shutDowns };
}

test('only the Mac app (with its token, never a web page) can shut Echo down', async () => {
  const s = await fakeServer([]);
  const token = bodyToken();
  try {
    assert.equal((await s.post({})).status, 403, 'no token');
    assert.equal((await s.post({ 'X-Echo-Token': 'f'.repeat(64) })).status, 403, 'a wrong token');
    assert.equal((await s.post({ 'X-Echo-Token': token, Origin: 'http://localhost:4777' })).status, 403, 'a web page, even with the token');
    assert.equal(s.shutDowns(), 0, 'nothing stopped');
    const r = await s.post({ 'X-Echo-Token': token });
    assert.deepEqual(await r.json(), { ok: true, working: 0 });
    assert.equal(s.shutDowns(), 1);
  } finally {
    s.close();
  }
});

test('with tasks running, the app is told how many before anything is paused', async () => {
  const s = await fakeServer([4, 9]);
  const token = bodyToken();
  try {
    const asked = await s.post({ 'X-Echo-Token': token }, { ifIdle: true });
    assert.deepEqual(await asked.json(), { ok: false, working: 2 }, 'the app asks the user first');
    assert.equal(s.shutDowns(), 0, 'still running');
    const go = await s.post({ 'X-Echo-Token': token });
    assert.deepEqual(await go.json(), { ok: true, working: 2 });
    assert.equal(s.shutDowns(), 1, 'the user chose to quit and pause them');
  } finally {
    s.close();
  }
  const src = serverSource();
  const quit = src.slice(src.indexOf('async function quit()'), src.indexOf("process.on('SIGINT'"));
  assert.match(quit, /quitAfter\(async \(\) => \{\s*const checkpointed = await tasks\.checkpointAll\(\);/, 'running tasks are paused (to resume) before it stops for good (lib/server/quit.js quitAfter)');
});

test('quitting under the supervisor stops both: Echo is not started again', { timeout: 30000 }, async () => {
  // A stand-in server that quits with the real stopForGood, under the real supervisor.
  const app = path.join(dirs.root, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(
    path.join(app, 'server.js'),
    `import http from 'node:http';
import fs from 'node:fs';
import { stopForGood } from ${JSON.stringify(path.join(ROOT, 'lib', 'server', 'quit.js'))};
fs.appendFileSync(${JSON.stringify(path.join(app, 'starts'))}, 'x');
http.createServer((req, res) => {
  res.end(JSON.stringify({ ok: true }));
  if (req.url === '/api/shutdown') stopForGood();
}).listen(process.env.ECHO_PORT, '127.0.0.1');\n`,
  );
  const port = await freePort();
  const sup = spawn(process.execPath, [path.join(ROOT, 'supervisor.js')], { env: { ...process.env, ECHO_APP_DIR: app, ECHO_PORT: String(port) }, stdio: 'ignore' });
  const exited = new Promise((r) => sup.once('exit', (code) => r(code)));
  const up = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      return false;
    }
  };
  try {
    await until(up, 15000, 'the server under the supervisor');
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' });
    assert.equal(await Promise.race([exited, wait(8000).then(() => 'still running')]), 0, 'the supervisor stopped too');
    await wait(1500); // longer than the supervisor's restart delay after a crash
    assert.equal(await up(), false, 'nothing answers any more');
    assert.equal(fs.readFileSync(path.join(app, 'starts'), 'utf8'), 'x', 'started once, never again');
  } finally {
    sup.kill('SIGKILL');
  }
});

const swiftTools = (() => {
  try {
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', 'swiftc'], { stdio: 'ignore', timeout: 20000, env: swiftEnv });
    return true;
  } catch {
    return false;
  }
})();

// The app's fallback when the server doesn't stop when asked: it signals the process on the port,
// but only after checking its command line and folder (macos/Tests/Quit runs the app's own code).
test('the app stops a server from its own Echo folder and never one from another folder', { skip: !swiftTools && 'no usable Swift build tools on this Mac', timeout: 120000 }, async () => {
  const src = (f) => path.join(ROOT, 'macos', 'Sources', f);
  const bin = path.join(dirs.root, 'quit-check');
  execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', src('Server.swift'), src('PointMath.swift'), path.join(ROOT, 'macos', 'Tests', 'Quit', 'main.swift'), '-o', bin], { env: swiftEnv });
  // Two folders, each with a server.js that answers on its port and doesn't know the shutdown request.
  const serve = (name, port, args = ['server.js']) => {
    const dir = path.join(dirs.root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'server.js'), `require('node:http').createServer((q, r) => r.end('{"ok":true}')).listen(${port}, '127.0.0.1');\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const child = spawn(process.execPath, args, { cwd: dir, stdio: 'ignore' });
    return { dir, port, child, gone: new Promise((r) => child.once('exit', (code, signal) => r(signal || code))) };
  };
  const ours = serve('echo-here', await freePort());
  const other = serve('someone-else', await freePort());
  // A folder with spaces in its name, and node given an option with a value of its own.
  const spaced = serve('my echo folder', await freePort(), ['--max-http-header-size', '16384', 'server.js']);
  const answers = async (port) => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {
      return false;
    }
  };
  try {
    await until(async () => (await answers(ours.port)) && (await answers(other.port)) && (await answers(spaced.port)), 10000, 'the servers');
    // Quit, with the other folder's server on "our" port: it isn't Echo's for this folder.
    execFileSync(bin, [String(other.port), ours.dir], { timeout: 30000 });
    assert.equal(await answers(other.port), true, "another folder's server on the port is left running");
    assert.equal(other.child.exitCode, null);
    // Quit, with this folder's own server on the port: stopped with SIGTERM (so tasks can pause).
    execFileSync(bin, [String(ours.port), ours.dir], { timeout: 30000 });
    assert.equal(await Promise.race([ours.gone, wait(3000).then(() => 'still running')]), 'SIGTERM', "this folder's server is stopped");
    assert.equal(other.child.exitCode, null, 'and still nothing else was touched');
    // The same from a folder with spaces in its path, started with an option that takes a value.
    execFileSync(bin, [String(spaced.port), spaced.dir], { timeout: 30000 });
    assert.equal(await Promise.race([spaced.gone, wait(3000).then(() => 'still running')]), 'SIGTERM', 'spaces in the path and a separate option value: still recognised as ours');
    assert.equal(other.child.exitCode, null);
  } finally {
    ours.child.kill('SIGKILL');
    other.child.kill('SIGKILL');
    spaced.child.kill('SIGKILL');
  }
});

// Quit while the launcher is still starting the server: nothing may start after the app has gone.
test('quitting while Echo is still starting leaves no supervisor behind', { skip: !swiftTools && 'no usable Swift build tools on this Mac', timeout: 120000 }, async () => {
  const src = (f) => path.join(ROOT, 'macos', 'Sources', f);
  const bin = path.join(dirs.root, 'quit-check-starting');
  execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', src('Server.swift'), src('PointMath.swift'), path.join(ROOT, 'macos', 'Tests', 'Quit', 'main.swift'), '-o', bin], { env: swiftEnv });
  // A stand-in Echo folder: its launcher starts a supervisor that notes it started and stays up.
  const folder = (name, launcher) => {
    const dir = path.join(dirs.root, name);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'supervisor.js'), `require('node:fs').writeFileSync('started', String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    fs.writeFileSync(path.join(dir, 'scripts', 'launcher.sh'), `#!/bin/bash\ncd "$1" || exit 1\n${launcher}\n`);
    return dir;
  };
  const start = `nohup ${JSON.stringify(process.execPath)} supervisor.js >/dev/null 2>&1 </dev/null &`;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const port = String(await freePort());
  // The launcher is still waiting (it would start the supervisor 2 s in) when Quit comes.
  const early = folder('echo starting', `sleep 2\n${start}\nsleep 20`);
  let pid = 0;
  try {
    execFileSync(bin, ['--starting', port, early], { timeout: 30000 });
    await wait(3000);
    assert.equal(fs.existsSync(path.join(early, 'started')), false, 'the launcher was stopped: no supervisor starts after the app has gone');
  } finally {
    if (fs.existsSync(path.join(early, 'started'))) process.kill(Number(fs.readFileSync(path.join(early, 'started'), 'utf8')), 'SIGKILL');
  }
  // The launcher had already started the supervisor (the server isn't answering yet).
  const late = folder('echo started', `${start}\nsleep 20`);
  try {
    execFileSync(bin, ['--starting', port, late], { timeout: 30000 });
    assert.ok(fs.existsSync(path.join(late, 'started')), 'the supervisor had started');
    pid = Number(fs.readFileSync(path.join(late, 'started'), 'utf8'));
    await until(() => !alive(pid), 3000, 'the supervisor the launcher had started is stopped');
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('the page keeps saying it wants the pill, and stops saying so when it does not', async () => {
  const posts = [];
  const feed = createCaptionFeed({ post: (m) => posts.push(m), throttleMs: 0, beatMs: 30 });
  feed.update({ speaking: true, echo: 'One moment.' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].beat, undefined, 'the first post is news');
  await wait(100);
  const beats = posts.filter((m) => m.beat);
  assert.ok(beats.length >= 2, `it refreshes while the pill is wanted (${beats.length} beats)`);
  assert.equal(beats[0].echo, 'One moment.', 'a beat carries the whole state');
  assert.equal(beats[0].active, true);
  feed.update({ speaking: false });
  assert.equal(posts.at(-1)?.active, false);
  const n = posts.length;
  await wait(100);
  assert.equal(posts.length, n, 'nothing going on: no more beats, so the app lets it go');
  assert.ok(CAPTION_BEAT_MS * 2 < 10000, 'two beats fit inside the app\'s 10 s expiry');
  assert.match(swift('PointMath.swift'), /static let expiry = 10\.0/, 'the app forgets the page after 10 s of silence');
});

test('the setting off, or a new state, restarts the heartbeat cleanly', async () => {
  const posts = [];
  let enabled = true;
  const feed = createCaptionFeed({ post: (m) => posts.push(m), enabled: () => enabled, throttleMs: 0, beatMs: 30 });
  feed.update({ driving: true, app: 'Notes' });
  await wait(80);
  assert.ok(posts.some((m) => m.beat && m.driving), 'a drive is refreshed too');
  enabled = false;
  feed.refresh();
  const n = posts.length;
  await wait(80);
  assert.equal(posts.length, n, 'switched off in Settings: no beats');
});

test('talk mode alone is marked quiet, so the app can let the pill leave', () => {
  const posts = [];
  const feed = createCaptionFeed({ post: (m) => posts.push(m), throttleMs: 0, beatMs: 100000 });
  feed.update({ windowLabel: 'Talk mode · just talk' });
  assert.equal(posts.at(-1)?.active, true);
  assert.equal(posts.at(-1)?.quiet, true, 'only the open conversation window holds it');
  feed.update({ hearing: true });
  assert.equal(posts.at(-1)?.quiet, false, 'you are talking: not quiet');
  feed.update({ hearing: false, windowLabel: '' });
  assert.equal(posts.at(-1)?.active, false);
  assert.equal(posts.at(-1)?.quiet, false);
});

test('the app owns the pill: reset, close and Stop work with or without the page', () => {
  const bar = swift('Caption.swift');
  const main = swift('main.swift');
  const driver = swift('Driver.swift');
  assert.match(bar, /func reset\(keepDraft: Bool = false\)/, 'one reset that hides it and clears every state');
  for (const where of ['func showStatusPage(', 'didCommit navigation', 'func webViewWebContentProcessDidTerminate(', 'func applicationWillTerminate(']) {
    const at = main.indexOf(where);
    assert.ok(at > 0, where);
    assert.match(main.slice(at, at + 300), /CaptionBar\.shared\.reset\(\)/, `${where} resets the pill`);
  }
  assert.match(main, /BodyLink\.shared\.onDrop = [\s\S]{0,200}CaptionBar\.shared\.reset\(keepDraft: true\)/, "the app's line to the server dropping resets it, but never a reply you are typing");
  assert.match(swift('ReplyField.swift'), /func reset\(keepDraft: Bool = false\) \{\s+offered = false\s+if keepDraft, expanded, !\(field\?\.stringValue \?\? ""\)\.isEmpty \{ return \}/, 'an open field with words in it is left alone');
  // A try that never connected has nothing to drop: no reset on every retry while the server is down.
  assert.match(swift('BodyLink.swift'), /let wasUp = up\s+stop\(\)\s+if wasUp \{ onDrop\?\(\) \}/, 'onDrop only when the line was up');
  assert.match(bar, /life\.heard\([\s\S]{0,200}confirming: confirming,/, 'a question that needs an OK reaches the pill\'s life (it reopens a closed pill)');
  const end = driver.slice(driver.indexOf('func end(abort: Bool = false, idle: Bool = false)'), driver.indexOf('private func showDriving()'));
  assert.match(end, /CaptionBar\.shared\.driveEnded\(\)/, "a run ending clears the pill's driving state");
  // The app's own driver holds the pill and Stop while it drives, page or no page.
  assert.match(driver, /driving = true\s+CaptionBar\.shared\.driveBegan\(\)/, 'the driver says when it starts');
  assert.match(end, /if idle \{ CaptionBar\.shared\.driveIdle\(\) \}/, 'and when it goes quiet');
  // Stop: the driver stops and tells the server over HTTP before anything is asked of the page.
  const stop = driver.slice(driver.indexOf('CaptionBar.shared.onStop = '), driver.indexOf('CaptionBar.shared.onConfirm = '));
  assert.match(stop, /driver\.abort\("stopped from the caption bar"\)[\s\S]*captionStop/, 'native first, then the page if it is there');
  assert.match(driver, /func wireCaption\(\)/);
  assert.match(main, /wireCaption\(\)/, 'wired at launch, not on the first message from the page');
  assert.match(bar, /func close\(\) \{\s+life\.dismiss\(\)[\s\S]{0,200}hide\(\)/, 'the close button dismisses and hides it in the app');
  assert.match(bar, /@objc private func closeClicked\(\) \{ close\(\) \}/);
  assert.match(bar, /asyncAfter\(deadline: \.now\(\) \+ 0\.5, execute: work\)[\s\S]{0,200}func finishHide/, 'the fade-out finishes on a timer, frame clock or not');
  assert.match(pageSource(), /captionClosed: \(\) => caption\.update\(\{ asks: false \}\)/, 'and the page is told');
});

test('overlays sit below menus and alerts, and follow screen changes', () => {
  for (const f of ['Caption.swift', 'ReplyField.swift', 'Overlays.swift', 'Pointer.swift']) {
    assert.doesNotMatch(swift(f), /\.level = [^\n]*screenSaver/, `${f}: nothing at the screen saver level`);
  }
  assert.match(swift('Caption.swift'), /p\.level = \.statusBar/);
  assert.match(swift('ReplyField.swift'), /p\.level = \.statusBar/);
  // Only the pointer goes above menus, and only while it points into an open one.
  assert.match(swift('Pointer.swift'), /let level = inMenu \? NSWindow\.Level\(rawValue: NSWindow\.Level\.popUpMenu\.rawValue \+ 1\) : Self\.restingLevel/);
  assert.match(swift('Pointer.swift'), /restingLevel = NSWindow\.Level\(rawValue: NSWindow\.Level\.statusBar\.rawValue \+ 1\)/);
  assert.match(swift('main.swift'), /didChangeScreenParametersNotification/);
  assert.match(swift('Config.swift'), /func rebuild\(\)/, 'the frame clock is rebuilt on screen changes and wake');
});

test('Quit stops the server by default; staying in the background is an explicit choice', () => {
  const config = swift('Config.swift');
  assert.match(config, /static var keepWorkingAfterQuit: Bool \{\s+get \{ d\.object\(forKey: "KeepWorkingAfterQuit"\) as\? Bool \?\? false \}/, 'off by default');
  const main = swift('main.swift');
  // Chosen in Settings: the page sets it through the app (setAppPref), and reads it back (appPrefs).
  assert.match(main, /if let v = body\["keepWorkingAfterQuit"\] as\? Bool \{ Prefs\.keepWorkingAfterQuit = v \}/);
  assert.match(main, /"keepWorkingAfterQuit": Prefs\.keepWorkingAfterQuit,/);
  assert.doesNotMatch(main + swift('Server.swift'), /startedByLauncher/, 'no longer only the copy the launcher started');
  const server = swift('Server.swift');
  assert.match(server, /X-Echo-Token/, 'the app presents its token');
  assert.match(server, /ProcessMath\.target\(holder: holder, parent: parent, echoDir: dir\)/, 'a process is signalled only after its command line and folder are checked');
  assert.doesNotMatch(server, /SIGKILL/, 'and only ever asked to stop (so tasks can pause), never killed');
  // A server that refuses the app (403) is running: Quit asks instead of assuming nothing is.
  assert.match(server, /if let token \{ req\.setValue\(token, forHTTPHeaderField: "X-Echo-Token"\) \}/, 'asked even without a token, so a running server is told apart from none');
  assert.match(main, /case \.refused:[\s\S]{0,200}askAboutRefusal\(\)/, 'a refusal is put to the user');
  assert.match(main, /server\.stopStarting \{/, 'Quit stops a launcher that is still starting the server first');
});
