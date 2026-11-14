# Echo for Chrome

The Chrome side of Echo's browser adapter (`lib/browser.js`). With it, Echo reads the page you're
on as a list of its buttons, links and fields (each with a ref, like `[e7] combobox "To
recipients"`), acts on them with real clicks and typing through Chrome's debugger, and reads them
back to check. It's more precise than the screen: Gmail's Compose, To and Subject are found by
what they are, not by where their text is.

Install (developer mode): Chrome → Extensions → turn on Developer mode → Load unpacked → pick this
`extension` folder. Then open Echo's Settings → Screen → copy the Chrome pairing code, click the
Echo toolbar icon and paste it. A green dot on the icon (and "Connected" in its options) means Echo accepted the connection; a red "!" means the code was refused. It stays connected while Chrome is open (a keep-alive and a 30-second alarm stop Chrome from putting it to sleep). After updating Echo, click the reload arrow on the extension in chrome://extensions.

Pairing is once: the code stays in the extension's storage (through Chrome restarts and extension
reloads) and in Echo's data folder (through Echo restarts and app rebuilds). When Echo restarts,
the extension reconnects by itself within a few seconds (it retries at once, then every 1 to 10
seconds, and replaces a socket Echo stopped answering). If it ever needs pairing again (it was
removed and added back, so its storage is new), Echo's window shows one prompt with the code.

Frames: Echo reads and types into rich-text editors that sit in an iframe (eBay's description box,
TinyMCE, CKEditor) as well as the page itself.

Privacy: it talks only to Echo on this Mac (127.0.0.1). It never reads or types into password
fields. While Echo acts, Chrome shows its "started debugging this browser" bar; that's the real
input. Without Chrome's debugger it falls back to the page's own events.
