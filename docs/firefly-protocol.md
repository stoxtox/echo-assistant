# The firefly: what the server and the Mac app say to each other

Echo's pointer is a small light (the "firefly") that flies from the companion to a target. This is
the wire contract between the server (`lib/screen.js`, `lib/computer.js`, `lib/teach.js`,
`lib/guide.js`, `lib/server/routes.js`) and the Mac app (`macos/Sources`). The server side is
built and tested (`test/firefly.test.js`); the app side is built from this page.

## The channels (nothing new)

- **Server → app:** JSON text messages on the app's own line, `/ws/body` (`BodyLink.swift`). Today
  it only takes `type: "screen_request"`; it must now also take `type: "firefly"` (below). With no
  body line up, the same messages go to the app's page socket instead, as requests already do.
- **App → server, answers:** `POST /api/screen/result` with `{ id, …answer }`, unchanged.
- **App → server, the user pointed:** `POST /api/computer/pointed` (new, below).
- **App → server, the light left or landed:** `POST /api/computer/event` with `type: "departed"`
  or `"arrived"` (section 5), so Echo's words start as the light lands.

## 1. Fields on `screen_request` (kinds `point` and `act`)

`{ "type": "screen_request", "id": "<16 hex>", "kind": "point" | "act", "params": { … } }`

New in `params`; everything already there is unchanged:

| field | on | meaning |
|---|---|---|
| `intent` | every `point` and every `act` (both `step: "resolve"` and `step: "do"`) | `"show"`, `"act"` or `"ask"`: the light's colour. Always present. |
| `route` | `point`, optional | 1 to 6 labels (each 1 to 60 characters, trimmed) to open in order, e.g. `["File", "Export", "PDF…"]`. `target` is always the last label. |
| `hold` | `point` from a lesson | `true`: the light stays on the target, waiting for the user, until a `firefly` release names its `stepId`. |
| `stepId` | with `hold` | Opaque string, at most 40 characters (today `"<lesson id>.<n>"`). Never reused for a different wait. |
| `caption` | `act` (both steps), optional; `point`, optional | A few words saying what this step is, for the small caption the app shows beside the light: one line, secrets blacked out, at most 60 characters. Left out when there is nothing to say. |

### `intent`

- `show`: Echo is only pointing something out and will not touch it: `point_at`, every guide step,
  every lesson step, and `act` requests while "show me how" mode is on.
- `act`: Echo is about to click, type, drag or scroll there itself. The `do` step is always `act`.
- `ask`: the step is risky and is waiting for the user's OK. A `resolve` carries `ask` when the
  server already knows it is risky from the request's own words. More often it only knows once the
  app has said what it found; then the `resolve` said `act` and a `firefly` hold follows (section 2).

The server's behaviour does not depend on the colour. A request with an intent the app does not
know should be drawn as `show`.

### `caption`

The app shows a small caption beside the light once it has arrived ("Clicking Send"), for a
couple of seconds. `caption` is the step's own short narration (the assistant's `say`), cleaned by
the server (`cleanCaption` in `lib/screen.js`: one line, redacted, 60 characters; the app shows
about 40). Today the server sends it on `act` requests only, and never for `type_text`: the
caption says where Echo types, never what. The app treats it as optional everywhere. Without it
the app words the step itself from the action and the name of what it found ("Typing in
Subject", "Scrolling down", "This one" for a plain point). Whatever the request says, a held
lesson step reads "Your turn", a step that asks reads "Is this OK?", a search reads "Looking for
<target>…", and a secure field is only ever "a password field". The app's setting
`stepCaptions` (Settings → Companion, sent with the page's `prefs` message) turns captions off;
the server sends the field either way.

### `route`

The light shows the way label by label: it rests on the first label of the route that is not open
yet, and moves to the next one as the user opens each menu, ending on `target`. The app never
opens a menu itself for a `point`. `route[0]` is looked up the way `target` is today (`app`,
`menuBar`); each later label is looked up inside what the one before it opens.

The answer is the usual point answer, where `found: true` means the light is resting on a label
of the route with a real on-screen frame (`debug.frame`, `debug.screen` as now), plus:

- `routeIndex`: the 0-based index of the label the light is resting on (0 to 5). Without it the
  server assumes the light is on the target.
- `label`: that label as found.

If not even `route[0]` can be found within the request's patience (`timeoutMs`, else 1.5 s; never
more than 15 s), answer `found: false` as for any target. A slow first label shows the light
searching (section 3) like any slow find; that search belongs to the walk and never ends it.

Every route request gets exactly one answer. A walk that is stopped before it has answered (another
request took the light, its step was let go, the light went home) answers then, with how far it
got: `found: true` and the `routeIndex` it is resting on, or `found: false` if it reached none.

### `hold` and `stepId`

A held light waits on its target (or walks its route) until it is released. A second `point` with
the **same** `stepId` is the same wait (a hint or "repeat"): fly or pulse again, keep waiting. A
`point` or `act` with a different `stepId`, or none, replaces the wait; the server will still send
the old one's release, which then names an id the app no longer holds and is ignored. If the app
answers `found: false`, it holds nothing.

The release can arrive before the find is over (the lesson was stopped, moved on with "next", or
got new steps while the app was still looking; the same for a hint's re-point). The app remembers
which `stepId` each running find is for, so such a release is not lost: the find is still answered
as usual, but the light is not shown for it and holds nothing, and a light out searching for it
goes home. The step is forgotten again when its last find is over.

## 2. `firefly` messages (server → app)

Two shapes, told apart by which key is present. Ignore unknown keys; ignore any `firefly` message
with neither.

### Release: let the light go

`{ "type": "firefly", "release": "<id>", "outcome": "done" | "skipped" | "stopped" | "not_found" }`

`release` is one of three ids. The app matches it against what it is holding or still working on,
and ignores an id it does not know (that is normal, not an error).

| `release` is | sent when | `outcome` |
|---|---|---|
| a lesson `stepId` | the step passed | `done` (burst, move on) |
| | the step was left undone: "next", "back", the lesson's steps were replaced | `skipped` |
| | the lesson is no longer watching: stopped by voice, Escape, the Stop button or the assistant; paused by voice or after two quiet minutes; Echo is quitting | `stopped` |
| a confirmation id (from a hold, below) | the user allowed the step; a new `act` `resolve` then `do` follows with `intent: "act"` | `done` |
| | the user said no, the card expired or was cancelled, Echo was stopped or is quitting | `stopped` |
| a `screen_request` id (`point` or `act`) | the server gave up waiting for the app's answer (20 s) | `not_found` |

Exactly one release is sent per wait, on every way out. After `stopped` and `not_found` the light
should go home quietly; after `done` it may burst; after `skipped` it just leaves.

### Hold to ask: a risky step is waiting for the user's OK

`{ "type": "firefly", "hold": "<confirmation id, 8 hex>", "intent": "ask" }`

Sent right after the app answered an `act` `resolve` that turned out to be risky. The light stays
where that resolve put it, turns to its asking colour, and waits until a release names this id. If
no light is out, ignore it.

## 3. Searching (the app's side)

When the app starts its own find for a `point` or an `act` `resolve` and the find is not instant,
it shows the light searching by itself, with no message from the server, and stops when its find
ends. If it finds nothing it answers `found: false` as now and ends the search itself: the server
sends nothing in that case. The only message from the server is the `not_found` release above,
for a request the server stopped waiting for while the app may still be searching: end the search
for that request id, drop any hold it would have started, and do not answer it.

## 4. The user points back: `POST /api/computer/pointed` (app → server)

The user picks up the light and drops it on something to say "this one".

- **Headers:** `Content-Type: application/json`, and `X-Echo-Token: <contents of
  data/self/body-token>`, the same token `/api/shutdown` and `/ws/body` use. No `Origin` header:
  any request with one is refused.
- **Body** (at most 16 KB):

  ```json
  { "app": "Preview", "window": "Holiday plan", "label": "Export…", "role": "AXMenuItem",
    "x": 412, "y": 96, "near": ["Print…", "Share"] }
  ```

  - `label`: the thing's own name: its title, description, placeholder or help, at most 80
    characters. Never its value and never the text inside it, whatever its role (for a label, a
    link, a cell or a row that would be the page's or the message's own words). With no name of
    its own: an empty `label` (left out) and its `role`. Nothing at all for a secure field but its `role`.
  - `role`: the Accessibility role, letters only (`AXButton`). Anything else is dropped.
  - `app`, `window`: the app's name and the window's title.
  - `near`: the names (the same kind of name as `label`, 60 characters each) of what is next to
    the drop point, nearest first: at most 5.
  - `x`, `y`: the drop point in AppKit screen coordinates (points, origin at the bottom-left of
    the primary display, y up). Accepted and unused.
  - At least one of `label`, `role`, `near` must be there. No other screen text may be sent; any
    other key is ignored.

  The server blacks out secrets and clips every name (label 80, near 60 each, app 80, window 120).
- **Answers:** `200 { "ok": true, "via": "turn" | "instruct" }`; `403 { "error": "Forbidden" }`
  (no or wrong token, or an `Origin`); `400` (not JSON, or nothing to go on).
  - `via: "instruct"`: a turn was under way, so the assistant gets it in place of its next step.
  - `via: "turn"`: nothing was under way, so it is a turn of its own, now.

The app does nothing more: no retry on `400`/`403`.

What the server does with it: the assistant is told `The user pointed at "<label>" (<role in
words>) in "<app>"…: they mean this one.` (every name quoted, and with its colons, parentheses and
quote marks taken out, so a name off the screen can never end that sentence and start its own). If
a turn was under way and the user speaks before the assistant gets to the drop, it goes in at the
front of that next turn: a drop the page has shown is never lost; every page gets `{ "type": "pointed", "label", "role",
"app", "via" }` (role in plain words, e.g. `"menu item"`) to show a small "You pointed at <label>"
line; and the timeline gets one `point.back` event with the role and the app only. A drop is never
counted as the user's words: it cannot be the yes to a confirmation card.

## 5. The light left, the light landed: `POST /api/computer/event` (app → server)

A person points as they say the pointing word. So the server holds a step's spoken words until
the light is on the step's target, and the app says when that is.

- **In the answer** to a `point` or an `act` `resolve` (`POST /api/screen/result`): `"light": true`
  when the light went out for this request, so an `arrived` will follow. Left out when nothing
  flies (the thing was not found, the step was let go, it is in Echo's own window, the other way
  of pointing): then the server speaks at once, as it does for an app that never sends the field.
- **Headers:** as for `pointed`: `Content-Type: application/json`, `X-Echo-Token`, no `Origin`
  (`403` otherwise).
- **`{ "type": "departed", "id": "<request id>", "ms": <expected flight ms>, "from": "pearl" | "target" | "turned" }`**:
  the light has just set out for this request: from the pearl in the island, from the last thing
  it showed, or turning round on its way home. Not sent when the light is already there, or with
  Reduce Motion. (Setting out to search sends it with the id alone.) With `ms`, the server asks
  for the held words that long after `departed`, less the time its voice takes to start, so word
  and light land together.
- **`{ "type": "arrived", "id": "<request id>", "ms": <flight ms>, "still": true? }`**: the light
  has reached the request's target: the end of its flight, before it circles. Sent once per
  request: for a route, when it reaches its first stop; `ms: 0` when it was already there (the
  same lesson step again). `still: true` with Reduce Motion (no travel: sent as soon as the thing
  is found).
- **Answers:** `200 { "ok": true }` (`ok: false` for an id that is not 16 hex characters). No retry.
- **`{ "type": "home", "ms": <ms out>, "stops": <things shown>, "why": "over" | "let_go" | "step" | "wait", "working": true? }`**:
  the light is going back to the pearl. `working`: Echo was still in the middle of a job, so the
  next step has to bring it all the way out again. Only for the timeline (`npm run light` reads
  the trips back); the server does nothing else with it. In the middle of a job the light waits
  at the last thing it touched for up to 15 seconds, so `working` should be rare.

What the server does:

- **A step Echo does (`act`) with narration, and a guide step:** words that only say where
  ("Top left, …", "In the toolbar, …") are spoken at once, while the light flies; the rest is
  spoken on `arrived` for that request, or after 1.2 s if none came (the timeline then gets
  `speech.unsynced` with the kind of step). An arrival that beats the answer is remembered.
- **A lesson step:** the step's instruction is spoken when the light has arrived on its target
  (same 1.2 s limit).
- **Letting the result sit:** in a lesson or in show-me mode, after a step of Echo's that visibly
  changed something, the next request is not sent for 700 ms. Not when Echo is just doing the
  job, and not after an `arrived` with `still: true`.
- The timeline gets `light.departed` and `light.arrived` (`ms`, `still`): never a name.

On the app's side, with no message from the server: how long the light shows a thing it is only
pointing at (about 2 s on a large thing on its own; one more lap and 3 to 4 s on one under 28 pt
on its short side, or with two or more look-alike labels within 220 pt), one slow extra lap with
the caption shown again when the user's mouse comes to rest more than 250 pt away and not on the
way to the thing (once within 4 s of a plain point; at most every 12 s while a lesson step
waits), and the captions "Your turn" and "Is this OK?" staying for as long as the light waits.
