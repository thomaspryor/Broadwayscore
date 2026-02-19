End-of-session wrap-up checklist. Run this before closing ANY project session. Do NOT skip steps — work through each one and report findings.

## Instructions

### Phase 1: Session Inventory

Summarize what was accomplished this session in 3-5 bullet points. Be specific — include file names, feature names, and outcomes. Distinguish between:
- **Completed**: Fully done, tested, pushed
- **In progress**: Started but not finished
- **Discovered**: Identified as important but not started

### Phase 2: Extrapolation Check

Look at the changes made this session and ask:

1. **Pattern reuse**: Did we create a pattern, component, or approach that should be applied elsewhere? (e.g., added error handling to one workflow — should other workflows get the same treatment?)
2. **Consistency**: Did we change something in one place that has equivalents elsewhere? (e.g., fixed a bug in one page — does the same bug exist on similar pages?)
3. **Data implications**: Did we change data structures, schemas, or processing that affects downstream consumers?

For each finding, note it — don't fix it now. Just capture it.

### Phase 3: Loose Ends Audit

Check for:

1. **Unstaged changes**: `git status` — are there modified files that should be committed or discarded?
2. **Uncommitted work**: Any TODO comments or half-finished code left in files?
3. **Running processes**: Any dev servers, background tasks, or watchers still running? Kill them.
4. **Temporary files**: Any `/tmp/` files, test fixtures, or debug logs that should be cleaned up?
5. **Failed tests**: Run `npx tsc --noEmit 2>&1 | head -20` — are there TypeScript errors?
6. **Broken deploys**: Check `gh run list --workflow="Deploy to Vercel" --limit 1 --json status,conclusion` — is the latest deploy healthy?

### Phase 4: Roadmap Update

Read the current roadmap: `gh issue view 50 --repo thomaspryor/Broadwayscore`

Then update it:
1. **Move completed items** to the "Recently Done" section with a one-line summary and date
2. **Update in-progress items** with current status
3. **Add new backlog items** for anything discovered (Phase 2 findings, Phase 3 loose ends, new ideas)
4. **Post a comment** on issue #50 summarizing this session's work (2-3 sentences max)

Use `gh issue edit 50 --body "..."` for body updates and `gh issue comment 50 --body "..."` for the session summary comment.

### Phase 5: Documentation & Memory

Check if any of these need updating:

1. **CLAUDE.md** — Did we learn a rule that ALL sessions need to follow? (e.g., "never use X because Y", "always do Z before W"). Only add rules that are:
   - Learned from actual failures or near-misses this session
   - Applicable to future sessions (not one-time fixes)
   - Not already covered by existing rules

2. **Memory files** (`memory/MEMORY.md` and topic files) — Did we discover:
   - A new gotcha or edge case?
   - A useful pattern or technique?
   - A correction to existing documentation?
   - Critical operational knowledge (API limits, secrets, infrastructure)?

3. **Workflow CLAUDE.md** (`.github/workflows/CLAUDE.md`) — Did we add, modify, or learn something about a workflow?

For each update, make the change now. Be concise — one line per rule/gotcha.

### Phase 6: Rules from Failures

Think about what went wrong or almost went wrong this session:

1. **What mistakes were made?** (Even small ones — wrong assumptions, wasted time, broken builds)
2. **What would have prevented each mistake?** (A rule? A check? A different workflow?)
3. **Is the prevention worth codifying?** (Only if it's likely to recur and the rule is simple)

For each worthwhile rule:
- Write it as a concise imperative ("Always X before Y", "Never Z without W")
- Add it to the appropriate file (CLAUDE.md for universal rules, memory for operational knowledge)
- Include the failure context so future sessions understand WHY the rule exists

### Phase 7: Final Report

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

### New Rules Added
- [rules and which file]

### Loose Ends (for next session)
- [anything unfinished, with enough context to pick up]
```

If there are no loose ends, say so explicitly — "Clean exit, no loose ends."
