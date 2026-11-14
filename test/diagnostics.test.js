// The report for whoever helps you (lib/diagnostics.js): versions, flags, last week's numbers and
// recent errors, with secrets and home folders blacked out and nothing anyone said in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandbox, serverSource } from './helpers.js';

const dirs = sandbox('diagnostics');
const { buildReport, reportFile, safeLine } = await import('../lib/diagnostics.js');

test('errors only, made safe; nothing anyone said', () => {
  const home = os.homedir();
  // Put together at run time, so the privacy check doesn't flag this file.
  const key = ['sk', 'ant', 'api03', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'].join('-');
  fs.writeFileSync(path.join(dirs.logs, 'echo.log'), [
    '[voice] Kokoro ready',
    `[api] Error: ENOENT: no such file or directory, open '${home}/Projects/secret-plan/notes.md'`,
    `[dispatcher] error_during_execution with key ${key}`,
    '[stt] heard: "text my sister I failed the exam"',
    '[stt] blank_final: final "call the landlord" failed, used live',
    '[wake] check timed out on "hey echo order the cake"',
    '[tasks] worker failed: could not open "Divorce papers.pdf"',
    '[dispatcher] fresh session (tokens; was 60534 tokens, 10 turns)',
  ].join('\n'));
  const r = buildReport({ dataDir: dirs.data, logDir: dirs.logs });
  assert.equal(r.kind, 'echo-report');
  assert.equal(r.recentErrors.length, 3);
  assert.match(r.recentErrors[2], /could not open "…"/, 'quoted words left out');
  assert.match(r.recentErrors[0], /open '~\/Projects\/secret-plan\/notes\.md'/, 'the home folder as ~');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(r), /AbCdEfGh/, 'secrets blacked out');
  assert.doesNotMatch(JSON.stringify(r), /sister|exam|landlord|cake|Divorce/, 'nothing anyone said, typed or named');
  assert.ok(r.flags.some((f) => f.name === 'policy'));
  assert.ok(r.lastWeek && Array.isArray(r.lastWeek.metrics));
  assert.equal(safeLine('/Users/someone/x'), '/Users/…/x');
});

test('saved to Downloads with the date in its name; shown first, never sent', () => {
  const f = reportFile(Date.parse('2026-10-02T21:30:00Z'), os.homedir());
  assert.match(f, /Echo report 2026-10-02 21\.30\.json$/);
  assert.match(serverSource(), /'POST \/api\/diagnostics\/save': async[\s\S]{0,600}JSON\.stringify\(shownReport, null, 2\)[\s\S]{0,200}execFile\('open', \['-R', file\]/, 'what was shown is what is saved');
  assert.match(serverSource(), /shownReport\.made !== made\) return sendJson\(res, \{ error: 'That report is out of date/);
  const ui = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'ui', 'report.js'), 'utf8');
  assert.match(ui, /This is everything in it\. Nothing is sent anywhere/);
  assert.match(ui, /postJson\('\/api\/diagnostics\/save', \{ made: report\.made \}\)/);
});
