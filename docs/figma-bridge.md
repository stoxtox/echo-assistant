# A bridge to Figma: plan (no code yet)

The same idea as the XD bridge (`docs/xd-bridge.md`): work through the app's own plugin interface
instead of clicking on a canvas. Figma should be the easier of the two, because its plugins may
change the document at any time, with no user gesture: there is nothing to probe.

## How a Figma plugin is built (from memory; check against Figma's docs before building)

- Two halves. The **main thread** has the document (`figma.currentPage`, `figma.currentPage.selection`,
  nodes with `x`, `y`, `resize()`, `fills`, `characters`, `name`) but no network. The **UI** is an
  iframe (`figma.showUI(__html__)`) with normal browser APIs, including `WebSocket`, but no
  document. They talk with `figma.ui.postMessage` / `figma.ui.onmessage` and
  `parent.postMessage({ pluginMessage }, '*')` / `window.onmessage`.
- So: the iframe holds the WebSocket to Echo and relays every message to the main thread, which
  does the work and relays the answer back. The UI can be tiny (a status line) or hidden
  (`figma.showUI(__html__, { visible: false })`), but the plugin must stay running: the user starts
  it once per file session (Plugins → Development → Echo bridge).
- `manifest.json` needs `networkAccess.allowedDomains` listing Echo's address
  (`ws://127.0.0.1:4777`, `ws://localhost:4777`); local addresses may need the `devAllowedDomains`
  list instead. Loaded with Plugins → Development → Import plugin from manifest. Desktop app only
  matters for us (the browser version would work too, but mixed-content rules may block `ws://` to
  this Mac from an `https` page: test it).
- Text edits need the font loaded first: `await figma.loadFontAsync(node.fontName)`.

## What changes on Echo's side

- The iframe is a web page, so it sends an `Origin` (for a plugin iframe this is expected to be
  `null`). `/ws/xd` refuses any Origin; a `/ws/figma` path must instead accept exactly the origin
  Figma's plugin iframe sends, plus the token. Find out what it sends first.
- The token: pasted into the plugin's UI once, kept with `figma.clientStorage`.
- Reuse `XdBridge` almost whole: make it a `DesignBridge` with a name and a path, two instances.
  Same request shape, same `describe` and `edit` vocabulary, so the assistant's tools can become
  `design_describe` / `design_edit` with an `app` argument rather than three more tools.
- No probe and no "Let Echo edit" button.

## Steps

1. Skeleton plugin: manifest, hidden UI with the socket, relay, `describe` (selection and the
   current page to depth 3, same node shape as XD: id, type, name, box, text, fill).
2. `/ws/figma` on the server, with the origin and token check; tests with a fake plugin socket.
3. `edit`: move, resize, fill (`fills = [{ type: 'SOLID', color }]`, colours are 0 to 1), text
   (after loading the font), rename, align (computed from boxes; Figma has no align command for
   plugins as far as remembered). Each returns before and after.
4. Fold the XD and Figma tools into one pair; pick the bridge by which app is in front.
5. Then the larger vocabulary (create, duplicate, group, auto layout, components), shared in shape
   with whatever XD ends up allowing.

## Open questions

- The exact `Origin` of the plugin iframe, and whether `ws://127.0.0.1` is allowed from it in the
  desktop app without TLS.
- Whether the plugin can be kept running across files, or must be started per file.
- Whether to ship it as a private organisation plugin or keep it a development import.
