# Speech: before and after (Sept 26, 2026)

Measured with local Kokoro (af_heart, speed 1.25) on this Mac, the reply streaming at ~250 characters a second. "First audio" is from the moment the reply starts streaming; the quick acknowledgement ("Sure, checking.") still plays the instant you stop talking, before that.

| Reply | Before: pieces | First audio | After: pieces | First audio |
|---|---|---|---|---|
| "Hey there! What's up?" | 2 | 0.55 s | 1 | 0.64 s |
| "Yep, all done. Nothing's running right now." | 2 | 0.63 s | 1 | 1.17 s |
| Job-search reply (3 sentences, 19-word opener) | 5 | 0.72 s | 3 | 2.65 s |
| Build reply (long opener, 2 sentences after) | 7 | 1.02 s | 3 | 2.57 s |

- Before: pieces were cut at commas or ~7 words. Kokoro says every piece as a finished thought and pads each one with ~0.25 s of silence before and ~0.35 s after, so there was ~0.6 s of dead air at every comma. That's the "reading word by word" sound.
- After: whole sentences, two short ones in a single request; the padding is trimmed and replaced by a 0.1-0.25 s pause that depends on the punctuation. Total speaking time for the longer replies dropped by about a second (fewer gaps).
- Cost: first audio is unchanged for short replies, and 1.5-2 s later when the reply opens with a long sentence. The prompt now asks Echo to open with a short first sentence, and a first sentence over ~20 words still starts at a comma.
- ElevenLabs: each piece is sent with the one before it (`previous_text`), so the intonation carries across pieces.

Blank transcriptions: see `data/stt-log.jsonl` entries with `"event": "blank_final"` (clip path, loudness, mic state and a likely cause) and the clips in `data/stt-blank-clips/`.
