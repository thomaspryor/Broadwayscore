---
name: ci-subprocess-env-inheritance
description: "Workflow step subprocesses via execFileSync/spawn need env: explicitly on the parent step — neighboring step's env doesn't reach them"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ff57183e-fbb4-4221-95c3-65b00720d107
---

When a workflow step shells out to a child script via `execFileSync`/`spawn`/`exec`, the child process only inherits env vars set on THAT step's `env:` block — not env vars set on neighboring steps. Any new secret the inner script reads must be added to BOTH the outer step's env block AND the subprocess-launching step's env block.

**Why:** Discovered 2026-05-25 during newsletter cron readiness review. `newsletter-draft.yml` had `GA4_PROPERTY_ID` + `GA_SERVICE_ACCOUNT_KEY` on the `Generate newsletter` step. The next step (`Regression test`) invoked `regression-test.mjs` which `execFileSync('node', ['generate.mjs', weekStart])`. Without GA env on the regression-test step, that subprocess regenerated the meta WITHOUT the Trending This Week section and overwrote the freshly-correct version from the main step. send-test.mjs then read the corrupted meta and sent a degraded preview. First smoke test exposed it (main run "13 sections fired" / regression rerun "12 sections fired · 3 skipped"); fix was to duplicate the GA env onto the regression-test step.

**How to apply:** When auditing a new env var added to a generator/scorer, grep for any other workflow step that re-invokes that script as a subprocess. Mirror the env block. CI lints don't catch this — both steps look syntactically valid in isolation.

Related: see [[silent-workflow-failures]] for other classes of CI failures that don't fail visibly.
