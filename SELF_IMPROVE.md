# Self-improvement rules

How Echo changes its own code. Self-improvement workers must read this first. The code is in `lib/selfimprove.js`, `lib/safety.js`, `lib/tasks.js` and `supervisor.js`.

## 1. Unlocking

- The assistant can only **request** an unlock (`start_self_improvement`). Speech alone never unlocks.
- The Echo window shows a random 5-character code. You type it, plus your PIN if you set one, and click **Unlock & start**.
- An unlock covers **one task, for up to 30 minutes** (`VOICEOPS_SELF_UNLOCK_MINUTES`). Five wrong tries lock self-improve for 15 minutes.
- The first time, Echo turns its folder into a git repo with a baseline commit.

## 2. Branches and worktrees

- **One branch per self task:** `self/<timestamp>-<slug>`, checked out in its own worktree in a `.voiceops-worktrees` folder next to the Echo folder. The live folder is never the working folder.
- **Follow-ups continue on the same branch and worktree.** A follow-up to a self task (by voice or in the window) goes to the same worker session, in the same folder:
  - Still under review: the worker keeps editing the existing worktree.
  - Already merged: the worktree is recreated at the same path on the same branch, fast-forwarded to the live `main`, with a fresh `node_modules` clone. The next review shows only the new changes.
  - Discarded: the branch is recreated from the live `main` at the same path. Discarded edits are gone.
  - The task goes back to `working`, and a new review is prepared when it finishes. This all happens before the worker starts (the `follow_up` event on `TaskManager`, handled by `SelfImprove.reopen`). `selfImprove.continueTask(taskId, message)` does the same for callers that only have a self task id.
- **Bundle related work on one branch:** make one request (or follow-ups on the same task), not several parallel self tasks editing the same files.

## 3. Commits

- **Workers never commit.** `git commit` is always gated. Echo stages the changes only to show the diff.
- **Echo commits when you merge:** `Self-improve #N: <title>` on the branch, then `Merge self-improve #N` on `main` (`--no-ff`).
- **Hand edits in the live folder are saved before merging, never lost:**
  1. Echo commits them on `main` as `Save live edits before self-improve #N merge`. That covers tracked and untracked files. `.gitignore` already excludes `data/`, `logs/`, `node_modules/`, `.env` and `models/`.
  2. If that commit fails (a hook, for example), Echo runs `git stash push -u -m "echo-merge-<taskId>-<timestamp>"` and records the stash SHA in the audit log. It never pops or drops any stash. To get the edits back, run `git stash apply <sha>`.
  3. If neither works, the merge is refused and nothing changes.
- The rollback point (`lastGood`) is taken after the live edits are saved, so a rollback keeps them.

## 4. Tests and review checks

The worker runs `npm run review-checks` before finishing. The review runs exactly the same checks (`runChecks` in `lib/selfimprove.js`):

1. **Install, only when needed:**
   - `npm install --no-audit --no-fund` if `package.json` or `package-lock.json` differ from the task's base commit.
   - `npm ci` if there's a lockfile and `node_modules` is missing (`npm install` without a lockfile).
   - `npm install` if `node_modules` is older than the lockfile.
   - Nothing to install if the package declares no dependencies.
2. `npm test`
3. `npm run check` (the type check)

Each step runs in a **clean environment**: no inherited `VOICEOPS_*` variables (no `VOICEOPS_SUPERVISED`, the live port or the live data folder), no test-runner or npm-script variables, a throwaway data and log folder, and a **free port picked by the OS**.

Tests must therefore be **port-agnostic**. Never hard-code 4777 or 4799. Derive the port from `config.port`, or get a free one with `net.createServer().listen(0)` (see `test/supervisor.test.js`). Tests use `sandbox()` from `test/helpers.js`, so they never touch real data.

## 5. Review and merge

- When the worker finishes, the task tile shows the changed files, the diff summary and the check results. **View diff** opens the full diff.
- Nothing is merged until you click **Merge & restart** in the window, entering your PIN if one is set. **Discard** removes the worktree and the branch.
- A task that is running a follow-up can't be merged until its new review is ready.
- If the merge conflicts, it's aborted and everything stays as it was.
- If the change touches `package.json` or the lockfile, the live folder gets `npm install`. If that fails, the merge is undone.

## 6. Graceful restart and planned restarts vs. crashes

- After a merge, Echo writes `data/self/pending-restart.json` (lastGood, head, taskId, time). It then waits up to a minute for running workers, checkpoints the rest (they resume after the restart), sends the supervisor a `restart` message, and exits with code **75**.
- **Planned restarts never count as crashes and never roll back.** These count as planned: exit code 75, a `restart` message followed by any exit (even a signal or abort), or the exit of the old version started before the pending update. The crash counter doesn't move.
- A **crash** is any other exit. The supervisor restarts after a growing delay and gives up after more than 5 crashes in 2 minutes.

## 7. Auto-rollback

- With a pending update, the supervisor health-checks the new process at `/api/health` (only that process's answer counts). Once it's healthy, it deletes the pending file and logs `health_ok`.
- If the new version fails its health check or crashes, the supervisor runs `git reset --hard <lastGood>`, reinstalls the packages if they changed, restarts, and leaves `rollback-notice.json` so Echo tells you. The change stays on its branch.

## 8. Audit log

Every step is appended to `data/self/audit.log` (JSON lines), including:

- unlocks: `unlock_requested`, `unlock_failed`, `unlocked`, `locked_out`
- tasks and reviews: `task_started`, `follow_up`, `review_ready`, `review_failed`
- merges: `live_edits_committed`, `live_edits_stashed`, `merged`, `merge_rejected`, `merge_failed`, `discarded`
- restarts: `restart_begin`, `restart_checkpointed`, `health_ok`, `rolled_back`, `rollback_failed`
- PIN changes: `pin_set`

## 9. What self tasks may do freely, and what's gated

**Free (no prompt):**

- Read, edit and run anything inside the task's own worktree (tests, type check, a smoke server on a spare port: `VOICEOPS_PORT=4799 VOICEOPS_DATA_DIR=$(mktemp -d) node server.js`).
- **Read** the live Echo repo, its `logs/` and `data/`, and the worktrees folder with Read/Grep/Glob.
- Read-only shell commands on them. Every part of the command must be one of these:
  - `cat`, `head`, `tail`, `ls`, `wc`, `grep`/`rg` (not recursive `grep -r`), `find` (without `-delete`/`-exec`), `stat`, `jq`, `du`, `diff`, `sort`, `uniq`, `cut`
  - `awk`/`sed` without in-place edits or writes
  - read-only `git` (`log`, `show`, `diff`, `status`, `branch` listing, `rev-parse`, `ls-files`, `blame`, `grep`, `worktree list`)
  - `ps`, `lsof`
  - `curl`/`wget` GETs to localhost, such as `/api/health`

  No output redirection (except to `/dev/null` or `2>&1`), no `tee`, no `$(…)` or variables.

**Gated (asks you, every time):**

- Any write, move or delete in the live folder. Edits outside the worktree are simply denied.
- Process kills (`kill`, `pkill`, `killall`), `git commit`/`push`/`reset --hard`/branch deletes, `rm -r`, `sudo`, deploys, publishing.
- POST, PUT or DELETE to the live Echo port, and any other network write.
- Any other command that touches the live folder or port.

**Never:**

- Reading `.env` files or `data/self/pin.json` (denied outright).
- Starting a server on port **4777**, or anything that stops or restarts the live Echo.
- Changing the live folder yourself. Changes reach it only through review and merge.
- Loosening these gates. `lib/safety.js` and the PreToolUse hooks must stay at least as strict.
