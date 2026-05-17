---
name: ::error:: annotation alone does NOT fail a GH Actions step
description: For notify-failure / failure() gates to fire, the shell step must exit non-zero. console.error with ::error:: is a UI annotation, not an exit code.
type: feedback
originSessionId: ad4a33ca-5751-4533-a117-5ec42911d332
archived: true
---
GitHub Actions `failure()` conditions (e.g., `notify-failure`, `if: failure()`) check the step's **exit code**, not workflow-command annotations.

- `console.error('::error::message')` → red annotation in the UI, but the shell command can still exit 0. Step is **success**. `failure()` gates do NOT fire.
- `process.exitCode = 1` (or `throw`, or `process.exit(1)`) → shell exits non-zero. Step is **failure**. Alerts fire.

**Why:** On 2026-04-24 during the showtimes-card fix, I added a fail-loud branch in scrape-lottery-rush.js that logged `::error::` and `return`ed. The workflow logged the annotation in red but reported success to the notify-failure action, so Discord + email alerts never fired. Adding `process.exitCode = 1` before the `return` fixed it — the script completes playbill/twopenny first, then exits 1 at the end, triggering the alert.

**How to apply:**
- Whenever you want a GH Actions alert to fire from a Node script, set `process.exitCode = 1` (lets current work finish) or `throw` (aborts immediately). Don't rely on `::error::` alone.
- Double-check: after adding fail-loud behavior, trigger the failure branch in a real CI run and confirm the `if: failure()` step actually ran.
- The `::error::` annotation is still worth emitting — it surfaces the reason in the GH UI above the step output. Pair it with a non-zero exit.
