# Teaching mode

Design: research task 138, `_research/echo-intuitive-teaching-mode/teaching-mode-design.md` (Sept 30, 2026). This page tracks what's built.

## Built

- **R1, the teaching rules** (`computerPrompt` in `lib/computer.js`). When the user is learning, the assistant gives one action per turn (about 12 words, verb first), points first and checks before the next step, repeats the current step word for word on "repeat", names cells by address (never "next to"), never says "drag" without where to grab, warns about the fill handle once, offers undo when something else changed, and corrects by address without saying "wrong". The Name Box recipe is only for doing it for the user, never while teaching.
- **R4/T6, the teach engine** (`lib/teach.js`, tests in `test/teach.test.js`). `TeachSession` runs a lesson in the background: `start()` returns at once, then every 500 ms it polls the step's check through an adapter.
  - One step at a time: point, update the card, speak `say` once. A check must hold for two polls in a row.
  - Pass: short praise (or "That works too." when the user got there another way: an `any_of` branch other than the first, or a later step already done). 600 ms, then the next step.
  - Collateral changes first, always at once: cells outside the step's expected cells changed (a fill-handle copy, a lost formula) → "Oops, that changed B3 to B5 and removed a formula. Say "undo" and I'll fix it." The step can't pass until it's fixed.
  - Near-misses, at most one per 10 seconds, re-pointing at the target: a selected cell or a value in the wrong place ("That's C5. We want A5, two cells to the left."), a typo ("Almost. It says Cofee. Try Coffee."), a formula typed as text, a wrong range ("That adds B2 to B3. We want B2 through B4."), and lesson-declared `near_miss` checks for other apps ("That's Display. We want Wi-Fi."). Three misses on one step tell the model, so it can offer to show them.
  - Edit mode (the adapter throws or says `editing`) is silence, and counts as activity.
  - Idle: 20 s re-points and replays the step; 45 s speaks the hint and offers to show them; 2 minutes pauses the lesson and tells the model.
  - Voice commands without a model call (`hear()`): repeat, show me (runs the step's demo, or speaks the hint), next/skip, back, pause, go on, stop, done (check now), undo/oops (⌘Z through the adapter, compares with the step's starting snapshot, puts back any cells undo missed, then replays the step's drag-free `alt_say`). Anything else pauses the watch for 15 seconds and returns the lesson context for the model.
  - End: the last praise is spoken, and the model is asked to sum up in one sentence.
  - `validateLesson`/`lintSay`: 1 to 12 steps, a known check each, and the spoken-line rules (≤ 14 words, one action, no "and then", no "next to"/"beside", "drag" says where to grab).
  - `labelAdapter(bridge)` answers `label_present` checks through the Mac app's `wait` request (Accessibility only), so lessons outside Excel work too: open a menu, then click inside it.

- **Phase 0 of the universal plan** (`_research/universal-teaching-and-computer-use-plan-for-ech/MASTER-PLAN.md`): lessons in any app, without an app adapter.
  - **The `teach` tool** (`computer.js`): the assistant writes the lesson from what it knows plus what it just saw. It's refused when the lesson breaks the rules (`validateLesson` with the spoken-line lint), when the Mac app is too old to report state, or when step 1's target isn't on screen ("never say a step whose target you haven't found"). It returns at once; the lesson speaks every step itself.
  - **General checks** (`evalCheck`): `app_front`, `window_title`, `menu_open`, `url_contains`, `focused`, `field_value`, `element_state` (selected, expanded, checked, enabled), `element_value` (equals, contains, approx ± tolerance), `label_gone`, next to `label_present` and the Excel ones.
  - **`uiAdapter`**: one read-only `state` request per poll to the Mac app (`Driver.state`: the click checks' snapshot plus the named controls' state, matched by `StateMath.match`). No screen capture, and it works with computer use off.
  - **No false pass on a check that was already true**: if a step's check holds before the user does anything, the step also needs something on screen to change, and the model hears `weak_check`.
  - **General near-misses**: another app in front ("That's Reminders. We want Notes."), a typo in the field, a value not there yet ("That's 55. We want about 70.").
  - **Voice** (`dispatcher.js`): during a lesson its commands are handled with no model call; anything else pauses the watch and reaches the main model with the lesson's step. Reports (struggling, idle, finished, stopped, weak check) reach the model through `notify`. Escape stops the lesson.
  - **Log**: `data/lesson-log.jsonl` (started, each step passed with its time, hints, commands, questions, targets not found, the ending), to measure lessons.
  - Needs the rebuilt Mac app (`npm run build-app`) for the `state` request.
- **Phase A of the live tutor plan** (`LIVE_TUTOR_PLAN.md`, after the Oct 1 Adobe XD lesson):
  - `labelAdapter` waits in `present` mode (a label already on screen counts) and, when allowed (`screenAware`), reads the screen's text at most every 3 s when Accessibility finds nothing.
  - `isProgressTalk`: "alright, I did", "seems like I did", "I got it, now what next?", "what's next?" are the `done` command (check now, answered from the screen).
  - Questions set a quiet window (`quietUntil`) instead of pausing the watch; lines are held (`heldLine`) and said at `endQuiet()` (the dispatcher calls it on `reply_end`; `resume()` too).
  - Check-ins: 20 s "Still with me?" plus the step; 45 s the hint, "Want me to show you?", and a `stuck` report asking the model to fix a step that can't work; 2 minutes a spoken pause.
  - `replaceSteps` and the `lesson_control` tool (stop, pause, resume, skip, replace_steps). Steps can say their `gesture`; a `drag` has `from` and `to`, points at `from`, and passes the lint as one action.
  - Lessons and opinion questions always go to the main model (`turnWeight`); `teach` and `lesson_control` are main-model tools.
- **When Echo can't see** (Apple Vision text reading took 38 s on macOS 27): `labelAdapter` gives the screen-text read `TEACH_SCREEN_TEXT_MS` (2.5 s) and turns it off for the lesson if it's slower or fails (`onScreenOff`, logged `screen_text_off`); every request is bounded by `TEACH_REQUEST_MS` (3 s). `uiAdapter` returns `{ error }` instead of throwing (a throw still means "editing", for the Excel adapter). `blindTick`: no pass or correction while blind, not counted as activity (the 20 s check-in still comes), `cant_see` said and reported once after `TEACH_BLIND_POLLS`; "I did it" answers that Echo can't see. A step whose baseline was taken blind uses the first real look and skips the already-true guard.

## Not built yet (next steps, in the design's order)

- **R2/T3, the Excel adapter** (`ExcelBridge.swift` + `lib/excel.js`): the engine's cell snapshots, ⌘Z and restore come from it. Needs Automation → Microsoft Excel permission once. Until then, cell checks only run in tests.
- **R3/T4, pointing at a cell** by its address (never by OCR text, which hit the Name Box).
- **R5/T5, typing into cells** safely (select, verify, type, read back, never paste).
- **R6–R10**: the lesson card panel, pinned highlight and ghost text, demo area (columns F to H, owner to confirm), the Excel curriculum as lesson files, adaptive hints.
