# Baseline, October 2026 (build plan step 1)

The "before" numbers for the build plan. Every later step that touches speed or accuracy is
compared against this file.

## How it was measured

- **When:** September 30, 2026, on main at `27f390f` (self-improve #128).
- **Window:** since the speech-correction work merged: #124 at 2026-09-29 15:02 EDT and #127 at
  15:22 EDT. The plan asked for a week, but only about 21 hours had passed, so the window is short
  and the sample sizes are small (noted by each number). For context, the same numbers are also
  given for the days before #124 (September 25 to 29).
- **Data:** copies of the live logs (`dispatcher-timing.jsonl`, `computer-log.jsonl`,
  `stt-log.jsonl`, plus vocabulary, contacts and projects for the correction replay) in a
  temporary data folder (`ECHO_DATA_DIR`). Nothing was written to the live data and the live
  port wasn't touched.
- **Commands** (run with `ECHO_DATA_DIR` set to the copy):

  ```
  node scripts/dispatcher-report.js <copy>/dispatcher-timing.jsonl --since 2026-09-29T19:02:53Z
  node scripts/computer-report.js <copy>/computer-log.jsonl --since 2026-09-29T19:02:53Z
  node scripts/correction-replay.js <copy>/stt-log.jsonl --since 2026-09-29T19:22:35Z   (script removed Oct 3 with the correction model)
  ```

  "Before" numbers come from copies filtered to lines before 2026-09-29T19:02:53Z.
- **Slowest 10%** is the 90th percentile (p90). **Median** is p50.
- Two numbers were added to the reports for this baseline: tokens per turn (dispatcher report)
  and likely false success (computer report). See "Report changes" below.

## The numbers

| Measure | Since #124: median | Since #124: slowest 10% | n | Before #124: median | Before #124: slowest 10% | n |
|---|---|---|---|---|---|---|
| Whole turn | 4.97 s | 21.78 s | 61 turns | 4.76 s | 10.22 s | 314 |
| First token (per model call) | 0.93 s | 1.67 s | 122 calls | 1.07 s | 2.10 s | 532 |
| Model call | 2.17 s | 4.77 s | 122 | 2.44 s | 4.96 s | 532 |
| Model calls per turn | 1 | 4 | 61 | 1 | 2 | 314 |
| Speech to text | 1.39 s | 1.57 s | 14 sentences (since #127) | 1.45 s | 2.32 s | 546 |
| Correction pass | 0.01 s | 0.92 s | 14 (since #127) | 1.01 s | 1.95 s | 546 |
| Input tokens per turn (cached or not) | 61K | 271K | 59 | 80K | 156K | 313 |
| Uncached input tokens per turn | 0.9K | 10.5K | 59 | 0.7K | 6.2K | 313 |
| Context per model call | 62K | 84K | 122 | 57K | 72K | 532 |

| Computer use | Since #124 | Before #124 |
|---|---|---|
| Runs | 4 (all in Chrome) | 26 |
| Finished as done | 0 of 4 (0%): 2 stopped from the caption bar, 2 went idle | 3 of 26 (12%) |
| Steps per run, median | 8 | 6 |
| Time per step, median / slowest 10% | 3.8 s / 50.3 s | 5.6 s / 51.0 s |
| Actions confirmed on screen | 100% of the actions that ran; 3 steps came back "not confirmed" and Echo was told not to claim them | not recorded (older driver) |
| Likely false success (ended "done" without a confirmed last step) | 0 of 0 done runs | can't tell: the 3 done runs predate verification |
| Safety prompts (confirm asked) | 2, both allowed | 11 |

## What the numbers say

- **The correction pass got much faster (#127 works).** Since #127 the smart pass ran on 2 of 14
  sentences (14%, down from 97%), and its median fell from about 1 s to 0.01 s. The slowest 10%
  is still about 0.9 s, when the smart pass does run. Replaying the week before #127 through the
  new gate: it would skip 351 of 540 sentences (65%), saving about 1.1 s each, and would have
  missed 11 fixes that matter (mostly names and unusual words) plus 41 wording-only fixes. The
  replay exits with a failure code because of those 11; that is the known trade-off of #127, not
  a new problem.
- **Speech to text is steady** at about 1.4 s median, and the slowest 10% improved (2.3 s to
  1.6 s), on a small sample.
- **First token got a little faster**, but **the slowest 10% of whole turns doubled** (10 s to
  22 s), because more turns needed several model calls (slowest 10% went from 2 to 4 calls).
  The window included the Chrome computer-use sessions, which likely account for most of them
  (not checked turn by turn). Tokens per turn in the slowest 10% rose to match
  (156K to 271K), since each call re-reads the whole context. Cached reads keep the uncached part
  small (median under 1K tokens).
- **Computer use isn't finishing.** No run since #124 ended as "done"; people stopped them or they
  went idle. Nothing claimed success it didn't have (no false successes), but there's also very
  little success to measure. This is the number steps 3 and 6 should move.
- **Hearing volume is low since the merge.** The speech log has no entries on September 30, while
  the assistant still had 10 turns that day (typed, or through a path that doesn't log speech).
  Only one "not for Echo" drop was logged since #124. Worth a look before step 2 builds its
  replay set from this log.

## Report changes made for this baseline

- `scripts/dispatcher-report.js` now prints **input tokens per turn** (the context of every model
  call in the turn, added up) and **uncached tokens per turn** (cache writes plus plain input).
- `scripts/computer-report.js` now prints **likely false success**: runs that ended "done" whose
  last step wasn't confirmed on screen, or had an unconfirmed step after the last confirmed one.
  Runs from before the verify driver are counted as unchecked. This is a proxy; real labels come
  with step 2.

## Limits

- About 21 hours of data after the merges, not a week. Re-run the same commands after a full week
  of normal use to firm up the numbers (the commands above are all it takes).
- The correction replay assumes the recognizer flagged no unsure words, so it's a worst case for
  the gate (fewer sentences run the smart pass than really would).
