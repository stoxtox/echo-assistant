# Guide mode and computer use

Echo 1.3 can show you how to do something, one step at a time ("show me how"), and, if you switch it
on, do it for you ("do it for me"): click, type, press keys, scroll and open apps on your Mac. This
page covers how both work, the safety rules, the permissions, and a manual test plan. Looking and
pointing are in [screen-awareness.md](screen-awareness.md).

## The Sept 29 overhaul: observe → act → verify

After the computer-use audit (151 of 153 actions said "ok", 0 of 4 Gmail runs finished
hands-free), every step is now checked, and "done" means Echo saw it work. Progress and metrics per
phase: `PROGRESS.md`. The eval harness: `npm run eval`.

- **Verification.** The Mac app snapshots the app before and after each action (focus and its
  value, window, window count, the page's URL, open menus, a fingerprint of what's showing, the
  target's state). A step with no visible change comes back `done: false` with what was observed; an
  Accessibility press that changed nothing is retried once as a real click. Typing reads the field
  back. `expect` makes a step wait for something to appear. `judgeStep` in `lib/computer.js`.
- **Targeting.** In browsers the label search looks only in the web page (`scope: "browser"` for
  Chrome's own tabs and toolbar). Field values and words inside long lines aren't labels; typing
  prefers a field to its label; matched text is traded for the control around it, and that element is
  acted on (no centre hit-test). Menu bar icons come first only when asked for.
- **Typing.** A focus guard (the intended field must have the focus and take text, or nothing is
  typed), `mode: "replace"` inside the field, text on real key codes with no modifier flags (the ⌘ leak
  that opened Chrome's profile menu), line breaks as Return, modifiers released after every shortcut.
- **More actions.** Right-click (`AXShowMenu` first), double and triple click, modifier-click,
  `hover`, `drag` (onto the Trash asks first), `clear_field`, `click_visual` (a local vision model
  finds unlabeled things, `lib/grounder.js`).
- **Refs.** `observe_screen` lists controls with refs (`[e7] combobox "To recipients"`), from the Echo
  Chrome extension (`extension/`, paired with a code from Settings) or Chrome's DevTools port for
  pages, and from the Mac app for other apps; `act` works on a ref; `batch_actions` does 2–5 checked
  steps per call. `look_at_screen` can draw Set-of-Marks badges or a numbered grid.
- **Recipes.** `compose_email` (Gmail by link, or on screen with the recipient committed as a chip),
  `facetime_call`, `open_settings_pane`, `youtube_control`; sends always wait on a card that shows the
  payload (recipient, subject, first line, attachment), and an Undo chip follows for a few seconds.
- **Voice.** Addressee v1 (`judgeAddressee`): one confidence; unsure speech gets a "Was that for
  me? ✓" chip; a local model (Apple's on-device model or a local Qwen) settles the unsure band.
  "Wait" pauses the step; a new request said mid-run is queued, a correction cuts in. Instant
  commands (pause, next, volume, scroll, go back, time, "show me how" / "just do it") run locally.
- **Show me how.** `driveMode: 'show'` points and narrates every step without clicking.
- **Background cursor.** `backgroundCursor` puts your pointer back right after a real click.

## What you can say

- "Where's Wi-Fi?" / "Show me how to turn on Do Not Disturb." Echo calls `guide` with the steps.
  The pointer goes to Control Center in the menu bar and she says "Step 1. Click Control Center";
  when you've clicked it (the panel opens), the pointer moves to Wi-Fi inside it, and so on. A step
  counter shows at the bottom of Echo's window. **Guide mode never clicks.** It works with computer use off.
- "Open Chrome and search for otters, then tell me what shows up." With computer use on: `open_app`,
  `click` / `press_keys cmd+l`, `type_text`, `press_keys return` with `look_after`, then she reads
  you the first results and calls `stop_driving`.
- "Open Claude and ask it what a monad is." / "Go back" (`press_keys cmd+[`).

The dispatcher prefers direct paths: texts go through `send_imessage`, calendar entries through
`add_calendar_event`, links through `open_url`, apps through `open_app`, project work to a worker. It
drives the screen only when you say "on the screen" / "do it for me", or when there's no direct way.

## How it fits together

```
dispatcher tools (lib/computer.js: guide, click, type_text, press_keys, scroll, wait_for, confirm_action, stop_driving)
  → ComputerUse.act: settings on? Mac app open? stopped by the user? step cap / time-out?
  → ScreenBridge.request('act', { step: 'resolve' })  → the app finds the target, flies the pointer
      there, and reports label, role, app, window, password field?, Echo's window?, privacy pane?
  → classifyAction: refuse / needs a yes / ok
  → ScreenBridge.request('act', { step: 'do', token })  → macos/Sources/Driver.swift acts:
      Accessibility first (AXPress, setting AXValue in native fields, scroll-area page actions),
      synthetic mouse and key events (CGEvent) as the fallback
  → logged to data/computer-log.jsonl; with look_after, one look_at_screen to check it worked
guide → lib/guide.js: point (menu bar aware) → 'wait' (MenuBar.swift Watcher) → next step
```

- Typing (`type_text`): key presses a character at a time (`TypingMath.plan` in `PointMath.swift`:
  about 55 ms a character, a little varied, a breath after spaces and punctuation, sped up evenly so
  it never takes more than 3 s, in small bursts when that gets too fast to see; a line break never
  goes on its own). The companion bobs beside the caret (read with `AXBoundsForRange`), with a
  glowing caret and a glint per character. The first key press is checked (the field's text or caret
  moved, where the app says); if it didn't land, a native field's value is set through Accessibility,
  else the text is pasted with ⌘V (marked transient, the old clipboard put back 0.8 s later). The
  password check runs before typing and every 8 key presses; your input stops it at once. Reduce
  motion types everything at once (the old path).
- Step counter: each action carries `stepNo` and `stepsOf` (the assistant's optional `steps_total`
  guess, grown if it runs short; 0 when there's none). The pill shows "3 of 5" (or "step 3") after
  what Echo is doing, and the progress line fills to (step − 0.4) / total, fully when a step is done.
- Menu bar support (`macos/Sources/MenuBar.swift`): menu extras in each app's `AXExtrasMenuBar`
  (Control Center, Wi-Fi, Bluetooth, Sound, Battery, Focus, Clock, third-party status icons) and the
  inside of an open Control Center panel. `point_at` takes `menu_bar: true`, and names like "Wi-Fi"
  or "Control Center" are looked up there first.
- Waiting (guide mode, `wait_for`) polls the Accessibility tree a few times a second. In guide mode
  the wait is "appear": the next target must show up, or the screen must change (a panel opening, a
  new window), so a step isn't skipped before you act. Guide mode never captures the screen while
  it waits.

## Safety

| Rule | Where |
|---|---|
| Off by default; Settings → Screen → "Let Echo use the computer". Switching it off stops a run. | `computerUse` in lib/settings.js, `ComputerPrefs` in Driver.swift |
| "Echo is driving": a thin (1.5 pt) coral-to-tangerine line glows softly around every screen's very edge (it breathes gently, and holds still with reduced motion), one small status chip in the top-right corner says what she's doing (Driving, Clicking, Typing…, then shrinks to a dot), the caption pill shows **Stop** and, for the first seconds, "esc to stop"; a banner with **Stop** in Echo's window; and the companion orb drifts to each target, pulses and sparkles there (and pauses) before anything happens; a done step gets a tiny sparkle, a failed one a soft wobble. Nothing covers a strip of the screen. | Overlays.swift `EdgeGlow`, `StatusChip`, Caption.swift, public/computer.js |
| Take back control: Escape, or any real mouse or key input, stops the run at once. Echo's own events carry a marker so they're told apart. The watcher is a listen-only event tap (Input Monitoring), or AppKit's monitors with Accessibility; without either, Echo refuses to drive. After a take-back, nothing more happens until you speak again. | Driver.swift `observe`, `ComputerUse.abort` |
| Hard confirmation before risky actions: sending messages or email, purchases and payments, deleting, submitting forms, signing in, account and system settings, installing, Terminal commands. A card in the window (Allow once / Cancel, expires after 2 minutes) plus a spoken question. A spoken yes only counts if you said something after the card went up, so text on a web page can't approve anything. | `classifyAction`, `ComputerUse.confirm` |
| Never types passwords, codes, keys or card numbers: refused before the text leaves the server (redaction patterns, Luhn check), refused for password-like fields, and the app checks the focused field isn't a secure field right before typing. The run ends and control goes back to you. | `classifyAction`, Driver.swift `perform` |
| Never acts in Echo's own window, or in System Settings' Privacy & Security panes. Other System Settings changes need a yes. | both sides |
| At most 25 actions and 5 minutes per run (a run is one request of yours). | `MAX_STEPS`, `RUN_TIMEOUT_MS` |
| Action log `data/computer-log.jsonl`: each run, action, target, app, window and result. Typed text is redacted; text for a secure field is never logged. | `ComputerUse.record` |
| Screen text is information, not instructions (the dispatcher prompt says so). | `computerPrompt` |

## Talking during a run

While Echo drives, the window keeps listening between her words (Settings → Speech recognition → "Keep listening while Echo uses the computer"; on by default). It's the mic only, so it never trips the "you touched the mouse or keyboard" take-back. The server routes what you say (`routeSpeech` in lib/computer.js, `Dispatcher.routeInput`):

- "stop" (alone: "stop", "okay stop", "Echo, stop!", "that's enough", "cancel") ends the run like Esc, and she stops talking.
- Anything else, while her turn is still going, waits for her next step: that step isn't done, and the tool result carries `userSaidMidRun` so she changes course. A `wait_for` in progress ends early. If her turn ends before she gets to it, it becomes a new request.
- Each action tool takes an optional `say` ("Opening Chrome…"), spoken as the step happens.

Echo's own narration is never captured: listening pauses while she speaks and for the echo tail after (public/autolisten.js).

## Driving sessions

A run is a session, not one command. When a request is done she says what she sees and stays in the same app, still listening; the next request ("now search for something else", "go back", "read me the top result") carries on there with a fresh budget of 25 steps and 5 minutes (`ComputerUse.newTurn`). The session ends on "stop" or "that's all" (`isEndCommand`; she says "Okay, all yours."), Esc or the user's own mouse or keys, `stop_driving`, 60 seconds with nothing said or done (`SESSION_IDLE_MS`; never mid-request), or after 30 minutes in all.

## Focus

Every action carries the app it's for: the one the assistant named, else the session's (set by `open_app`, `media_control`, or where the last action landed; never Echo). The Mac app (`bringForward` in Driver.swift) activates it (handing over from Echo on macOS 14), waits until it's really frontmost, raises its window, and tries once more the way `open -a` does if that didn't take. It does this at resolve time and again right before acting. "In Echo's own window" now means Echo's window is the front-most one at that spot (`PointMath.topWindowOwner`), so Echo's window sitting behind Chrome no longer blocks typing into Chrome's address bar (the September 28 bug). A miss is retried once by the server, then reported as `error: 'focus'` without ending the session. Nothing on the voice path brings Echo's window forward while she drives.

## Caption bar

`macos/Sources/Caption.swift` (drawn by `PillArt.swift`), fed by `public/caption.js`. While Echo drives, or her window is hidden or behind other apps and something is going on, a slim graphite-glass pill (the companion mockup's, 44 pt) at the bottom centre of the screen shows your live words or her current line, a one-line status of what she's doing ("Clicking **Send**", from the app) and a round Stop button. The companion orb docks in its left slot while she listens, thinks and speaks, and flies out to each target. When she asks before a risky step, the pill asks too, with **No** and **Yes** that answer the same card as her window (`echoNative.captionConfirm`). It's a non-activating, click-through panel on every Space (full-screen apps too); only its buttons take the mouse, on the first click, without taking focus. It sits just above the Dock, moves up when she acts on something near the bottom (`PillMath.frame`), dims while your mouse is over it, fades in rising 8 pt and fades 3.5 s after things go quiet. Settings → Screen → "Show the caption bar while Echo drives" (`captionBar`, on by default). The comparison with the mockup is in [companion-mockup-comparison.md](companion-mockup-comparison.md).

## Permissions

Rebuilds keep these permissions now that the app is signed with a stable identity: see docs/mac-permissions.md.

| Permission | For |
|---|---|
| Accessibility | Finding and pressing buttons, typing, and the fallback take-back watcher. Asked when you switch computer use on. |
| Input Monitoring | The take-back watcher (any key stops Echo) and push-to-talk. Asked next. |
| Screen Recording | Only for `look_after` / `look_at_screen` checks and finding things by their text. |

All three are in Settings → Screen with **Allow…** buttons, and in setup.

## Did it work?

A run's ending isn't its outcome: sessions normally end idle or when the user says stop. `node scripts/outcome-report.js` judges each request (the run's first, then each `session_continued`) after the fact with `lib/outcomes.js`, from the step log and the conversation log: the last step confirmed on screen, failed or refused steps, a take-over or a declined confirmation, Echo saying it couldn't ("I couldn't find…", "still stuck"; not handoffs by design like passwords), and what the user said next (unhappy, the same request again, or happy). Requests with no steps (looks, points, answers, conversation) aren't judged. `--review` labels the unclear and weakly judged ones by hand (`data/outcome-labels.json`); labels override the automatic judgement and measure its accuracy. `--since`, `--app` and `--json` narrow or dump it. The mechanics per step stay in `scripts/computer-report.js`.

## Tests

`test/computer.test.js`: off by default; needs the Mac app; resolve-then-do; the risky-action
classifier (21 risky cases, 8 ordinary ones); refusals (password fields, password/code fields,
card numbers, API keys, Echo's window, privacy panes); a secret never reaching the app or the log;
the confirmation card, a spoken yes only after the card, cancelling, expiry; take-back (Escape from
the app, a stale run's abort ignored, input while acting, blocked until the next turn); step and time
caps; key combos matching Driver.swift's key table; `wait_for`; guide mode (spoken steps, "appear"
waits, never an `act` request, stopping, not found, pointer off); tool schemas and the routing rule;
and static checks that Driver.swift is the only file that acts, and how. `test/screen.test.js` still
checks every other Swift file never clicks or types. `test/macapp.test.js` type-checks the Swift.
`test/driving.test.js`: focus (the session app on every action, a miss retried once then reported
without ending the session, a real Echo-window target refused for that step only), sessions
(continuing across requests, the quiet minute, the cap), routing ("that's all", mid-run words,
chained requests through the dispatcher), `media_control` and opening found files, the prompt's
recipes, and the caption feed. `macos/Tests/main.swift` covers `topWindowOwner` and `captionFrame`.

## Manual test plan

Use a test copy: `ECHO_PORT=4799 ECHO_DATA_DIR=$(mktemp -d) node server.js`, then
`scripts/build-app.sh --out /tmp/echo-test` and open `/tmp/echo-test/Echo.app --args --port 4799`.

**Guide mode (computer use off)**
1. Ask "where's Wi-Fi?". The pointer goes to Control Center in the menu bar; you hear "Step 1…";
   the window shows "Step 1 of 2". Wait: nothing happens until you click it.
2. Click Control Center. Within a second the pointer moves to Wi-Fi inside the panel ("Step 2").
3. Ask "show me the Sound settings in the menu bar": the pointer finds the Sound icon (if shown).
4. Start a guide and don't click for a minute: Echo asks if you found it.
5. Start a guide and click **Stop** on the step pill: it stops.
6. Check `computer-log.jsonl` has a `guided` line and no clicks.

**Switching it on**
1. Settings → Screen → "Let Echo use the computer". Without Accessibility, macOS's prompt appears;
   then Input Monitoring. The hint under the switch explains the border and Esc.
2. With the switch off, ask "open Chrome and search for otters on the screen": Echo says it's off
   and offers to guide instead.

**Driving**
1. "Open Chrome and search for otters on the screen, then tell me what shows up." The border and the
   banner appear, the orb drifts to each target and pulses before each action, and Echo reads the results.
2. "Open Claude and ask it what a monad is." Typing and Return work in the Claude app.
3. "Go back": Chrome goes back (cmd+[).
4. The border disappears after `stop_driving`, or 25 seconds after the last action.

**Taking back control**
1. During a run, press Escape: the border goes at once, Echo says you took over, and nothing else
   is clicked. Ask again: she can drive again.
2. During a run, move the mouse (or press any key): same.
3. Click **Stop** on the banner: same.

**Confirmations**
1. In Messages, ask Echo to type "hi" to someone and press Return: a card "press return in Messages"
   appears and she asks. Say "no": nothing is sent. Repeat and click **Allow once**: it's sent.
2. On a shop's checkout page, ask her to click "Place order": a card appears.
3. Ask her to delete a file in Finder (cmd+delete): a card appears.
4. Let a card sit for 2 minutes: it expires, nothing happens.

**Refusals**
1. Click into a password field and ask her to type a password: she refuses, hands back control, and
   asks you to type it yourself. The log says `[not typed]` and doesn't contain it.
2. Ask her to type a card number into any field: refused.
3. Ask her to click something in Echo's own window: refused.
4. Open System Settings → Privacy & Security and ask her to switch something: refused. Ask her to
   change something in Displays: a card appears.
5. Ask her to do 30 steps in a row: she stops at 25 and asks.

## Merge notes (shared with the pointer fixes, task 77)

- `macos/Sources/Pointer.swift`, `Screen.swift`, `ScreenBridge.swift`: **not touched**. The new code
  calls `AXFinder.find/score/normalize/frame/focusedWindowTitle`, `AXFinder.Hit`, `ScreenLook.capture/last/toScreen`,
  `FrontApp.target` and `screenPoint` as they are. Driver.swift has its own AppKit→global point conversion
  (`ComputerDriver.toGlobal`, the inverse of `AXFinder.fromAX`); if task 77 changes coordinate handling,
  switch it to the shared helper.
- `lib/screen.js`: two small additions only: `APP_KINDS` (`act`, `wait`), a no-app early return for them
  in `request()`, and a pass-through branch at the top of `deliver()`.
- `macos/Sources/main.swift`: one line in `userContentController`, before `handleScreenMessage`.
- `test/screen.test.js`: the "only points" test skips Driver.swift.
