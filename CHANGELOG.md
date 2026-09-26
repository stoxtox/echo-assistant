# Changelog

All notable changes to Echo. Write notes for the next release under "Unreleased"; `npm run release` moves them under the new version.

## Unreleased

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
