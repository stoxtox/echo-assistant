# Listening section polish: before and after

The area under the sunset orb in Echo's main window: the status line, your live words, and the orb itself.

| | Before | After |
|---|---|---|
| Status while you hold Space | "Listening (local Whisper) · release Space to send" | "Listening". The first 3 push-to-talk turns add a quiet "· release Space to send" (the Mac app's shortcut says "let go to send"), then it's gone for good. |
| Other status lines | "Listening (Deepgram)…", "Voice input needs … the local Whisper engine" | Plain words: "Listening", "Listening · say “stop” anytime", "Voice input isn't available in this browser". No engine names anywhere in the main window (the engine picker in Settings still names them, since that's where you choose). |
| Live transcript | A big italic block of muted text that grew line after line and could push the chat down | A slim graphite-glass caption pill, like the Mac caption pill: 1–2 lines, the newest 4 words brightest, older ones dimmed, the oldest line slides up and fades out under the top edge. It hugs short phrases, wraps between words, never overflows, and fades away when the turn is sent. |
| The orb while you talk | Grew by about 3% with each syllable, only when the page itself held the mic | Swells up to about 8% with your voice, eased (rises in ~0.15 s, settles in ~0.6 s), ignoring room noise. Also works with the Mac app's own mic (its level now reaches the window). With Reduce Motion it doesn't grow; its glow brightens a little instead. |
| "Didn't catch that" | Could show while your words were still on screen; the status message was overwritten at once, and a dashed "Didn't catch that." bubble stayed in the chat | Only when nothing at all was heard (no live words and no transcription). Your words clear first, then a short note fades in in the same spot and fades out after about 2.6 s. It never overlaps the caption. The other quiet notes ("That was my own voice", "Not for me? Say “Echo” first") use the same spot, so they no longer vanish instantly. |

Screenshots of the new caption (dark and light) and the "Didn't catch that" note are in `docs/screenshots/listening/`.

Code: `public/livecaption.js` (the caption and notes, with pure helpers tested in `test/livecaption.test.js`), `public/voiceviz.js` (`swellFollow`), `public/app.js` (wiring), `public/style.css` (`.live*`), and one line in `macos/Sources/NativeMic.swift` that forwards the mic level to the window. That Swift change needs a rebuild of the Mac app (`npm run build-app`); without it everything else still works, the orb just doesn't swell with the app's own mic.
