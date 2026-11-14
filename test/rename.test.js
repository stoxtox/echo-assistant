// The VoiceOps -> Echo rename: old settings names still work, and moving the folder keeps tasks,
// worktrees, git links and Claude sessions working (lib/legacy.js, lib/rename.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.js';

const dirs = sandbox('rename');
const { adoptLegacyEnv, withLegacyEnv, appDirAliases, migrateLegacyLog } = await import('../lib/legacy.js');
const { planRename, runRename, blocker, claudeKey, rewritePaths } = await import('../lib/rename.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('old VOICEOPS_* settings fill in their ECHO_* names; an ECHO_* value wins', () => {
  const env = { VOICEOPS_PORT: '4799', VOICEOPS_DATA_DIR: '/old', ECHO_DATA_DIR: '/new', PATH: '/bin' };
  assert.deepEqual(adoptLegacyEnv(env), ['ECHO_PORT']);
  assert.equal(env.ECHO_PORT, '4799');
  assert.equal(env.ECHO_DATA_DIR, '/new');
  assert.equal(env.VOICEOPS_PORT, '4799', 'old names stay for older copies');
  // A child that may be an older Echo gets the old names too, with the current values.
  const child = withLegacyEnv({ ECHO_SUPERVISED: '1', ECHO_PORT: '4800', VOICEOPS_PORT: '4799' });
  assert.equal(child.VOICEOPS_SUPERVISED, '1');
  assert.equal(child.VOICEOPS_PORT, '4800');
});

test('logs/voiceops.log becomes logs/echo.log once', () => {
  const logs = path.join(dirs.root, 'logs-mig');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'voiceops.log'), 'old lines\n');
  assert.equal(migrateLegacyLog(logs), true);
  assert.equal(fs.readFileSync(path.join(logs, 'echo.log'), 'utf8'), 'old lines\n');
  fs.writeFileSync(path.join(logs, 'voiceops.log'), 'other\n');
  assert.equal(migrateLegacyLog(logs), false, 'an existing echo.log is never overwritten');
});

test('only saved folder paths are rewritten, not text that mentions them', () => {
  const data = [{ cwd: '/p/VoiceOps', text: 'cd /p/VoiceOps', self: { worktree: '/p/.voiceops-worktrees/a' } }, { projectPath: '/p/VoiceOpsOther' }];
  const swap = (p) => (p === '/p/VoiceOps' ? '/p/Echo' : p.startsWith('/p/.voiceops-worktrees/') ? p.replace('.voiceops-worktrees', '.echo-worktrees') : null);
  assert.equal(rewritePaths(data, swap), 2);
  assert.equal(data[0].cwd, '/p/Echo');
  assert.equal(data[0].text, 'cd /p/VoiceOps');
  assert.equal(data[0].self.worktree, '/p/.echo-worktrees/a');
  assert.equal(data[1].projectPath, '/p/VoiceOpsOther');
});

test('renaming the folder keeps data, worktrees, git and Claude sessions working', () => {
  const parent = path.join(fs.realpathSync(dirs.root), 'ProjectX');
  const oldApp = path.join(parent, 'VoiceOps');
  const oldWts = path.join(parent, '.voiceops-worktrees');
  const home = path.join(dirs.root, 'home');
  fs.mkdirSync(path.join(oldApp, 'data', 'self'), { recursive: true });
  fs.mkdirSync(path.join(oldApp, 'logs'));
  fs.writeFileSync(path.join(oldApp, '.gitignore'), 'data/\nlogs/\n');
  fs.writeFileSync(path.join(oldApp, 'server.js'), '// echo\n');
  git(oldApp, 'init', '-q', '-b', 'main');
  git(oldApp, 'add', '-A');
  git(oldApp, 'commit', '-q', '-m', 'base');
  const wt = path.join(oldWts, 'self-1');
  fs.mkdirSync(oldWts);
  git(oldApp, 'worktree', 'add', '-q', '-b', 'self/1', wt);
  fs.writeFileSync(path.join(wt, 'new.js'), 'x\n');

  // projectPath as saved through a link (on a Mac the temp folder /var is a link to /private/var).
  const viaLink = path.join(dirs.root, 'ProjectX', 'VoiceOps');
  const tasks = [{ id: 1, cwd: wt, projectPath: viaLink, self: { worktree: wt }, log: [{ text: `cd ${oldApp}` }] }];
  fs.writeFileSync(path.join(oldApp, 'data', 'tasks.json'), JSON.stringify(tasks));
  for (const f of ['settings.json', 'contact-aliases.json']) fs.writeFileSync(path.join(oldApp, 'data', f), '{"kept":true}');
  fs.writeFileSync(path.join(oldApp, 'data', 'memory.md'), '- remembered\n');
  fs.writeFileSync(path.join(oldApp, 'logs', 'voiceops.log'), 'log\n');
  fs.mkdirSync(path.join(home, '.claude', 'projects', claudeKey(oldApp), 'memory'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', claudeKey(oldApp), 'memory', 'MEMORY.md'), 'm\n');
  fs.mkdirSync(path.join(home, '.claude', 'projects', claudeKey(wt)));
  fs.writeFileSync(path.join(home, '.claude', 'projects', claudeKey(wt), 'session.jsonl'), '{}\n');

  const plan = planRename({ appDir: oldApp, home });
  assert.equal(blocker(plan), '');
  const dry = runRename(plan, { dryRun: true, macPrefs: false });
  assert.ok(dry.length >= 4, dry.join('\n'));
  assert.ok(fs.lstatSync(oldApp).isDirectory() && !fs.lstatSync(oldApp).isSymbolicLink(), 'a dry run changes nothing');

  runRename(plan, { macPrefs: false });
  const newApp = path.join(parent, 'Echo');
  const newWt = path.join(parent, '.echo-worktrees', 'self-1');
  assert.ok(fs.lstatSync(newApp).isDirectory());
  assert.equal(fs.readlinkSync(oldApp), 'Echo', 'old folder name links to the new one');
  assert.equal(fs.readlinkSync(oldWts), '.echo-worktrees');
  assert.deepEqual(appDirAliases(newApp).sort(), [newApp, oldApp].sort(), 'the old name still counts as Echo itself');

  // Data kept, saved folder paths updated, history text untouched, a backup made.
  const saved = JSON.parse(fs.readFileSync(path.join(newApp, 'data', 'tasks.json'), 'utf8'));
  assert.equal(saved[0].cwd, newWt);
  assert.equal(saved[0].projectPath, newApp);
  assert.equal(saved[0].self.worktree, newWt);
  assert.equal(saved[0].log[0].text, `cd ${oldApp}`);
  assert.ok(fs.existsSync(path.join(newApp, 'data', 'tasks.json.before-rename')));
  assert.equal(fs.readFileSync(path.join(newApp, 'data', 'contact-aliases.json'), 'utf8'), '{"kept":true}');
  assert.equal(fs.readFileSync(path.join(newApp, 'data', 'memory.md'), 'utf8'), '- remembered\n');
  assert.equal(fs.readFileSync(path.join(newApp, 'logs', 'echo.log'), 'utf8'), 'log\n');

  // git: the worktree and the checkout know each other by their new paths.
  assert.equal(fs.readFileSync(path.join(newWt, '.git'), 'utf8').trim(), `gitdir: ${path.join(newApp, '.git', 'worktrees', 'self-1')}`);
  assert.match(git(newApp, 'worktree', 'list'), new RegExp(newWt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(git(newWt, 'status', '--porcelain'), /new\.js/);
  assert.equal(git(newWt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'self/1');

  // Claude's sessions and memory moved to the new folder names, with links left behind.
  const cp = path.join(home, '.claude', 'projects');
  assert.equal(fs.readFileSync(path.join(cp, claudeKey(newApp), 'memory', 'MEMORY.md'), 'utf8'), 'm\n');
  assert.equal(fs.readFileSync(path.join(cp, claudeKey(oldApp), 'memory', 'MEMORY.md'), 'utf8'), 'm\n');
  assert.ok(fs.existsSync(path.join(cp, claudeKey(newWt), 'session.jsonl')));

  // Running it again does nothing harmful.
  const again = planRename({ appDir: newApp, home });
  assert.equal(blocker(again), '');
  assert.doesNotThrow(() => runRename(again, { macPrefs: false }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(newApp, 'data', 'tasks.json'), 'utf8'))[0].cwd, newWt);
});

test('a rename never overwrites an existing Echo folder', () => {
  const parent = path.join(dirs.root, 'Both');
  fs.mkdirSync(path.join(parent, 'VoiceOps'), { recursive: true });
  fs.mkdirSync(path.join(parent, 'Echo'));
  const plan = planRename({ appDir: path.join(parent, 'VoiceOps'), home: dirs.root });
  assert.match(blocker(plan), /both/);
  assert.throws(() => runRename(plan, { macPrefs: false }), /both/);
});
