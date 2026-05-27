---
name: review-this
version: "1.0.0"
description: "User-invocable code review of the current branch delta against origin/main. Catches security holes, logic errors, edge cases, business-rule mismatches, and unbounded loops that slip through tests. Run manually with /review-this before risky pushes — NOT auto-triggered on commit/done/ship keywords (that pattern fork-bombs through session-stop hooks)."
allowed-tools: Bash, Read, Grep
user-invocable: true
---

# /review-this — Manual branch review

Invoke before pushing changes that touch high-risk paths. Adapted from `2389-research/fresh-eyes-review` (MIT) — checklist principles reused; trigger semantics replaced (auto-loading on "commit" / "done" / "ship" keywords is unsafe in this codebase's hook environment).

## When to run

Run before pushing changes that touch any of:
- `scripts/lib/review-guards.js`, `scripts/rebuild-all-reviews.js`
- `src/lib/scoring.ts`, `src/lib/engine.ts`, `src/lib/data-core.ts`
- `scripts/lib/scraper.js`, scoring-source extractors/parsers
- `.github/workflows/*.yml` touching deploy/broadcast/orchestrator
- Anything in `email-templates/` (one wrong send = real audience harm)
- New cron schedules
- Any change to `~/.claude/hooks/`

If the change is doc-only, comment-only, or a one-line typo: skip — `/ship-check` is sufficient.

## The flow

### 1. Collect the diff

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
DELTA=$(git diff origin/main...HEAD --stat | tail -5)
DIFF=$(git diff origin/main...HEAD)
SIZE=$(echo "$DIFF" | wc -c)
echo "Branch: $BRANCH"
echo "Delta: $DELTA"
echo "Diff size: $SIZE bytes"
```

If `$SIZE` > 200000: skip auto-review. Diffs that large need human reading first; ask the user to chunk.

### 2. Identify changed risk paths

```bash
git diff origin/main...HEAD --name-only | grep -E 'scripts/lib/|src/lib/(scoring|engine|data-core)|\.github/workflows/|email-templates/|hooks/|review-guards|gather-reviews|rebuild-all|opening-night-orchestrator'
```

If empty: tell the user the diff doesn't touch high-risk paths; recommend `/ship-check` instead of full review.

### 3. Run the checklist

For each changed file, walk through:

**Security**
- SQL injection: any string concatenation into a query? Use parameterized queries.
- Command injection: `Bash` calls with unescaped variables? Wrap in `"$VAR"` or use array form.
- Path traversal: user-supplied filenames joined to paths without `path.resolve` + boundary check?
- Secrets in logs: any `console.log` / `console.error` that could log `process.env.*`?
- XSS in email/HTML templates: any unescaped variable interpolation in HTML strings?

**Logic correctness**
- Off-by-one: any loop with `<` vs `<=`, any array indexing at `length` or `length-1`?
- Null/undefined: any optional-chained value used in arithmetic or comparison without a default?
- Async race: any `Promise.all` where order matters? Any shared state mutated across awaits?
- Boundary: empty array, single-element array, exactly-at-threshold value — does the code handle each?

**Business rules (this codebase)**
- Scoring touched? Run `node scripts/scoring-delta.js` per `memory/feedback_scoring_delta_required.md`.
- Content quality regex touched? Run `node scripts/audit-regex-patterns.js --full`.
- Manual review fields touched? Verify all 8 protection fields preserved (`feedback_manual_review_protection_fields.md`).
- New show added? Confirm it went through `validate-show-venue.js`.
- Email broadcast code touched? Re-read `memory/email-broadcast-rules.md` — NEVER call `POST /broadcasts/{id}/send` directly.

**Performance / footguns**
- Unbounded loop: any `while` that doesn't visibly decrement a counter?
- N+1: any loop fetching one record at a time from a JSON or DB? Batch.
- Memory: any read of `data/review-texts/` without streaming? File is large.
- Cron cascade: new workflow with `workflow_run` trigger — does the upstream actually exist? `memory/feedback_workflow_cascade_prevention.md`.

**Test gap**
- Pure decision function added in `scripts/lib/`? Is there a `.mjs` test that `require()`s it?
- Old behavior + new behavior — is there a regression fixture proving old still works?

### 4. Report

Output as a single block, severity-sorted, then save to `~/Documents/claude-outputs/review-this-${BRANCH}-$(date +%Y%m%d-%H%M%S).md`:

```
# /review-this report for branch <branch>

Diff: <N> files, <M> lines vs origin/main
Risk paths touched: <list>

## P0 (blocker)
- ...

## P1 (should fix before push)
- ...

## P2 (nit / future)
- ...

## Required follow-ups
- Run: <commands the codebase requires, e.g. scoring-delta.js>
```

If no findings: write "No P0/P1 findings against the checklist." and still save the file so the user has a record.

### 5. Stop. Do not auto-fix.

This skill REPORTS. Fixes are the user's call (or a follow-up Claude turn). Auto-fix in this codebase has burned us before — `feedback_must_match_comment_is_a_bug.md`.

## Anti-patterns this skill must not do

- Don't auto-load on "commit" / "push" / "done" / "ship" keywords. The original `fresh-eyes-review` skill's frontmatter triggers on those; in this codebase's hook environment, that would fan-out via session-stop.sh's cloud-memory push (see plan-review pre-mortem 2026-05-27).
- Don't spawn `claude -p` from inside any hook (PreToolUse / PostToolUse). Manual invocation only.
- Don't write to `memory/` or `cloud-memory/`. Reports go to `~/Documents/claude-outputs/` (iCloud, phone-visible, no rsync race).

## Attribution

Checklist categories derived from MIT-licensed `2389-research/fresh-eyes-review` (pinned reference SHA: c4440fd99a7226d9a787c3a22086bf0cf44cda20). Trigger semantics, codebase-specific business rules, and output routing are local.
