# Why Echo misheard project names, and what changed

Findings from a night when one project name was misheard every time it was said, in an Indian-English accent. The project name is written "Project O" below, so no personal names end up in the package.

## What went wrong

1. **Whisper spelled the name wrong, and the corrector then made it worse.** Whisper heard a made-up word. The correction step (a small, fast Claude model) saw that nothing sounded like it and swapped in *a different project*, the first one in its vocabulary list. It did flag the new name as unsure, but Echo still acted on it and ran a check on the wrong project.
2. **Whisper's prompt barely helped.** Echo gives Whisper a list of expected words. That list was about 680 characters: every project folder (including "empty", "Rename" and folder digits like "Name2"), then food words, places and brands. whisper.cpp keeps only the last ~220 tokens of a prompt, and a long list weakens the bias anyway. On test clips, the prompt raised names heard correctly from 2 of 12 to only 4 of 12.
3. **The turbo model is weak on unusual names in this accent.** Even with a good prompt, large-v3-turbo gets 7 of 12. It hears the project name as a common surname every time.
4. **Spelling it out didn't help.** Spelled letters were taken exactly as heard ("O-C-S-I-O"), so a letter the recognizer dropped made the spelling itself wrong, and the spoken word was then "corrected" to that wrong spelling.
5. **Audio: Echo's own voice could start a clip.** The mic keeps the last 350 ms before you start talking so first syllables aren't cut. That buffer kept filling while Echo spoke, so pressing Space to cut her off could start your clip with the end of her sentence. Echo cancellation was already requested from the browser, and hands-free already pauses the mic while she speaks (there's no barge-in), but nothing recorded whether the browser actually turned echo cancellation on.

The garbled "echo, hello, echo, echo…" clip can't be pinned down after the fact: no audio was kept for clips that weren't blank. It came 5 seconds after one of Echo's replies, so her voice leaking in is possible; Whisper also tends to repeat prompt words ("Echo" was in the prompt) when audio is unclear. Both are addressed below, and clips are now kept so the next one can be checked.

## What changed

- **A short, focused Whisper prompt** (`whisperPrompt` in `lib/vocab.js`): at most 320 characters, only names Whisper wouldn't spell right on its own (no ordinary English words), without folder digits ("Name2" is said "Name"), never aliases (those are mishearings), and with the most important names last: projects you have nicknames for, then recent projects, then contacts and your own words.
- **The full large-v3 model when it's downloaded** (`whisperModel` in `lib/stt.js`). Get it with `npm run setup:whisper -- --accurate` (about 1.1 GB); Echo uses it after the next restart. Without it, Echo keeps using turbo.
- **The corrector can't swap in a name you didn't say** (`guardCorrection` in `lib/correct.js`). A project or contact name only goes in when it sounds like the heard words, or the heard words are a confirmed nickname or a learned mishearing of it. Otherwise the words stay as heard and are marked unsure, so Echo asks. The model is also given the confirmed nicknames and told never to pick a project by elimination.
- **Spelled letters are matched to known names** (`matchSpelled`): letters within 1 (short names) or 2 (5+ letters) of a project, contact or vocabulary word become that name. If two names are equally close, nothing is guessed.
- **Echo's voice is kept out of the mic** (`public/app.js`): while she speaks and for 400 ms after, the pre-roll buffer stays empty and hands-free ignores sound. Each clip records whether echo cancellation was really on (`audio.aec` in `data/stt-log.jsonl`).
- **The last 20 clips are kept** in `data/stt-clips`, named in each speech-log entry with their length and loudness. They're personal data: the privacy check keeps them out of packages, and Reset deletes them.

## Measurements

8 clips made with macOS's Indian-English voices (Rishi, Aman, Tara), each with 1 or 2 project or contact names, 12 names in all. Run with `node scripts/stt-bench.js` on an Apple Silicon Mac. Latency is per clip with the model warm.

| Model | Prompt | Names right | Word error rate | Median time |
| --- | --- | --- | --- | --- |
| large-v3-turbo | none | 2 / 12 | 21% | 0.66 s |
| large-v3-turbo | old (long list) | 4 / 12 | 17% | 0.69 s |
| large-v3-turbo | new (short) | 7 / 12 | 9% | 0.71 s |
| large-v3-turbo | new, beam search 5 | 7 / 12 | 12% | 0.74 s |
| large-v3 | none | 2 / 12 | 21% | 0.98 s |
| large-v3 | old (long list) | 9 / 12 | 13% | 1.06 s |
| **large-v3** | **new (short)** | **12 / 12** | **5%** | **1.06 s** |

Beam search didn't help, so it's left off. Synthetic voices aren't a real speaker: the clips Echo now keeps can be used to check with real speech.

# Sep 27 regression: "Echo cannot listen to me properly anymore"

After the change above, turns came out garbled ("Water vehicle, make them.", "We have our own words to fix its offering and the home of the moment of this."), cut short ("Hey, Missa, I'm"), with a made-up "you" on the end, and "Thank you" / "Thanks" / "Yeah" turns appeared that were never said. The live preview often showed the right words while the final text was wrong.

## What was really wrong

Checked against the 13 clips Echo kept that day (`data/stt-clips`), replayed through whisper.cpp:

1. **Silence inside the clip, not the prompt or the model.** Push-to-talk clips held 3 to 7 seconds of digital silence before the first word, long pauses between sentences and up to 20 seconds after. On those, turbo skipped whole sentences (a 62-second clip with about 17 seconds of speech came back as two short sentences) and made others up. Every prompt (none, the old long one, the new short one) gave the same garbled output on the same clips. This isn't new, but clips got longer.
2. **The model never changed.** large-v3 was never downloaded on this Mac, so Echo was still on turbo. Tried on the real clips, large-v3 is *worse* for this voice (see below), so Echo no longer picks it by itself.
3. **Clips with no speech at all still went to Whisper.** A click or a breath (0.26 to 0.30 s of sound) came back "Thank you.", "Thanks.", "Yeah." Whisper's `no_speech_prob` is always about 0 in whisper.cpp, so it can't be used to catch this.
4. **The corrector wasn't it.** For every bad turn, the corrector's output matched Whisper's word for word.
5. **The shorter prompt did cost one phrase.** It dropped "launch that project" (in your words list, an ordinary-English phrase), and "Can you launch that project?" came back "And you launch the closet." With the silence squeezed out, the short prompt gets it right too.
6. **Talk that wasn't for Echo.** Two long clips (17:13 and 17:14) are a steady voice for 30 seconds: very likely other people or a video, recorded because the mic stayed open.

## What changed

- **Silence is squeezed out before Whisper hears a clip** (`squeezeSilence` in `lib/heard.js`): speech is found against the clip's own noise floor, kept with 150 ms of padding, and every pause is cut to 300 ms. A clip with under 200 ms of lasting sound (clicks don't count) never goes to Whisper: "Didn't catch that."
- **Whisper's inventions are dropped** (`cleanHeard`): a stock silence phrase Whisper tacks on as its own last segment ("you", "Thank you.", "Thanks for watching") unless the live preview heard it too, a lone "you", and a lone "Thank you" / "Thanks" / "Bye" when there was barely any speech (under 400 ms) or the live preview was on and heard nothing. A segment Whisper was guessing at (average log-probability under -1.0) is dropped; if every segment was a guess, it's "Didn't catch that."
- **The live text wins when the final is a different sentence** (under 35% of the live words in it, at least 6 live words), not just a name spelled differently.
- **Every turn logs every stage** in `data/stt-log.jsonl`: the live text, Whisper's text with each segment's confidence, what was dropped and why, which text was used, and the corrector's output.
- **turbo again, not large-v3**, even when large-v3 is downloaded (`VOICEOPS_WHISPER_MODEL` still picks any model).
- **Click-to-talk stops by itself** (the mic button or the Mac menu, not Space held): 2 s after you stop talking (or your end-of-sentence pause, if longer), or after 8 s with no speech, so an open mic doesn't record the room.
- **Hands-free only answers speech for Echo** (new setting, on by default: "Hands-free: only answer when I say Echo"): the turn needs "Echo" in its first words or as its last word, or has to come within 15 s of her reply. Anything else is logged as `not_for_echo` and ignored.
- **Echo's own voice is never a turn:** on top of the mic ignoring her while she speaks (and for 400 ms after), a turn made almost entirely of her last reply's words is dropped (`own_voice`).
- Kept from before: the short prompt (it helps names), the corrector's guard, echo cancellation and the echo tail.

## Measurements

`node scripts/stt-bench.js --clips DIR/clips.txt --prompts prompts.json` on an Apple Silicon Mac, turbo unless noted. "Before 55" is the old long prompt on the whole clip; "current" is task 55's short prompt on the whole clip; "fixed" is the short prompt with the silence squeezed out and the clean-up. Word error rate counts every word of the spoken clips; made-up turns count any text for a clip where nothing was said.

**Your own saved clips** (7: the 4 "Thank you" / "Thanks" / "Yeah" clips you said were silent, and 3 spoken ones whose words are known: two where you repeated yourself, and the one the live preview showed correctly):

| Setup | Word error rate | Made-up turns | Median time | Slowest |
| --- | --- | --- | --- | --- |
| Before 55 | 15% | 4 of 4 | 1.33 s | 2.74 s |
| Current | 37.5% | 4 of 4 | 1.31 s | 2.72 s |
| **Fixed** | **15%** | **0 of 4** | **1.32 s** | **1.41 s** |
| Fixed, large-v3 | 30% | 0 of 4 | 1.73 s | 2.15 s |

**Indian-English test clips** (Rishi, Aman, Tara from macOS: 15 requests with realistic pauses before, between and after sentences, 20 names; plus 6 clips with only clicks, a breath, room noise or silence):

| Setup | Word error rate | Names right | Made-up turns | Median time | Slowest |
| --- | --- | --- | --- | --- | --- |
| Before 55 | 11.9% | 15 / 20 | 3 of 6 | 1.36 s | 3.43 s |
| Current | 6.6% | 17 / 20 | 5 of 6 | 1.34 s | 2.14 s |
| **Fixed** | **4.0%** | **17 / 20** | **0 of 6** | **1.34 s** | **1.39 s** |
| Fixed, no prompt | 8.6% | 13 / 20 | 0 of 6 | 1.32 s | 1.39 s |
| Fixed, large-v3 | 2.6% | 19 / 20 | 0 of 6 | 1.78 s | 2.11 s |

No spoken clip was lost by the clean-up in either set. large-v3 wins on synthetic voices but doubles the errors on your real voice and is 0.4 s slower, so turbo stays. Only one real clip has a known transcript for the live-versus-final rule, so its threshold is deliberately loose. The per-stage log will show how often it fires.

# "Hey Echo": the wake word (1.2.0)

Say "Hey Echo" (or just "Echo") to talk, as well as holding Space. On by default; Settings has the switch and a sensitivity slider (strict, normal, loose), and the "Hey Echo" pill at the top shows the listener is on and turns the mic off completely (Space still works then, and the mic is let go right after).

## How it works

- **The page listens locally** (`public/wake.js`). A loudness detector with an adaptive noise floor runs on every mic frame. Only a burst of speech (120 ms of sound after quiet) is looked at, and only its first 1.8 s, or less if it ends sooner. Clicks and coughs (under 180 ms of sound) are never checked.
- **This Mac's Whisper decides** (`POST /api/wake`, `lib/wake.js`). The burst goes to the local whisper-server that already runs for transcription, never to Deepgram or any other service. The audio and the words are not logged or saved; the server only counts checks and wakes (`GET /api/stt`). No match: the audio is dropped, and the rest of that burst is left alone.
- **Accent-tolerant matching.** Her name has to open the burst, with only greetings in front ("Hey", "Hay", "A", "Okay"): "Echo", "Eko", "Ecco", "Heiko", "A echo", "Hey Co". Near misses ("Ego", "Eggo", "Echoes") only count after "Hey", or at the loose setting. Her name further into a sentence ("the echo of…", "…, Echo?") doesn't wake her, and neither do hyphenated words ("Eco-friendly"). A segment Whisper was only guessing at counts for less.
- **No prompt for the wake check.** With "Hey Echo." as Whisper's prompt, it heard "Echo." in 6 of 19 of your own clips that never said it (room noise, pauses). With no prompt: 0 of 19, and it still caught all 3 of your "Hey Echo"s.
- **On a match:** a soft two-note chime, the sunset lights up, and your request is recorded until a natural pause (your end-of-sentence setting). "Hey Echo, check the build" in one breath keeps everything after her name; "Hey Echo" … pause … "check the build" waits up to 6 s for the request. The whole recording goes through the usual pipeline (silence squeezed out, Whisper's inventions dropped, the corrector), and the server takes "Hey Echo" off the front (`stripWake`).
- **Never her own voice:** the listener is muted while she speaks and for 400 ms after, and a check in flight is thrown away when she starts. Echo cancellation stays on, and a turn that's just her last reply is still dropped.
- **Answering her question:** when her reply ends with a question, the next 6 s are taken as your answer without "Hey Echo".
- **Hands-free** (the toolbar switch) is separate: it sends every sentence and, with the wake-word setting on, only answers ones that say "Echo". The wake listener is off while hands-free is on.
- Needs local Whisper (`npm run setup:whisper`); without it the pill doesn't show and Space works as before. The Mac app already grants the microphone to Echo's own page and plays audio without a click, so the listener starts as soon as the window opens. In a browser it starts after your first click or key press (browser audio rules).

## Measurements

`node scripts/wake-bench.js --make DIR`, then `node scripts/wake-bench.js --clips DIR/clips.txt --tv DIR/tv.wav`, on an Apple Silicon Mac with turbo, normal sensitivity. The bench runs the page's own listener and the server's matcher on 20 ms frames with silence around each clip.

| Recordings | Clips | Woke |
| --- | --- | --- |
| Your own "Hey Echo", cut from a saved clip (Indian English, real voice) | 3 | **3** |
| Your other saved clips (requests without her name, room noise, other voices) | 19 | **0** |
| "Hey Echo" / "Echo" / "Hey Echo, <request>" in Indian-English voices (Rishi, Aman, Tara) | 21 | 20 |
| The same in US, UK, Australian and Irish voices | 28 | 27 |
| Indian-English "Hey Echo" over a TV voice and pink noise | 12 | 10 |
| Speech not for Echo (14 lines, 7 voices: "The echo of the canyon", "Hey Ethan", "A long time ago", "Hey everyone…") | 98 | **0** |
| 163 s of TV-like talk in 7 voices (incl. "Echoes of the past", "Eco-friendly homes") | 57 checks | **0 false wakes** |

**Sensitivity** (synthetic clips): strict (needs "Hey") woke on 13 of 21 Indian-English and 6 of 12 over-TV clips; loose woke as often as normal but 3 times in the 163 s of TV ("Echoes of the past…"). Normal, the default, had no false wakes anywhere.

The misses were Whisper hearing "Hey, hey, go.", "Hey, I go." and "Here go!", and one "Hey Echo" lost under the TV voice. Every one-breath request came through with "Hey Echo" taken off ("What is the weather today?").

**Speed:** a wake check takes about 1.3 s (median; slowest 2.6 s) with turbo, so the chime comes a moment after you finish "Hey Echo". Recording already continues during the check, so nothing you say is lost.

**CPU:**

| | CPU |
| --- | --- |
| The page's listener on every frame (measured in Node on 25 minutes of audio) | 0.01 to 0.02% of one core |
| Echo's server at idle | ~0.05% |
| whisper-server at idle (loaded, no checks) | ~0.3% |
| whisper-server while a TV talks nonstop (a check every ~3 s) | 0.9% |
| The whole Echo tab in headless Chrome, silent mic, wake word on / off | 2.6% / 3.4% (the difference is noise; the tab's cost is its animation) |

The mic frames now come from the audio worklet in blocks of 1024 samples instead of 128, so the page handles 8 times fewer messages.

## Not done yet

- A dedicated keyword model. openWakeWord would need a custom "Hey Echo" model trained first, and Porcupine needs an account key; a tiny local Whisper model (tiny.en or base.en) just for wake checks would cut the 1.3 s to about 0.1 to 0.2 s.
- Synthetic voices and a synthetic TV aren't a real room: the counts on your own voice are small (3 wakes, 19 others). The server counts checks and wakes (`GET /api/stt`), so a week of real use will show the rate.
