# Speed work (build step 4): before and after

The speed step of the build plan (the plan's "Speed I" and "Speed II"): quick turns on a fast
small model, a slimmer prompt, instant commands with no model call, the first sentence to the
voice straight away, and read-only tools that run in parallel. Measured on September 30, 2026.

## How it was measured

`scripts/latency-bench.js` runs the dispatcher on its own with the real models, in a throwaway
data folder holding copies of the live memory, projects, settings and contact favorites (so the
prompt is the real size). It never touches the Mac: every AppleScript call is a no-op and there
is no screen bridge. For each turn it times:

- **first piece:** from the words going in to the first piece handed to the voice;
- **first audio:** first piece plus the local voice (Kokoro) rendering it, i.e. the first
  spoken word is ready to play;
- **whole turn:** until the reply ends.

Speech to text happens before all of this and wasn't changed, so it's left out (about 1.4 s
median, docs/baseline-2026-10.md). One warm-up turn runs first, since a real session is warm.

```
# before: the code at the base commit, exported to a temp folder
node scripts/latency-bench.js --from <live data> --rounds 2 --tts
# after: this branch
node scripts/latency-bench.js --from <live data> --rounds 2 --tts
# the main model only, more samples
node scripts/latency-bench.js --from <live data> --rounds 4 --tts --only hard
```

The turns: five chat or quick-fact turns ("what's the capital of Australia?", "any tasks running
right now?"), two harder ones ("compare renting versus buying a home, in two sentences"), and
four instant commands ("pause", "next song", "stop", "scroll down"), each twice.

## The numbers (medians)

| Turns | Before: first piece | After | Before: first audio | After | Before: whole turn | After |
|---|---|---|---|---|---|---|
| Chat and quick facts (n=10) | 1.64 s | **0.57 s** | 3.07 s | **1.30 s** | 1.66 s | **0.58 s** |
| Harder, main model (n=4, mixed run) | 1.28 s | 1.52 s | 3.41 s | **2.71 s** | 2.08 s | 2.61 s |
| Harder, main model only (n=8) | 1.44 s | 1.38 s | 3.54 s | **2.51 s** | 2.42 s | 2.32 s |
| Instant commands (n=8) | 1.27 s | **0.00 s** | 1.93 s | **0.62 s** | 1.28 s | **0.00 s** |
| All (n=22) | 1.62 s | **0.54 s** | 3.15 s | **1.30 s** | 1.81 s | **0.56 s** |

| Context per model call | Before | After |
|---|---|---|
| Quick turn (fast model) | 57K tokens | **24K** (−58%) |
| Main model | 57K tokens | **31–33K** (−44%) |

- **Quick replies start speaking 58% sooner** (3.07 s to 1.30 s to the first audio), and the
  whole quick turn is 65% shorter.
- **"Stop" and "scroll down" no longer go to the model.** Before, each took a full model turn
  (2.5 to 3.1 s). Now they act in under a millisecond of Echo's own time (the real scroll or
  pause then takes as long as the Mac does, typically 0.1 to 0.3 s). "Pause" and "next song" were
  already instant.
- **Harder replies are heard about a second sooner** (3.5 s to 2.5 s to first audio), mostly
  because the first sentence now goes to the voice on its own instead of waiting for the second.
  In the mixed run, the first main-model turn after quick ones also re-reads the few exchanges
  the fast model had (a small cost, within the noise of four samples).
- **Tokens per turn are down 44 to 58%.**

## What changed, and what each part was worth

1. **No account connectors in the prompt.** The dispatcher's session picked up the Claude
   account's claude.ai connectors (Gmail, Docs…) as tools. It could never call them (they were
   never allowed), but their definitions were about 16K tokens of every call. The session now
   takes only Echo's own tools (`strictMcpConfig`, `disableClaudeAiConnectors`) and four
   built-in ones (Read, Glob, Grep, WebSearch).
2. **Memory trimmed per session.** memory.md is 55 KB (about 14K tokens), and all of it went into
   every call. Now the newest facts, up to about 8 KB, go in (long notes cut to their first
   sentence), in file order so the prompt cache keeps hitting; the new `recall` tool finds the
   rest by topic (lib/memory.js).
3. **Digest only when it changes.** The task digest now shows active tasks in full and
   just-finished ones by title only, says "No tasks today" when there are none (so "anything
   running?" needs no tool call), and a message whose digest didn't change since the last one
   says "unchanged" instead of repeating it (every message stays in the conversation).
4. **Fast model on by default.** Quick turns (chat, quick facts, one simple step; lib/intent.js
   `turnWeight`) go to Claude Haiku 4.5 with thinking off; anything bigger, task events, and turns
   with more context than the fast model should take go to the main model. The fast model is told
   to call `hand_off` before writing anything when a turn needs more; the rest of that turn then
   runs on the main model (checked live: the next call in the same turn came from Opus). Thinking
   off alone halved the fast model's time to first word (about 0.9 s to 0.45 s). Setting:
   `fastModel` ('auto' for Haiku 4.5, a model id, or 'off').
5. **First sentence to the voice at once** (lib/speech.js). Before, the first piece waited for a
   second sentence when the first was short, so a short reply was only voiced once it was
   finished, and a longer first piece took longer to render. A tiny opener ("Done.") still waits
   for the next sentence, and a first sentence over 12 words starts at an early comma.
6. **Instant "stop"** (lib/intent.js `isHushCommand`): "stop", "stop talking", "be quiet",
   "that's enough" silence Echo and drop the reply she's working on, with no model call, even
   mid-reply or with a card up. When she wasn't doing anything, whatever is playing pauses (never
   opening a music app to do it). "Cancel" and "never mind" still go to the assistant, since they
   can answer a card. **Scroll up/down and "go back"** act at once whenever computer use is on
   and the Mac app is there, not only inside a driving session.
7. **Parallel tool calls.** Read-only tools (get_task, list_tasks, find_contact, find_file, recall
   and a few more) are marked read-only, so the SDK runs several at once, and the prompt asks the
   model to call independent lookups together. Checked live: two get_task calls in one reply ran
   side by side. Tools that act (sending, clicking, starting work) still run one at a time.
8. **The self-improve paragraph** is only in the prompt of a copy that can change itself.

## Live logging

Each turn in `data/dispatcher-timing.jsonl` now records the model that answered, whether the fast
model handed off, and `firstSpeakMs` (time to the first piece going to the voice).
`node scripts/dispatcher-report.js` prints "first words to the voice", first token by model, and
the hand-off count, so a week of real use can confirm these numbers.

## Against the plan's acceptance criteria

| Target | Result |
|---|---|
| Tokens per turn down at least 40% | 44% (main model) to 58% (quick turns) |
| Median whole turn for quick requests down at least 35% | 65% (1.66 s to 0.58 s, from the words going in) |
| Instant intents act in under 300 ms, no model call in the log | Yes: under 1 ms of Echo's own time, no request logged |
| Quick replies start speaking in under 1.2 s (median) | First piece 0.57 s; with the voice rendering it, 1.30 s |
| No accuracy drop | Full test suite passes; the fast model hands off when unsure |

## Limits and what's left

- The bench is the dispatcher alone: it leaves out speech to text before it, and the page's own
  audio start after it (tens of milliseconds). The first-audio figure is the voice rendering in
  the same process, one piece at a time.
- Samples are small (2 rounds of each turn, 4 for the main-model-only run); the live log will
  give firmer numbers after a day of use.
- **Transcribe while talking** was left out of the first pass and is now done (next section).
  Tool descriptions weren't shortened: after the changes above, Echo's own tools
  are about 9K tokens of the remaining context and each description carries safety rules.
- The first switch to the fast model in a session writes its prompt cache (about 3.5 s once);
  after that it stays warm while you talk.

# Transcribe while talking (the last piece of step 4)

Measured on September 30, 2026, on an M3 Pro with local Whisper (large-v3-turbo).

## Where the time went

After you stop talking, the page waits for your end-of-sentence pause (1.3 s by default) to be sure
you've finished. Only then did the clip go to Whisper, which takes about 1.3 s on this Mac however
short the clip (it always works on a 30-second window; shrinking that window, whisper.cpp's
`audio_ctx`, turned turbo's output into gibberish, so it isn't used). Then came the correction pass
when a sentence needs it, then the assistant. So a plain sentence was text about 2.6 s after you
stopped, with Whisper never starting until the pause had run out.

## What changed

- **The audio streams while you talk** (public/sttstream.js, lib/sttstream.js). While a clip is
  recorded (push-to-talk, hands-free, the answer window, and the request after "Hey Echo"), its
  audio also goes to Echo over the page's WebSocket as 16 kHz PCM: the very samples the finished
  clip will hold (the page's downsampler and rounding are shared, and a test checks them byte for
  byte at 48 and 44.1 kHz).
- **Whisper starts at your pause.** At 300 ms of quiet after speech, everything so far is
  transcribed, so the text is being made while the page waits out the rest of the pause. Talking
  again drops that run and the next pause starts a new one.
- **The finished clip uses that text when it's the same speech.** The clip is still uploaded and
  goes through every check as before (silence squeezed out, Whisper's inventions dropped, the live
  text, the addressee gates, Echo's own voice). Whisper isn't asked again when the streamed audio is
  the clip's own beginning byte for byte, it reaches past the clip's last speech, it found the same
  amount of speech, and Whisper was sure of it (every segment's average log-probability -0.5 or
  better). If any of that fails, the clip is transcribed whole, exactly as before. On unclear audio
  a slightly different clip can come back as a different guess, which is why unsure text isn't
  reused (about 1 turn in 5 in the speech log).
- **Your words so far show live.** Every second of new speech, what's been said is transcribed and
  sent to the page for the caption, but only when the browser's own live preview shows nothing (it
  does in about 9 of 10 page turns). A Whisper run can't be shared, so a partial under way is
  dropped the moment you pause.
- **The turn is prepared at the pause.** When the pause's text is ready and you're still quiet, the
  server checks it for an instant command ("stop", "scroll down", "next song"): if it is one, the
  page ends the clip at once instead of waiting out the pause. Otherwise, for push-to-talk and
  "Hey Echo" requests, the correction pass starts and the assistant switches to the model the turn
  will use; the finished clip uses that correction when the words match. Hands-free speech is never
  sent to the correction pass (a cloud model) before the addressee check. With the default 1.3 s
  pause, Whisper usually finishes just after the clip arrives, so this mostly helps with a longer
  end-of-sentence setting.
- **Unchanged:** the wake word, the end-of-speech pause, the stray-phrase filters and the gates.
  Deepgram (paid per minute) is never asked twice: only local Whisper streams.
  `ECHO_STREAM_STT=off` turns streaming off. The speech log's `stages.stream` says for each
  turn whether the early text was used and, if not, why; `GET /api/stt` counts both.

## How it was measured

`scripts/listen-bench.js` speaks each request with a macOS voice (Rishi, Indian English), adds room
noise before and after, and plays it in real time, 21 ms at a time at 48 kHz, through the page's own
end-of-speech detector (1.3 s of quiet). Then it runs what `POST /api/utterance` does for a
push-to-talk clip, twice per clip, alternating the order: **before** (the clip goes to Whisper once
it's finished, then the correction pass, then the assistant: the pipeline as it was at the base
commit) and **after** (streaming as above). It times from the moment the last word has been
captured to "text ready" (the words handed to the assistant) and "reply starts" (the first piece of
the reply goes to the voice; for an instant command, the moment it acts). A throwaway data folder
(copies of the live memory, settings, projects and vocabulary), a throwaway whisper-server on a free
port, no AppleScript, real model calls.

```
node scripts/listen-bench.js --model <ggml-large-v3-turbo-q5_0.bin> --from <live data> --rounds 2 --partials off
node scripts/listen-bench.js --model <…> --from <live data> --rounds 1 --partials on --no-reply --clips <live data>/stt-clips
```

The turns: four quick questions, one harder request, one with a 0.6 s pause mid-sentence ("Tell me a
fun fact … about octopuses"), and three instant commands. `--partials off` is the usual case (the
browser's live preview shows your words, so no Whisper partials); `--partials on` is the worst case
(every second of speech also gets a Whisper partial). `--clips` replays the 20 clips Echo kept from
real use (their words aren't printed or saved).

## The numbers (medians, from the moment you stop talking)

Usual case, with the assistant replying (2 rounds):

| Turns | Before: text ready | After | Before: reply starts | After |
|---|---|---|---|---|
| Quick questions (n=8) | 2.67 s | **1.69 s** | 3.19 s | **2.27 s** |
| With a pause mid-sentence (n=2) | 2.64 s | **1.68 s** | 3.41 s | **2.36 s** |
| Instant commands (n=6) | 2.62 s | **1.63 s** | 2.62 s | **1.63 s** |
| Harder, main model (n=2) | 2.62 s | **1.64 s** | 5.44 s | 7.70 s |
| **All (n=18)** | **2.64 s** | **1.67 s** | **3.18 s** | **2.22 s** |

- **The reply starts about a second sooner (3.18 s to 2.22 s, 30% less)**, and the text is ready
  1 s sooner in every kind of turn. Of the 1.67 s left, 1.3 s is the end-of-sentence pause itself.
- The harder turns' reply time is the main model's own variance: the text was ready 1 s sooner in
  both, and one of the two replies took 8 s to start (the other 5.4 s against 4.9 s before).
- The same text came back with and without streaming in 18 of 18 turns.

Worst case and real clips (text ready only, 1 round):

| Clips | Before | After | Early text used |
|---|---|---|---|
| Spoken requests, Whisper partials on (n=9) | 2.73 s | **2.07 s** | 9 of 9 |
| Your 20 kept clips, partials on | 2.72 s | **1.89 s** | 16 of 20 |

- With partials on, a partial under way when you pause costs about 0.5 s (a dropped Whisper run
  still finishes its first half), so it's 0.7 s sooner rather than 1 s.
- In the 4 kept clips that weren't reused, Whisper wasn't sure of the words, so they were
  transcribed whole as before. Before that rule, 2 of your clips (both unclear, with low
  confidence) came back with different words each way; with it, the text matched in 29 of 29.

## Limits and what's left

- **The Mac app's own mic doesn't stream yet.** It records in the app (macos/Sources/NativeMic.swift)
  and sends the whole clip when you stop, so its turns take the old path (about 1 in 5 turns on
  September 29). Streaming it needs the app to send its audio as it records, and a rebuild.
- Whisper itself (about 1.3 s a run on this Mac) is now the limit: the text is ready about 0.3 s
  after the pause runs out. A faster Whisper, or a shorter end-of-sentence pause, would show here
  directly.
- Samples are small (2 rounds of 9 turns, with one voice); `stages.stream` in the speech log will
  show how often the early text is used in real use.
