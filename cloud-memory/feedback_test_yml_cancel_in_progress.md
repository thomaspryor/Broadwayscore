---
name: test_yml_cancel_in_progress
description: "Recurring \"no clean CI signal\" on main = cancel-in-progress cancelling every commit; phantom jsdom/shows.json failures are the symptom, not the bug"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 714da609-967b-4032-8111-dc674efb80c2
---

For months, nearly every session re-diagnosed the same thing: test.yml on `main` shows
~75% of runs `cancelled`, no clean green signal, and the cancelled runs emit misleading
`jsdom` / missing-`shows.json` failures. Sessions kept "fixing" those phantom failures
(the assertions, the jsdom setup) and the problem returned the next day.

**Root cause (the mechanism, not the symptom):** the workflow's concurrency block keyed
the group only on `${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}` with
`cancel-in-progress: true`. On `main` every push shares ONE group, so each new commit
cancels the previous run mid-setup. Data-commit workflows push to main every few minutes,
so most code commits never finish validating, and the cancelled-during-setup runs report
jsdom/shows.json errors that look like real test failures but are just teardown artifacts.

**Fix (2026-06-06):** make cancellation conditional — cancel superseded runs only on PR
branches, never on main:
```yaml
cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```
Applied to test.yml, check-performance.yml, test-ugc.yml. submit-indexnow.yml legitimately
keeps `true` (idempotent search-engine ping, latest-wins is correct) and carries a
`# concurrency-cancel-ok:` annotation. This matches the repo's existing "queued, not
cancelled" pattern (rebuild-reviews, enrich-reviews, llm-ensemble-score — all documented in
.github/workflows/CLAUDE.md as moved off cancellation for the same reason).

**Nuance (learned 2026-06-06):** `cancel-in-progress: false` does NOT mean *every* commit runs to
completion. GitHub keeps **one running + one pending** per concurrency group; when a newer run
queues, the previously-*pending* run is cancelled (only the latest pending survives). So on a busy
branch the RUNNING commit always finishes (the real win), but intermediate commits queued behind it
can still show `cancelled`. A `workflow_dispatch` you fire (e.g. `update_snapshots`) competes in that
same pending slot and gets bumped by parallel-session pushes — re-dispatch until one completes.

**Prevention:** `scripts/audit-workflow-concurrency.js` runs in test.yml's `lint-workflows`
job. It fails CI if any push-to-main workflow has a commit-collapsing concurrency group
(no github.run_id/sha) + `cancel-in-progress: true` without a `# concurrency-cancel-ok:`
annotation. So the class cannot silently regress.

**Why:** the recurrence wasn't a flaky test — it was a structural cancellation that made
"red CI" the steady state, and every session attacked the symptom. The Stop-hook verification
gate can't catch "the run never finished," so the signal looked like a real failure each time.

**How to apply:** If you see cancelled test.yml runs on main / jsdom / shows.json failures
that don't reproduce locally — DO NOT touch the assertions or jsdom. Check the run's
`conclusion`: if `cancelled`, it's the concurrency mechanism, and the guard above should
already be enforcing the fix. Never reintroduce unconditional `cancel-in-progress: true` on a
push-to-main workflow. Related: [[feedback_ci_red_stale_state_and_brittle_assertions.md]],
[[feedback_test_yml_data_gates_flap_and_shortcircuit.md]], [[feedback_workflow_cascade_prevention.md]].

---

**2026-07-12 follow-up — `cancel-in-progress: false` is NOT sufficient on its own.**
The conditional-cancel fix above stopped *in-progress* cancellation, but main runs were STILL
cancelled during data-bot/code-merge bursts (7 in a row on 2026-07-11, e.g. run 15546f848
cancelled in 42s with `jobs:[]` — killed while PENDING, before any job started). Root cause:
GitHub keeps only ONE pending run per concurrency group and **cancels the older pending run when
a newer push queues behind the same in-progress run** — independent of `cancel-in-progress`.
Fix: on main, append `github.sha` to the concurrency group so every commit runs in its OWN group
(`...-${{ github.event_name }}${{ github.ref == 'refs/heads/main' && format('-{0}', github.sha) || '' }}`);
PRs keep the shared group + cancel-superseded. `audit-workflow-concurrency.js` treats a group
containing a per-run token (`github.sha`) as exempt, so the guard stays green.

**How to apply (updated):** cancelled main run + `jobs:[]` + <60s runtime = pending-supersession,
NOT in-progress cancellation. `cancel-in-progress:false` won't fix it — the concurrency GROUP must
be per-commit (include github.sha/run_id) so nothing shares a pending queue. Applies to ANY
push-to-main workflow, not just test.yml.
