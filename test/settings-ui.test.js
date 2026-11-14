// The settings modal (public/settings.js, public/index.html): every setting has a home, the
// search finds them, and the header keeps only the essentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const app = read('app.js');
const shell = read('settings.js');

test('the old side drawer is gone; settings is a dialog with five sections and no search', () => {
  assert.doesNotMatch(html, /class="drawer"/);
  assert.match(html, /id="settings" class="settings-veil" hidden/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="settingsTitle"/);
  assert.doesNotMatch(html, /settingsSearch/, '30 rows in five short sections: nothing to search');
  assert.doesNotMatch(shell, /search/i);
  const sections = [...html.matchAll(/<section class="set-section" id="sec-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['listening', 'voice', 'companion', 'mac', 'you']);
  for (const id of sections) {
    assert.match(html, new RegExp(`role="tab" class="set-tab" id="tab-${id}" data-section="${id}" aria-controls="sec-${id}"`), id);
  }
  // Links and the Mac app's menu that name an old section still land somewhere.
  assert.match(app, /const OLD_SECTIONS = \{ general: 'you', account: 'you', updates: 'you', privacy: 'you', computer: 'mac', music: 'voice' \}/);
});

test('every setting that stays has exactly one control, with the id it always had', () => {
  const ids = ['setHandsFree', 'setWake', 'setPause', 'setBargeIn', 'setSecondListen',
    'speakOut', 'setVoice', 'previewVoice', 'setSpeed', 'setSounds',
    'setLook', 'setLively', 'setPointer', 'setStepCaptions',
    'setComputer', 'setSafe', 'setBackground', 'chromeCode', 'chromeCopy', 'setHotKey', 'setOpenAtLogin', 'setKeepWorking',
    'setUser', 'setName', 'personalities', 'claudeSignIn', 'setDailyBudget', 'usageToday', 'setKeepRecordings', 'setKeepTranscript',
    'permsOpen', 'updCheck', 'updRollback', 'resetEcho'];
  for (const id of ids) assert.equal(html.split(`id="${id}"`).length, 2, `exactly one #${id}`);
});

test('each setting row says what it does in one line', () => {
  const rows = html.match(/<(label|div) class="set-row[^"]*"[\s\S]*?<\/\1>/g) || [];
  assert.equal(rows.length, 30);
  for (const row of rows) {
    assert.match(row, /class="set-label"/, row.slice(0, 120));
    assert.equal(row.split('class="set-desc"').length, 2, `one line of help: ${row.slice(0, 120)}`);
  }
});

test('the top bar is one segmented control (Talk, Workers, Sky, Settings) and a "more" menu: hands-free, new chat, what happened, a report', () => {
  const bar = html.slice(html.indexOf('<div class="controls"'), html.indexOf('</header>'));
  const seg = bar.slice(bar.indexOf('<nav class="segnav"'), bar.indexOf('</nav>'));
  assert.deepEqual([...seg.matchAll(/<button[^>]*>([A-Z][a-z]+)/g)].map((m) => m[1]), ['Talk', 'Workers', 'Sky', 'Settings']);
  assert.match(seg, /role="tab" class="tab" data-view="sky"/);
  assert.match(seg, /role="tab" class="tab on" data-view="chat"/);
  assert.match(seg, /role="tab" class="tab" data-view="tasks"/);
  assert.match(seg, /id="openSettings"/);
  const more = bar.slice(bar.indexOf('<details class="more"'));
  assert.deepEqual([...more.matchAll(/id="(\w+)"/g)].map((m) => m[1]), ['moreMenu', 'listenHint', 'listenSeg', 'handsFree', 'newConvo', 'whatHappened', 'reportBtn'], 'every old control keeps its id (hands-free is now one of three listening states)');
  // What happened left Settings: it opens in the dialog, from the menu or the "…" beside a reply.
  assert.doesNotMatch(html, /sec-happened/);
  assert.match(app, /openModal\('What happened', \[happenedView\]/);
  assert.match(app, /\$\('whatHappened'\)\.onclick = \(\) => whatHappened\.show\(\);/);
  for (const gone of ['pianoToggle', 'voiceBtn', 'moreBtn', 'wakePill', 'id="meta"', 'id="cost"']) assert.ok(!html.includes(gone), gone);
  // Going to Talk or Workers leaves Settings; the menu closes on Esc and on a click elsewhere.
  assert.match(shell, /closest\?\.\('\.segnav \.tab'\)\) close\(\)/);
  const topbar = read('ui/topbar.js');
  assert.match(topbar, /e\.key !== 'Escape'/);
  assert.match(topbar, /!menu\.contains\(/);
});

test('keyboard: Esc closes, Tab stays inside, focus goes back; another dialog on top keeps its keys', () => {
  assert.match(shell, /e\.key === 'Escape'/);
  assert.match(shell, /e\.key === 'Tab'/);
  assert.match(shell, /returnTo\.focus\(\)/);
  assert.match(shell, /if \(root\.hidden \|\| blocked\(\)\) return;/);
  assert.match(app, /blocked: \(\) => !els\.modal\.hidden \|\| wizard\.isOpen\(\)/);
  assert.match(app, /!settingsPanel\.isOpen\(\)\) \{/, 'Space does not start talking behind the settings');
});

test('the rows that belong to the Mac app show only once the app has said their value', () => {
  for (const id of ['hotKeyRow', 'openAtLoginRow', 'keepWorkingRow', 'permsRow']) assert.match(html, new RegExp(`id="${id}" hidden>`), id);
  // Asked each time Settings opens; answered through window.echoNative.appPrefs; changed with setAppPref.
  assert.match(app, /onOpen: \(\) => \{.*toApp\(\{ type: 'appPrefs' \}\);/);
  assert.match(app, /appPrefs: \(p\) => renderAppPrefs\(p\),/);
  assert.match(app, /const has = \(k\) => Boolean\(nativeApp\(\)\) && p != null && p\[k\] !== undefined;/);
  assert.match(app, /const setAppPref = \(key, value\) => toApp\(\{ type: 'setAppPref', \[key\]: value \}\);/);
  for (const key of ['hotKey', 'openAtLogin', 'keepWorkingAfterQuit']) assert.match(app, new RegExp(`setAppPref\\('${key}', `), key);
  // Permissions: one row; the app's own checklist window does the rest.
  assert.match(app, /\$\('permsRow'\)\.hidden = !nativeApp\(\) \|\| !macPerms;/);
  assert.match(app, /\$\('permsOpen'\)\.onclick = \(\) => toApp\(\{ type: 'showPermissions' \}\);/);
  assert.match(app, /permissions: \(st\) => \{ macPerms = st; renderPermsRow\(\);/);
});

test('one voice picker: choosing a voice also chooses the engine it belongs to', () => {
  assert.doesNotMatch(html, /setProvider|setFallbackVoice/);
  assert.match(app, /new Option\(v\.name, `\$\{p\.id\}:\$\{v\.id\}`\)/, 'each choice carries its engine');
  assert.match(app, /saveSetting\(provider === 'browser' \? \{ ttsProvider: provider, browserVoice: voice \} : \{ ttsProvider: provider, voice \}\);/);
  // Premium engines are listed only when the server offers them (GET /api/voices: their key is set up).
  assert.match(app, /const groups = voiceCatalog\.providers\.map\(/);
});

test('personality: three ways of talking and Beginner, which is the beginnerMode setting', () => {
  assert.match(app, /saveSetting\(\{ personality: p\.id, beginnerMode: false \}\)/);
  assert.match(app, /choiceChip\('Beginner', beginner, \(\) => saveSetting\(\{ beginnerMode: true \}\)\)/);
});

test('how long to wait when you pause: three choices, and a saved pause in between shows as the nearest', () => {
  assert.deepEqual([...html.matchAll(/role="radio" data-ms="(\d+)">(\w+)</g)].map((m) => [m[2], Number(m[1])]), [['Short', 900], ['Normal', 1300], ['Long', 1900]]);
  assert.match(app, /Math\.abs\(Number\(b\.dataset\.ms\) - ms\) < Math\.abs\(Number\(a\.dataset\.ms\) - ms\) \? b : a/);
  assert.match(app, /c\.onclick = \(\) => saveSetting\(\{ endSilenceMs: Number\(c\.dataset\.ms\) \}\);/);
});
