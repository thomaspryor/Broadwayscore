End-of-session wrap-up checklist. Run this before closing ANY project session.

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

### Phase 2: Extrapolation Check (full sessions only)

**Skip this phase** unless the session involved UI changes, bug fixes, refactoring, or new patterns. It's most valuable when you changed something that has equivalents elsewhere.

Look at the changes and ask:
1. **Pattern reuse**: Did we create a pattern, component, or approach that should be applied elsewhere?
2. **Consistency**: Did we fix a bug or change behavior in one place that has equivalents elsewhere?
3. **Data implications**: Did we change data structures, schemas, or processing that affects downstream consumers?

For each finding, note it — don't fix it now. Just capture it for the roadmap.

### Phase 2.5: Mobile App Feature Parity

**Skip** unless this session shipped a new user-facing feature (new page, UI component, user flow). Data/CI/docs/backend changes don't need this.

If you shipped a user-facing feature:
1. Read `/Users/tompryor/BroadwayScorecard/memory/feature-parity.md`
2. If the feature isn't listed, add a row to "Needs App Implementation":
   `| Feature name | Priority (P0-P3) | Today's date | Web files, one-line description |`
3. Commit + push:
   ```bash
   cd /Users/tompryor/BroadwayScorecard && git add memory/feature-parity.md && git commit -m "chore: Flag [feature] for app parity" && git push && cd -
   ```

### Phase 3: Loose Ends Audit

Check for:
1. **Unstaged changes**: `git status` — are there modified files that should be committed or discarded? **Worktree note**: If in a worktree, pre-existing changes from prior sessions are NOT loose ends. Only flag changes YOU made this session. Compare against the worktree's state at session start (check `git stash list` or the initial git status snapshot).
2. **Running processes**: Any dev servers, background tasks, or watchers still running? Kill them (`kill $(lsof -ti:3456)` etc.)
3. **Failed tests**: Run `npx tsc --noEmit 2>&1 | head -20` — are there TypeScript errors in files YOU changed?
4. **Broken deploys**: Check `gh run list --workflow="Deploy to Vercel" --limit 1 --json status,conclusion` — is the latest deploy healthy?
5. **Worktree cleanup**: If the worktree was created for this session and all work is merged to main, note it can be removed. If the worktree pre-existed, leave it alone.

### Phase 4: Roadmap Update

Read the current roadmap: `gh issue view 50 --repo thomaspryor/Broadwayscore`

Then update it:
1. **Move completed items** to the "Recently Done" section with a one-line summary and date
2. **Update in-progress items** with current status
3. **Add new backlog items** for anything discovered (extrapolation findings, loose ends, new ideas)
4. **Post a comment** on issue #50 summarizing this session's work (2-3 sentences max)

Use `gh issue edit 50 --body "..."` for body updates and `gh issue comment 50 --body "..."` for the session summary comment.

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

### Loose Ends (for next session)
- [anything unfinished, with enough context to pick up]
```

If there are no loose ends, say so explicitly — "Clean exit, no loose ends."
