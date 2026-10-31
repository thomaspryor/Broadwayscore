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
(retry the fetch with backoff on network errors), then `bash scripts/cloud-bootstrap-data.sh | tail -4`
(routine sessions are multi-repo, so no repo hook does this: without it core data
is the environment snapshot, days old, and review texts are absent; BRO-5008).
Then remove the Claude lane's worktrees an earlier firing left (every firing
runs in the same session, so they pile up at about 1.3 GB each; BRO-5384):
`for w in .claude/worktrees/*/; do case "$(basename "$w")" in codex-runner*) continue ;; esac; [ -z "$(git -C "$w" status --porcelain)" ] && [ -z "$(git -C "$w" log --oneline -1 HEAD --not --remotes)" ] && git worktree remove --force "$w"; done; git worktree prune`.
It keeps a worktree with uncommitted or unpushed work. Never touch `codex-runner*`:
a Codex slot from the last firing may still be running. The Codex runner itself deletes stale test temp dirs in /tmp when it starts.
If the directory is missing,
reply "repo missing" and stop. Follow .claude/CLOUD.md and CLAUDE.md. Never ask
the owner to do anything on a Mac.

## 1. Codex lane (start first, in the background)

Skip this lane if `pgrep -f scripts/codex/daily-runner.js` finds one in this
container, or if `node scripts/codex/daily-runner.js --lock-status --lane cloud` exits 3: a
runner in another session (an earlier firing's session lives for hours) holds
the run lock. Exit 0 means no live runner anywhere: start it. Exit 4 (lock
unreadable): start it anyway, the runner re-checks and waits its turn.

1. `codex --version` must print 0.160.0; otherwise `npm i -g --no-audit --no-fund @openai/codex@0.160.0`.
2. Start `CODEX_CAN_DISPATCH=1 node scripts/codex/daily-runner.js --slots 3 --limit 9 --max-minutes 105 --card-max-minutes 60 --hard-stop-minutes 112 > /tmp/codex-run.log 2>&1`
   with run_in_background AND timeout 7200000. The default background limit is
   30 minutes and it killed the runner mid-card on 2026-10-11, after Codex had
   pushed a passing fix. Codex works on the owner's ChatGPT plan, so it takes
   up to 6 cards a firing (owner decision 2026-10-11); --max-minutes stops it
   starting a new card that could not finish inside the 2-hour limit, and
   --hard-stop-minutes 112 makes it cut cards, fix rounds and landing waits so it
   posts its summary and frees its lock before that limit kills it (a kill
   mid-card left a stale lock and a stranded card on 2026-10-13). It restores the owner's Codex login, has Codex fix
   each card, gates every result on a Claude check, lands what passes and
   returns the rest to Todo. --slots 3 runs three runners side by side, two
   minutes apart, each with its own worktree and lock, and up to 3 cards each
   (BRO-5384: one at a time used 1-4% of the weekly Codex allowance). It runs
   one when the Codex login could expire during the run. A SHIP-WITH-FIXES
   verdict always gets its fix round, past --card-max-minutes, or in the next
   firing when this one has no time left. Do not touch .claude/worktrees/codex-runner*.

## 2. Claude lane (up to 4 cards, in your own worktrees)

Keep picking until 4 cards are finished or the pick comes back empty. A card
you close, pause or bounce counts as finished; it is never a reason to stop
the lane. Waiting for Codex is not a reason either: finish (section 3) only
after this lane is done. On 2026-10-11 a worker paused its first card and then
only waited for Codex while 68 cards were eligible.

Turn-end rule (BRO-6087): while this lane is open (fewer than 4 cards claimed and the
pick is not empty), no turn may end. A mid-lane turn end is not the final reply:
background waiters and test runs wake you later, and a turn that ends on "KEEP OPEN,
the test run wakes this session" stops the lane with cards still eligible. Claim logs
for 2026-10-20..23 show the lane averaging 2.69 claims per firing (cap 4).
`node scripts/worker-firing-stats.js --min-avg 3.0` re-measures that. Section 3 is different: once this lane is done, waiting
there means ending turns until woken.

Never sit idle while a landing is checked (about 15-30 minutes): push it, start
its waiter in the background (timeout 4000000), and go straight to the next
card. Step 6 runs for each card once its waiter reports.

Once per firing, before the first pick (BRO-6684): call `get_session` with no
session_id and run `node scripts/opus-budget.js --record-usage
--status=<external_metadata.rate_limit_info.status>
--resets-at=<external_metadata.rate_limit_info.resetsAt>`. The picker uses it for
the daily Opus budget (no cap in the last 30h before the weekly reset with room
left; none for non-P0 cards while the weekly limit warns). If get_session fails,
skip it: the default 4/24h cap applies.

For each card:

1. `node scripts/cloud-worker-pick.js` (background it if slow). Non-zero exit or
   a null `pick`: stop this lane. A `pick.resume`: follow its instructions.
   While a Codex runner is live the pick leaves to it the cards one Codex
   firing will take (up to 9, listed in `leftToCodex`; owner 2026-10-15, BRO-5384: Codex carries the
   load, this lane is the fallback for what Codex cannot do, Urgent and
   START-NOW cards, and everything once Codex stops). Cards Codex would skip
   for their pause history stay in this lane's queue (BRO-5407). A null pick then means
   nothing is left for this lane: that is the saving, not a problem.
   A null pick with `breakerReason` means the spend breaker stopped the lane
   (BRO-6229: daily or per-card claim cap, P0 exempt; advisory unless
   CLOUD_WORKER_BREAKER_ENFORCE=true): stop this lane. A daily-cap trip has
   already filed the owner's card; a per-card skip is quiet by design.
2. Claim: `node scripts/linear-session.js claim --issue=<pick.identifier> --worker-model=<pick.model>`. A
   `"action": "noop"` or a failure means the Codex lane or another worker has
   it: pick again once, then stop this lane.
3. Read the full card. If a comment starts "SAME ROOT CAUSE" and lists sibling
   cards, take the group: claim each open sibling (skip any another worker
   holds), fix them together in one branch and one landing, and close each
   card with the same evidence. A group counts as one card toward the 4.
   FIRST check it is still true on current main (run its
   VERIFY, grep the code it names). Already fixed: close it with a check the
   Done gate re-runs on fresh main, either the card's own acceptance command
   or a test that proves it:
   `node scripts/linear-brain.js update <id> --state Done --comment "Already fixed on main: <evidence>` + a blank line + `VERIFY: <node --test command>"`
   (or `PR-EVIDENCE: merged deployed checked (<commit url>)` when you have the
   commit). A refusal saying the command did not pass means it is NOT fixed:
   work it. Obsolete: cancel with a reason. Then move on.
4. Otherwise fix it in a new worktree on a fresh branch from current
   origin/main. The pick names a `model`: when it is "opus" (urgent cards,
   cards marked Model: Opus, retries after a failed attempt), hand steps 4 and 5
   to a subagent with the Agent tool and model "opus", giving it the card id,
   the worktree path and these steps, and check its result before step 6. Follow
   CLAUDE.md: tsc/lint/tests for what you touched,
   scoring-delta checks if scoring files change, a review-panelist subagent
   review with its findings fixed, recorded with
   `node scripts/lib/review-gate.mjs --query=record --reviewer=second-opinion --result=pass`.
   Shared infrastructure (CLAUDE.md rule 18) needs `--query=record-plan` first.
   Data changes go through approved-fix plans (`data/pending-fixes/`, see
   .claude/CLOUD.md); cloud `data/*.json` are disposable copies, so an edit
   to them is lost, and never write into the core-data clone (BRO-5217).
   The Codex slots in this routine take data-fix route cards too: step 1 starts
   the runner with `CODEX_CAN_DISPATCH=1`, since cloud sessions dispatch
   execute-approved-fix.yml through scripts/cloud-dispatch.js (proven 2026-10-26,
   BRO-6260). The runner, not Codex, dispatches the apply, and waits only for the
   time left before its hard stop; an apply it cannot wait for is deferred and
   applied on a later reconcile. You (the Claude lane) still keep route cards
   when your picker gives you one.
   A card that genuinely needs an owner decision: write the one-sentence
   question on the card and pause it; do not build it.
5. Land: a commit holding ONLY your files on a branch from current origin/main
   (never `git reset --soft` over a failed merge). Before the push, run
   `node scripts/lib/land-local-check.js | tail -15` in the background
   (timeout 2700000, ~20 min; it runs land.yml's test gates here, so a
   guard-test refusal costs minutes, not a land run). Push only on exit 0 or 4;
   on 1 fix the new failures it lists; on 3 commit your work first. Then
   `git push origin HEAD:refs/heads/land/bro-<N>-<short-name>`, then
   `node scripts/lib/wait-for-land.js land/<name> 58 --prod=30` in the
   background (timeout 5700000), and pick the next card now. When a waiter
   reports a refusal, read the run log, fix, push the same ref again. Exit 4
   means landed but not live yet: the landing stands, never push it again;
   re-check with the `check-prod-deploy.js` command it prints.
6. After it lands, re-run the card's VERIFY on fresh main. Then, before
   closing, run the shadow Codex cross-check in the background (timeout 1800000):
   `node scripts/codex/check-claude.js --card <id> --commit <landed sha> | tail -3`.
   It reviews the landed diff with Codex, comments on the card on REJECT or
   SHIP-WITH-FIXES, skips itself when the Codex weekly allowance is 70%+ or
   unknown or the Codex runner is live, and always exits 0. It never stops or
   delays closing the card: do not wait on it here, and ignore its failures
   (section 3 lets it finish so it can save the Codex login). VERIFY passes:
   `node scripts/linear-brain.js update <id> --state Done --comment "<Outcome + PR-EVIDENCE: merged deployed checked (<commit url>)>"`.
   Otherwise `node scripts/linear-session.js report --issue=<id> --status=paused --summary="<what is left and why>"`
   (with `RECHECK-AFTER: YYYY-MM-DD` and a safe recheck command when the
   result is only observable later).
   A pause is for a real block only: an owner decision (DECISION NEEDED:),
   a missing key or access, Mac-only hands or files, a dated wait on a named
   event, or the budget. If the next step is doable here ("next worker: add
   the aliases", "next session: dispatch the runs"), do it now instead of
   pausing. `linear-session.js report` flags such hand-offs (BRO-6635,
   advisory now, refused later). Never pause through `linear-brain.js update`.
7. Then remove that card's worktree (`git worktree remove --force <path>`,
   never a .claude/worktrees/codex-runner* one). Each is about 1.3 GB and
   the Codex slots share the same disk: on 2026-10-15 a full disk crashed 17
   Codex cards in two minutes (BRO-5287).

## 3. Finish

Before replying, wait for every land waiter you started (finish step 6 for
each), every Codex cross-check you started, and for the Codex lane to exit (check /tmp/codex-run.log
every few minutes, never in a tight loop) and read its "## Codex runner"
summary. Then re-run, in the foreground, each cross-check from step 6 that
skipped because the Codex runner was live (same command; it posts nothing
twice for one commit, and its result never changes a card).

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
