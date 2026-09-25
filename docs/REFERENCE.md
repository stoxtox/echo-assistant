# Echo

*(The project folder is still named `VoiceOps` for now.)*

A voice assistant for all your projects and everyday errands. You talk to it, and it runs Claude Code workers in the background (coding in your project folders, research in a web-enabled workspace) while it keeps talking to you. It can even improve its own code, safely.

```
You (mic) ─► speech-to-text ─► Dispatcher (Claude) ─► spoken reply (Kokoro / ElevenLabs)
                                   │  knows the time, your projects, your memory
               ┌───────────────────┼────────────────────┬──────────────────────┐
               ▼                   ▼                    ▼                      ▼
        start_task: FitTrack start_task: Foodbowl start_research: trip   start_self_improvement
        (project folder)     (project folder)     (_research/, web on)   (git worktree, reviewed)
```

## Run it

```bash
# from the Echo folder:
npm start            # supervisor + server; open http://localhost:4777 in Chrome
```

Or double-click `start.command`. `npm start` runs `supervisor.js`, which keeps the server alive, restarts it gracefully after a self-update, and rolls back automatically if the update is broken. (`npm run serve` runs the server alone, with no auto-restart.)

It uses your existing Claude Code login, so you don't need an API key.

## Voice

- **Kokoro** (default): a free, natural-sounding neural voice that runs locally on your Mac (~1s per sentence on an M3). The first run downloads the ~90 MB model.
- **ElevenLabs** (premium): copy `.env.example` to `.env`, add `ELEVENLABS_API_KEY`, restart, then pick it under **Voice & vibe**.
- **Browser**: the basic built-in voice, used as a fallback.
- Replies are spoken **sentence by sentence while the assistant is still writing**, and a quick "one sec" filler plays the moment it starts looking something up, so there's no dead air.
- **Voice & vibe** panel: assistant name, your name, personality (Buddy, Hype, Chill, Witty, Pro), voice, speed, sound effects, and your self-improve PIN.
- Press <kbd>Space</kbd> while it's talking to cut in.
- Echo's voice is a drop of liquid sunset light behind glass (WebGL, with a Canvas2D fallback). It breathes softly when idle, ripples in cooler dusk tones with your mic while listening, flows gently while thinking, and moves with her voice while she speaks: loudness drives motion and size, pitch shifts the colour between deep rose, coral, tangerine and gold. States morph into each other, it pauses in background tabs, and with reduced motion it only pulses gently.
- **Ambient piano:** the note button in the header plays gentle, generative piano (never the same twice) while workers run. Pick a mood (Upbeat & professional, Mellow, 90s feel, Deep focus) from its menu. It ducks whenever Echo speaks or listens, and remembers your choice.

## Speech recognition

Tuned for English with an Indian accent, and **locked to English**: every engine is told the language, so English is never transcribed (or translated) as another language. The **Language** setting (`sttLanguage`) only picks the accent: `en-IN` (default), `en-US` or `en`; anything else falls back to `en-IN`. Pick the engine under **Voice & vibe → Speech recognition**:

| Engine | Cost | Notes |
|---|---|---|
| **Local Whisper** (default via *Auto*) | Free, private, offline | whisper.cpp + large-v3-turbo on the Mac's GPU, ~1s per sentence. Always English: started with `-l en` and every request sends `language=en`, no auto-detect, no translation. Setup: `npm run setup:whisper`. |
| **Deepgram Nova-3** | Paid per minute of audio | Cloud; uses your vocabulary as *keyterms*; gets the language setting (`en-IN`, `en-US` or `en`). Add `DEEPGRAM_API_KEY` to `.env` and restart. |
| **Browser** | Free | Chrome's built-in engine, set to `en-IN` or `en-US` (`browserLang` from `GET /api/stt`; `en` means `en-US`). Fallback; also shows your words live while you talk. |

What happens to each sentence:
1. **Vocabulary**: your project names, confirmed aliases, the words list you edit in the panel (Maya, Hoboken, AMC, bibimbap, …) and learned fixes go to Whisper as its initial prompt, or to Deepgram as keyterms.
2. **Instant fixes**: learned mishearings that aren't normal English ("hoe broken" → Hoboken, "they eat 31" → 8:30) are replaced right away. Everyday words like "football" are only fixed when the context fits.
3. **Smart correction**: a fast model (Claude Haiku, about 1s and about $0.003 per sentence) fixes remaining mishearings using the vocabulary, your projects and the last few lines of conversation. Fixes that don't sound like what was said are marked *unsure*.
4. **Confirm, don't guess**: low-confidence words, and loose guesses that matter (a project, time, name or amount), get a quick "Budget2, right?" before Echo acts. They're underlined in the chat.
5. **Learning**: say "no, I meant bibimbap" and Echo saves the fix (`learn_correction`), so it works from then on. You can remove learned fixes in the panel.

Raw and corrected text are logged side by side in `data/stt-log.jsonl` and in the daily transcript in `data/conversations/`.

**End of speech:** hold <kbd>Space</kbd> to talk; the last 0.35s after you release is still captured, and the 0.35s before you pressed is kept too, so first and last words aren't clipped. In **Hands-free**, a detector ends your sentence after a pause you choose (0.8–3s, default 1.3s). Make it longer if you get cut off mid-thought.

## Using it

- **Talk:** hold <kbd>Space</kbd> (or click the orb), speak, then release. Turn on **Hands-free** to talk without pressing anything.
- **Hush:** <kbd>Esc</kbd> stops it talking.
- **Type:** the text box works too.
- Things to say:
  - "In FitTrack, find out why the build fails and fix it." *(coding task)*
  - "Find kid-friendly weekend activities in Riverside." *(research task, saved in `_research/`)*
  - "What's playing at AMC tomorrow around 9?" *(knows today's date and time)*
  - "How's the weekend research going?" *(checks the real status and the saved files)*
  - "Tell task 2 to also add tests." *(works even while it's running)*
  - "Yes, and stop asking me about read-only lookups for this task."
  - "When I say football I mean Foodbowl." / "Hide the untitled folder."
  - "Open a terminal on task 1."
  - "Improve yourself: say goodbye when I close the app." *(self-improve mode, below)*

### Project names

Speech recognition mishears names, so project tools match by **sound and spelling** ("fit track" → FitTrack). When a match isn't confident ("football" → Foodbowl?), the assistant **asks before acting**, and once you confirm, it saves the alias so it works next time. Aliases, hidden folders and one-line project descriptions are in `data/projects.json`. Folders starting with `_` or `.` are never treated as projects.

### Research and errands

Trip planning, movie lookups, shopping research and other errands run with `start_research` in **`_research/<topic>/`** inside your projects folder. Web search and fetch are on there, and results are saved as Markdown files. A research task is only reported as done once it has actually saved something.

### Quick errands (no worker)

Texting someone, adding a calendar event, or opening a link or an app happens right away on the Mac through `osascript` (`lib/quick.js`), in seconds instead of minutes.

- **Contacts:** `find_contact` searches the Contacts app (cached for 5 minutes). The assistant only sees masked numbers and emails (last 4 digits); the full value stays in Echo under an id.
- **Favorites:** after you confirm which "Sam" you meant, the assistant saves it with `set_contact_alias` (`data/contact-aliases.json`), and from then on "text Sam" goes straight to that number.
- **iMessage:** `send_imessage` shows a **Send / Cancel** card in the chat (it expires after 3 minutes), or you can say "yes, send it". It sends without a card only when you gave both the person and the exact words in one request *and* the person is a saved favorite or an unambiguous match. SMS only when you ask for it. Every card, send, cancel and failure is logged in `data/quick-actions.log`.
- **Calendar:** `add_calendar_event` adds to your first writable calendar, or the one you name, with an optional alert.
- **Permissions:** the first time, macOS asks whether the app Echo runs in (Terminal or node) may control Contacts, Messages and Calendar. If you said no, Echo tells you where to switch it on: System Settings, Privacy & Security, Automation.

## Costs

The header shows today's running total: **the assistant you talk to** plus **its workers**, and each task tile shows what that task cost. These are the Agent SDK's API-equivalent estimates. With a claude.ai login they count toward your plan's usage limits rather than being billed in dollars. The ledger is `data/costs.json`. Task titles are written by a small model (Claude Haiku), which costs a fraction of a cent.

## Safety

- Coding workers can edit files inside their own project folder. They can't read or edit Echo itself, and research workers only write inside their research folder.
- **Always asks you first; no grant can skip it:** `git commit`/`push`/`reset --hard`, `rm -r`, `sudo`, deploys, publishing, piping downloads into a shell, and any web request that logs in, pays, signs up, applies, submits a form, uploads, or uses credentials. Also anything touching the Echo folder or its port. The one exception: self-improvement workers may *read* the live Echo (its code, logs and data) without asking; see [SELF_IMPROVE.md](SELF_IMPROVE.md).
- **Read-only web requests** (like store or listings searches) ask once. Say "approve all like this" (or click it) to stop being asked for that task, or for the whole session.
- **Approvals aren't read out stale.** Echo waits about 2 seconds before mentioning a new approval; anything you already clicked in the window by then is never mentioned, and a queued mention is dropped the moment it's answered. Read-only lookups from several tasks become one question ("three tasks want quick web lookups, okay?") that you can answer once. Risky ones are always asked about on their own and never covered by a group answer.
- A click on an approval that was already answered (or replaced by a newer one) is ignored.
- These gates are **PreToolUse hooks**, so they hold even though your Claude Code user settings auto-approve some commands.
- Subagents are forced to run in the foreground, so a worker can't end before its work is done.
- The server only listens on `127.0.0.1` and rejects requests from other websites' origins.

## Self-improve mode

Echo can change its own code without risking the running app:

1. **Ask by voice:** "Improve yourself: …". The assistant can only *request* an unlock.
2. **Confirm on screen:** a box shows a random code. Type it (plus your PIN, if you set one under Voice & vibe) and click **Unlock & start**. Speech can't unlock it, so a mishearing or someone overhearing can't trigger it. The unlock lasts **30 minutes or one task**, whichever comes first. Five wrong tries lock it for 15 minutes.
3. **Isolated work:** the worker edits a separate **git worktree** on a `self/…` branch in a `.voiceops-worktrees` folder next to the Echo folder, never the live folder, and runs the tests and type check. It may read the live code, logs and data without asking; changing anything live still asks. The review runs the checks again the same way `npm run review-checks` does: packages installed first if `package.json` or the lockfile changed or `node_modules` is missing or stale, then tests and type check in a clean environment (throwaway data folder, a free port, no inherited `VOICEOPS_*` settings).
   **Follow-ups** ("tell task 7 to also…") continue on the same branch and worktree, even after a merge or discard, and produce a new review.
4. **Review:** the task tile shows the diff summary and check results. Use **View diff** to see the full diff. Nothing is committed until you click **Merge & restart** (the PIN is needed again, if set), or **Discard**.
5. **Graceful restart:** Echo waits up to a minute for running tasks, pauses the rest, restarts, and **resumes them automatically**.
6. **Auto-rollback:** the supervisor installs changed packages, then health-checks the new version. If it doesn't come up or it crashes, it resets to the last good commit, restarts, and tells you. How the *old* version exits (even a crash on the way out) doesn't count; only the new version's health does.
7. **Audit log:** every request, unlock, failed attempt, review, merge, restart and rollback is in `data/self/audit.log`.

**Updating from a version before September 25, 2026:** the supervisor that was already running then still judged a restart by how the old version exited, and the old voice library always crashed on exit, so every merge was rolled back. To apply the first update past that, quit Echo, start it once with `npm run serve`, then click **Merge & restart**. It hands over to the new supervisor (logging to `logs/voiceops.log`). From then on, merges restart on their own, and `start.command` works as usual.

The first time you use it, Echo turns its folder into a git repo with a baseline commit (the unlock box tells you). If the live folder has hand edits when you merge, Echo first commits them on `main` ("Save live edits before self-improve #N merge"), or, if that commit fails, stashes them as `echo-merge-<task>-<time>` and logs the stash's SHA, so hand edits never get lost.

The full rulebook (branches, commits, checks, restarts, rollback, and what self-improvement workers may and may not do) is in **[SELF_IMPROVE.md](SELF_IMPROVE.md)**.

## Sharing Echo, setup and beginner mode

Echo can be given to someone who isn't a developer. **[GETTING_STARTED.md](GETTING_STARTED.md)** is their guide. **HANDOFF.md** (kept out of the package) explains how to package and install it for them.

- **Package:** `npm run package` (or `npm run make-share`) copies only the product into `dist/Echo/` and makes `dist/Echo.zip`, but only if the **privacy check** passes. The check (`npm run privacy-check`, `lib/privacy.js`) fails on:
  - personal files (`data/`, `logs/`, `.env`, the PIN, memory, transcripts…)
  - secrets
  - `/Users/<name>` paths
  - real-looking phone numbers and emails
  - this install's personal words: your Mac and git names, plus your name, favorites, vocabulary and project names read from your data folder at check time
- **Install:** double-click `install.command` (`scripts/install.sh`). It installs Node.js if needed (nvm) and the packages, installs Claude Code and walks through the Claude sign-in (each person needs their own Claude subscription), optionally sets up Whisper and the Kokoro voice, and builds the native `~/Applications/Echo.app` (`macos/`, `scripts/build-app.sh`; `npm run build-app` for your own copy), falling back to a browser launcher (`scripts/launcher.sh`) without Apple's Swift tools. A packaged install is marked by `.echo-package`, so its projects default to `~/Echo Projects`.
- **First-run setup:** a fresh install (no `data/settings.json`) opens a wizard. It asks for:
  - your name
  - what you want help with
  - whether you've written code before
  - the projects folder
  - voice and hands-free
  - a self-improve PIN

  It also walks through the macOS permissions with test buttons and ends with a short tour. Installs from before setup existed never see it. For screenshots, `?setup=<step>` opens it at a step.
- **Beginner mode** (setup turns it on for non-developers): Echo uses plain words, suggests things that fit your interests, and handles errands and questions directly. For small projects, `start_project` makes a new folder in the projects folder, and a worker creates a real `.xlsx` or `.docx` file (or a website running on this Mac) and opens it. `find_file` finds your own files with Spotlight, and they're copied in, never changed. Deploying is explained step by step and always needs your OK.
- **Safe mode** (also on for non-developers): these always ask first:
  - deleting files
  - installing software
  - controlling other apps (`osascript`)
  - sending email

  Messages always show the Send / Cancel card, "stop asking" grants cover one task at most, and self-improve stays locked until a PIN is set.
- **Releases and updates:** `npm run release` prepares a versioned, privacy-checked `Echo-<version>.zip` with a SHA-256 file and CHANGELOG notes; `npm run publish-repo` and `npm run release:publish` put it on GitHub (both ask first; see HANDOFF.md). People install with one line (`install-remote.sh`), and an installed Echo checks GitHub Releases daily, shows **Update available**, and installs with **Update now** (or by itself if turned on): verified download, data never touched, graceful restart, health check, and automatic rollback (`lib/updater.js`). A git checkout like this one shows "Developer copy" and never updates from releases.
- **Reset Echo** (Settings, Help & safety) wipes this install's personal data and restarts into setup: the data folder, logs, chat attachments, and the Claude Code transcripts of Echo's own sessions. Projects are kept.

## Files

| Path | What |
|---|---|
| `supervisor.js` | Keeps the server running; restarts, health checks and rollbacks |
| `server.js` | HTTP + WebSocket server; wires everything together; graceful restart |
| `lib/dispatcher.js` | The assistant you talk to: its prompt and tools |
| `lib/tasks.js` | Workers: one Claude Code session per task, approvals, follow-ups, checkpoints |
| `lib/quick.js` | Quick native errands: contacts, iMessage with a confirmation card, calendar, open link/app |
| `lib/approvals.js` | Tells the assistant about approvals: debounced, grouped, never stale |
| `lib/safety.js` | What needs approval, and voice-granted auto-approvals |
| `lib/selfimprove.js` | Self-improve mode: unlock, worktree, review, merge |
| `lib/onboarding.js` | First-run setup answers, and Reset Echo |
| `lib/privacy.js`, `scripts/privacy-check.js` | The personal-data check for packages |
| `scripts/package.js` | `npm run package`: the shareable folder and zip |
| `lib/release.js`, `echo-release.json` | Versions (semver), checksums, the changelog, and the public GitHub repo (set in one place) |
| `scripts/release.js`, `scripts/publish-release.js`, `scripts/publish-repo.js` | `npm run release`, `release:publish` and `publish-repo` |
| `lib/updater.js`, `scripts/update.js` | In-app updates from GitHub Releases: check, verify, stage, swap, roll back |
| `install-remote.sh` | The one-line install from GitHub |
| `scripts/simulate-release.js` | `npm run release:simulate`: the whole release, install and update flow against a local stand-in for GitHub |
| `install.command`, `scripts/install.sh`, `scripts/launcher.sh` | The macOS installer, and the launcher that starts Echo (at most one copy) |
| `macos/`, `scripts/build-app.sh` | The native Echo Mac app (Swift, WKWebView, menu bar item, summon shortcut) and its build |
| `public/onboarding.js` | The setup wizard |
| `lib/projects.js` | Project discovery, sound-alike matching, aliases, hidden folders |
| `lib/text.js` | Local time, and turning worker output into speakable summaries |
| `lib/voice.js`, `lib/settings.js` | Text-to-speech engines; voice and personality settings |
| `public/` | The voice UI: warm graphite with a sunset accent (theme tokens at the top of `style.css`), the liquid-light voice visual (`voiceviz.js`) and the ambient piano (`piano.js`) |
| `public/icons/` | Echo logo sources (`echo-mark.svg`, `echo-app-icon.svg`, `favicon*.svg`) and generated PNGs |
| `test/` | `npm test` (unit tests plus an end-to-end rollback test) |
| `data/` | Tasks, memory, `projects.json`, `conversations/` (daily transcripts), `self/` (audit log, PIN hash) |
| `logs/task-N.log` | Live log per task (what the Terminal button tails) |

## Development

```bash
npm test          # unit tests plus end-to-end rollback tests, all in throwaway folders
npm run review-checks  # install if packages changed, then tests and type check, as the review runs them
npm run check     # type check (TypeScript over JSDoc)
npm run build     # same as check; there's no bundling step
npm run package   # shareable dist/Echo.zip, only if the privacy check passes
npm run privacy-check  # re-run the check on dist/Echo (or a folder you name)
npm run release [patch|minor|major]  # a versioned release in dist/release/ (see HANDOFF.md)
npm run release:simulate  # rehearse release → one-line install → update → rollback, locally
npm run icons     # re-render the PNG icons from the SVGs (needs rsvg-convert: brew install librsvg)
```

## Config (env vars)

| Var | Default |
|---|---|
| `VOICEOPS_ROOTS` | the projects folder picked in setup (a shared install: `~/Echo Projects`; a developer checkout: the folder Echo sits in); colon-separate to add more |
| `VOICEOPS_PORT` | `4777` |
| `VOICEOPS_TZ` | your Mac's time zone |
| `VOICEOPS_MAX_WORKERS` | `4` concurrent workers (more get queued) |
| `VOICEOPS_RESEARCH_DIR` | `_research` in the projects folder |
| `VOICEOPS_SELF_UNLOCK_MINUTES` | `30` |
| `VOICEOPS_DISPATCHER_MODEL` / `VOICEOPS_WORKER_MODEL` | your Claude Code default |
| `VOICEOPS_DISPATCHER_EFFORT` | `low` (snappy voice replies; workers use full effort) |
| `ELEVENLABS_API_KEY` | unset (premium voice off) |
| `DEEPGRAM_API_KEY` | unset (cloud speech recognition off) |
| `VOICEOPS_WHISPER_PORT` | port + 1 (`4778`), local Whisper server |
| `ECHO_REPO` | `owner/repo` from `echo-release.json` (where updates come from) |
| `ECHO_GITHUB_API` | `https://api.github.com` (a stand-in for tests and the simulation) |
| `ECHO_UPDATE_CHECKS` | on; `off` stops the daily check |
| `ECHO_DEVELOPER_COPY` | detected (`.git` and no `.echo-package`); `1` or `0` to force |

## Roadmap

1. **Streaming ears:** stream audio to Deepgram (or chunked Whisper) for words-as-you-speak and true hands-free barge-in with echo cancellation, plus a wake word ("Hey Echo").
2. **Voice fingerprint:** fine-tune or adapt Whisper on your own saved corrections (`data/stt-log.jsonl`).
3. **Browser handoff:** open checkout or login pages pre-filled for you to finish (never entering passwords itself), with a "done" confirmation back to the assistant.
4. **Result cards:** show research results (showtimes, products) as clickable cards in the UI while the assistant summarizes them aloud.
5. **Isolation for coding tasks:** optional worktree/branch per coding task, with a spoken "review the diff" step.
6. **Native shell:** a menu-bar app with a global hotkey and notifications when tasks finish.
7. **Phone access:** a secure tunnel plus auth.
8. **Beyond code:** calendar, email and GitHub connectors, scheduled routines ("every morning, check CI").
9. **Self-review:** have self-improve mode read `data/conversations/` and propose fixes for stumbles it finds.
