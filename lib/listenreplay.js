// The listening replay: labelled utterances like the ones in the Sept 28–30 logs (names changed),
// run through the same decisions the server makes (lib/addressed.js judgeAddressee, and
// lib/listening.js midRunDecision while Echo drives). Pure: `node scripts/listen-replay.js` prints it and
// test/listening.test.js holds it to the conversation-mode bar:
//   - at least 95% of answers to Echo get through with no wake word,
//   - at most 1% of background clips (TV, podcast, other people) start or cancel anything,
//   - 0 of 10 long computer-use runs are cancelled with a TV or podcast playing.
import { judgeAddressee } from './addressed.js';
import { midRunDecision } from './listening.js';

/** A voice at the Mac: loud, well above the room. */
export const NEAR = { level: 0.08, floor: 0.004, snrDb: 26 };
/** The user close to the mic while a video plays on the Mac. */
export const NEAR_OVER_MEDIA = { level: 0.09, floor: 0.012, snrDb: 17.5 };
/** A TV or a podcast: the voice sits in a room full of the same sound. */
export const TV = { level: 0.03, floor: 0.014, snrDb: 6.6 };
/** Someone talking across the room. */
export const ACROSS = { level: 0.012, floor: 0.003, snrDb: 12 };

/** Echo's questions, as she really asks them. */
const Q = {
  send: 'I wrote the email to Sam. Should I send it?',
  which: 'I found three playlists: lofi beats, jazz for work, and rainy day piano. Which one?',
  who: 'Who should I send it to?',
  when: 'How many minutes should I set the timer for?',
  delete: 'That one is a screenshot from Monday. Want me to delete it?',
  video: 'The first result is the official trailer. Want me to play it?',
};

/**
 * Answers to Echo's question, heard without her name: inside the follow-up window (20 s later),
 * after it (90 s later, her question still open), and while she drives with a card waiting.
 * @type {Array<{ text: string, question: string, sinceReplyMs: number, driving?: boolean, card?: boolean }>}
 */
export const ANSWERS = [
  ...['Yeah', 'Yes', 'Yes please', 'Yeah go ahead', 'Sure', 'Do it', 'Yep, send it', 'No', 'Nope, not yet', 'Not now', 'Okay', 'That sounds good', 'Perfect', 'No thanks', 'Absolutely']
    .flatMap((text) => [{ text, question: Q.send, sinceReplyMs: 20000 }, { text, question: Q.send, sinceReplyMs: 90000 }]),
  ...['The second one', 'Jazz', 'The jazz one', 'Lofi beats', 'The first one', 'The last one', 'Rainy day piano', 'Both']
    .flatMap((text) => [{ text, question: Q.which, sinceReplyMs: 20000 }, { text, question: Q.which, sinceReplyMs: 90000 }]),
  ...['Sam', 'To Alex', 'Priya Shah'].flatMap((text) => [{ text, question: Q.who, sinceReplyMs: 20000 }, { text, question: Q.who, sinceReplyMs: 120000 }]),
  ...['Ten', '5 minutes', 'Twenty'].flatMap((text) => [{ text, question: Q.when, sinceReplyMs: 25000 }, { text, question: Q.when, sinceReplyMs: 75000 }]),
  ...['Yeah delete it', 'Uh yeah', 'Go ahead', 'No keep it'].map((text) => ({ text, question: Q.delete, sinceReplyMs: 60000 })),
  // A card waiting while she drives: answered close to the mic.
  ...['Yes', 'Yeah', 'Send it', 'No', 'The other one', 'You can send it', 'That looks good'].map((text) => ({ text, question: Q.video, sinceReplyMs: 3000, driving: true, card: true })),
];

/**
 * Background audio: lines from a TV, a podcast or a video (media playing), and other people in
 * the room. None of them is for Echo. `after`: how long after her last reply they were heard;
 * `open`: her question was still open.
 * @type {Array<{ text: string, media: boolean, sinceReplyMs?: number, open?: boolean }>}
 */
export const BACKGROUND = [
  ...[
    'Coming up next, the weather with Janet', 'Stay tuned for more after the break', 'Subscribe and hit the bell',
    'And that is why the markets fell on Tuesday', 'He shoots, he scores, what a goal', 'Tonight on the evening news',
    'I think we need to talk about what happened last night at the party and why nobody called me back',
    'This episode is brought to you by our friends at the mattress company', 'Welcome back to the show everybody',
    'So what do you think about the new album that came out on Friday, I think it is the best one they ever made honestly',
    'The police say the suspect fled on foot heading north on Main Street toward the river', 'Let me tell you a story about my grandfather and the farm he had in Ohio when he was a kid',
    'And the award goes to', 'Previously on the show', 'Don\'t forget to like and subscribe', 'Back to you in the studio',
    'Scientists say the storm could bring up to six inches of rain across the region by Thursday night',
    'That is not how any of this works, and you know it, and I know it, and everybody watching at home knows it',
  ].flatMap((text) => [{ text, media: true }, { text, media: true, sinceReplyMs: 20000 }, { text, media: true, sinceReplyMs: 90000, open: true }]),
  ...[
    'Did you watch the game last night', 'My mom called earlier about the weekend', 'Are you coming to dinner on Sunday or not',
    'I left my keys on the counter again', 'We should get dinner after this, maybe that Thai place on Main Street near the station',
    'Madagascar, Cure, Diario, Nape', 'Enric, Black, Colonna, Capra', 'Oh my god look at that',
    'The meeting got moved to three because Dana is out sick today and nobody told the rest of the team until this morning',
    'turn on the Echo Dot in the kitchen', 'There is an echo in this room',
  ].flatMap((text) => [{ text, media: false }, { text, media: false, sinceReplyMs: 90000, open: true }]),
];

/** Ten long computer-use runs with a TV or a podcast on: everything the room said during each. */
export const LONG_RUNS = Array.from({ length: 10 }, (_, i) => ({
  name: `run ${i + 1}: ${['YouTube search', 'Gmail draft', 'Finder cleanup', 'Spotify playlist', 'Calendar invite', 'Docs edit', 'Slack reply', 'Photos export', 'Maps route', 'Amazon cart'][i]}`,
  heard: [
    'Stop!', 'Wait', 'No no no', 'Go back', 'Cancel that', 'Hold on a second', 'That\'s enough', 'Never mind',
    'No, the other one', 'Stop it right now', 'Don\'t do that', 'Wait, wait, wait', 'Okay stop', 'Enough', 'Yes',
    'Back to you in the studio', 'Scroll down', 'Undo', 'Pause', 'That\'s it',
  ].slice(0, 12 + (i % 8)),
  answering: i % 3 === 0, // a card was waiting part of the time
}));

/**
 * @param {{ answers?: typeof ANSWERS, background?: typeof BACKGROUND, runs?: typeof LONG_RUNS }} [sets]
 */
export function runListening({ answers = ANSWERS, background = BACKGROUND, runs = LONG_RUNS } = {}) {
  const followUpMs = 45000;
  const answerMiss = [];
  for (const a of answers) {
    if (a.driving) {
      const judged = judgeAddressee({ text: a.text, clarity: 'ok', driving: true, pendingQuestion: true });
      const d = midRunDecision({ text: a.text, decision: judged.decision, answering: Boolean(a.card), clarity: 'ok', loud: NEAR });
      if (d.action !== 'go' && d.action !== 'cut') answerMiss.push({ ...a, got: d.action });
      continue;
    }
    const judged = judgeAddressee({ text: a.text, clarity: 'ok', followUp: a.sinceReplyMs < followUpMs, sinceReplyMs: a.sinceReplyMs, awaitingAnswer: true, question: a.question, context: [`Assistant: ${a.question}`] });
    if (judged.decision !== 'accept') answerMiss.push({ ...a, got: judged.decision });
  }
  const triggered = [];
  for (const b of background) {
    const since = b.sinceReplyMs;
    const judged = judgeAddressee({
      text: b.text, clarity: 'ok', followUp: since !== undefined && since < followUpMs, sinceReplyMs: since,
      awaitingAnswer: Boolean(b.open), question: Q.send, context: since !== undefined ? [`Assistant: ${Q.send}`] : [],
      quiet: false, mediaPlaying: b.media,
    });
    if (judged.decision === 'accept') triggered.push({ ...b, why: judged.why });
  }
  const cancelledRuns = [];
  for (const r of runs) {
    const cuts = r.heard.filter((text) => {
      const judged = judgeAddressee({ text, clarity: 'ok', driving: true, pendingQuestion: r.answering, mediaPlaying: true });
      return midRunDecision({ text, decision: judged.decision, answering: r.answering, clarity: 'ok', loud: TV, mediaPlaying: true }).action === 'cut';
    });
    if (cuts.length) cancelledRuns.push({ name: r.name, cuts });
  }
  return {
    answers: { n: answers.length, accepted: answers.length - answerMiss.length, rate: (answers.length - answerMiss.length) / answers.length, missed: answerMiss },
    background: { n: background.length, triggered: triggered.length, rate: triggered.length / background.length, which: triggered },
    runs: { n: runs.length, cancelled: cancelledRuns.length, which: cancelledRuns },
  };
}
