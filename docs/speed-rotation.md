# Dispatcher session rotation: before and after

Measured Sep 28, 2026 on the live dispatcher transcript (read-only), 21:00–02:36 UTC, 618 model calls.
Reproduce with:

    node scripts/rotation-replay.js ~/.claude/projects/-Users-me-ProjectX/<session>.jsonl --since 2026-09-28T21:00:00Z

| | before (measured) | after (replayed estimate) |
|---|---|---|
| context per call, p50 | 716K | 49K |
| context per call, p90 | 920K | 60K |
| context peak | 966K | 74K |
| latency per model call, p50 | 3.8 s | ~2.1 s |
| input-side cost | 100% | ~10% |
| fresh sessions | 0 | 23 (about one every 13 min) |

How "after" is estimated: the same per-call context growth is replayed, but a fresh session
(system prompt ~32K + a ~3K seed) starts at the first turn boundary past 60K. Latency maps each
call's new context size to the median the transcript measured at that size (0–100K: 2.1 s over 87
calls; 800–900K: 4.4 s over 143 calls). Cost counts cache reads at 0.1x and cache writes at 1.25x the
input price; output tokens are unchanged. The summary model (Haiku) adds one small call per rotation.
p90 "after" is not meaningful from this method (it uses bucket medians).

Synthetic check (test/rotation.test.js, 120 turns with a fake SDK): one session peaks above 300K;
with rotation the peak stays under ~65K and total tokens re-read drop more than 4x.

After merging, compare real numbers with `node scripts/dispatcher-report.js --since <date>`.

A reply that asks something ("Should I book it?") holds rotation for about a minute (`ANSWER_HOLD_MS` in lib/dispatcher.js, counted in `busyWithUser`), so the answer lands in the session that asked, with the cache still warm; only the hard token cap rotates sooner.
