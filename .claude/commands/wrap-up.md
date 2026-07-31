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

**Skip this phase if `/ship-check` already ran this session** — ship-check chains into `/what-else` automatically, so the discoveries are already captured.

**Otherwise**, run `/what-else` now to find adjacent improvements before context fades. This catches pattern reuse, cousin bugs, data quality issues, and compounding improvements that would be expensive to rediscover in a future session.

For each finding, capture it for the roadmap (Phase 4 will create Notion cards).

### Phase 2.5: Mobile App Feature Parity

**Skip** unless this session shipped a new user-facing feature (new page, UI component, user flow). Data/CI/docs/backend changes don't need this.

If applicable, check whether the new feature needs a corresponding update in the mobile app (BroadwayScorecard-app repo). Note it for the roadmap — don't implement it now.

### Phase 3: Loose Ends Audit

Check for:
1. **Unstaged changes**: `git status` — are there modified files that should be committed or discarded?
2. **Running processes**: Any dev servers, background tasks, or watchers still running? Kill them (`kill $(lsof -ti:3456)` etc.)
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

**Detect project type:** Check if this is a Notion-tracked project (same detection as session-start: `CLAUDE.md` contains "Broadway Scorecard").

**If NOTION_PROJECT:** Update the Notion card instead of GitHub issues. See `memory/notion-brain-workflow.md` for database IDs and schema.

1. **Find the session's card:** Search Notion for cards with Status="In progress". If exactly 1 → use it. If multiple → list them and ask the user which one this session was working on. If none found → **this is a process failure** (the card should have been created at session start per startup hook rule #1). Create one now, but flag it to the user: "⚠️ Notion card was not created at session start — creating retroactively. This shouldn't happen."
2. **Read existing Outcome** from the card (it may have content from a prior session). Prepend — never overwrite.
3. **Write the Outcome using the MANDATORY template below.** Check the card's **Type** field and use the matching variant. Every section must be filled — no placeholders, no "N/A", no skipping. If a section truly doesn't apply, write "None identified" with a one-sentence explanation.

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
   [New bugs found, improvements spotted, tech debt uncovered. Each should have a corresponding new Notion card.
   Format: "- [card name] — [1-sentence description]"]
   ```

   **Self-check before writing:** Re-read your Outcome draft. For each section, ask: "Would someone who has never seen this codebase understand what happened and why?" If no, add detail. The Outcome is the permanent record — conversation context disappears, but this stays.

4. **Fill Key Files** — every commit from this session (`git log --oneline --since="2 hours ago"`), any PRs created, key files changed. Format: `commit abc1234: [description]` one per line.
5. **Set Tags** — tag with relevant subsystems (scoring, scraping, opening-night, west-end, off-broadway, commercial, email, ios-app, infra, data-quality)
6. **Set Completed Date** if marking as Done: `"date:Completed Date:start": "YYYY-MM-DD"`
7. **Set Status** → "Done" or "Paused" (if paused, add reason to Notes explaining what's left and what's blocking it)
7a. **RECHECK-AFTER rule (task #695): if the fix's effect is only observable later — next cron run, next day's billing/data, next opening night — it may NOT go Done.** Set Status="Paused" instead, and add to Notes:
   ```
   RECHECK-AFTER: YYYY-MM-DD

   ## Acceptance criteria
   `<safe-form command>` passes
   ```
   Pick RECHECK-AFTER as the earliest date the claim becomes checkable (e.g. "streak of N days" → N days out). The command MUST be one of the safe forms `scripts/lib/verify-gate.js` already accepts (`node --test <path>.test.mjs`, `npx tsc --noEmit`, `npx next lint`, `test -f <path>`) — write a real colocated test that asserts the live condition if no existing command covers it (see `scripts/verify-provider-spend-streak.test.mjs` for the pattern: a test that reads live repo data, not a fixture). `scripts/autonomous-acceptance-recheck.js` (hosted daily in `data-health-check.yml`) picks up Paused cards carrying this stamp once the date passes, re-runs the command against fresh `origin/main`, and reports pass/fail in shadow mode — it never auto-reopens or auto-completes the card; a passing recheck is your signal to come back and flip it to Done yourself (or the owner's, if it's their card).
7.5. **If Status is "Done" and this session claimed a shared-task-list task** (via `TaskUpdate` at session start, per the startup seed prompt): mark that task `completed` via `TaskUpdate` now, in THIS still-live turn — not later. This is what lets the workspace-mark-done Stop hook (`~/.claude/hooks/workspace-mark-done.sh`) ✅-mark the workspace automatically on this session's own next Stop event; the hook only reads the local task-list mirror, and nothing else updates it on a normal timescale (Notion→local sync is on-demand, not cron'd). Skip if this session never claimed a task (ad hoc / non-dispatched sessions).
8. **Create new cards** for any discovered work items (Status="Not started", appropriate Priority and Tags). Every item in "Discovered work" MUST have a card — don't just list them and forget.
   **CRITICAL — every new card must be a self-contained handoff.** Use the Notes field with this template:
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
9. **Fallback:** If Notion MCP calls fail at any point during this phase, output the FULL card update to the user so nothing is lost:
   ```
   ## Notion Card Update (Manual — MCP failed)
   - **Card:** [card name or URL]
   - **Status:** Done (or Paused — [reason])
   - **Completed Date:** [YYYY-MM-DD]
   - **Outcome:** [full template above]
   - **Key Files:** [commits]
   - **Tags:** [tags]
   ```
   The Status update is the most critical part — without it, the card stays "In progress" forever and becomes an orphan.

### Phase 4.5: Cross-session card sweep (NOTION_PROJECT only)

**Why this exists:** the per-session Stop hook enforces a 1:1 session↔card mapping. Roadmap cards that no session "owns" never get closed by that hook, so they accumulate. This phase catches the common case where a session *incidentally* ships work listed on another open card.

1. **Collect this session's footprint:**
   ```bash
   # Files touched by this session's commits
   git log --name-only --since="3 hours ago" --pretty=format: | sort -u | grep -v '^$'
   # Commit titles
   git log --oneline --since="3 hours ago"
   ```

2. **Pull all OTHER open cards:**
   ```bash
   node scripts/notion-brain.js search --status "In progress" 2>&1 | \
     python3 -c "import sys,json;d=json.load(sys.stdin);[print(x['id']+'|'+x['name']+'|'+(x.get('keyFiles','') or '')) for x in d]"
   ```
   Exclude this session's own card (already closed in Phase 4).

3. **Cross-reference — only flag if there's hard evidence:**
   - For each open card with a populated `keyFiles` field, check whether this session touched ANY of those files.
   - Extract 2-3 distinctive noun phrases from the card name. Grep this session's commit messages for those phrases.
   - A card is a **candidate** only if it matches on files OR phrases. Generic overlap (e.g., both touched `scripts/rebuild-all-reviews.js`) is NOT enough — many cards name that file.

4. **Surface candidates to the user** — don't auto-close:
   ```
   ### Possibly shipped by this session
   - [card name] — you touched [file] / commit [SHA] title mentions [phrase]
   - ...
   ```
   Ask: "Any of these closeable with today's work as outcome?" Let the user confirm per card before updating.

5. **If zero candidates:** skip silently. Don't pad the report with "no matches found."

**Scope note:** This phase only catches matches between THIS session and OTHER open cards. For the long tail of genuinely-stale roadmap cards that nobody has touched recently, run `/notion-sweep` weekly.

**Otherwise (non-Notion projects):**

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

**Dispatch-first (the default) — and dispatch at CREATION, not at report time (owner rule 2026-07-24: every P0/P1 that doesn't need an owner judgment call gets a workspace the moment it's carded; the nightly loop is the backstop, never the plan).** (`bsc-next --list` now prints pending P0/P1s below the top-10 cutoff in an explicit tail — fixed 2026-07-24.) If the item is technical + self-contained + carded (a Notion card / task-list entry exists — Phase 4 step 8 should have created one), do NOT hand the user a paste-prompt. Dispatch it yourself:
```bash
node scripts/bsc-next.js --list        # find the task # for the card
node scripts/bsc-next.js --id <task#>  # launch a seeded Cmux workspace on it
```
Verify the output shows a workspace actually launched, then report it as a plain line of prose — NOT inside a code fence, the finish-line gate strips fenced text and won't see it:

DISPATCHED: workspace <name> — <task subject>

The card IS the handoff — bsc-next seeds the new workspace with its full Notion context. Gotchas:
- **Card exists but isn't in the task list yet:** run `node scripts/notion-tasks-sync.js pull` (only P0/P1 cards mirror), then `--list` again to get the task #.
- **Item isn't carded at all:** card it first (Phase 4 template, Priority P1), sync, then dispatch. A dispatch without a card has no context to seed.
- **Launch fails** (Cmux missing/errored): fall back to the DEFERRED + HANDOFF PROMPT format below and say the dispatch failed.
- The gate verifies a bsc-next command actually ran this session — a DISPATCHED line without the launch gets blocked.

**Paste-prompt fallback (exception only).** Reserved for items that need a user decision first, or access this session lacks (different machine, missing credentials). Format:
```
DEFERRED: <what> — <which deferral bar it hits and why it can't be dispatched>
HANDOFF PROMPT:
<complete paste-ready prompt: task, key files, context, what was already tried, acceptance criteria>
```
The user pastes the prompt into a fresh session and it works with zero extra context. A Notion card ID alone is NOT a handoff, and a paste-prompt for a fully-specified technical task is a process failure — dispatch it instead.

**End the report with a mandatory `### Next` section** that triages EVERY Notion card created this session and every recommendation you made, each into exactly one bucket:
- **DONE-NOW** — you did it before ending (say what happened)
- **DISPATCHED** — you launched it via bsc-next (workspace name + task)
- **DEFERRED** — user-decision or different-machine items ONLY, with the deferral bar + HANDOFF PROMPT (format above)
- **BACKLOG** — one line on why it can safely wait; no user action needed

**Close with the SESSION STATUS block** — plain prose lines, NEVER inside a code fence (`exit-status-gate.sh` strips fences and enforces the SAFE/NOT SAFE line; the owner asked for this exact scannable shape 2026-07-20 so they don't parse walls of text):

──────────────────────────────────────────
DONE        <what shipped, and how it was verified — one line>
CONTINUING  <none | workspace/session name — what it's doing>
NEEDS YOU   <nothing | answer the DECISION NEEDED above | paste the handoff prompt above (non-dispatchable items only)>
SAFE TO EXIT — <one-line reason>
──────────────────────────────────────────

**A pending DECISION NEEDED always means NOT SAFE TO EXIT** — "nothing running" is not the bar, "nothing needed from the owner" is (owner rule 2026-07-20; exit-status-gate blocks SAFE TO EXIT when a decision block is present). The SAFE/NOT SAFE line is the hook-required part and must be the last content line (the closing rule is fine). Its three valid forms:
- `SAFE TO EXIT — <what finished and how it was verified>` — only when nothing is running anywhere (no deploy, no CI, no dispatched follow-up you're responsible for watching) and every claim was verified
- `NOT SAFE TO EXIT — CONTINUING IN <workspace/session>: <what it's doing>` — work continues elsewhere; NAME the workspace/session
- `NOT SAFE TO EXIT — <what's still running/blocked and what happens next>`

If a DECISION NEEDED block exists, it must sit immediately above the SESSION STATUS block, fully restated (never "the decision I asked earlier"), using the full template: `DECISION NEEDED:` / `Why this is your call:` / `Option A — name: upside / downside` / `Option B — name: upside / downside` / `My recommendation:` / `Default:`.

Only say "Clean exit, no loose ends" when you are ALSO not recommending any next-session work — a "recommended next session" IS a loose end and belongs in `### Next`, triaged. Never make the user ask "what's required next?"

### Phase 7: Workspace self-marking (Cmux sessions only) — mark, NEVER close

**Skip unless this session runs inside a Cmux workspace** — check with `/Applications/cmux.app/Contents/Resources/bin/cmux identify` (succeeds and returns your `workspace_ref`). Finished workspaces must be visually distinct so pruning is at-a-glance (owner rule, 2026-07-12).

After delivering the final report:
```bash
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
WS=$($CMUX identify | python3 -c "import sys,json;print(json.load(sys.stdin)['caller']['workspace_ref'])")
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
