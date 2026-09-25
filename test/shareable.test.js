// Making Echo shareable: setup, beginner and safe mode, Reset Echo, and the privacy check
// that keeps personal data out of packages. All in throwaway folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery } from './helpers.js';

const dirs = sandbox('shareable');
const home = path.join(dirs.root, 'home');
fs.mkdirSync(home, { recursive: true });
const { expandHome, projectsDirProblem, saveOnboarding, onboardingState, wipePersonalData, echoSessionIds } = await import('../lib/onboarding.js');
const { getSettings, saveSettings, markFirstRun, needsOnboarding } = await import('../lib/settings.js');
const { classifyCommand, Grants, riskReason } = await import('../lib/safety.js');
const { TaskManager } = await import('../lib/tasks.js');
const { SelfImprove } = await import('../lib/selfimprove.js');
const { Dispatcher, createProjectFolder, projectFolderName, copySourceFiles, PROJECT_GUIDES } = await import('../lib/dispatcher.js');
const { QuickActions } = await import('../lib/quick.js');
const { friendlyError } = await import('../lib/text.js');
const { scanFolder, formatFinding } = await import('../lib/privacy.js');
const { productFiles, INCLUDE } = await import('../scripts/package.js');
const { APP_DIR } = await import('../lib/config.js');

const tasks = () => new TaskManager({ queryFn: fakeQuery(() => []).queryFn });

test('a fresh install starts with setup; an install from before setup existed does not', () => {
  assert.equal(needsOnboarding(), false, 'no settings file yet: nothing decided');
  assert.equal(markFirstRun(), true);
  assert.equal(needsOnboarding(), true);
  assert.equal(markFirstRun(), false, 'only the first time');
  // Older installs have settings without the flag and never see the wizard.
  saveSettings({ onboarded: undefined });
  assert.equal(needsOnboarding(), false);
  saveSettings({ onboarded: false });
});

test('project folders: ~ is expanded, and only sensible places inside home are allowed', () => {
  assert.equal(expandHome('~/Echo Projects', '/Users/sam'), '/Users/sam/Echo Projects');
  assert.equal(expandHome('Stuff', '/Users/sam'), '/Users/sam/Stuff');
  assert.equal(projectsDirProblem('/Users/sam/Echo Projects', '/Users/sam'), null);
  for (const bad of ['/Users/sam', '/etc/stuff', '/Users/sam/Library/Echo', APP_DIR]) assert.ok(projectsDirProblem(bad, '/Users/sam'), bad);
});

test('setup saves each answer; not a developer turns on beginner and safe mode; finish ends setup', () => {
  const self = new SelfImprove(tasks(), { appDir: dirs.root });
  let r = saveOnboarding({ userName: '  Sam  ', interests: ['errands', 'documents', 'bogus'] }, { selfImprove: self, home });
  assert.equal(r.settings.userName, 'Sam');
  assert.deepEqual(r.settings.interests, ['errands', 'documents']);
  r = saveOnboarding({ developer: false, projectsDir: '~/Echo Projects' }, { selfImprove: self, home });
  assert.equal(r.settings.beginnerMode, true);
  assert.equal(r.settings.safeMode, true);
  assert.equal(r.settings.projectsDir, path.join(home, 'Echo Projects'));
  assert.ok(fs.statSync(path.join(home, 'Echo Projects')).isDirectory(), 'the folder is created');
  assert.throws(() => saveOnboarding({ projectsDir: '/etc/nope' }, { selfImprove: self, home }), /inside your home folder/);
  saveOnboarding({ pin: '2580', handsFree: true }, { selfImprove: self, home });
  assert.ok(self.hasPin());
  assert.throws(() => saveOnboarding({ pin: '1111' }, { selfImprove: self, home }), /already set/);
  assert.equal(getSettings().handsFree, true);
  assert.equal(onboardingState(self).needed, true);
  saveOnboarding({ finish: true }, { selfImprove: self, home });
  assert.equal(onboardingState(self).needed, false);
  assert.equal(onboardingState(self).hasPin, true);
  const dev = saveOnboarding({ developer: true }, { selfImprove: self, home }).settings;
  assert.equal(dev.beginnerMode, false);
  assert.equal(dev.safeMode, false);
});

test('safe mode gates deletes, installs, app control and email; normal mode does not', () => {
  for (const cmd of ['rm notes.txt', 'rm -f old.xlsx', 'git rm draft.md', 'find . -name x -delete', 'brew install ffmpeg', 'npm install -g serve', 'pip3 install openpyxl', `osascript -e 'tell application "Messages" to send "hi"'`, 'mail -s hi a@example.com < body.txt']) {
    assert.equal(classifyCommand(cmd, { strict: true }).level, 'risky', cmd);
  }
  for (const cmd of ['rm notes.txt', 'brew install ffmpeg', 'npm install -g serve']) assert.equal(classifyCommand(cmd).level, 'safe', cmd);
  // Local work a new project needs still runs without asking.
  for (const cmd of ['npm install exceljs', 'npm init -y', 'node build.js', 'open "Monthly Budget.xlsx"', 'open http://localhost:8123', 'nohup python3 -m http.server 8123 --bind 127.0.0.1 > .server.log 2>&1 &', 'npm run confirm-rates']) {
    assert.equal(classifyCommand(cmd, { strict: true }).level, 'safe', cmd);
  }
  // Always-gated actions stay gated either way.
  assert.equal(classifyCommand('git push', { strict: false }).level, 'risky');
  assert.ok(riskReason('Bash', { command: 'rm a.txt' }, { strict: true }));
});

test('in safe mode, "stop asking" grants only ever cover one task', () => {
  let strict = true;
  const g = new Grants({ strict: () => strict });
  g.grant({ taskId: 1, scope: 'session', kind: 'network_read' });
  assert.equal(g.describe(1).session.networkRead, false);
  assert.equal(g.describe(1).task?.networkRead, true);
  assert.throws(() => g.grant({ scope: 'session', kind: 'network_read' }), /one task/);
  strict = false;
  g.grant({ scope: 'session', kind: 'network_read' });
  assert.equal(g.describe(2).session.networkRead, true);
});

test('safe mode: self-improve stays locked until a PIN is set', () => {
  fs.rmSync(path.join(dirs.data, 'self', 'pin.json'), { force: true });
  saveSettings({ safeMode: true });
  const self = new SelfImprove(tasks(), { appDir: dirs.root });
  assert.throws(() => self.requestUnlock('change the colors'), /locked until a PIN is set/);
  self.setPin('2580');
  assert.ok(self.requestUnlock('change the colors').code);
  self.cancelRequest();
  saveSettings({ safeMode: false });
});

test('safe mode: messages always wait on the Send / Cancel card', async () => {
  const sends = [];
  const q = new QuickActions({ exec: async (file, args, input) => (input?.includes("Application('Contacts')") ? JSON.stringify([{ name: 'Sam', nickname: '', phones: [{ value: '5550101234', label: 'mobile' }], emails: [] }]) : (sends.push(args), '')) });
  const found = await q.findContact('Sam');
  q.setAlias('Sam', found.matches[0].handles[0].id);
  const d = new Dispatcher(tasks(), null, q);
  const tool = /** @type {any} */ (d.quickTools().find((t) => t.name === 'send_imessage'));
  saveSettings({ safeMode: true });
  await tool.handler({ to: 'Sam', text: 'Running late', direct: true }, {});
  assert.equal(sends.length, 0, 'not sent without the card');
  assert.equal(q.pendingList().length, 1);
  saveSettings({ safeMode: false });
  await tool.handler({ to: 'Sam', text: 'Running late', direct: true }, {});
  assert.equal(sends.length, 1, 'a favorite with exact words goes straight out in normal mode');
});

test('beginner mode: plain language, suggestions, and new projects in their own folder', () => {
  saveSettings({ beginnerMode: true, interests: ['documents', 'apps'] });
  const p = new Dispatcher(tasks()).systemPrompt();
  assert.match(p, /Beginner mode: the user isn't a programmer/);
  assert.match(p, /Spreadsheets, Excel and documents; Building apps and websites/);
  assert.match(p, /start_project/);
  assert.match(p, /find_file/);
  saveSettings({ beginnerMode: false });
  assert.doesNotMatch(new Dispatcher(tasks()).systemPrompt(), /Beginner mode/);
  assert.match(PROJECT_GUIDES.spreadsheet, /\.xlsx/);
  assert.match(PROJECT_GUIDES.document, /\.docx/);
  assert.match(PROJECT_GUIDES.website, /Do not deploy/);
});

test('new project folders are readable, safe and never reuse an existing folder', () => {
  const root = path.join(dirs.root, 'Echo Projects');
  assert.equal(projectFolderName('monthly budget!'), 'Monthly budget!');
  assert.equal(projectFolderName('../../etc/passwd'), 'Etc passwd');
  assert.equal(projectFolderName('  '), 'New project');
  const a = createProjectFolder('Monthly budget', root);
  const b = createProjectFolder('Monthly budget', root);
  assert.equal(a.name, 'Monthly budget');
  assert.equal(b.name, 'Monthly budget 2');
  assert.ok(fs.statSync(b.dir).isDirectory());
});

test("the user's own files are copied into a project, never moved, and only from their home", () => {
  const src = path.join(home, 'Downloads', 'sales.xlsx');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, 'xlsx');
  const dir = createProjectFolder('Sales', path.join(dirs.root, 'Echo Projects')).dir;
  assert.deepEqual(copySourceFiles([src, src], dir, home), ['sales.xlsx', 'sales 2.xlsx']);
  assert.ok(fs.existsSync(src), 'the original stays');
  assert.throws(() => copySourceFiles(['/etc/hosts'], dir, home), /can't use/);
  assert.throws(() => copySourceFiles([path.join(home, '.env')], dir, home), /can't use/);
  assert.throws(() => copySourceFiles([path.join(home, 'missing.xlsx')], dir, home), /no file/);
});

test('start_project makes a folder and starts a worker with the file-making guide', async () => {
  saveSettings({ projectsDir: '' });
  const tm = tasks();
  const d = new Dispatcher(tm);
  const tool = /** @type {any} */ (d.toolList().find((t) => t.name === 'start_project'));
  const out = await tool.handler({ name: 'Monthly budget', kind: 'spreadsheet', instruction: 'Rent, food, fun.' }, {});
  const r = JSON.parse(out.content[0].text);
  const t = tm.get(r.taskId);
  assert.equal(t.kind, 'code');
  assert.match(t.instruction, /exceljs/);
  assert.match(t.instruction, /Rent, food, fun/);
  assert.ok(fs.existsSync(t.cwd));
  await tm.stop(t.id).catch(() => {});
});

test('permission tests and file search on the Mac (mocked)', async () => {
  const calls = [];
  const q = new QuickActions({
    exec: async (file, args, input) => {
      calls.push({ file, args, input });
      if (input?.includes('Messages')) throw Object.assign(new Error('x'), { stderr: 'Not authorized to send Apple events to Messages. (-1743)' });
      if (file === 'mdfind') return [path.join(home, 'Downloads', 'sales.xlsx'), path.join(home, 'Library', 'sales.xlsx'), path.join(home, '.hidden', 'sales.xlsx'), '/etc/sales.xlsx'].join('\n');
      return '42';
    },
  });
  assert.deepEqual(await q.testPermission('contacts'), { ok: true, kind: 'contacts', message: 'Contacts works. I can see 42 contacts.' });
  const denied = await q.testPermission('messages');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'permission');
  assert.match(denied.message, /Privacy and Security, then Automation/);
  await assert.rejects(q.testPermission(/** @type {any} */ ('camera')), /Unknown/);
  await q.openPrivacySettings('microphone');
  assert.deepEqual(calls.at(-1).args, ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
  const found = await q.findFiles('sales', { home });
  assert.deepEqual(found.files.map((f) => f.path), [path.join(home, 'Downloads', 'sales.xlsx')]);
});

test('sign-in problems get plain words', () => {
  assert.match(friendlyError('Claude Code native binary failed to launch'), /signed in/);
  assert.match(friendlyError('Not logged in · Please run /login'), /own Claude subscription/);
  assert.equal(friendlyError('something else'), 'something else');
});

test('Reset Echo wipes personal data and only the Claude transcripts Echo started', () => {
  const claudeDir = path.join(dirs.root, 'claude');
  const convo = path.join(claudeDir, 'projects', '-Users-sam-Echo-Projects');
  fs.mkdirSync(convo, { recursive: true });
  fs.writeFileSync(path.join(dirs.data, 'state.json'), JSON.stringify({ sessionId: 'aaaaaaaa-1111', costSeen: { 'bbbbbbbb-2222': 1 } }));
  fs.writeFileSync(path.join(dirs.data, 'tasks.json'), JSON.stringify([{ id: 1, sessionId: 'cccccccc-3333' }]));
  fs.writeFileSync(path.join(dirs.data, 'memory.md'), '- likes tea\n');
  fs.mkdirSync(path.join(dirs.data, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(dirs.data, 'conversations', '2026-09-25.md'), 'hi');
  fs.writeFileSync(path.join(dirs.logs, 'task-1.log'), 'log');
  fs.writeFileSync(path.join(dirs.logs, 'echo-launcher.pid'), '123');
  const attachments = path.join(dirs.research, 'attachments');
  fs.mkdirSync(attachments, { recursive: true });
  fs.writeFileSync(path.join(attachments, 'a.png'), 'png');
  fs.writeFileSync(path.join(dirs.research, 'keep.md'), 'research');
  for (const id of ['aaaaaaaa-1111', 'cccccccc-3333', 'dddddddd-4444']) fs.writeFileSync(path.join(convo, `${id}.jsonl`), '{}');
  assert.deepEqual(echoSessionIds(dirs.data).sort(), ['aaaaaaaa-1111', 'bbbbbbbb-2222', 'cccccccc-3333']);

  const r = wipePersonalData({ dataDir: dirs.data, logDir: dirs.logs, attachmentsDir: attachments, claudeDir });
  assert.equal(r.transcripts, 2);
  assert.deepEqual(fs.readdirSync(dirs.data), []);
  assert.deepEqual(fs.readdirSync(dirs.logs), ['echo-launcher.pid'], 'the launcher can still stop Echo');
  assert.deepEqual(fs.readdirSync(attachments), []);
  assert.ok(fs.existsSync(path.join(dirs.research, 'keep.md')), "the user's own files stay");
  assert.deepEqual(fs.readdirSync(convo), ['dddddddd-4444.jsonl'], "the user's own Claude Code chats stay");
  assert.throws(() => wipePersonalData({ dataDir: path.dirname(APP_DIR), logDir: dirs.logs }), /Refusing/);
  // Next start is a first run again.
  assert.equal(markFirstRun(), true);
});

test('the privacy check finds personal files, secrets, home paths, phones, emails and personal words', () => {
  const dir = path.join(dirs.root, 'pkg');
  const put = (f, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  };
  put('lib/ok.js', "// Call +1 (555) 010-1234 or mail sam@example.com; see /Users/me/x and /Users/.../y. Motifs evolve occasionally.\n");
  put('README.md', 'Built by Jordan Quill.\n');
  // Built at run time, so this file itself passes the check when it's packaged.
  const [users, at] = ['/Us' + 'ers/', '@'];
  put('lib/secret.js', `const key = '${'sk-' + 'ant-api03-abcdefghijklmnopqrstuv'}';\n`);
  put('lib/path.js', `const dir = '${users}jquill/Projects';\n`);
  put('lib/contact.js', `// text 201-555-0199 or ${['973', '214', '8890'].join(' ')}, or jquill${at}gmail.com\n`);
  put('data/memory.md', '- private\n');
  put('.env', 'X=1\n');
  put('.env.example', '# X=\n');
  put('lib/Quillsoft.js', '\n');
  const findings = scanFolder(dir, { terms: ['Jordan Quill', { term: 'Quillsoft', exact: true }] });
  const kinds = findings.map((f) => `${f.file}|${f.kind}`);
  for (const want of ['README.md|personal word', 'lib/secret.js|secret', 'lib/path.js|home folder path', 'lib/contact.js|phone number', 'lib/contact.js|email address', 'data/|personal folder', 'data/memory.md|personal file', '.env|personal file', 'lib/Quillsoft.js|personal word in a file name']) {
    assert.ok(kinds.includes(want), `${want} in ${kinds.join(', ')}`);
  }
  assert.ok(!findings.some((f) => f.file === 'lib/ok.js' || f.file === '.env.example'), 'placeholders, 555 numbers and example.com are fine');
  assert.equal(findings.filter((f) => f.file === 'lib/contact.js' && f.kind === 'phone number').length, 1, 'only the real-looking number');
  assert.match(formatFinding({ file: 'a', line: 1, kind: 'personal word', detail: 'Quill' }), /"Q••••"/);
});

test('the package is an allow-list of product files, and the product itself is clean', () => {
  const files = productFiles();
  for (const f of ['server.js', 'supervisor.js', 'lib/config.js', 'public/index.html', 'package.json', 'install.command', 'scripts/install.sh']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => /^(data|logs|models|node_modules|dist)\/|^\.env$|HANDOFF\.md$|\.log$/.test(f)), files.filter((f) => /^(data|logs)/.test(f)).join());
  assert.ok(INCLUDE.includes('GETTING_STARTED.md'));
  // Copy the product and scan it for secrets, home paths, phone numbers and emails.
  const out = path.join(dirs.root, 'product');
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(path.join(APP_DIR, f), path.join(out, f));
  }
  const findings = scanFolder(out);
  assert.deepEqual(findings.map((f) => formatFinding(f)), []);
});
