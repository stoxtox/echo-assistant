// Talking over a conversation (public/ui/talkview.js): the pearl and your words used to take the
// whole window over every time you spoke, hiding what Echo had just said. Now your words are the
// next bubble in the thread while you say them, and nothing else moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const { bubbleParts, listeningHint, UNSETTLED_WORDS } = await import('../public/ui/talkview.js');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('the newest words are shown as unsettled, the rest as said', () => {
  assert.deepEqual(bubbleParts('So what should we do next with these photos'), { settled: 'So what should we do next with', unsettled: 'these photos' });
  assert.deepEqual(bubbleParts('  Hello   there '), { settled: '', unsettled: 'Hello there' });
  assert.deepEqual(bubbleParts(''), { settled: '', unsettled: '' });
  assert.equal(UNSETTLED_WORDS, 2);
});

test('the message box says what the key does, only while listening over a conversation', () => {
  assert.equal(listeningHint({ listening: true, inConversation: true, handsFree: false }), 'Release Space to send · Esc to cancel');
  assert.equal(listeningHint({ listening: true, inConversation: true, handsFree: true }), 'Listening…');
  assert.equal(listeningHint({ listening: false, inConversation: true, handsFree: false }), '');
  assert.equal(listeningHint({ listening: true, inConversation: false, handsFree: false }), '', 'Home has its own Listening bar');
});

test('the full-window pane is for the empty Home screen only', () => {
  // No rule gives the hero the whole pane because of live words or a held key alone.
  for (const line of css.split('\n')) {
    if (!/\.hero \{/.test(line) || !/grid-row: 1 \/ 4/.test(line)) continue;
    assert.match(line, /^\.convo:has\(#chatEmpty:not\(\[hidden\]\)\) \.hero \{/, 'only when the conversation is empty');
  }
  assert.doesNotMatch(css, /^:is\(\.convo:has\(#chatEmpty:not\(\[hidden\]\)\), \.convo:has\(\.live\[data-mode="caption"\]\)/m);
  assert.doesNotMatch(css, /\.convo:has\(#chatEmpty\[hidden\]\)[^{]*\.hero \{ animation: fade/);
  // What shows instead: the bubble, the level bars, the outlined message box.
  assert.match(css, /\.msg\.you\.live-bubble \{[^}]*var\(--grad\) border-box/);
  assert.match(css, /\.convo:has\(#chatEmpty\[hidden\]\):is\(:has\(\.live\[data-mode="caption"\]\), :has\(#mic\.listening\)\) \.lvl \{ display: flex; \}/);
  assert.match(css, /\.convo:has\(#chatEmpty\[hidden\]\):is\(:has\(\.live\[data-mode="caption"\]\), :has\(#mic\.listening\)\) \.composer \{[^}]*var\(--grad\) border-box/);
  assert.match(html, /<span class="lvl" aria-hidden="true">(<i><\/i>){4}<\/span>/);
  assert.match(app, /createTalkView\(\{ transcript: \$\('transcript'\), live: \$\('live'\)/);
  // A correction from the second listen goes to your real bubble, never the live one.
  assert.match(app, /\.msg\.you:not\(\.live-bubble\)/);
});
