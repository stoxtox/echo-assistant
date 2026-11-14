// Names as hints, not rewrites (lib/correct.js nameHints / hearAsSaid): what the user said reaches Echo as heard; names it may be are a note for the assistant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until, serverSource } from './helpers.js';

const dirs = sandbox('namehints');
const { nameHints, hearAsSaid } = await import('../lib/correct.js');
const { learnCorrection, setWords } = await import('../lib/vocab.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const ctx = { known: new Set(['mira', 'claude', 'traxstix', 'veyla', 'fortuna']), names: ['Mira', 'Claude', 'Traxstix', 'Veyla', 'Fortuna'], learned: { myra: 'Mira', meera: 'Mira' } };

test('hints: a learned mishearing, or a word that sounds like one of your names; nothing is replaced', () => {
  assert.deepEqual(nameHints('text Myra that I am late', ctx), [{ heard: 'myra', maybe: 'Mira', why: 'learned' }]);
  assert.deepEqual(nameHints('ask cloud to fix it', ctx), [{ heard: 'cloud', maybe: 'Claude', why: 'sounds-like' }]);
  assert.deepEqual(nameHints('open track sticks', ctx), [{ heard: 'track sticks', maybe: 'Traxstix', why: 'sounds-like' }]);
  assert.deepEqual(nameHints('message Vela about lunch', ctx), [{ heard: 'Vela', maybe: 'Veyla', why: 'sounds-like' }]);
  // An everyday word that sounds like a name is only a hint: the assistant sees it isn't one here.
  assert.deepEqual(nameHints('tonight I have a fortune', ctx), [{ heard: 'fortune', maybe: 'Fortuna', why: 'sounds-like' }]);
  assert.deepEqual(nameHints('tell Mira hi', ctx), [], 'the name itself needs no hint');
  assert.deepEqual(nameHints('play Silver Lake', ctx), [], 'a name Echo doesn\'t know about is left alone');
  assert.deepEqual(nameHints('it is a nice day today', ctx), []);
  assert.ok(nameHints('a b c d e f g h Myra Meera cloud Vela fortune track sticks', ctx).length <= 6, 'at most six');
});

test('heard as said: learned mishearings no longer rewrite the sentence, spelled-out letters still join', () => {
  setWords(['Mira']);
  learnCorrection('Myra', 'Mira');
  hearAsSaid('warm up'); // the first call loads the word lists: slow on a busy machine, and not what's timed
  const r = hearAsSaid('text Myra that I am late', { uncertain: [{ word: 'late' }] as any });
  assert.equal(r.text, 'text Myra that I am late', 'nothing replaced');
  assert.deepEqual(r.hints.map((h) => [h.heard, h.maybe]), [['myra', 'Mira']]);
  assert.deepEqual(r.unsure, ['late']);
  assert.ok(r.ms < 200, 'instant: no model call');
  assert.match(hearAsSaid('message Tavis, T-A-V-I-S-H, that I am late').text, /\bTavish\b/, 'letters spelled out one by one are what was meant');
});

test('the only way in: every sentence is heard as said, with no switch and no correction model', () => {
  const server = serverSource();
  assert.match(server, /const fixed = hearAsSaid\(raw, \{ uncertain \}\);/);
  assert.doesNotMatch(server, /corrector|flagOn\('hints'\)/, 'no correction model started, kept warm or waited on');
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="setSmart"/, 'the old switch is gone from Settings');
});

test('the assistant gets the hints in the speech note, and is told the words are not rewritten', async () => {
  fs.rmSync(path.join(dirs.data, 'state.json'), { force: true });
  const quick: any = { favorites: () => [], pendingList: () => [], osa: async () => '', mediaControl: async () => ({}) };
  const d: any = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quick);
  assert.match(d.systemPrompt(), /NOT rewritten for you/);
  assert.match(d.systemPrompt(), /spelling the name back/);
  const sent: string[] = [];
  d.queryFn = ({ prompt }: { prompt: AsyncIterable<any> }) => {
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for await (const m of prompt) {
        sent.push(JSON.stringify(m));
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0 };
      }
    })();
    return Object.assign(q, { setModel: async () => {}, close() {} });
  };
  d.start();
  await until(() => d.q, 1000, 'session');
  d.send('text Myra that I am late', { raw: 'text Myra that I am late', hints: [{ heard: 'Myra', maybe: 'Mira' }] });
  await until(() => sent.length > 0, 1000, 'sent');
  assert.match(sent[0] ?? '', /may be names: \\"Myra\\" may be Mira/);
  d.input.close();
});
