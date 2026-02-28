Quick plan review by an independent Claude agent. Use this to get a second opinion on a plan or approach before implementing. Lighter than `/critique` (one reviewer, no external APIs) — takes ~30 seconds instead of ~3 minutes.

## When to use

- Before implementing a medium-complexity plan (1-4 files)
- When you want a quick sanity check without the full `/critique` multi-model treatment
- After drafting a plan but before committing to it

**Workflow:** Plan → **`/check`** → Refine → Implement → `/test` → Commit

For large or risky plans (5+ files, architectural changes), use `/critique` instead.

## Instructions

### Phase 1: Gather the plan

Identify what to review. This is either:
- The text passed as arguments: $ARGUMENTS
- If no arguments, look at the most recent plan or proposed changes in the conversation
- If in plan mode, read the current plan file

Write the plan + relevant codebase context to `/tmp/check-plan.txt`. Include:
- The plan itself
- Tech stack context (Next.js 14, TypeScript, Tailwind, static export)
- Key constraints (CLAUDE.md rules that apply)
- List of files that will be modified

### Phase 2: Agent review

Launch a single Claude agent (subagent_type "general-purpose") with this prompt:

> You are a senior engineer reviewing a plan before implementation. You have access to the full codebase. Your job is to find problems that will waste time or break things — not to nitpick style.
>
> Read the plan below, then examine the actual files that will be modified. For each file:
> 1. Read the current state of the file
> 2. Check if the planned changes are compatible with the existing code
> 3. Look for hidden dependencies the plan doesn't mention
>
> **FIND THESE PROBLEMS:**
>
> 1. **Will it compile?** Check that every new reference (variable, function, import, constant) actually exists or is being created. This is the #1 source of bugs — plans that reference things that don't exist yet.
>
> 2. **Is anything missing?** Are there callers of modified functions that also need updating? Are there other files that import from changed modules? Run `grep -r "functionName"` to find all call sites.
>
> 3. **Will it break existing behavior?** Check for changes to function signatures, renamed/removed exports, changed return types. Every caller must be updated.
>
> 4. **Is the fix systematic?** Does the plan fix just one instance of a problem, or does it fix the root cause? If there are 5 places that could have the same bug, does the plan fix all 5? Look for patterns: if a function needs a new `market` param, check ALL callers — not just the one that was reported broken.
>
> 5. **Are there test gaps?** Does the plan include verification steps? If not, what specific checks would catch a regression?
>
> 6. **Edge cases in real data:** Check the actual data files (shows.json, reviews.json) for edge cases the plan doesn't handle — null values, missing fields, empty arrays, shows with no category.
>
> **OUTPUT FORMAT:**
>
> **BLOCKERS** (must fix before implementing):
> - [specific issue with file:line reference]
>
> **WARNINGS** (should fix, easy to miss):
> - [specific issue with file:line reference]
>
> **SUGGESTIONS** (nice to have):
> - [specific improvement]
>
> **VERDICT:** "Ready to implement" / "Fix N blockers first" / "Rethink approach"
>
> Under 500 words. Be specific — reference actual file paths, function names, and line numbers.
>
> THE PLAN:
> [paste the full plan text here]

### Phase 3: Present and act

Show the agent's findings. Then:

1. If **blockers found**: List them clearly and ask "Should I fix these and re-check, or adjust the plan?"
2. If **warnings only**: Note them, incorporate into the implementation plan
3. If **ready to implement**: Proceed with implementation

Do NOT re-run the agent after fixes — that's what `/test` is for after implementation.
