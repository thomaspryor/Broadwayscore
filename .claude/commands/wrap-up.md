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
3. **Failed tests**: Run `npx tsc --noEmit 2>&1 | head -20` — are there TypeScript errors?
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
   - **Fix:** Add `### Root cause` and `### Prevention added` (prevention = a code/test/hook/CI change; a memory file alone doesn't count — CLAUDE.md rule 16)
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

**Memory-entry criteria (CLAUDE.md rule 16 — encode first, write rarely):** a memory file must pass all three: (1) the lesson could NOT be encoded as code/test/hook/CI gate — if you already encoded the fix, the memory is redundant, skip it; (2) you can name the specific future action that changes; (3) a future session hitting the same mistake would plausibly recall the file from its description. **"No new learnings worth saving" is the normal outcome — say that and move on.** Never offer to commit memory files to the repo; the session-stop hook auto-syncs them to `cloud-memory/`.

**MEMORY.md size check** — if you touched MEMORY.md this session, verify it's still under cap:
```bash
wc -l ~/.claude/projects/-Users-tompryor-Broadwayscore/memory/MEMORY.md   # cap: 180
( cd ~/Broadwayscore && node scripts/rebuild-memory-index.js --enforce-limit=180 2>&1 >/dev/null )
```
If over 180, trim or archive (`archived: true` frontmatter) before the session ends. The harness silently truncates at ~200 — `claude-sync push` will block hard at >200.

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

**Before listing any loose end, ask: can I just do this now?** If a loose end would take <5 minutes to fix, fix it instead of listing it. The user should never have to read a loose end and tell you to go do it. Only list items that genuinely require a separate session (blocked, different repo, would take >15 minutes, needs user decision).

**Every deferred loose end must carry its own handoff.** Format (the finish-line gate enforces this):
```
DEFERRED: <what> — <which deferral bar it hits and why>
HANDOFF PROMPT:
<complete paste-ready prompt: task, key files, context, what was already tried, acceptance criteria>
```
The user pastes the prompt into a fresh session and it works with zero extra context. A Notion card ID alone is NOT a handoff.

**End the report with a mandatory `### Next` section** that triages EVERY Notion card created this session and every recommendation you made, each into exactly one bucket:
- **DONE-NOW** — you did it before ending (say what happened)
- **DEFERRED** — with the deferral bar it hits + HANDOFF PROMPT (format above)
- **BACKLOG** — one line on why it can safely wait; no user action needed

Close with exactly one line: `Your next action: <nothing | paste the handoff prompt above into a new session | answer the DECISION NEEDED above>`.

Only say "Clean exit, no loose ends" when you are ALSO not recommending any next-session work — a "recommended next session" IS a loose end and belongs in `### Next`, triaged. Never make the user ask "what's required next?"
