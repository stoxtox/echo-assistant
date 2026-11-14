// Settings, round 2 (DESIGN-round2.html, section 3): 73 rows down to 30, in five sections. Each
// row is a label, one short line of help and its control; everything else is gone from the page,
// and a settings.json saved by an older version loads cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('settings2');
const { getSettings, saveSettings, PAUSE_CHOICES } = await import('../lib/settings.js');

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const html = read('public/index.html');
const panel = html.slice(html.indexOf('<div id="settings"'), html.indexOf('<div id="happenedView"'));
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The five sections as shown: [title, [[label, help], …]]. @type {Array<[string, Array<[string, string[]]>]>} */
const sections = [...panel.matchAll(/<section class="set-section"[^>]*data-title="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => {
  const rows = m[2].match(/<(label|div) class="set-row[^"]*"[\s\S]*?<\/\1>/g) || [];
  return [m[1].replace('&amp;', '&'), rows.map((row) => {
    const label = text(row.match(/class="set-label"[^>]*>([\s\S]*?)<span class="set-desc"/)?.[1] || '');
    const help = [...row.matchAll(/class="set-desc"[^>]*>([\s\S]*?)<\/span>/g)].map((d) => text(d[1]));
    return /** @type {[string, string[]]} */ ([label, help]);
  })];
});

const KEPT = {
  Listening: ['Hands-free', '“Hey Echo”', 'How long to wait when you pause', 'Talk over Echo to interrupt', 'Double-check what I heard'],
  Voice: ['Read replies aloud', 'Voice', 'Speed', 'Sounds'],
  Companion: ['Look', 'Lively', 'Point at things', 'Caption beside the light'],
  'On your Mac': ['Let Echo use the computer', 'Extra safety', 'Leave my mouse alone', 'Echo for Chrome', 'Summon shortcut', 'Open at login', 'Keep working after I quit'],
  'You & privacy': ['Your name', "Echo's name", 'Personality', 'Claude sign-in', 'Daily limit', 'Keep recordings', 'Keep a conversation log', 'Permissions', 'Updates', 'Reset Echo'],
};

test('exactly the 30 rows that stay, in the five sections, in order', () => {
  assert.deepEqual(sections.map(([title]) => title), Object.keys(KEPT));
  assert.deepEqual(Object.fromEntries(sections.map(([title, rows]) => [title, rows.map(([label]) => label)])), KEPT);
  assert.equal(sections.reduce((n, [, rows]) => n + rows.length, 0), 30);
  // The list on the left names the same five, in the same order.
  assert.deepEqual([...panel.matchAll(/class="set-tab"[^>]*><span>([^<]+)</g)].map((m) => m[1].replace('&amp;', '&')), Object.keys(KEPT));
  // And nothing else is a row: no notes, no group headings among them, no search.
  assert.equal(panel.split('class="set-row').length - 1, 30);
  assert.doesNotMatch(panel, /class="set-note"|type="search"|data-keywords/);
});

test('every row has one line of help: a single sentence of at most 14 words', () => {
  for (const [title, rows] of sections) {
    for (const [label, help] of rows) {
      assert.equal(help.length, 1, `${title} → ${label}: one help line`);
      const words = help[0].split(/\s+/).filter(Boolean);
      assert.ok(words.length >= 3 && words.length <= 14, `${title} → ${label}: ${words.length} words`);
      assert.match(help[0], /^[^.!?]+\.$/, `${title} → ${label}: one sentence ("${help[0]}")`);
    }
  }
});

test('none of the removed rows is on the page: not its control, not its label', () => {
  const ids = [
    // Listening
    'setWakeSens', 'setMicOff', 'micOffRow', 'setAutoListen', 'setFollowUp', 'pauseVal', 'setPtt', 'setNativeMic', 'setStt', 'setSttLang', 'setPreview',
    'vocabWords', 'vocabSave', 'vocabFixes',
    // Voice
    'setProvider', 'setBriefVoice', 'setFallbackVoice', 'fallbackRow', 'voiceBudgetNote', 'elevenHint', 'setSpokenAcks', 'setThinkingSound',
    // Companion
    'setCompanionSize', 'setReduceMotion', 'orbPreview', 'setCaption',
    // On your Mac
    'labsList', 'labsGroup', 'setMovePx', 'setTakeBack', 'setDuck', 'setRunListen', 'setShowMe', 'computerHint', 'screenPerms',
    // You & privacy
    'setBeginner', 'setFastModel', 'projectsDirShow', 'changeFolder', 'runSetup', 'setTaskBudget', 'setCostWarn', 'pinNew', 'pinCurrent', 'pinSave', 'pinTitle',
    'setScreen', 'setAutoUpdate', 'autoUpdateRow',
    // Gone entirely
    'setPiano', 'setPianoMood', 'setPianoVolume', 'sec-music', 'sec-happened', 'tab-happened', 'settingsSearch',
  ];
  for (const id of ids) assert.equal(html.includes(`id="${id}"`), false, `#${id}`);
  const labels = ['Wake word sensitivity', 'Auto-listen', 'Follow-up window', "Use the Echo app's own mic", 'Recognition engine', 'Show words live',
    'Pause the microphone', 'Voice engine', 'Backup voice', 'Brief voice', 'Spoken acknowledgements', 'Thinking sound', 'Sound effects', 'Choose its size',
    'Reduce motion', 'Caption bar', 'Labs', 'Ignore small mouse movements', 'When you click or type', "Lower the Mac's volume", 'Keep listening while she drives',
    'Show me how', 'Beginner-friendly mode', 'Quick model', 'Projects folder', 'Run setup again', 'Limit per task', 'Self-improve PIN', 'Screen awareness',
    'Words to expect', 'Learned corrections', 'Ambient piano', 'Music', 'Push-to-talk from anywhere', 'Install updates automatically', 'Daily heads-up'];
  const shown = text(panel);
  for (const label of labels) assert.equal(shown.includes(label), false, label);
  // "A report for whoever helps you" and "What happened" moved to the "more" menu in the top bar.
  const more = html.slice(html.indexOf('<details class="more"'), html.indexOf('</header>'));
  assert.match(more, /id="whatHappened"/);
  assert.match(more, /id="reportBtn"/);
});

test('the code behind the removed features is gone', () => {
  for (const f of ['public/piano.js', 'test/piano.test.js', 'lib/brief.ts', 'test/brief.test.ts', 'public/ui/labs.js']) {
    assert.equal(fs.existsSync(new URL(`../${f}`, import.meta.url)), false, f);
  }
  const app = read('public/app.js');
  assert.doesNotMatch(app, /piano|loadVocab|renderLabs|thinkingSound|briefVoice|renderMicOff/i);
  assert.doesNotMatch(read('lib/dispatcher.js'), /brief\.ts|BriefSplitter|ScreenSplitter|briefVoice|BRIEF_/);
  assert.doesNotMatch(read('server.js'), /thinkingSound/);
  // The word list editor's route went with the editor; reading the list stays (the recognizers and the Mac app use it).
  const speech = read('lib/server/speech.js');
  assert.match(speech, /'GET \/api\/vocabulary'/);
  assert.doesNotMatch(speech, /'POST \/api\/vocabulary'/);
  // The Labs rows are gone; the flags and their defaults are untouched (test/flags.test.ts).
  assert.match(read('lib/server/routes.js'), /flagInfo\(\)/);
});

test('an old settings.json with removed keys loads cleanly: they are ignored, then dropped on the next save', () => {
  const file = path.join(dirs.data, 'settings.json');
  const old = {
    assistantName: 'Nova', userName: 'Sam', voice: 'am_puck', ttsProvider: 'kokoro', endSilenceMs: 2100, sttLanguage: 'en-US', beginnerMode: true, dailyBudgetUsd: 12,
    // every setting that was removed, at a value that is not today's default
    wakeSensitivity: 1, autoListenMs: 0, followUpSeconds: 120, takeBackMovePx: 600, takeBack: 'end', duckMedia: false, listenDuringRuns: false,
    taskBudgetUsd: 3, orbSize: 'large', companionSize: 'medium', nativeMic: false, sttEngine: 'deepgram', livePreview: false, fastModel: 'off',
    screenAware: false, reduceMotion: 'on', briefVoice: true, spokenAcks: true, thinkingSound: true, fallbackVoice: 'bf_emma',
    // and things that were never settings
    piano: true, madeUp: { deep: [1, 2] },
  };
  fs.writeFileSync(file, JSON.stringify(old));
  const s = getSettings();
  // What stays is read as saved.
  assert.deepEqual([s.assistantName, s.userName, s.voice, s.endSilenceMs, s.sttLanguage, s.beginnerMode, s.dailyBudgetUsd], ['Nova', 'Sam', 'am_puck', 2100, 'en-US', true, 12]);
  // What was removed is today's default, whatever the file says.
  assert.deepEqual(
    { wakeSensitivity: s.wakeSensitivity, autoListenMs: s.autoListenMs, followUpSeconds: s.followUpSeconds, takeBackMovePx: s.takeBackMovePx, takeBack: s.takeBack, duckMedia: s.duckMedia,
      listenDuringRuns: s.listenDuringRuns, taskBudgetUsd: s.taskBudgetUsd, orbSize: s.orbSize, nativeMic: s.nativeMic, sttEngine: s.sttEngine,
      livePreview: s.livePreview, fastModel: s.fastModel, screenAware: s.screenAware, reduceMotion: s.reduceMotion, spokenAcks: s.spokenAcks, fallbackVoice: s.fallbackVoice },
    { wakeSensitivity: 0.5, autoListenMs: 8000, followUpSeconds: 45, takeBackMovePx: 120, takeBack: 'pause', duckMedia: true,
      listenDuringRuns: true, taskBudgetUsd: 0, orbSize: 'medium', nativeMic: true, sttEngine: 'auto',
      livePreview: true, fastModel: 'auto', screenAware: true, reduceMotion: 'system', spokenAcks: false, fallbackVoice: 'af_heart' },
  );
  for (const gone of ['briefVoice', 'thinkingSound', 'piano', 'madeUp', 'companionSize']) assert.equal(Object.hasOwn(s, gone), false, gone);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old, 'reading never rewrites the file');
  // The next save writes only what Settings still has.
  const next = saveSettings({ userName: 'Sam R', thinkingSound: true, wakeSensitivity: 0 });
  assert.equal(next.userName, 'Sam R');
  assert.equal(next.wakeSensitivity, 0.5);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const gone of ['wakeSensitivity', 'autoListenMs', 'followUpSeconds', 'takeBackMovePx', 'takeBack', 'duckMedia', 'listenDuringRuns', 'taskBudgetUsd', 'orbSize',
    'companionSize', 'nativeMic', 'sttEngine', 'livePreview', 'fastModel', 'screenAware', 'reduceMotion', 'briefVoice', 'spokenAcks', 'thinkingSound', 'fallbackVoice', 'piano', 'madeUp']) {
    assert.equal(Object.hasOwn(written, gone), false, `${gone} is not written back`);
  }
  assert.deepEqual([written.assistantName, written.userName, written.endSilenceMs, written.beginnerMode], ['Nova', 'Sam R', 2100, true], 'kept keys are untouched');
  // A file that is not even an object is no settings at all, not a crash.
  fs.writeFileSync(file, '["oops", 3]');
  assert.equal(getSettings().wakeSensitivity, 0.5);
  assert.equal(getSettings().assistantName, 'Echo');
  fs.rmSync(file, { force: true });
});

test('the three pauses are the ones on the page', () => {
  assert.deepEqual(PAUSE_CHOICES, { short: 900, normal: 1300, long: 1900 });
  assert.deepEqual([...html.matchAll(/data-ms="(\d+)"/g)].map((m) => Number(m[1])), Object.values(PAUSE_CHOICES));
  assert.equal(saveSettings({ endSilenceMs: 1900 }).endSilenceMs, 1900);
  saveSettings({ endSilenceMs: 1300 });
});
