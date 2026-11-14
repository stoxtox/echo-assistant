// Echo beside the thing (echo-talk-design.html, sections 5, 5b and 6): the bubble beside the light
// is dark glass with the answer's colours round its rim while Echo says the words and a quiet
// hairline after; an explanation's sentence goes in it whole; and a risky step asks its question,
// with its two buttons, beside the thing it is about to press.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('aurorabubble');
const swift = (f) => fs.readFileSync(new URL(`../macos/Sources/${f}`, import.meta.url), 'utf8');

test('an explanation sends the sentence it says with each part, for the bubble', () => {
  const src = fs.readFileSync(new URL('../lib/explain.js', import.meta.url), 'utf8');
  assert.match(src, /intent: 'show', caption: chunk\.key, words: String\(chunk\.say \|\| ''\)\.slice\(0, 200\) \}\)/);
  assert.match(swift('ScreenBridge.swift'), /let words = p\["words"\] as\? String \?\? ""/);
  assert.match(swift('ScreenBridge.swift'), /request: id, words: words\)/);
});

test('the bubble: lit while the words are said, quiet after, and a sentence stays with the light', () => {
  const art = swift('Companion.swift'), pointer = swift('Pointer.swift');
  assert.match(art, /static func draw\(in ctx: CGContext, _ text: String, intent: String, in r: CGRect, pixelScale px: CGFloat, live: Bool = true, toward: CGPoint\? = nil\)/);
  assert.match(art, /\} else if live, let space = CGColorSpace\(name: CGColorSpace\.sRGB\),/, 'the answer\'s colours round the rim only while it is live');
  assert.match(art, /static func lines\(_ text: String\) -> \[CTLine\]/);
  // Only something Echo is showing (never a step it does, a lesson's waiting step, or a question) carries a sentence.
  assert.match(pointer, /let long = pinned && !asks && stepId == nil && !sentence\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty/);
  assert.match(pointer, /if stays \{ b\.live = false; b\.setNeedsDisplay\(\); return \}/);
  assert.match(pointer, /b\.toward = CGPoint\(x: light\.x - b\.frame\.minX, y: light\.y - b\.frame\.minY\)/);
});

test('asking at the thing: the island\'s own question and answer, beside the thing, and gone when the light moves on', () => {
  const ask = swift('AskBubble.swift'), pointer = swift('Pointer.swift'), caption = swift('Caption.swift');
  assert.match(caption, /confirming && !question\.isEmpty \? \(question, action\.isEmpty \? "Yes" : action, cancel\.isEmpty \? "No" : cancel\) : nil/);
  assert.match(pointer, /guard firefly, mode == \.out, intent == "ask", let ask = CaptionBar\.shared\.ask, let c = lastCaption, let screen = panel\?\.screen else \{\n\s+return AskBubble\.shared\.hide\(\)/);
  // The same answer as the island's buttons: nothing new counts as a yes.
  assert.match(ask, /@objc private func yesClicked\(\) \{ hide\(\); CaptionBar\.shared\.onConfirm\?\(true\) \}/);
  assert.match(ask, /@objc private func noClicked\(\) \{ hide\(\); CaptionBar\.shared\.onConfirm\?\(false\) \}/);
  assert.doesNotMatch(ask, /keyEquivalent/, 'neither button is a default: Return never says yes');
  for (const where of [/private func goHome\(why: String = "over"\) \{\n\s+stopTyping\(\)\n\s+hush\(\)\n\s+AskBubble\.shared\.hide\(\)/, /func hide\(animated: Bool, quick: Bool = false\) \{\n\s+stopTicking\(\)\n\s+AskBubble\.shared\.hide\(\)/]) assert.match(pointer, where);
  assert.match(swift('Driver.swift'), /forName: CaptionBar\.askChanged, object: nil, queue: \.main\) \{ \[weak self\] _ in self\?\.pointer\.syncAsk\(\) \}/);
});
