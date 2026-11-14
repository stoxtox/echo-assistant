# The bridge to Adobe XD

## Why

On a design canvas Echo has nothing to hold on to. The Mac's accessibility tree shows one opaque
canvas; shapes have no labels; clicking by picture is slow and misses. Spreadsheets had the same
problem and the fix was to use the app's own interface (`lib/sheets.js`). XD's own interface is its
plugin system (UXP: JavaScript, a manifest, panels that stay loaded, `WebSocket` allowed).

## The design

    assistant ── xd_describe / xd_probe / xd_edit ──▶ lib/xd.js (XdBridge)
                                                          │  one WebSocket, /ws/xd
                                                          ▼
                                    integrations/xd-bridge/main.js  (panel plugin inside XD)
                                                          │  require("scenegraph"), editDocument
                                                          ▼
                                                    the open document

- **The plugin dials Echo**, never the other way: `ws://127.0.0.1:<port>/ws/xd?token=…`. It
  reconnects every 5 seconds while XD is open and says "ping" every 20.
- **Getting in** (`server.js`, `xdRefusal`): the token in `data/self/xd-token` (made by the server,
  readable by this user only, pasted into the panel once and kept in the plugin's data folder), and
  no `Origin` header (so no web page). One connection; a newer one replaces the older. A line
  silent for 75 seconds is dropped.
- **Requests** go out as `{ id, kind, params }` and come back as `{ id, ok, result }` or
  `{ id, ok: false, error, code }`, with a time limit (8 s). Three kinds:
  - `describe`: the selection and the tree from the root to depth 3. Per node: id, type, name,
    box `[x, y, width, height]`, text (text nodes), fill. At most 300 nodes, 300 characters of text
    each; deeper children are only counted.
  - `probe_edit`: see below.
  - `edit`: `move` (dx/dy or x/y), `resize`, `fill`, `text`, `rename`, `align` (XD's own Align
    commands, selection only). On the selection, or one node by id. Each is checked in
    `cleanEdit` before it is sent, and returns each node before and after.
- **The tools** (`lib/tools/xd.js`) are offered only while the panel is connected; when it connects
  or goes, the session restarts with the right tool list once it is idle (same conversation).
  `xd_edit` counts as acting on the screen: it needs Computer use on.
- **Privacy**: nothing from the document is logged. A probe report carries the type of the node it
  tried on, never its name.

## The probe

XD's documentation says a panel's edits go through `require("application").editDocument(fn)`, and
(from memory) that this must be called from a panel UI event. What is not known is how strict that
is. The probe's edit is harmless: rename one node, check the new name took, put the old name back.
It tries, in order:

| Step | What is tried | When |
| --- | --- | --- |
| `message` | `editDocument(fn)` | inside the event of the request message from Echo |
| `message_label` | `editDocument({ editLabel }, fn)` | inside the event of a second message |
| | *if either worked, stop: full control. Otherwise the panel shows "Let Echo edit".* | |
| `click` | a change inside `editDocument` called in the click handler | the control: do edits work at all |
| `held` | the click's edit function returns a promise, so the edit stays open; the change is made when a message from Echo arrives | does a held-open edit accept changes from a message |
| `after_0` | `editDocument(fn)` from a message that arrives once the click's edit has closed | right after the click |
| `after_5000` | the same | 5 seconds later |

For each step the report says whether the edit function ran, what `editDocument` returned, what it
threw or rejected with (XD's words, verbatim), and whether the change took and was put back. The
messages are real network messages: the plugin asks Echo for a "poke" and makes its attempt inside
the event of the poke that comes back.

## The three outcomes, and what gets built next

**1. Full control** (`message` or `message_label` worked). XD has no gesture rule for this. Build
the real vocabulary: create shapes and text, duplicate, delete, group, reorder, set stroke, corner
radius, opacity, font and size; batch several edits into one undo step; a `select` request so the
user sees what Echo means; and switch lessons in XD from pointing at pixels to checking the
document itself ("is there a rectangle named Card, 200 wide?").

**2. Control after a click** (`held` or `after_*` worked). The report says which:
- `after_5000` worked: a click unlocks edits for some time. Next: measure how long (30 s? until the
  panel closes?), and have Echo ask for the click once per session.
- only `held` worked: edits must happen inside an edit the click opened. The plugin already holds
  one open for 30 s per click. Next: find how long XD lets an edit stay open and whether the
  document is locked for the user meanwhile (the owner is asked to notice if XD felt frozen). If it
  is locked, keep the hold short and ask for a click per request ("say what you want, then click").
- only `after_0` worked: the window is short; treat as a click per request.
Then build the same vocabulary as under 1, behind "click Let Echo edit".

**3. Read-only** (only `click` worked, or nothing). Echo cannot edit from a message. Keep
`xd_describe`, which is still a large gain: Echo knows the exact names, places and sizes of things,
so it can point precisely (box → screen position needs the artboard's on-screen origin and zoom,
from the viewport API) and can check a lesson step from the document. One more thing worth a try
under this outcome: the user states the change, Echo queues it, and one click on a button in the
panel ("Do it") applies it inside that click.

## Not verified

Everything on the XD side is from memory of Adobe's documentation and has not run in XD: the
manifest's shape, whether `WebSocket` to `ws://127.0.0.1` needs a permission or sends an `Origin`,
`editDocument`'s return value, the scenegraph property names, the `commands` alignment names, the
data folder API. The plugin wraps every call and reports failures verbatim, so the first run in XD
will show which of these were wrong.
