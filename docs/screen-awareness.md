# Screen awareness, the pointer and push-to-talk

Echo 1.3 can look at your screen when you ask, point at things on it, and listen while you hold a
key from any app. This page covers how it works, what stays private, the permissions it needs, and
a manual test plan.

## What you can say

- "What's this error?" / "What am I looking at?" / "What does this say?" / "Help me with this page."
  Echo calls `look_at_screen` and answers from the text on screen (and the picture, if the text isn't enough).
- "Where's the share button?" / "Show me where Wi-Fi is." Echo calls `point_at`, and the companion
  orb drifts to it. She says "click here"; **she never clicks**.
- "Fix the error on my screen." Echo looks, then starts a coding worker with `attach_screen: true`:
  the worker gets the redacted screenshot as a temporary file plus the text from the screen.
- Hold **Control + Option** anywhere, talk, let go. Same as holding Space in Echo's window.

## Private by default

| | |
|---|---|
| When | Only when you ask about your screen (the assistant is told never to look "just in case"), or while `point_at` searches for a label it can't find with Accessibility. Nothing watches the screen in the background. |
| What's captured | One frame of the display under the mouse. Echo's own windows are left out. |
| Where text is read | On your Mac, with Apple's Vision text recognition. |
| Redaction | Before anything leaves the app: password fields (found with the Accessibility API) are blacked out in the picture, and every line of text that holds an API key, token, password, private key, password-in-a-URL or card number (Luhn-checked) is blacked out in the picture and replaced with `[redacted]` in the text. The server redacts the text again (`redactText` in `lib/screen.js`). |
| What the assistant gets | The text first. The (redacted) picture only when it asks for it (`include_image`). |
| Files | None from the app. The only file ever written is a worker's copy for "fix the error on my screen": in a private temp folder (`echo-screen-<uid>`, mode 600), deleted when that task ends or after 30 minutes, and swept on start-up. The last look is kept in memory for 10 minutes so it can be handed to a worker. |
| Log | `data/screen-log.jsonl` records only that a look or a point happened (time, native or browser, whether there was a picture, how many things were redacted). Never what was on screen. |
| Indicator | Mac app: the status chip in the top-right corner says "Looking" (one chip, one state at a time, also used while Echo drives) and a thin sunset line glows around the screen's edge. In Echo's page: "Echo is looking at your screen" at the top. |
| Settings | Settings → Screen: screen awareness (on, but only on request), the pointer (the companion orb, on), its size (small 22, medium 28 (default) or large 34 pt) and Reduce motion (same as macOS, on or off), the push-to-talk chord. Turning screen awareness off stops every look and tells the assistant it's off. |

In a **plain browser** (no Mac app), a look shows a card in the chat: you choose the screen or
window to share, see the picture, and click **Send to Echo** or **Don't send**. The browser can't read
text or black out secrets, so you check the picture yourself. Pointing needs the Mac app (the
first-run demo points inside Echo's own page instead).

## How it fits together

```
assistant tool (lib/dispatcher.js: look_at_screen, point_at)
  → ScreenBridge.request (lib/screen.js)   waits up to 20 s (90 s for a browser share)
  → WebSocket "screen_request" → the Mac app's page (public/screen.js)
  → echoApp message handler → macos/Sources/ScreenBridge.swift
      look:  Screen.swift  ScreenCaptureKit → Vision OCR → redaction → JPEG (≤1600 px)
      point: Pointer.swift AXUIElement search (role + title/description) → OCR boxes → overlay
  → POST /api/screen/result (the app answers the server directly; the picture never goes through the page)
  → ScreenBridge.deliver → redacted again → the tool result
```

- `start_task` and `follow_up` take `attach_screen`. The note added to the worker's instructions names
  the temp file; workers may Read it without asking (`isScreenShot` in `lib/tasks.js`), and it's
  deleted on the task's `finished` or `stopped` event.
- `point_at` can also take `x`/`y` in the last look's picture, for things found by eye.
- The pointer is Echo's **companion**, a small sunset drop (`PointerOverlay` in Pointer.swift moves
  it, `CompanionArt` in Companion.swift draws it, motion in `CompanionMath` in PointMath.swift). It is
  a Core Graphics port of the design mockup's renderer (`_research/echo-companion-ui-plan`), redrawn
  each frame in a small layer: 22, 28 (the default) or 34 pt, a honey → amber → coral → dusk-violet
  gradient with a 1 px inner rim, a soft highlight and a faint dusk shadow so it reads on white pages
  and dark wallpapers, and a coral glow that fades to zero well inside its layer (no clipping, no
  seams). Its home is the caption pill's left slot (Caption.swift): whenever the pill is up it docks
  there, following the pill on a critically damped spring. It glides out on a gentle arc (ease-glide,
  260–700 ms by distance, with a soft launch; a new target mid-flight keeps its speed, so it never
  kinks) with a faint amber comet trail, parks just outside the target's corner leaning its point
  toward it (never over the words, never over the pill), and highlights the target in honey (faintly
  as it approaches, fully on arrival). It comes home when Echo speaks or listens again, 1.8 s after a
  finished step, or when you talk after a "look here" (`CompanionMath.shouldReturnHome`). Motion
  runs on the display's clock (`FrameClock`, up to 120 Hz). It steps 16 pt aside and fades when your mouse comes near.
  States cross-fade over about 240 ms and follow the voice (the page sends
  `{ type: 'companion', voice, level }`; the native mic sends your level too): resting, it breathes
  once every 5.5 s; listening, a honey halo appears, the breath quickens and it swells up to 18% with
  your voice; thinking, it cools toward violet while a comet of honey light circles the rim every
  1.6 s; speaking, a ring rolls out on each peak of Echo's voice. Before a computer-use click it
  squashes and pops with a ring, throws three small glints at the target and the outline pings (the
  click waits for it: `aboutToAct` returns the delay); a done step gets five tiny four-point stars
  and a bounce; a failed one a soft ±7° wobble, a small droop and a cooler tint (no red). With
  Reduce Motion it fades out and in instead of gliding, and shows states by colour and halo only
  (three still dots for thinking, a glint for done). It stays while Echo is still talking or
  thinking (up to 30 s), otherwise, with no pill to go home to, it fades about 6 s after the last
  point. Reduce motion can also be set in Settings → Screen (`reduceMotion`: system, on, off). Coordinates are
  unchanged: the same AX, screenshot x/y and menu bar conversions feed `point(at:label:)`. Only
  "sunset" is built; `CompanionMath.looks` and `COMPANION_LOOKS` in lib/settings.js leave room for
  aurora and mandala.
- The overlay is a click-through, non-activating panel on every Space (`ignoresMouseEvents`). Only
  `Driver.swift` (computer use, opt-in and off by default; see [computer-use.md](computer-use.md))
  posts mouse or key events or performs Accessibility actions; a test checks no other file does.
- Push-to-talk is a **listen-only** `CGEvent` tap on modifier changes (`PushToTalk.swift`). The chord
  has to be held for 0.18 s, and pressing any key while it's held (a shortcut like Control-Option-E)
  cancels it. It calls the page's `echoNative.pttStart/pttStop/pttCancel`, which work like Space.
  The web view's occlusion detection is off, so the page keeps listening behind other windows; if
  Echo's window was closed, it's brought back on screen without taking focus.

## Permissions (Mac app)

| Permission | For | Asked |
|---|---|---|
| Screen Recording | Looking | The first time you ask about your screen: a friendly explanation, then macOS's prompt. Also in setup and Settings → Screen. macOS may need Echo reopened after you allow it. |
| Accessibility | Finding buttons by name for the pointer; finding password fields to black out | Setup, Settings → Screen, or the first time the pointer needs it. Without it the pointer falls back to the text on screen. |
| Input Monitoring | Push-to-talk from anywhere | Setup, Settings → Screen, or when you pick a chord. Echo retries when it comes back to the front. |

Looking needs macOS 14 (Sonoma) or newer; on macOS 13 Echo says so. A rebuilt, ad-hoc signed
`Echo.app` may need the permissions granted again.

## Tests

- `test/screen.test.js`: redaction (and what isn't redacted: error messages, git hashes, order
  numbers), the bridge (answers, time-outs, a declined browser share, pointing without the app), the
  log never holding screen content, `look_at_screen` with and without the picture, the setting,
  permission errors, `point_at`, handing a look to a worker and deleting it, the sweep, the settings
  defaults, the chord lists matching across Node, the page and Swift, the Mac app never clicking or
  saving screenshots, and dropping the retired "Hey Claude" correction.
- `test/macapp.test.js` type-checks all the Swift sources; `npm run build-app` builds the app.

## Manual test plan

Use a test copy: `ECHO_PORT=4799 ECHO_DATA_DIR=$(mktemp -d) node server.js`, then
`scripts/build-app.sh --out /tmp/echo-test` and open `/tmp/echo-test/Echo.app --args --port 4799`.

**Setup demo**
1. Open `http://localhost:4799/?setup=tryit` in the Mac app. Click **Play**: Echo speaks.
2. Click **Look**. Without Screen Recording: the message says so and System Settings opens. Allow Echo,
   reopen it, click **Look** again: the pill shows at the top of the screen, and the step says how
   many words it read, with a sample. Nothing is sent anywhere (check `screen-log.jsonl` has no new line).
3. Click **Point**: the companion orb drifts to the Continue button and rings it; the label reads
   "Click here when you're ready". Click Continue yourself: the click goes through the overlay.
4. In a browser (not the app), **Look** explains the Mac app, and **Point** draws the pointer in the page.
5. `?setup=permissions` in the Mac app lists Screen Recording, Accessibility and Input Monitoring
   with **Allow** buttons; the chips turn to "Allowed ✓" after you allow them.

**Looking**
1. Open Terminal with an error on screen. Ask Echo "what's this error?". Expect the pill, then an
   answer about that error. `data/screen-log.jsonl` gets one `screen_looked` line with no text.
2. Put a fake key on screen (`echo "api_key=zzTopSecret123456"`) and a password field in a browser.
   Ask "what's on my screen?". Echo mentions something was blacked out and never reads the key out.
3. Ask something that needs the picture ("what colour is the button?"). The assistant asks for
   `include_image` (the activity line shows it) and answers.
4. Ask "how's the weather?" and other questions not about the screen: no pill, no look.
5. Switch off Settings → Screen → Screen awareness and ask "what's this error?": Echo says it's off.
6. Deny Screen Recording (System Settings) and ask again: a friendly sheet explains it; Echo tells
   you where to allow it.

**Pointing**
1. In TextEdit, ask "where's the Format menu?": the orb drifts to it (via Accessibility), with a faint trail, and parks just outside its corner, leaning toward it and breathing gently.
2. In a web page, ask "where's the sign-in link?": found by Accessibility or, failing that, by the
   text on screen (the pill flashes).
3. Ask for something that isn't there: Echo says she can't find it and describes where it might be.
4. Check the overlay never takes clicks, never steals focus, and fades after about 6 seconds.
5. Turn on Reduce Motion (Accessibility → Display): the orb fades out and back in at the target instead of drifting, and holds still.
5a. Settings → Screen → Companion size → Medium: the next point shows a larger orb. While Echo speaks it ripples, while she thinks it swirls, while you talk (push-to-talk) it swells with your voice.
6. Switch off the pointer in Settings: Echo says it's off.

**Push-to-talk**
1. With another app in front, hold Control + Option, say "what time is it?", let go. Echo answers.
2. Press Control-Option-E (or another shortcut): nothing is recorded.
3. Close Echo's window (it stays in the menu bar), hold the chord: the window comes back without
   focus, and it listens.
4. Pick "Right Option" in Settings → Screen: only that key works now. Pick "Off": nothing happens.
5. Space in Echo's window and "Hey Echo" still work as before.

**Workers**
1. With a failing build on screen, say "fix the error on my screen" (name the project if asked).
   The new task's instructions include the screen text and a temp file path under `echo-screen-<uid>`.
2. The worker can open the screenshot without an approval prompt.
3. When the task finishes (or you stop it), the file is gone.

**Browser fallback**
1. Open `http://localhost:4799` in Chrome (not the app) and ask "what's on my screen?". A card asks to
   share; **No thanks** makes Echo say you chose not to share.
2. Share a window: the preview shows; **Send to Echo** answers from the picture, **Don't send** doesn't.

**Speech correction**
1. With a data folder whose `vocabulary.json` has `"hey claude": "Hey Clicky"`, start Echo: the log says
   it dropped `hey-claude-clicky`, and Settings no longer lists it. Say "Hey Claude": it stays "Claude".
