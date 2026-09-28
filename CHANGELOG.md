# Changelog

All notable changes to Echo. Write notes for the next release under "Unreleased"; `npm run release` moves them under the new version.

## Unreleased

## [1.2.0] - 2026-09-28

- Say "Hey Echo" (or just "Echo") to talk, hands-free, as well as holding Space. Echo listens for her name on your Mac only: a light loudness check runs all the time, and each burst of speech is checked by the local Whisper model; nothing is sent anywhere or saved before the wake word. When she hears it, a soft chime plays and the sunset lights up, and your request is recorded until you pause ("Hey Echo, check the build" in one breath works too). She never wakes on her own voice (the listener is muted while she speaks), and when she's just asked you a question you can answer without saying her name. On by default; Settings has the switch and a sensitivity slider, and the "Hey Echo" pill at the top turns the mic off completely. Needs local Whisper (`npm run setup:whisper`). On test recordings it woke on 3 of 3 of your own "Hey Echo"s and never on 19 of your other clips; details and idle CPU are in docs/speech-recognition.md.
- Echo sounds like she's speaking, not reading: her voice gets whole sentences (a short reply in one go) instead of comma-sized pieces, the silence the voice engine pads each piece with is trimmed, and pieces join with a short, natural breath. With ElevenLabs, each piece also carries on the intonation of the one before. She's told to open with a short first sentence so she still starts quickly.
- No more answering a bare ".": when the final transcription comes back blank (or much shorter than what the live listener showed), Echo uses the live text; if nothing was heard at all, nothing is sent, a small "Didn't catch that" note appears, and she says so softly once. Each blank clip is saved with its loudness and the mic's state in the speech log, a microphone stream that has gone silent (after sleep or a device change) is reopened, and push-to-talk now really keeps the last moment after you let go.

- Echo hears your project and contact names much better. Whisper now gets a short list of just the unusual names you say (spelled the way you say them, most important last) instead of a long list it mostly ignored, and Echo uses the full large-v3 Whisper model when it's downloaded (`npm run setup:whisper -- --accurate`, about 1.1 GB): on test clips in Indian-English voices it got 12 of 12 names right, against 4 of 12 before, for about a third of a second more.
- Speech correction never swaps in a project or contact you didn't say: a name only goes in when it sounds like what was heard or is a nickname you've confirmed. Otherwise your words stay as heard and Echo asks.
- Spelling a name out works even when a letter or two is misheard: the letters are matched to your projects, contacts and vocabulary.
- Echo listens properly again. Pauses are squeezed out of each recording before Whisper hears it (long silences made it skip and invent whole sentences), and a recording with no real speech in it, like a click or a breath, is never sent, so phantom "Thank you" turns are gone. Whisper's stock silence phrases (a trailing "you", "Thanks for watching") and segments it was only guessing at are dropped, and you see "Didn't catch that" instead. When the final text is a different sentence from what the live preview showed, the live text is used. On your own saved clips, made-up turns went from 4 of 4 to 0 and word errors from 37.5% to 15%. On Indian-English test clips, word errors went from 6.6% to 4.0% (11.9% before the name change). Details are in docs/speech-recognition.md.
- Echo stays on the turbo Whisper model even when large-v3 is downloaded: on real speech, large-v3 made twice the errors and was slower.
- Clicking the mic (or using the Mac menu) stops listening by itself after you finish talking, or after 8 seconds of nothing, so an open mic no longer records the room. Hands-free now only answers when you say "Echo" or reply right after her (new setting, on by default), and a turn that's just Echo's own voice picked up by the mic is ignored.
- Each turn's speech-log entry records every stage (the live text, Whisper's text with its confidence, what was dropped and why, and what was used), so a misheard turn can be traced.
- Echo's own voice is kept out of your recordings: the mic ignores everything while she speaks and for a moment after, so a clip never starts with the end of her reply. Each clip notes whether echo cancellation was really on, and the last 20 clips are kept (in the data folder) so a misheard sentence can be checked.

## [1.1.0] - 2026-09-25

- The installer works on a brand-new Mac: Node.js now comes straight from nodejs.org (the right build for your Mac, checked against its official checksum) into Echo's own folder, so it no longer needs git or Apple's developer tools. Apple's Command Line Tools are checked at the start; if they're missing, Apple's installer opens while everything else carries on, and if you skip it Echo opens in the browser instead.
- Setup has a new "Sign in to Claude" step: it shows whether you're signed in, opens the Claude sign-in in your browser, explains a Claude Pro or Max plan versus a pay-as-you-go API key, and confirms it works with a tiny test message. The installer now installs Claude Code without asking.
- Echo starts talking sooner: her voice begins at the first comma or phrase instead of the end of the sentence, the pieces play back to back with no gaps, the voice engine stays warm, and she says a quick "Sure, checking." the moment you stop talking.
- Echo always knows where every task stands (status, latest activity, pending approvals and how risky they are), so "where are we?" gets an instant answer.
- Task news never cuts Echo off: it waits until she's finished, then comes in with a short "Oh, and…". Approvals you've already answered are never announced.
- Task updates show in the chat as compact cards with a task chip and a status colour; approvals have Approve and Deny right on the card, and shrink once answered.
- The sunset shrinks to a small glow at the top when Echo is idle, giving the chat more room, and grows back when she listens, thinks or speaks (instantly, with reduced motion).
- A new app icon: Echo's glass sunset drop over the water, drawn for every size from 16 to 1024 pixels.
- Release tools: confirmations can be piped in or skipped with `--yes`, and `npm run release -- --current` prepares the current version without bumping it.

## [1.0.1] - 2026-09-25

- One-line install from GitHub (`install-remote.sh`), with a verified download.
- Echo updates itself from GitHub Releases: a daily check, an "Update available" card, "Update now", an optional automatic install, and an automatic rollback if a new version doesn't start.
- The setup wizard shows how far the voice download is.
- Speech correction no longer swaps a spelled-out name, a contact or a vocabulary word for something else, and never puts in your own name for someone else's.

## [1.0.0] - 2026-09-25

- First shareable version of Echo: a voice assistant for your Mac that runs Claude Code workers for your projects, research and everyday errands.
- Setup wizard, beginner mode and safe mode, Reset Echo, and a privacy check that keeps personal data out of every package.
- A native Mac app with a menu bar icon and a summon shortcut.
