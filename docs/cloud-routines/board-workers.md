# Board workers (Claude + Codex), one firing

Read by the "Board workers" routine on every firing. The routine fires into
one session that has the repositories attached (a fresh routine session does
not: routine sessions created from a tool call start with no repositories and
no add_repo, BRO-4956, 2026-10-10), so the routine prompt only says "read this
file and follow it". Change the workers' behaviour here, not in the routine.

No human is watching. Earlier firings in this conversation are finished: do not
continue, re-check or summarise them, and do not re-read files you read before
unless they may have changed. Keep tool output short (`| tail`, `| head`) so
the conversation stays small.

## 0. Reset

In /home/user/Broadwayscore: `git fetch origin main && git checkout -f -B worker-base origin/main && git clean -fd -e .claude/worktrees`
(retry the fetch with backoff on network errors). If the directory is missing,
reply "repo missing" and stop. Follow .claude/CLOUD.md and CLAUDE.md. Never ask
the owner to do anything on a Mac.

## 1. Codex lane (start first, in the background)

Skip this lane if `pgrep -f scripts/codex/daily-runner.js` finds one still
running from an earlier firing.

1. `codex --version` must print 0.160.0; otherwise `npm i -g --no-audit --no-fund @openai/codex@0.160.0`.
2. Start `node scripts/codex/daily-runner.js --limit 3 > /tmp/codex-run.log 2>&1`
   with run_in_background. It restores the owner's Codex login, has Codex fix
   each card, gates every result on a Claude check, lands what passes and
   returns the rest to Todo. Do not touch .claude/worktrees/codex-runner.

## 2. Claude lane (up to 4 cards, in your own worktrees)

Never sit idle while a landing is checked (about 15-30 minutes): push it, start
its waiter in the background, and go straight to the next card. Step 6 runs
for each card once its waiter reports.

For each card:

1. `node scripts/cloud-worker-pick.js` (background it if slow). Non-zero exit or
   a null `pick`: stop this lane. A `pick.resume`: follow its instructions.
2. Claim: `node scripts/linear-session.js claim --issue=<pick.identifier>`. A
   `"action": "noop"` or a failure means the Codex lane or another worker has
   it: pick again once, then stop this lane.
3. Read the full card. FIRST check it is still true on current main (run its
   VERIFY, grep the code it names). Already fixed: close it with a check the
   Done gate re-runs on fresh main, either the card's own acceptance command
   or a test that proves it:
   `node scripts/linear-brain.js update <id> --state Done --comment "Already fixed on main: <evidence>` + a blank line + `VERIFY: <node --test command>"`
   (or `PR-EVIDENCE: merged deployed checked (<commit url>)` when you have the
   commit). A refusal saying the command did not pass means it is NOT fixed:
   work it. Obsolete: cancel with a reason. Then move on.
4. Otherwise fix it in a new worktree on a fresh branch from current
   origin/main, following CLAUDE.md: tsc/lint/tests for what you touched,
   scoring-delta checks if scoring files change, a review-panelist subagent
   review with its findings fixed, recorded with
   `node scripts/lib/review-gate.mjs --query=record --reviewer=second-opinion --result=pass`.
   Shared infrastructure (CLAUDE.md rule 18) needs `--query=record-plan` first.
   A card that genuinely needs an owner decision: write the one-sentence
   question on the card and pause it; do not build it.
5. Land: a commit holding ONLY your files on a branch from current origin/main
   (never `git reset --soft` over a failed merge),
   `git push origin HEAD:refs/heads/land/bro-<N>-<short-name>`, then
   `node scripts/lib/wait-for-land.js land/<name> 58` in the background, and
   pick the next card now. When a waiter reports a refusal, read the run log,
   fix, push the same ref again.
6. After it lands, re-run the card's VERIFY on fresh main. Passes:
   `node scripts/linear-brain.js update <id> --state Done --comment "<Outcome + PR-EVIDENCE: merged deployed checked (<commit url>)>"`.
   Otherwise `node scripts/linear-session.js report --issue=<id> --status=paused --summary="<what is left and why>"`
   (with `RECHECK-AFTER: YYYY-MM-DD` and a safe recheck command when the
   result is only observable later).

## 3. Finish

Before replying, wait for every land waiter you started (finish step 6 for
each) and for the Codex lane to exit (check /tmp/codex-run.log
every few minutes, never in a tight loop) and read its "## Codex runner"
summary.

Rules: never call send_later, create_trigger or any scheduling tool; never
create sessions or dispatch other workers; skip anything irreversible,
expensive (bulk rescoring, large dispatches) or needing an owner decision and
record it on the card; never edit or push the private data repos directly;
never read credentials; never send email broadcasts.

Final reply, plain English, at most 6 lines, no em dashes: what changed for
the owner, "Nothing needed from you." unless something truly is, then one line
per card: `WORKER RESULT: <claude|codex> <card id|none> <done|closed-already-fixed|paused|bounced|nothing eligible|failed: reason>`.

## Setting the routine up (one time, from the owner's phone)

In a new Claude Code session started with the Broadwayscore repositories (the
normal way), the owner sends: "Set up the board workers from
docs/cloud-routines/board-workers.md". That session then calls create_trigger
once (the owner approves the prompt) with: name "Board workers: Claude + Codex",
cron `47 */2 * * *`, initiation human_request, no persistent_session_id and
create_new_session_on_fire false (fires into that same session), prompt:
"New board-workers firing. Read docs/cloud-routines/board-workers.md on
origin/main (git fetch first) and follow it exactly." It disables the old
routines "Cloud card worker (one urgent card every hour, repo attached)" and
"Board workers: Claude + Codex (fresh session, every 2 hours)" if they are
enabled, and replies in one line.
