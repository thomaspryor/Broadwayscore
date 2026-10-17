---
name: feedback_rebuild_reviews_unguarded_dispatch_tips_job_red
description: rebuild-reviews.yml intermittent conclusion=failure is a spurious post-success red from two unguarded gh workflow-run dispatches; fix lives in the workflow yaml
metadata:
  type: feedback
---

`Rebuild Reviews Data` (`.github/workflows/rebuild-reviews.yml`) shows up in the digest's **Repeat Workflow Failures** (health-check.js `repeatFailureResults`, 3+ real `conclusion=failure` in 24h) while the rebuild itself keeps succeeding (reviews.json rebuilt + pushed; `data/audit/pipeline-health/rebuild-reviews.last-success` fresh). Cause: two post-success dispatch steps run without the `|| echo` guard the sibling deploy dispatch already has, and neither has `continue-on-error`:

- **Auto-trigger LLM scoring** — `gh workflow run llm-ensemble-score.yml …` (~line 586)
- **Auto-trigger consensus update if needed** — `gh workflow run update-critic-consensus.yml` (~line 627)

On a GitHub API rate-limit (recurring during opening-night bursts — task #148) either `gh` exits non-zero and, with no guard, tips the whole job to `failure` **after** reviews.json was already rebuilt and pushed. This is exactly the anti-pattern the workflow's own comment above the deploy dispatch (~line 456-463) describes and defends against for `vercel-deploy.yml` (`gh workflow run vercel-deploy.yml || echo "Deploy dispatch failed …"`) — the guard was just never applied to these two later dispatches.

**Why:** the failures are genuine `conclusion=failure` (cancelled runs are NOT counted — `getWorkflowRunSummary` filters `r.conclusion === 'failure'`), so the digest is right to flag them, but the red is spurious: the rebuild's real product succeeded. Every other non-`continue-on-error` step in this workflow is either these two yaml-inline `gh` dispatches, `push-with-retry.sh` (a `.sh`), or `rebuild-all-reviews.js` (scoring watchlist) — none of which the overnight loop (Tier 3: `src/**`, `scripts/**` `.js/.ts` only) can edit, and `.github/workflows/` is hard-excluded. So there is NO in-loop-scope code change that stops these failures.

**How to apply (owner / in-scope session):** append `|| echo "dispatch failed — non-fatal (workflow_run will catch success)"` to each of the two `gh workflow run` lines, OR add `continue-on-error: true` to the two steps. One-token-per-line yaml edit. Mirrors the deploy-dispatch guard already in the same file. Same fix class as [[feedback_workflow_cascade_prevention.md]] step-ordering / [[feedback_silent_workflow_failures.md]] (never let a non-essential post-output step fail the job). Related repeat-failure-card pattern: update-show-status (#438 fixed the real failure, #486 deduped the alert).

**Loop note:** BSC-Daily "Workflow repeat-failure: Rebuild Reviews Data" cards are NOT closable by the Tier-3 loop — the fix is a `.github/workflows/` edit. Don't re-attempt an in-scope code fix; surface the two-line yaml guard to the owner.
