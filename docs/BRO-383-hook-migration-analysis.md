# BRO-383 — Hook layer classification for the Linear migration

**Phase 3 of the fleet retirement.** The Notion + cmux-fleet + dispatcher + local
hook-gate stack is being retired in favour of **Linear as the sole board** with
**hosted runners** (Cyrus as the Claude Code agent). Reference decision:
`cloud-memory/project_linear_migration_decision.md` (2026-08-11).

This document enumerates every hook that fires for this project and classifies
each **KEEP** (with the reason it must survive) or **DELETE** (naming the
mechanism that replaces it). Per the owner's rule, **the default is DELETE** —
"might still be useful" is not a reason to keep a hook.

---

## Scope: what "the hooks" actually are

Two layers exist today:

1. **User-level `~/.claude/hooks/` masters** — ~15 scripts wired by Tom's local
   `~/.claude/settings.json`. These fire **only on the local Mac CLI**. Hosted
   runners are stateless sandboxes that never mount `~/.claude/` (see
   `.claude/CLOUD.md`), so **the entire user-level layer ceases to exist the
   moment work moves to hosted runners.** It is deleted wholesale by the
   migration — not hook-by-hook. (Known members that have no repo counterpart:
   `worktree-enforce`, `design-system-lint`, `notify.sh`, `commit-check.sh`,
   `script-edit-check.sh`, `notion-mcp-block.sh`, `gh-zombie-reap.sh`,
   `session-stop.sh`, `claude-sync`. All DELETE — the machine they ran on is
   retired; the equivalents that still matter are the repo hooks + CI below.)

2. **Repo-committed `.claude/hooks/` (10 scripts, wired by `.claude/settings.json`)**
   — these are the derivatives that **actually fire in the hosted-runner world**,
   so they are the only hooks that can meaningfully "survive the Linear
   migration." Each self-skips to the user-level master on local CLI and runs on
   its own in cloud.

The title's "**34 hooks**" is these 10 scripts expanded to their **34 distinct
enforcement checks** (several scripts — `verify-edits.sh`, `session-start.sh`,
the push/merge gates — bundle many independent gates). The table below is at
that per-check granularity.

**The result: of 34 checks, 1 must survive (`cloud-bootstrap`). The other 33
DELETE**, each replaced by one of four migration-native mechanisms:

- **CI** — GitHub Actions (`test.yml` already runs scoring-delta,
  temporal-override-regression, `audit-regex-patterns.js`, and the review-gate /
  infra-review tests) made **required** by branch protection.
- **Branch protection** — required PR review + required checks on `main`;
  post-migration *every* landing is a GitHub PR merge, never a local push.
- **Runner isolation** — each Linear issue gets its own ephemeral workspace
  (this session runs in `/home/cyrus/cyrus-workspaces/BRO-383`, its own linked
  worktree). No shared local `main`, no cross-session collisions, no long-lived
  state to go stale.
- **Linear** — replaces Notion outright as the board / card system.

---

## Classification table

Legend — Replacement status: **[exists]** mechanism already in place ·
**[build]** replacement must be built as part of the migration before the hook
is removed.

| # | Script (event) | Check | KEEP / DELETE | Reason to survive **or** replacement mechanism |
|---|----------------|-------|---------------|------------------------------------------------|
| 1 | `verify-edits.sh` (Stop) | Generic code-verification gate ("you claimed done without running the code") | **DELETE** | CI: full test suite runs on every PR; branch protection blocks merge until green. Stronger than a local nudge. **[exists]** |
| 2 | `verify-edits.sh` | Scoring-delta / audit-sweep gate (blocks after mutating `data/review-texts/` without a delta run) | **DELETE** | CI: `test.yml` path-triggered `scoring-delta.js` + `test-temporal-override-regression.js`, required by branch protection. **[exists]** |
| 3 | `verify-edits.sh` | Scoring-logic file-edit gate (`scoring.ts`/`engine.ts`/`review-guards.js`…) | **DELETE** | Same CI scoring-delta job (path-triggered on scoring files). **[exists]** |
| 4 | `verify-edits.sh` | Ship-check gate on `scripts/lib/**` + `.github/workflows/**` edits | **DELETE** | Required PR review + `infra-review-gate` CI test; `/code-review` on the PR. **[exists]** |
| 5 | `verify-edits.sh` | Visual-QA verdict freshness gate | **DELETE** | Required CI visual-diff check + screenshots in PR review. **[build]** |
| 6 | `verify-edits.sh` | Visual-QA verdict schema-version gate | **DELETE** | Same CI visual check validates the artifact. **[build]** |
| 7 | `verify-edits.sh` | Visual-QA reference-image LLM-verdict gate | **DELETE** | Same CI visual check. **[build]** |
| 8 | `verify-edits.sh` | Visual-claim-language block ("looks correct / ready to ship") | **DELETE** | No replacement needed — anti-overclaim nudge, not a correctness gate; correctness is covered by CI. **[exists]** |
| 9 | `verify-edits.sh` | Human-time-estimate block ("a couple hours") | **DELETE** | No replacement — pure workaround artifact, not a gate. **[exists]** |
| 10 | `session-start.sh` (SessionStart) | Critical-rules banner | **DELETE** | `CLAUDE.md` loads every session by design; the banner duplicates it. **[exists]** |
| 11 | `session-start.sh` | CLAUDE.md anchor/integrity check | **DELETE** | CI markdown/anchor lint job (or drop — low value). **[build]** |
| 12 | `session-start.sh` | CLAUDE.md / MEMORY.md size warning | **DELETE** | CI file-hygiene / markdownlint size check; the File Hygiene rule already lives in CLAUDE.md. **[build]** |
| 13 | `session-start.sh` | Worktree reminder ("you're in main, not a worktree") | **DELETE** | Runner isolation: Cyrus provisions one linked worktree per issue — nothing to remind. **[exists]** |
| 14 | `session-start.sh` | Command-file drift (`.claude/commands` vs `~/.claude/commands`) | **DELETE** | No `~/.claude` on hosted runners; repo `.claude/` is the only, authoritative copy. **[exists]** |
| 15 | `session-start.sh` | Hook-file drift (`.claude/hooks` vs `~/.claude/hooks`) | **DELETE** | Same — repo `.claude/` is the sole copy in the runner; nothing to drift against. **[exists]** |
| 16 | `session-start.sh` | Data-staleness check (review-texts behind/ahead/diverged) | **DELETE** | Ephemeral runner clones fresh each run via `cloud-bootstrap`; never stale. **[exists]** |
| 17 | `session-start.sh` | Scoring-delta session baseline snapshot | **DELETE** | CI scoring-delta computes its own baseline vs `origin/main`. **[exists]** |
| 18 | `session-start.sh` | Stalled merge-state detection | **DELETE** | Runner isolation: each run starts from a clean clone. **[exists]** |
| 19 | `session-start.sh` | Stale MERGE_HEAD/REBASE_HEAD marker detection | **DELETE** | Same — clean clone per run. **[exists]** |
| 20 | `session-start.sh` | Conflict-marker check (`data/review-texts`) | **DELETE** | Same — fresh clone; no local corruption to inherit. **[exists]** |
| 21 | `session-start.sh` | Stash-accumulation guard (>10 stashes) | **DELETE** | Same — no long-lived local checkout to accumulate stashes. **[exists]** |
| 22 | `session-start.sh` | Data-repo `pre-commit` hook self-heal | **DELETE** | Runners write code, never data files (issue rule #3); the data-repo's own CI carries its guards. **[exists]** |
| 23 | `session-start.sh` | `gh-zombie-reap` (kill stale gh polling loops) | **DELETE** | Ephemeral runner teardown kills every process at end of run. **[exists]** |
| 24 | `session-start.sh` | `claude-sync pull` (refresh `~/.claude` repo) | **DELETE** | No `~/.claude` repo on hosted runners; config ships in repo `.claude/`. **[exists]** |
| 25 | `cloud-bootstrap.sh` (SessionStart) | Materialize private data (`data/shows.json`, review-texts) + `npm install` so the app builds | **KEEP** | **The one hard keep.** Hosted runners are stateless; nothing else materializes the private dataset + deps, and without it every runner fails `tsc` (TS2307). Runs *inside* the runner before work begins, so no CI job can replace it — it **is** the migration's data-provisioning path. |
| 26 | `pre-push-review-gate.sh` (PreToolUse Bash) | Push-allowed review-verdict gate (`git push` → main) | **DELETE** | Branch protection: required PR review + required CI checks on `main`. **[exists / config]** |
| 27 | `pre-push-review-gate.sh` | CI-red claim-conflict gate (two sessions fixing the same red run) | **DELETE** | Runner isolation removes the shared-checkout collision; each Cyrus session owns its own branch. **[exists]** |
| 28 | `pre-merge-review-gate.sh` (PreToolUse Bash) | Merge-allowed review-verdict gate (local `git merge` → shared main) | **DELETE** | No local merge to a shared `main` post-migration; PRs merge on GitHub under branch protection. **[exists / config]** |
| 29 | `pre-push-visual-gate.sh` (PreToolUse Bash) | Visual-QA verdict present + valid (schema/contentHash) on push | **DELETE** | Required CI visual-diff check on the PR before merge. **[build]** |
| 30 | `pre-push-visual-gate.sh` | Visual-QA ledger / user-approval on push | **DELETE** | GitHub PR approval (human review) is the approval of record. **[exists]** |
| 31 | `check-skill-redaction.sh` (PreToolUse Bash) | Block push if a redacted secret reappears in a committed `.claude/skills/**` file (public repo) | **DELETE** | GitHub secret scanning + push protection + a `gitleaks` CI Action with committed rules. ⚠️ Migration-independent risk **and already non-functional in cloud** (denylist is gitignored/absent), so the replacement is mandatory. **[build]** |
| 32 | `notion-create-block.sh` (PreToolUse) | Block subsequent tools if a `notion-brain.js create` failed earlier | **DELETE** | Notion is retired → **Linear**. Cyrus is invoked *on* a Linear issue, so there is no self-create-a-card step left to guard. **[exists]** |
| 33 | `enterworktree-guard.sh` (PreToolUse EnterWorktree) | Refuse same-name resume of a live session's worktree | **DELETE** | Runner isolation: one ephemeral workspace per issue; parallel same-name collisions cannot occur. **[exists]** |
| 34 | `whitespace-nowrap-lint.sh` (PostToolUse Edit/Write) | Warn on `whitespace-nowrap` + long text (FeaturedSpot overflow trap) | **DELETE** | Warning-only heuristic; `/visual-qa` (still a skill) + CI visual check catch real overflow. **[exists]** |

---

## Summary

| Verdict | Count |
|---|---|
| **KEEP** | **1** — `cloud-bootstrap.sh` (#25) |
| **DELETE** | **33** |

DELETE replacements by mechanism:

- **CI (already exists):** 1, 2, 3, 4, 8, 9, 17 — verification/scoring gates already mirrored in `test.yml`.
- **CI (must build):** 5, 6, 7, 11, 12, 29, 31 — visual-diff job, CLAUDE.md lint, secret-scan Action.
- **Branch protection / PR review:** 26, 28, 30.
- **Runner isolation:** 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 27, 33.
- **Linear replaces Notion:** 32.
- **No replacement needed (workaround artifacts):** 8, 9, 10, 34.

### Sequencing note (do not delete before the replacement lands)

Seven checks are **[build]** — deleting them before their CI replacement exists
would open a real gap:

- **#31 skill-redaction** — public-repo secret leak. Highest priority; land
  `gitleaks` + GitHub push-protection first.
- **#5/#6/#7/#29 visual-QA** — no CI visual-diff job exists yet; build it (or
  make `/visual-qa` a required, screenshot-attaching PR step) before removing
  the local visual gates.
- **#11/#12 CLAUDE.md lint** — lowest stakes; safe to simply drop if not worth a
  CI job.

Everything else (26 checks) is safe to delete immediately: their replacement
(runner isolation, branch protection, existing CI, Linear) is already in force.
