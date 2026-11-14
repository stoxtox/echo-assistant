# Listening: conversation mode, and background speech can't cancel

The "Listening" step of the Echo build plan (numbered step 5 in the plan's table; run third, after the baseline and the safety-check fix). Code: `lib/listening.js`, `lib/mediaplaying.js`, `lib/addressed.js` (`answerShaped`, `judgeAddressee`), `lib/computer.js` (held instructions), `server.js` (`POST /api/utterance`, `user_text`), `public/nativemic.js`, `public/app.js`. Tests: `test/listening.test.js`. Replay: `node scripts/listen-replay.js` (`lib/listenreplay.js`).

## What was wrong (from the code and `data/stt-log.jsonl`)

- **"Yeah" after the wake word was dropped.** With the Mac app's own mic and the wake word on, the mic listened for every sentence only during the 8-second answer window after a question. After that it went back to waiting for "Hey Echo", so a reply 20 seconds later never reached Echo. The 45-second follow-up window only applied to the window's own hands-free mic. The log shows replies at 58–75 s dropped as `not_for_echo`.
- **A TV could cancel a step.** Mid-run, "stop", "wait" or a correction ("no, go back") cut in as soon as the words matched. There was no check on how clearly, how close or how long. Speech with no clip (the browser's recognizer, a clip cut too short) skipped the check entirely.
- **Clear direct questions rarely passed in a quiet room.** The "quiet room" signal was only sent by the window's own mic. Sentences from the Mac app's mic never had it, and there was no check for audio playing on the Mac.
- "5 minutes" was dropped as "not English" (a digit was counted as a spelled-out letter).

## What changed

- **Engaged window (conversation mode).** After Echo speaks, the Mac app's mic keeps listening for every sentence for the follow-up window (Settings, 45 s by default). The window restarts every time she finishes speaking. Each sentence is still judged on the server (addressee v1), and a long stretch that isn't on the topic, a command or a question to her now only gets the "Was that for me?" chip.
- **Awaiting-answer state.** When her last reply asked something, the mic stays open and answer-shaped replies get through **with no time limit**, until the question is answered (you speak or type) or replaced by a new reply. Only answers count: yes/no/a confirmation, a number ("5 minutes"), one of the choices she offered ("jazz" to "lofi or jazz?"), or a name when she asked who.
- **Background can't cancel.** While an action runs, a stop, wait or correction needs all four:
  1. addressed to Echo (addressee v1 accepted it),
  2. heard clearly (recognizer confidence; with no scores, only with her name),
  3. short (5 words or fewer, or "Echo, …"),
  4. near: loud enough and at least 12 dB above the room's own sound, measured on the clip. A TV fills the room with the same sound, so its voice stands only a few dB above it.

  If a correction fails, it's **held**: the step goes on, and at the next step the assistant sees it as "heard nearby, maybe not for you". It never counts as a turn or as the yes to a card, and it's dropped at the end of the run. If a stop or wait fails, you get the "Was that for me?" chip, and a tap stops it. The Stop button on the caption pill, Escape, and taking the mouse always stop a run.
- **Audio playing on the Mac.** Echo checks macOS's audio power assertions (at most every 4 s, never slower than 1.5 s) for any app other than Echo's own window sending sound to the speakers. While one is, the bar goes up: addressee confidence drops by 0.15, a bare "stop" needs 18 dB above the room ("Echo, stop" the usual 12), and the room doesn't count as quiet. This only runs in the Mac app: in a browser tab, Echo's own page shares the browser's sound with any video.
- **Quiet room for every sentence.** When the page didn't measure it, the room's own sound is measured on the clip. A clear direct question in a quiet room passes without "Echo". The list of direct questions now includes "what time is it", "what's the weather", "do I have any new emails" and similar.
- **Every wake-word-free turn is logged** (`no_wake_turn` in the speech log: why, how sure, word count, quiet, media), so a looser gate that lets in the TV shows up. Held speech is logged as `run_held` with its loudness.

## Acceptance (replay)

`node scripts/listen-replay.js`, also enforced by `test/listening.test.js`:

| | Result | Bar |
|---|---|---|
| Answer replies accepted with no wake word (69: inside the window, 60–120 s later with the question open, and card answers mid-run) | 69 of 69 (100%) | at least 95% |
| Background clips that start or cancel something (76: TV, podcast and video lines with media playing, and other people talking, at different times after her reply) | 0 of 76 (0%) | at most 1% |
| Long computer-use runs cancelled with a TV or podcast on (10 runs, 12–19 lines each, including "stop", "wait", "no no no", "go back", "cancel that") | 0 of 10 | 0 |

**What this doesn't prove yet.** The real-log eval gate (the plan's step 2) isn't built, so this replay is labelled sentences written like the real ones, not recorded audio. The loudness numbers for "near" and "TV" are modelled, not measured on this Mac's mic. Before relying on the numbers, check them live (below) and look at `run_held` and `no_wake_turn` in the speech log after a day.

## Known limits

- Someone else in the room talking to you **inside** the follow-up window ("did you watch the game?") can still reach Echo, as it could before in hands-free mode. Only speaker verification (later backlog) really fixes that.
- Outside the conversation window, the Mac app's own mic still needs "Hey Echo". It only sends whole sentences while engaged, so the quiet-room direct question works with the window's hands-free mic, or inside the window.
- A video in **Safari** isn't detected as media playing, because Safari shares the WebKit helper with Echo's window.
- A real "stop" said quietly or from across the room may be held back. Use the Stop button, Escape, or say "Echo, stop".

## To check on the Mac

1. Wake word on. "Hey Echo, should I bring an umbrella tomorrow? Ask me what city first." When she asks, wait 20 seconds and say "yeah, Boston". It should get through without "Echo".
2. Ask something that ends in a question, wait a minute and a half, and say "yes". It should still answer that question.
3. Start a long computer-use task with a YouTube video playing out loud. Say nothing. It shouldn't stop, pause or go back.
4. During the same run, say "stop" at the Mac. It should stop. Say "Echo, stop" from across the room. It should stop too.
5. With the room quiet and no video playing, inside the window: "what time is it?" It should answer.

No Mac app rebuild is needed. The new "follow" mic label passes through the app's existing code unchanged.
