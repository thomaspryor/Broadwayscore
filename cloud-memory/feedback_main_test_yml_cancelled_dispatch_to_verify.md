---
name: main-test-yml-gets-cancelled-by-bot-churn-dispatch-to-get-a-real-ci-signal
description: "A push to main rarely yields a completed test.yml run (bot pushes every few min cancel it). To verify your own change in CI, dispatch a workflow_dispatch run — it's in a separate concurrency group and completes."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 18f7bfa1-1290-421d-b733-878793091095
---

2026-06-25: after pushing a 3-card CI change to main, the push-triggered `test.yml` run was **cancelled before any job ran** — a bot push landed seconds later. The repo pushes to main every few minutes (rebuild/odds/audit crons), so the push-event `test.yml` run almost never completes during active hours. `gh run watch --exit-status` returned 1 (cancelled), giving zero signal on my change.

**Why:** `test.yml` concurrency is `group: ${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}`. On main the config is "never cancel a *running* job," but a QUEUED run still loses to the next push before it starts. So a freshly-pushed commit's run is routinely cancelled at the queued stage.

**How to apply:**
- To get a real CI verdict on your own commit to main, **dispatch a run**: `gh workflow run test.yml --ref main`. Because the concurrency key includes `github.event_name`, a `workflow_dispatch` run is in a SEPARATE group from `push` runs — bot pushes won't cancel it, and it runs to completion.
- Get its id: `gh run list --workflow=test.yml --branch main --event workflow_dispatch --limit 1 --json databaseId`. Watch with `--exit-status`.
- **Read the overall conclusion skeptically:** a single job cancelled at its Checkout step (seen: `Awards Data Freshness`, a transient runner cancel) marks the WHOLE run `cancelled` even when every real gate — Lint Workflows, Unit Tests, E2E, Data Validation, **Test Summary** — is `success`. Inspect per-job conclusions (`gh run view <id> --json jobs`), don't trust the top-level status.
- For a data-independent test (the `node --test` no-data batch), the local `node --test <file>` IS the same command CI runs — local green == CI green for that file, no dispatch needed.

Related: [[feedback_github_polling_rate_limit]], [[feedback_e2e_runs_against_production]], [[feedback_test_yml_data_gates_flap_and_shortcircuit]].
