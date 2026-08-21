Quick sanity check from an independent reviewer. 30 seconds, no API calls. For when `/plan-review` is overkill.

## When to use

- Before implementing a medium-complexity plan (1-4 files)
- When you want a quick sanity check without the full `/plan-review` multi-model treatment
- After drafting a plan but before committing to it

**Workflow:** Plan → **`/second-opinion`** → Refine → Implement → `/build-check` → Commit

For large or risky plans (5+ files, architectural changes), use `/plan-review` instead.

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

> You are a senior engineer reviewing a plan before implementation. You have access to the full codebase. Your job is to find two classes of problem with EQUAL weight: (a) it won't work, and (b) it will work but the design is wrong and will age into tech debt. Skip neither.
>
> **MANDATORY READING BEFORE YOU REVIEW:**
> 1. Read every file the plan modifies (current state)
> 2. Read 1–3 SIMILAR files in this codebase — features that solve adjacent problems — so you understand the established patterns. List the files you read at the top of your review.
> 3. Grep for the names of any new helpers/types/functions the plan introduces, to check if equivalents already exist.
>
> A review that didn't read the existing code is worthless for design questions. Do not skip this.
>
> ---
>
> ## PART 0 — IS THE FRAMING RIGHT? (answer this BEFORE Parts 1–2)
>
> Reviewers default to critiquing a plan as framed — finding missing guards inside its stated structure — instead of asking whether the structure itself is right. (Task #1218: six reviewers passed a plan whose first gate was "5 shows through new tooling"; nobody suggested "2 shows by hand first," because every reviewer was hunting for flaws inside that ramp, not questioning the ramp.) Answer directly:
>
> 0a. **State the plan's first real execution step in units** (N shows/files/records/users/dollars). Could 1-2 units run mostly by hand, before any tooling or automation is built, and validate the riskiest assumption for pennies? If yes, say so explicitly as a **DESIGN BLOCKER**, not a suggestion — "first gate should be 1-2 by hand, not N through new tooling."
> 0b. Is there a simpler approach, or existing infrastructure, the plan is ignoring entirely?
> 0c. What breaks if this is done at half the scope, or deferred? If "nothing, it's just not ideal," say that plainly — it's a real answer, not a non-answer.
>
> ---
>
> ## PART 1 — WILL IT WORK? (Correctness)
>
> 1. **Will it compile?** Every new reference (variable, function, import, constant) must exist or be created. Plans that reference things that don't exist yet are the #1 source of bugs.
>
> 2. **Is anything missing?** Callers of modified functions, files that import from changed modules, related config. `grep -r "functionName"` for all call sites.
>
> 3. **Will it break existing behavior?** Changed function signatures, renamed/removed exports, changed return types. Every caller must be updated.
>
> 4. **Is the fix systematic?** Does it fix the root cause or one instance? If 5 places have the same bug, does the plan fix all 5? Patterns: if a function needs a new `market` param, check ALL callers, not just the broken one.
>
> 5. **Test gaps?** Does the plan include verification? If not, what specific checks would catch a regression?
>
> 6. **Edge cases in real data:** Inspect actual data files for null values, missing fields, empty arrays, shows with no category, etc.
>
> ---
>
> ## PART 2 — IS IT WELL DESIGNED? (Maintainability — equally important)
>
> Skipping this part is the failure mode the user explicitly wants to fix. "It will work" is not the bar.
>
> 7. **Codebase fit / inconsistency tax.** Does the plan match how SIMILAR features are built in this codebase, or is it inventing its own pattern? Quote the existing pattern (file:line) and the diverging plan side by side if you find a mismatch. Inconsistency is a permanent tax on every future maintainer who has to learn two ways of doing the same thing.
>
> 8. **Wrong abstraction / reinventing existing primitives.** Is the plan introducing a new abstraction (helper, class, type, module) where an existing one fits? Or doing manually what a utility already does? Before approving any new helper, name what it might be replacing. Premature abstractions (only 1 caller, speculative generality) are as bad as missing ones.
>
> 9. **Wrong layer / wrong responsibility.** Is the new code going where it belongs? Validation in the view, business logic in the controller, scoring rules in a presentation component, side effects inside pure functions, data shaping in route handlers — these are all smells. Where SHOULD this code live, and why is the plan putting it elsewhere?
>
> 10. **Deletion cost / hidden coupling.** If we wanted to REMOVE this feature in 6 months, how many files would we have to touch? More than 5 = hidden coupling. Does the plan add this feature's name into shared registries, type unions, switch statements, or barrel exports that will leak the abstraction across the codebase?
>
> 11. **Will it age well?** If the underlying data 10x's, or the upstream API shape changes, or a similar feature is added next quarter — where does this design break? Be specific about which file and which assumption.
>
> 12. **API surface & naming.** For any new public function/type/component: is the parameter list minimal? Are the names accurate enough that a reader at the call site understands without opening the implementation? Misleading names are a permanent tax. Could two parameters be one? Could a flag be inferred from context?
>
> ---
>
> ## OUTPUT FORMAT
>
> **FILES READ:** [list — including the similar files you used to learn the patterns]
>
> **EXISTING PATTERNS YOU FOUND:** [1–3 references to similar code in this codebase that the plan should match or has diverged from]
>
> **CORRECTNESS BLOCKERS** (will-it-work issues — must fix before implementing):
> - [specific issue with file:line]
>
> **DESIGN BLOCKERS** (wrong-shape issues — must fix BEFORE implementing because they're hard to undo later):
> - [specific issue, with the existing-pattern alternative the plan should follow]
>
> **WARNINGS** (should fix, easy to miss):
> - [specific issue with file:line]
>
> **SUGGESTIONS** (nice to have):
> - [specific improvement]
>
> **VERDICT:** Pick ONE — "Ready to implement" / "Fix N correctness blockers first" / "Fix N design blockers first" / "Rethink approach (correctness AND design problems)"
>
> Under 650 words. Be specific — reference actual file paths, function names, and line numbers. For design issues, ALWAYS quote the existing pattern that the plan should match. Vague advice ("consider maintainability") is not allowed.
>
> THE PLAN:
> [paste the full plan text here]

### Phase 3: Present and act

Show the agent's findings. Then:

1. If **blockers found**: **Default to fixing them now.** Don't just list them — fix them and note what changed. Only ask the user if the fix is ambiguous or would require rethinking the approach.
2. If **warnings only**: Incorporate into the implementation plan. For each warning, state how you'll address it.
3. If **ready to implement**: Proceed with implementation.

**If what you reviewed was IMPLEMENTED code (a working-tree diff, not a plan) in the Broadwayscore repo, record the verdict (MANDATORY):**

```bash
node scripts/lib/review-gate.mjs --query=record --reviewer=second-opinion --result=pass
```

(`--result=fail` if blockers remain.) This writes the push-boundary breadcrumb `pre-push-review-gate.sh` checks at `git push` time. A second-opinion verdict only satisfies the gate for diffs ≤100 gated lines — bigger diffs need /ship-check or /code-review.

**If what you reviewed was a PLAN (nothing implemented yet), record the plan-phase verdict instead (MANDATORY):**

```bash
node scripts/lib/review-gate.mjs --query=record-plan --reviewer=second-opinion \
  --result=pass --session-id="$CLAUDE_CODE_SESSION_ID" --note="<one line: what the review changed>"
```

This is what `~/.claude/hooks/infra-plan-review-gate.sh` checks before the session's first edit to shared infrastructure (task #1079, owner decision 2026-08-05). Without it the session stays blocked no matter how good the review was. `--result=fail` if you found blockers — a fail verdict does NOT unblock, and overturning it is the owner's call, recorded as `--reviewer=owner-override`.

**If Part 0 (framing) fired an escalation:** prefix the `--note` with `restructure-flag: adopted — <what shrank>` or `restructure-flag: dismissed — <why the scope stood>`. `scripts/lib/infra-review-digest.js` counts that prefix so this check's real hit rate shows up in the daily digest instead of vanishing at session end (task #1218).

For any issue you truly can't fix now, the bar is high: blocked on user decision, missing creds, different repo, or would push past ~2 hours. "Would take 30 min" is not blocked — that's just the work. For the rare genuine blocker, create a self-contained Notion card — and if it's technical + self-contained, dispatch it yourself (`node scripts/bsc-next.js --id <task#>` in Broadwayscore, ending with a `DISPATCHED:` line) instead of leaving a paste-prompt — then KEEP WORKING on what you can. Never offer to "hand off to a new session" — that phrase is banned (see `feedback_no_premature_handoff.md`).

After presenting findings and fixes, give the user **the actual plan in plain English** — not just what changed:

> **The plan:**
> [2-4 sentences: what will be built, how it works from the user's perspective, what the end result looks like]
>
> **What the reviewer changed:** [1-2 bullet points, or "No changes needed"]
>
> **Size:** [S/M/L]

The user is approving THE PLAN, not a diff. Describe it the way you'd explain it to someone who hasn't been in this conversation.

**Sprint-plan recommendation:** Based on the plan's scope, recommend whether `/plan-tasks` is needed:
- **1 session / <5 files:** "Small enough to implement directly. Skip `/plan-tasks`."
- **2-4 sessions:** "Recommend `/plan-tasks` to break into atomic tasks."
- **5+ sessions:** "`/plan-tasks` essential — task ordering matters at this scale."

Do NOT re-run the agent after fixes — that's what `/build-check` is for after implementation.
