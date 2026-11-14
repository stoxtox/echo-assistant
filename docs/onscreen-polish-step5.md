# On-screen polish (build plan step 5 / plan step 8)

What was asked, what was already there, and what this pass changed.

| Ask | State before | This pass |
|---|---|---|
| Orb idle breathing, 4–6 s cycle | 5.5 s scale breath (Core Animation, frame loop stopped) | Kept 5.5 s, added a soft sunset glow behind the orb that swells and eases with each breath (`RestMath.glow`) |
| Occasional shimmer every 20–30 s | One shimmer on a fixed 16 s beat | A keyframe track of six sweeps at random 20–30 s gaps (`RestMath.gaps`, `RestMath.shimmerTrack`), the first 12–20 s after the orb settles; a fresh rhythm each rest |
| Reduced motion | Orb simply still | A still, soft glow; no breath, no shimmer |
| Caption pill never empty | Closes to just the orb (task 118) | Unchanged |
| One status chip, no stacking | Mac app: one corner chip (task 116). Window: banner and look pill, look pill hidden while driving | Window: both are now the same small 24 px chip ("Looking", "Driving · step 2", compact Stop); the full sentence is the VoiceOver label and tooltip |
| Thin sunset edge line | 1.5 pt coral → tangerine line with a breathing glow (task 116) | Unchanged |
| Typing character by character, caret glow, orb bobbing, glints, long texts faster | Done (`TypingMath.plan`, capped at 3 s) | Added the finishing shimmer: one soft band over the typed line once the text is in (`TypingMath.shimmerSpan`); none with reduced motion, none on a tall field with no caret |

Safety and checks are untouched: passwords and codes are refused before and during typing, the
first-character probe and paste fallback are the same, and `checkTyped` still reads the field back
and decides whether the step worked. The shimmer is drawn on Echo's own overlay, never in the field,
and only when the typing step itself reported no error.

CPU: the idle breath, glow and shimmer are Core Animation animations run by the window server, with
Echo's frame loop stopped (as before). The typing shimmer is one short layer animation per typed
field.

Needs a Mac app rebuild (`npm run build-app`) for the orb and the typing shimmer. The window chip
shows after a reload.

Tests: `macos/Tests/main.swift` (RestMath gaps, track and timing; the shimmer span),
`test/phase2.test.js` (the rest wiring), `test/computer.test.js` (the typing shimmer only when the
text went in, and the read-back check unchanged).
