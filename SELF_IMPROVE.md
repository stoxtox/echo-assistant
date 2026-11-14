# Self-improvement rules

How Echo changes its own code. Self-improvement workers must read this first. The code is in `lib/selfimprove.js`, `lib/safety.js`, `lib/tasks.js` and `supervisor.js`.

## 0. Developer copy only

Self-improve exists only in the developer's own copy of Echo (decided Sept 30, 2026). `lib/devcopy.js` is the one check, made once at startup, and it fails closed. A copy may self-improve only if it is:

- not packaged (no `.echo-package`),
- the main git checkout of its folder (not a worktree, not a subfolder of another repo),
- not a clone of the public release repo (`echo-release.json`),
- explicitly marked: `ECHO_DEV_COPY=1`, or a git-ignored `.echo-dev` file in the Echo folder. `ECHO_DEV_COPY=0` always turns it off.

A checkout with its own `origin` remote whose audit log already records a merged self-improvement gets the `.echo-dev` marker once (`dev_copy_marked` in the audit log), so the existing developer copy keeps working. Anywhere else, `start_self_improvement` answers "Self-improve is only available in the developer copy of Echo", no unlock box appears, and nothing can be started, continued or merged. The PIN still guards reset and rollback.

## 1. Unlocking

- The assistant can only **request** an unlock (`start_self_improvement`). Speech alone never unlocks.
- The Echo window shows a random 5-character code. You type it, plus your PIN if you set one, and click **Unlock & start**.
- An unlock covers **one task, for up to 30 minutes** (`ECHO_SELF_UNLOCK_MINUTES`). Five wrong tries lock self-improve for 15 minutes.
- The first time, Echo turns its folder into a git repo with a baseline commit.

## 2. Branches and worktrees

- **One branch per self task:** `self/<timestamp>-<slug>`, checked out in its own worktree in a `.echo-worktrees` folder next to the Echo folder (worktrees made before the rename, in `.voiceops-worktrees`, keep working where they are). The live folder is never the working folder.
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

Each step runs in a **clean environment**: no inherited `ECHO_*` variables (no `ECHO_SUPERVISED`, the live port or the live data folder), no test-runner or npm-script variables, a throwaway data and log folder, and a **free port picked by the OS**.

Every step has a **hard time limit** (6 minutes, `ECHO_CHECK_TIMEOUT_MS`) and runs in its own process group: when npm exits, anything it left running (a test server, a test build) is killed, so a leftover process can't keep the review waiting. The whole review has a limit too (15 minutes, `ECHO_REVIEW_TIMEOUT_MS`). If the checks time out or can't run, the task **still goes to "ready for review"**, with a note on the tile saying so; it never stays "working".

A worker is finished when it has answered everything it was sent. A follow-up sent while it was busy is often answered in the same turn; if the worker then stays quiet for 90 seconds (`ECHO_FOLLOWUP_SETTLE_MS`), that last answer counts as final. A worker whose session doesn't close within 30 seconds of its final answer (`ECHO_WORKER_EXIT_GRACE_MS`) is ended.

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
- tasks and reviews: `task_started`, `follow_up`, `review_ready` (with a `note` when the checks timed out or couldn't run), `review_failed`
- merges: `live_edits_committed`, `live_edits_stashed`, `merged`, `merge_rejected`, `merge_failed`, `discarded`
- restarts: `restart_begin`, `restart_checkpointed`, `health_ok`, `rolled_back`, `rollback_failed`
- PIN changes: `pin_set`
- the developer copy recognized by its history: `dev_copy_marked`

## 9. What self tasks may do freely, and what's gated

**Free (no prompt):**

- Read, edit and run anything inside the task's own worktree (tests, type check, a smoke server on a spare port: `ECHO_PORT=4799 ECHO_DATA_DIR=$(mktemp -d) node server.js`).
- Stop its **own test processes** (`kill <pid>`, `pkill -f <pattern>`, `lsof -ti:4799 | xargs kill`, `kill $(lsof -ti:4799)`). Echo looks up every process the command would hit first (`lib/ownprocs.js`). Each must have started after the task did, must belong to it (run from or name its worktree or a temp folder, or listen on the test port 4799), and must not be the live Echo (this server, its supervisor or launcher, or whatever listens on the live port). The rest of the command may be anything that wouldn't ask on its own (starting the smoke server, curl GETs to it, `sleep`, read-only helpers), so `start the server; check it; kill it` on one line doesn't ask either (Oct 1, 2026). If any check fails, it asks as usual.
- Run a **node script that names the live folder** (a dry run, a report over its data): a plain `node <script>` or `node -e "…"`, after an optional `cd <folder> &&`, with only read-only helpers around it (`2>&1 | sed …`, `| head`), runs in Node's permission sandbox instead of asking (`lib/nodesandbox.js`, the hook rewrites it to `node --permission …`). It reads the worktree, the live code, data (not `data/self` except the audit log) and logs, and temp folders, never a `.env` or the PIN hash; it writes only to the worktree and temp folders; it can't start child processes, worker threads or add-ons. No variables, substitutions or redirections on the node part, no `--allow-*` options, and never when the command names Echo's port. A script that needs more (listing folders outside those, running `git`) fails with `ERR_ACCESS_DENIED`; run it another way, which asks. An ordinary task with an `echo_read` grant gets the same.
- **Read** the live Echo repo, its `logs/` and `data/`, and the worktrees folder with Read/Grep/Glob.
- Read-only shell commands on them. Every part of the command must be one of these:
  - `cat`, `head`, `tail`, `ls`, `wc`, `grep`/`rg`, `find` (without `-delete`/`-exec`), `stat`, `jq` (not `env`/`$ENV`), `du`, `diff`, `sort`, `uniq`, `cut`
  - `grep` with known read-only options only (macOS may run ugrep as `grep`, whose `--filter`/`--view` run programs). Recursive `grep -r` only over named folders (absolute, or relative to a leading `cd` into an existing folder) that hold no `.env` file or the PIN hash; the whole Echo folder holds `.env.example`, so searching all of it asks
  - `awk`/`sed` without in-place edits or writes (awk: no pipes, redirects, `system`, `getline`, `ENVIRON` or `@` calls; `|` or `>` inside a regex or string is fine)
  - `xargs` feeding `ls`, `wc`, `stat` or `du` (they show names and sizes, never contents)
  - read-only `git` (`log`, `show`, `diff`, `status`, `branch` listing, `rev-parse`, `ls-files`, `blame`, `grep`, `worktree list`, `reflog`, `remote -v`)
  - `ps`, `lsof`, `strings`, `sw_vers`, `uname`, `sleep`; on macOS `log show`, `plutil -p`/`-lint`/`-extract … -o -`, `codesign -d`/`-v`, `defaults read`, `xcode-select -p`. `/bin/x` and `/usr/bin/x` count as `x`
  - `rg` and `diff -r` only over folders that hold no secret (like `grep -r`)
  - `curl`/`wget` GETs to localhost, such as `/api/health`

  No output redirection (except to `/dev/null` or `2>&1`), no `tee`, no `$(…)`. Variables only as plain values the command sets first (`L=/path/to/Echo/logs; tail "$L/echo.log"` is read as `tail /path/to/Echo/logs/echo.log`), never one the environment already has (`PATH`, `GIT_…`). Inside double quotes a backslash is fine (`grep -n "a\|b"`). The leading `cd` may be quoted in parts (`cd "/Users/me/Echo Copy"/data && …`). No secret named in any spelling, and no glob that could expand to one: with a known folder (absolute, or after a leading `cd`) the glob is checked against what's really there (`cd data && grep x *.json` is fine, `data/self/*` asks); otherwise by name (`ls`, `du`, `stat` and `wc` may use such globs: they never print contents).

  Web requests are judged by the request itself: `head -c 300` elsewhere on the line isn't a cookie jar, and `curl http://127.0.0.1:4799/api/health` to the task's own smoke server is a plain read. A curl option passed as a variable (`curl $OPTS …`) asks.

**Gated (asks you, every time):**

- Any write, move or delete in the live folder. Edits outside the worktree are simply denied.
- Process kills (`kill`, `pkill`, `killall`) other than the task's own test processes above, `git commit`/`push`/`reset --hard`/branch deletes, `rm -r`, `sudo`, deploys, publishing.
- POST, PUT or DELETE to the live Echo port, and any other network write.
- Any other command that touches the live folder or port.

**Ordinary (non-self) tasks and Echo's code:**

- An ordinary task that wants to read Echo's code, logs, data or worktrees (Read/Grep/Glob, or the read-only shell commands above) asks once, as a read-only request. Approving it grants that task read access for the rest of the task; `grant_permission` with kind `echo_read` and scope `session` grants it to every task until Echo restarts.
- The grant also covers Claude Code's own "outside the task folder" check for those read-only commands, and the node sandbox above.
- The grant never covers writes (edits are refused outright), secrets, the live port (even a GET), or anything on the always-gated list.

**Never:**

- Reading `.env` files or `data/self/pin.json` (denied outright).
- Starting a server on port **4777**, or anything that stops or restarts the live Echo.
- Changing the live folder yourself. Changes reach it only through review and merge.
- Loosening these gates. `lib/safety.js` and the PreToolUse hooks must stay at least as strict.
