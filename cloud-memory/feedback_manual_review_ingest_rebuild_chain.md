---
name: feedback_manual_review_ingest_rebuild_chain
description: "ingest-manual-review.js doesn't commit/push in disconnected worktrees; scoring needs a second rebuild-fast pass"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 48a59b71-0750-4215-b1ab-c4fb80125dcf
  modified: 2026-07-22T04:11:04.659Z
---

`scripts/ingest-manual-review.js` writes the review-text file into the CALLING repo's `data/review-texts/` path and only dispatches a CI rebuild — it does NOT commit/push itself. In a worktree where `data/review-texts` isn't a live checkout of the private `broadway-review-texts` repo (the common case — most worktrees skip `setup-local-data.sh` for review-texts), the written file never reaches the repo the triggered CI rebuild actually checks out. The script reports success regardless, so this fails silently.

**How to apply:** After running `ingest-manual-review.js` in a worktree, verify the file actually landed by checking `~/broadway-review-texts` (the real clone) before trusting the triggered rebuild. If it's missing there, manually copy the written JSON into `~/broadway-review-texts/<show-id>/`, `git add && commit && push` it yourself, then dispatch/wait for `rebuild-reviews.yml`.

Separately: scoring a manually-ingested review needs an EXTRA `rebuild-fast.yml` pass after `llm-ensemble-score.yml` completes. The scoring run only pushes the updated review-text source file back ("no core data changes to push" in its log is normal) — `reviews.json` aggregation with the new score happens in a distinct rebuild step, not automatically. Expect the full chain: ingest → push review-texts → rebuild-reviews (aggregates raw text) → llm-ensemble-score (writes score into source file) → rebuild-fast (aggregates score into reviews.json) → deploy.

`rebuild-reviews.yml`/`rebuild-fast.yml` runs also hit push contention + got auto-cancelled 2-3 times each during a high main-commit-churn window (2026-07-22) — this is the known project-level flakiness in [[feedback_github_polling_rate_limit]]'s neighborhood, not specific to manual review ingestion. Re-dispatch on cancellation/failure rather than assuming the chain is broken.
