# The VoiceOps → Echo rename

Echo started out as VoiceOps. Since October 1, 2026 every name in the code, scripts, tests and docs is Echo. What changed:

| Before | Now |
|---|---|
| `VOICEOPS_*` environment variables (`VOICEOPS_PORT`, `VOICEOPS_DATA_DIR`…) | `ECHO_*` (`ECHO_PORT`, `ECHO_DATA_DIR`…) |
| `logs/voiceops.log` (the supervisor handover log) | `logs/echo.log` |
| `.voiceops-worktrees` next to the Echo folder | `.echo-worktrees` |
| `voiceops.*` keys in the window's local storage | `echo.*` |
| git identity `voiceops@localhost` on Echo's merge commits | `echo@localhost` |
| the folder `…/VoiceOps` | `…/Echo` (with `npm run rename-folder`) |

Not changed on purpose: the Mac app's bundle ID (`local.echo.app`) and its signature, so macOS keeps its microphone, screen recording and accessibility permissions.

## Moving the folder

`npm run rename-folder` (`scripts/rename-folder.js`, the work is in `lib/rename.js`) moves a folder still named `VoiceOps` to `Echo` next to it. Echo must be stopped; `--restart` stops it, renames and starts it again (in the background, so it can be started from Echo itself; progress in `/tmp/echo-rename.log`). `--dry-run` only shows the steps. Each step skips itself if it's already done.

1. `VoiceOps/` becomes `Echo/`, and a `VoiceOps` link to it is left behind.
2. The worktrees in `.voiceops-worktrees/` move to `.echo-worktrees/`, and a `.voiceops-worktrees` link is left behind.
3. git's links between the checkout and each worktree are rewritten to the new paths (then `git worktree repair`).
4. Folder paths saved in Echo's data (a task's `cwd`, `projectPath` and `worktree`) are updated. Each changed file is backed up first as `<name>.before-rename`. Text that merely mentions the old path (conversation history, the audit log, task logs) is left as it was. Settings, memory, contact aliases, vocabulary, costs and logs live inside the folder and move with it unchanged.
5. Claude Code's per-folder sessions and memory (`~/.claude/projects/<folder>`) are renamed to the new folder names, with links left behind, so tasks resume their sessions.
6. On a Mac, the app's `EchoDir` preference is set to the new folder (it takes priority over the folder baked into the app), so the app opens the renamed folder without a rebuild.

## Compatibility shims (the only places the old name is left)

- `lib/legacy.js`: `VOICEOPS_*` variables fill in their `ECHO_*` names at start-up (an `ECHO_*` value wins); `withLegacyEnv` gives the supervisor's server both names, so a rollback to a version from before the rename still gets its settings; `logs/voiceops.log` is renamed to `logs/echo.log` on start; `appDirAliases` treats a `VoiceOps` link to Echo's folder as Echo itself.
- `lib/config.js` `legacyWorktreeDir`: worktrees made in `.voiceops-worktrees` stay readable to self-improve workers like the new folder (`lib/safety.js` `selfReadableRoots`).
- `lib/safety.js` `selfPatterns`: commands naming the old `VoiceOps` path still count as touching Echo itself, so the gate stays as strict.
- `lib/projects.js`: the `VoiceOps` link isn't listed as a project.
- `lib/selfimprove.js` `INHERITED`: review checks strip both `ECHO_*` and `VOICEOPS_*` variables.
- `lib/privacy.js`: `.voiceops-worktrees` is still a personal folder name, and `VoiceOps` is still a product word (so these shims don't trip the package privacy check).
- `public/app.js`: `voiceops.*` local-storage keys move to `echo.*` once; Reset clears both.
- `scripts/launcher.sh`, `start.command`, `scripts/install.sh`: `VOICEOPS_PORT` is read if `ECHO_PORT` isn't set.
- `macos/Sources/Config.swift` reads `VOICEOPS_PORT` after `ECHO_PORT`; `macos/Sources/Server.swift` sets both for the launcher (an older Echo folder reads the old name). These only take effect on the next `npm run build-app`; the installed app already sets `VOICEOPS_PORT`, which still works.
- `scripts/simulate-release.js` strips `VOICEOPS_*` variables along with `ECHO_*` ones.
- The `VoiceOps` and `.voiceops-worktrees` links left by the folder rename, and the `.before-rename` backups. Delete them once nothing needs the old paths.

Your own data still mentions VoiceOps where it records history (conversations, memory notes, the audit log, task logs) and in the vocabulary (words like "white soaps" → VoiceOps). That's left alone; edit the vocabulary in Settings if you like.
