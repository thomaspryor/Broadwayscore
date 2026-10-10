Verify deploys are live (not "should be fine"), update the roadmap, capture what you learned. Clean handoff to next session.

## Mode Selection

First, determine the session scope:
- **Quick session** (1-2 files changed, <30 min): Run Phases 1, 3, 4, 6 only
- **Full session** (multi-file changes, new features, infrastructure work): Run all phases

## Instructions

### Phase 1: Session Inventory

Identify what YOU did this session using git. **Worktree-aware**: if you're in a worktree, check both the worktree branch AND main (fixes may have been committed/pushed directly to main):
```bash
# Check current worktree branch
git log --oneline --since="2 hours ago" | head -10
# ALSO check main in the main repo (commits may have been pushed there directly)
MAIN_REPO=$(git worktree list | head -1 | awk '{print $1}')
git -C "$MAIN_REPO" log --oneline --since="2 hours ago" | head -10
```

Summarize in 3-5 bullet points. Be specific — include file names, feature names, and outcomes. Distinguish between:
- **Completed**: Fully done, tested, pushed
- **In progress**: Started but not finished
- **Discovered**: Identified as important but not started

### Phase 2: What Else? (full sessions only)

**Skip this phase only if `/what-else` itself already ran this session** (a real Skill invocation). `/ship-check` does NOT run it for you: it only tells you to run it next, and finish-line Gate 4 counts real invocations only (owner 2026-09-24: "Every session like this should still run what-else. We catch a lot of improvements there").

**Otherwise**, run `/what-else` now to find adjacent improvements before context fades. This catches pattern reuse, cousin bugs, data quality issues, and compounding improvements that would be expensive to rediscover in a future session.

For each finding, capture it for the roadmap (Phase 4 files Linear issues for what can't be fixed now).

### Phase 2.5: Mobile App Feature Parity

**Skip** unless this session shipped a new user-facing feature (new page, UI component, user flow). Data/CI/docs/backend changes don't need this.

If applicable, check whether the new feature needs a corresponding update in the mobile app (BroadwayScorecard-app repo). Note it for the roadmap — don't implement it now.

### Phase 3: Loose Ends Audit

Check for:
1. **Unstaged changes**: `git status` — are there modified files that should be committed or discarded?
2. **Running processes**: Any dev servers, background tasks, or watchers still running? Kill them (`fuser -k 3456/tcp; kill $(lsof -ti:3456)` etc., then confirm none left with `ps -eo pid,args | grep -E 'next (dev|-server)' | grep -v grep`)
3. **Failed tests** (skip if no `.ts`/`.tsx` files changed this session):
   ```bash
   if git log --name-only --since="3 hours ago" --pretty=format: | grep -q '\.tsx\?$'; then
     npx tsc --noEmit 2>&1 | head -20
   else
     echo "No TypeScript files changed this session — skipping tsc"
   fi
   ```
4. **Async operation gate (MANDATORY — blocks wrap-up until clear):**
   Check for ANY pending async operations from this session:
   ```bash
   # Workflows (deploys, rebuilds, scoring, collection)
   gh run list --limit 5 --json workflowName,status,conclusion,createdAt | jq '[.[] | select(.status != "completed")]'
   ```
   **Cloud/iOS session (no `gh` CLI):** use `mcp__github__actions_list` with
   `method: "list_workflow_runs"` and `workflow_runs_filter.status` values
   `queued`/`in_progress` instead — see
   `cloud-memory/feedback_gh_cli_to_github_mcp_mapping.md` for the full
   `gh`→MCP mapping. This step is still MANDATORY on cloud; "no `gh` CLI"
   is not a reason to skip it, only a reason to use a different tool.

   Also count this session's own background agents (no hand-back yet) and
   any `send_later` / `create_trigger` check-in scheduled into THIS session
   that has not fired or been deleted. The Stop hook enforces that part
   (INFLIGHT): SAFE TO EXIT with any of them live is blocked, because the
   owner reads SAFE TO EXIT as "I can close or kill this session now".

   **If anything is still running or queued: STOP. Do not proceed to Phase 4.**
   - Monitor in background (check every 30-60s)
   - When it completes, check the conclusion
   - If **failed**: fix it now. Do not end the session with a failed operation.
   - If **succeeded**: verify the result:
     - **Deploy:** confirm changes are live on the production URL
     - **Rebuild:** confirm data files were updated (`git log --oneline -1 origin/main`)
     - **Workflow run:** confirm expected output was produced

   **Red flag phrases that mean you haven't verified:**
   - "Deploy should be fine" — NO. Check it.
   - "Just needs to go live" — NO. Wait for it.
   - "I'll monitor" — NO. Monitor NOW, report the result.
   - "The run was triggered" — NO. That's the start, not the end.

### Phase 4: Roadmap Update

**Detect project type:** Check if this is a Linear-tracked project (same detection as session-start: `CLAUDE.md` contains "Broadway Scorecard").

**If LINEAR_PROJECT:** Close out the session's Linear issue instead of GitHub issues. Flow and commands: `memory/linear-board-workflow.md` (cloud: `cloud-memory/linear-board-workflow.md`). Notion is retired: never `notion-brain.js`, and a Notion update does not satisfy the Stop hook's close-out check.

1. **Find the session's card:** it is the `BRO-N` printed by this session's `linear-brain.js create` or `linear-session.js claim` at start (the NOCARD Stop hook requires one). If you truly can't find it in the transcript, `node scripts/linear-brain.js find "<distinctive title phrase>"`. If none was ever filed, **this is a process failure**: file it now with `linear-brain.js create ... --park`, and flag it to the user: "⚠️ Linear card was not created at session start — creating retroactively. This shouldn't happen."
2. **Read the issue's existing comments** (a prior session may have posted an Outcome). Add a new Outcome comment; never rewrite someone else's.
3. **Write the Outcome comment using the MANDATORY template below.** Pick the variant that matches the kind of work (fix, feature, expansion, data quality). Every section must be filled — no placeholders, no "N/A", no skipping. If a section truly doesn't apply, write "None identified" with a one-sentence explanation.

   **Type-specific additions** (add these sections AFTER the standard 4):
   - **Fix:** Add `### Root cause` and `### Prevention added` (prevention = a code/test/hook/CI change; a memory file alone doesn't count)
   - **New Feature:** Add `### User-facing changes` and `### How to verify`
   - **Market Expansion:** Add `### Shows affected` and `### Aggregators used`
   - **Data Quality:** Add `### Data before/after` and `### Validation added`

   ```
   ## [DATE] — [1-line summary of what this session accomplished]

   ### What changed
   [Bullet list of specific changes. Include file names, function names, data counts.
   BAD: "Fixed the scraper"
   GOOD: "Fixed gather-reviews.js DTLI parser — was dropping reviews where critic name contained unicode. 3 shows affected: giant-2026, cats-the-jellicle-ball-2026, wicked-west-end-2021."]

   ### Why this approach
   [What alternatives existed? Why was this one chosen? What constraint drove the decision?
   BAD: "Seemed like the best option"
   GOOD: "Considered (1) regex fix in the parser, (2) normalizing critic names upstream in collect-review-texts.js, (3) adding a unicode-safe comparison helper. Chose #1 because the bug is isolated to DTLI's format — other sources already handle unicode. #2 would require re-collecting 400+ review texts."]

   ### Gotchas & watch out
   [What almost broke? What's fragile? What will bite the next session?
   Include: edge cases found, assumptions that turned out wrong, things that work but are brittle.
   BAD: "Be careful with the data"
   GOOD: "The DTLI slug map has 3 shows with duplicate slugs (giant, cats, wicked) — the parser picks the first match. If DTLI adds another production of these shows, the slug map needs manual disambiguation."]

   ### Discovered work
   [New bugs found, improvements spotted, tech debt uncovered. Each should have a corresponding Linear issue (or say why it was fixed now instead).
   Format: "- [card name] — [1-sentence description]"]
   ```

   **Self-check before writing:** Re-read your Outcome draft. For each section, ask: "Would someone who has never seen this codebase understand what happened and why?" If no, add detail. The Outcome is the permanent record — conversation context disappears, but this stays.

4. **Key Files** go in the same Outcome comment — every commit from this session (`git log --oneline --since="2 hours ago"`), any PRs, key files changed. Format: `commit abc1234: [description]` one per line.
5. **Evidence for Done:** add `PR-EVIDENCE: merged deployed checked (<landed commit or PR URL>)` to the comment, or make sure the issue carries a safe-form `VERIFY:` / `## Acceptance criteria` command. Without one the Done gate refuses (exit 5).
6. **Post and close in one call:** `node scripts/linear-brain.js update BRO-N --state Done --comment "<Outcome + Key Files + PR-EVIDENCE>"` (heredoc for long text). For an issue this session CLAIMED: `node scripts/linear-session.js report --issue=BRO-N --status=done --summary="..." --key-files="a,b" --verification="..."`.
7. **Paused instead of Done:** Linear has no Paused state. `node scripts/linear-session.js report --issue=BRO-N --status=paused --summary="<what's left and what blocks it>"` (sets Backlog), or `linear-brain.js update BRO-N --state Backlog --comment "..."`. Read the output: a `REFUSED`/`❌` result means the card is still open. **If step 6's Done was refused (exit 5), its comment was NOT posted** — the gate refuses before writing, so re-post the Outcome here via `--summary`, or add the missing evidence and re-run step 6.
7a. **RECHECK-AFTER rule (task #695): if the fix's effect is only observable later — next cron run, next day's billing/data, next opening night — it may NOT go Done.** Pause it instead (step 7), with this in the summary/comment:
   ```
   RECHECK-AFTER: YYYY-MM-DD

   ## Acceptance criteria
   `<safe-form command>` passes
   ```
   Pick RECHECK-AFTER as the earliest date the claim becomes checkable (e.g. "streak of N days" → N days out). The command MUST be one of the safe forms `scripts/lib/verify-gate.js` already accepts (`node --test <path>.test.mjs`, `npx tsc --noEmit`, `npx next lint`, `test -f <path>`) — write a real colocated test that asserts the live condition if no existing command covers it (see `scripts/verify-provider-spend-streak.test.mjs` for the pattern: a test that reads live repo data, not a fixture). `scripts/autonomous-acceptance-recheck.js` (hosted daily in `data-health-check.yml`) picks up paused (Backlog) issues carrying this stamp once the date passes, re-runs the command against fresh `origin/main`, and reports pass/fail in shadow mode — it never auto-reopens or auto-completes the card; a passing recheck is your signal to come back and flip it to Done yourself (or the owner's, if it's their card).
7.5. **If the issue went Done and this session claimed a shared-task-list task** (via `TaskUpdate` at session start, per the startup seed prompt): mark that task `completed` via `TaskUpdate` now, in THIS still-live turn — not later. This is what lets the workspace-mark-done Stop hook (`~/.claude/hooks/workspace-mark-done.sh`) ✅-mark the workspace automatically on this session's own next Stop event; the hook only reads the local task-list mirror, and nothing else updates it on a normal timescale (board→local sync is on-demand, not cron'd). Skip if this session never claimed a task (ad hoc / non-dispatched sessions).
8. **File issues only for discovered work this session cannot finish** (`node scripts/linear-brain.js create "<title>" --park "<why it needs its own session>" --model opus|sonnet --notes "..."`, or `--dispatch` for P0/P1; `--model` picks the worker: Opus for multi-file/hard work, Sonnet for mechanical fixes). Apply the same three tests `/what-else` Phase 5 uses, in order: (1) can you just fix it now? then fix it — that is the default; (2) is an open issue or the roadmap already covering it? then say so and file nothing; (3) only if neither holds, file it, and the notes must name **why it needs its own session**. Batch related findings into ONE issue. Rationale, measured 2026-09-08: the board held 1,107 open at 3.1 filed per 1 closed, and 89% of a week's 361 new issues were session-authored rather than automated — the session-close ritual was manufacturing the backlog it reports. Report what you fixed AND what you deliberately did not file, so restraint reads as a decision rather than an omission.
   **CRITICAL — every new issue must be a self-contained handoff.** Use this template in `--notes`:
   ```
   ## Problem
   [Specific description — not just a label]
   ## Evidence
   [Show IDs, error counts, commands that demonstrate the issue]
   ## Root cause (if known)
   [Why it happens]
   ## Suggested approach
   [File paths, functions to modify, commands to run]
   ## What was already tried
   [So the next session doesn't repeat failed attempts]
   ## Acceptance criteria
   [How to verify the fix is complete]
   ```
   **Self-check:** "Could a fresh session start working on this card in under 2 minutes?" If no, add the missing context.
9. **Fallback:** If Linear is unreachable at any point during this phase, do NOT fall back to Notion. Output the FULL close-out to the user so nothing is lost:
   ```
   ## Linear Close-out (Manual — Linear unreachable)
   - **Issue:** BRO-N (URL)
   - **State:** Done (or Backlog — [reason])
   - **Outcome:** [full template above]
   - **Key Files:** [commits]
   ```
   The state change is the most critical part — without it, the issue stays "In Progress" forever and becomes an orphan.

### Phase 4.5: Cross-session card sweep (LINEAR_PROJECT only)

**Why this exists:** the per-session Stop hook enforces a 1:1 session↔card mapping. Issues that no session "owns" never get closed by that hook, so they accumulate. This phase catches the common case where a session *incidentally* ships work listed on another open issue.

1. **Collect this session's footprint:**
   ```bash
   git log --name-only --since="3 hours ago" --pretty=format: | sort -u | grep -v '^$'
   git log --oneline --since="3 hours ago"
   ```

2. **Look for other open issues naming the same work:** pick 2-3 distinctive phrases (a file basename this session changed, a function name, a feature noun) and run `node scripts/linear-brain.js find "<phrase>"` for each. It returns the first OPEN issue whose title or body contains the phrase, or null. Ignore this session's own issue.

3. **Only flag hard evidence:** a match on a generic file many issues name (e.g. `scripts/rebuild-all-reviews.js`) is NOT enough. The issue's problem statement must be something this session's commits actually fixed.

4. **Close or surface:** if this session's commits plainly satisfy the issue's acceptance criteria, run them, then close it with `linear-brain.js update BRO-M --state Done --comment "Shipped incidentally by <commit>; <acceptance result>"`. If it's a judgment call, list it in the report as "possibly shipped by this session" with the evidence.

5. **If zero candidates:** skip silently. Don't pad the report with "no matches found."

**Otherwise (non-Linear projects):**

Read the current roadmap:
```bash
gh issue view 1 --repo thomaspryor/broadway-scorecard-data --json body -q '.body' > /tmp/roadmap-current.md
cat /tmp/roadmap-current.md
```

Then update it:
1. **Move completed items** to the "Recently Done" section with a one-line summary and date
2. **Update in-progress items** with current status
3. **Add new backlog items** for anything discovered (extrapolation findings, loose ends, new ideas)
4. **Write updated roadmap** to `memory/roadmap.md` and sync:
   ```bash
   gh issue edit 1 --repo thomaspryor/broadway-scorecard-data --body-file memory/roadmap.md
   ```
5. **Post a session comment** (2-3 sentences max):
   ```bash
   gh issue comment 1 --repo thomaspryor/broadway-scorecard-data --body "..."
   ```

### Phase 5: Documentation, Memory & Learnings

This phase combines documentation updates with lessons learned. For each item below, make the change now if warranted.

**What did we learn this session?** Think about:
- What went wrong or almost went wrong? (Wrong assumptions, wasted time, broken builds)
- What new gotchas, edge cases, or operational knowledge did we discover?
- Did we add, modify, or learn something about a workflow or infrastructure?

**Where should each learning live?**

| Learning type | Where to save | Example |
|---|---|---|
| Universal rule (all sessions must follow) | `CLAUDE.md` | "Never use show ID in URLs — use slug" |
| Gotcha, edge case, operational knowledge | `memory/MEMORY.md` | "TodayTix recycles numeric IDs" |
| Workflow added/changed | `.github/workflows/CLAUDE.md` | New workflow description |
| Correction to existing docs | Edit the relevant file | Fix wrong API endpoint |

**Rules criteria** — only codify a learning as a rule if:
- It was learned from an actual failure or near-miss (not hypothetical)
- It's likely to recur in future sessions
- It's not already covered by existing rules
- It can be stated in one imperative sentence with brief context

**Memory-entry criteria (encode first, write rarely):** a memory file must pass all three: (1) the lesson could NOT be encoded as code/test/hook/CI gate — if you already encoded the fix, the memory is redundant, skip it; (2) you can name the specific future action that changes; (3) a future session hitting the same mistake would plausibly recall the file from its description. **"No new learnings worth saving" is the normal outcome — say that and move on.** Never offer to commit memory files to the repo (in Broadwayscore the session-stop hook auto-syncs local memory to `cloud-memory/`).

**MEMORY.md size** — the index cap is now ENFORCED at write time, so you normally do nothing. `memory-index-cap-guard.sh` (PreToolUse) blocks any Edit/Write/bash-redirect that would grow the index past **180 lines / 20KB**; `memory-index-cap-postcheck.sh` (PostToolUse) flags it if something writes it over cap by another path. If a hook blocks an index edit, follow its message: merge or drop an entry (the file stays on disk and recall still surfaces it), or just don't index the new memory. To eyeball size:
```bash
wc -lc ~/.claude/projects/-Users-tompryor-Broadwayscore/memory/MEMORY.md   # caps: 180 lines / 20000 bytes
```
Do **NOT** run `node scripts/rebuild-memory-index.js > MEMORY.md` — it regenerates verbose auto-gen lines that clobber the curated short hooks (and the redirect is hook-blocked anyway). The script is read-only-safe with `--diff` only. The harness silently truncates the index at ~200 lines; `claude-sync push` blocks hard at >200.

### Phase 6: Final Report

Present a summary to the user:

```
## Session Wrap-Up

### Done
- [completed items]

### Roadmap Updated
- Moved to done: [items]
- Added to backlog: [items]

### Documentation Updated
- [files changed and why]

### Loose Ends
- [anything that truly can't be done now, with context for next session]
```

**Before listing any loose end, ask: can I just do this now?** If a loose end would take <5 minutes to fix, fix it instead of listing it. The user should never have to read a loose end and tell you to go do it. Only list items that hit a real deferral bar (blocked on the user, missing credentials, different repo, or >2 hours of work — the same bars the finish-line gate and global CLAUDE.md use).

**Every deferred loose end must be dispatched or carry its own handoff** (the finish-line gate enforces this).

**Dispatch-first (the default) — and dispatch at CREATION, not at report time (owner rule 2026-07-24: every P0/P1 that doesn't need an owner judgment call gets a workspace the moment it's carded; the nightly loop is the backstop, never the plan).** If the item is technical + self-contained + carded (a Linear issue exists — Phase 4 step 8 should have filed one), do NOT hand the user a paste-prompt. Dispatch it yourself:
```bash
node scripts/linear-next.js --id BRO-N   # launch a supervised worker seeded from the issue
```
Verify the output shows a workspace actually launched, then report it as a plain line of prose — NOT inside a code fence, the finish-line gate strips fenced text and won't see it:

DISPATCHED: workspace <name> — <task subject>

The issue IS the handoff — linear-next seeds the worker with its full description. Gotchas:
- **Item isn't carded at all:** file it first (Phase 4 template, `--dispatch`, priority P1), then dispatch.
- **Cloud session:** linear-next's local launch needs the owner's Mac. `create_session` is denied (it prompts the owner): put a `START-NOW:` line in the card's notes and the hourly cloud worker takes it first (.claude/CLOUD.md, Starting a worker session). A dispatch without a card has no context to seed.
- **Launch fails** (Cmux missing/errored): fall back to the DEFERRED + HANDOFF PROMPT format below and say the dispatch failed.
- The gate verifies a linear-next (or bsc-next) command actually ran this session — a DISPATCHED line without the launch gets blocked.

**Paste-prompt fallback (exception only).** Reserved for items that need a user decision first, or access this session lacks (different machine, missing credentials). Format:
```
DEFERRED: <what> — <which deferral bar it hits and why it can't be dispatched>
HANDOFF PROMPT:
<complete paste-ready prompt: task, key files, context, what was already tried, acceptance criteria>
```
The user pastes the prompt into a fresh session and it works with zero extra context. A bare issue ID alone is NOT a handoff, and a paste-prompt for a fully-specified technical task is a process failure — dispatch it instead.

**End the report with a mandatory `### Next` section** that triages EVERY Linear issue filed this session and every recommendation you made, each into exactly one bucket:
- **DONE-NOW** — you did it before ending (say what happened)
- **DISPATCHED** — you launched it via bsc-next / linear-next (ref + exact title). Gate O makes you own its landing. If you dispatched two or more children and are closing, run `node scripts/fanout-verified.js --refs A,B --verify "<safe-form combined check>" --reason "..."` after the last one lands — Gate S refuses CLOSE ME without that ledger row (owner 2026-09-20: per-child LANDED lines are "spawn and hope").
- **DEFERRED** — user-decision or different-machine items ONLY, with the deferral bar + HANDOFF PROMPT (format above); owner-judgment items go in a DECISION NEEDED block instead.
- There is NO backlog bucket (owner 2026-09-20): every found item is fixed now, dispatched, or a DECISION NEEDED. finish-line Gate 3 refuses "filed as Backlog / out of scope / not fixed / worth a follow-up" endings.

**Close with a plain-English message for the owner, and record the machine block separately** (owner escalation 2026-09-20, BRO-3914; `exit-status-gate.sh` reads the recorded block, never the chat, when one is fresh):

1. Write the machine block to a file (scratchpad is fine), then record it as your LAST tool call: `wrapup-block --file <path>`. Lines, plain prose, never in a code fence:

──────────────────────────────────────────
DONE        <what shipped, and how it was verified — one line>
CONTINUING  <none | workspace:N ("exact tab title") — what it's doing>
NEEDS YOU   <nothing | answer the DECISION NEEDED in the chat>
PREVENTION: <what now catches this class> ; cousins: <where you looked, what you found>   (required after code edits; NO-PREVENTION: <reason> only for a non-fix change)
DISPATCHED: / LANDED: / OWNED BY: / EXECUTED: / NO-EXECUTE: / NO-SHIP-CHECK: lines as applicable
THIS SESSION: KEEP OPEN | CLOSE ME | IDLE — <one-line reason>
──────────────────────────────────────────

   The CLI rejects a block that would fail a gate and tells you why in tool output. Anything you run after recording makes it stale — re-record.

2. Then send the owner the chat message: what changed for them (1-2 sentences), `Still running:` / `Nothing is still running.`, `You need to:` / `Nothing needed from you.`, the DECISION NEEDED block if any (full template, plain words), and a closing line matching the verdict: `You can close this tab.` / `Keep this tab open.` / `Nothing is running here; keep this tab only if you want to continue <topic>.` No ids, paths, card or workspace numbers, command names or evidence lines in the chat. Quoted tab titles and one URL are fine.

**A pending DECISION NEEDED always means KEEP OPEN** — "nothing running" is not the bar, "nothing needed from the owner" is (owner rule 2026-07-20). Headless jobs (`claude -p`) keep the block in their final text instead of recording it.

Only say "Clean exit, no loose ends" when you are ALSO not recommending any next-session work — a "recommended next session" IS a loose end and belongs in `### Next`, triaged. Never make the user ask "what's required next?"

### Phase 7: Workspace self-marking (Cmux sessions only) — mark, NEVER close

**Skip unless this session runs inside a Cmux workspace of its own.** The test is `[ -n "$CMUX_WORKSPACE_ID" ]` — the same signal cmux itself defaults on. A headless job (bsc-runner / `claude -p`) has no CMUX_* env: `cmux identify` still SUCCEEDS there but returns `"caller": null` (with a `"focused"` block that is the OWNER'S cursor, not your tab). **`caller: null` means you have NO workspace — skip this phase entirely. Never pick a target from `focused`, `[selected]`, or a `list-workspaces` listing.** (BRO-3218, 2026-09-08: a headless job did exactly that and ✅-renamed the owner's focused tab, which was a different live mid-turn session; the `cmux-destructive-guard.sh` hook now blocks any rename/set-color that is not your own tab.) Finished workspaces must be visually distinct so pruning is at-a-glance (owner rule, 2026-07-12).

After delivering the final report:
```bash
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
[ -n "${CMUX_WORKSPACE_ID:-}" ] || { echo "no cmux tab of my own (headless) — skipping Phase 7"; exit 0; }
WS=$($CMUX identify | jq -r '.caller.workspace_ref // empty')
[ -n "$WS" ] || { echo "cmux identify has no caller — skipping Phase 7"; exit 0; }
$CMUX workspace-action --action rename --workspace "$WS" --title "✅ <short session title>"
$CMUX workspace-action --action set-color --workspace "$WS" --color Green
```

**Do NOT self-close the workspace. Ever.** (Owner rule, 2026-07-15: a session's
Phase-7 self-close killed a tab while the owner was mid-typing in it — their
unsent text was lost. `workspace-mark-done.sh` had already documented this exact
hazard; only the ✅-mark is safe.) The mark is the handoff: `bsc-prune` / `node scripts/bsc-prune.js` is the sweep
the OWNER runs to close ✅-marked workspaces (bsc-next no longer sweeps at
dispatch — removed 2026-07-15 after it closed in-use tabs) — closing is always
a human or human-triggered action, never automatic.
