---
name: opening-night-poller-cancels-rebuild
description: "opening-night-poller.yml gh-cancels in-flight rebuild-reviews.yml runs on busy nights; don't fight it with repeat dispatches"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3c9f3f8c-3def-489d-a038-45399923755a
  modified: 2026-07-24T01:32:50.071Z
---

**On a busy opening-night evening, manual `gh workflow run rebuild-reviews.yml` dispatches can get repeatedly cancelled or fail** — not a bug, working as designed.

**Why:** `opening-night-poller.yml`'s inline fast-path (lines ~464-479) explicitly `gh run cancel`s any in-flight `rebuild-reviews.yml` runs to get exclusive write access to the review-texts repo before doing its own inline rebuild. `rebuild-reviews.yml` and `gather-reviews.yml` share the `rebuild-reviews` concurrency group (`cancel-in-progress: false`), so this isn't a concurrency-group cancel — it's a deliberate cross-workflow lock the poller takes. On 2026-07-24 with 3 concurrent Opening Night Poller runs active, 2 manual rebuild-reviews.yml dispatches were cancelled/failed (one even got past checkout and rebuild steps successfully but failed on the final "Commit and push changes" step from a non-fast-forward push race) before a third succeeded once the queue cleared. See [[feedback_workflow_cascade_prevention.md]] for the broader dispatch-graph tracing habit this is a special case of.

**How to apply:** Before manually dispatching `rebuild-reviews.yml` to publish a data fix, check `gh run list --workflow=opening-night-poller.yml --status=in_progress` — if any are running, either wait for them to finish (their own inline rebuild will pick up already-pushed source data anyway) or accept the dispatch may get cancelled and will need a retry. Don't loop retries blindly; check the queue is actually clear first. The private-repo pushes (source of truth) succeed independently of this — only the public `public/data/shows/*.json` regeneration (what the site actually reads, see [[feedback_critic_score_canonical_helper.md]]) lags until a rebuild completes cleanly. Verify the fix landed with `curl https://broadwayscorecard.com/data/shows/{id}.json` (or `check-prod-deploy.js`), not just "a rebuild ran".
