# BRO-749 — state at handoff

## Done
1. **Found & verified the real QEH Southbank (Apr 7-12 2026) review**: londonwithatoddler.com,
   published 2026-04-07, explicitly names "Queen Elizabeth Hall" and matches the show's real
   cast. (Ruled out several other 2026-04 hits — ayoungishperspective.co.uk Apr 17 and
   thereviewshub.com — both turned out to be *other legs* of the same national tour: The Lowry,
   Salford. This show tours widely in 2026 with the same cast at every stop, so cast-name match
   alone is NOT sufficient to confirm venue — always confirm venue/date text explicitly.)
2. **Ingested the review** into the private `broadway-review-texts` repo (source of truth):
   `the-boy-at-the-back-of-the-class-west-end-2026/london-with-a-toddler--kate-s.json`.
   Registered the outlet (`london-with-a-toddler`, tier 3) in `outlet-registry.json` in
   `broadway-scorecard-data` (core-data repo). Both pushed to `main` — commits
   `88516f16feb`/`d38ba5b809b` (review-texts), `32306e498` (core-data).
3. **Flagged 2 wrong-production stubs** that CI's `gather-reviews.yml` SERP pass surfaced for
   this show — both are the Lowry, Salford leg, not QEH: `a-youngish-perspective--unknown.json`
   and `thereviewshub--the-reviews-hub-london.json`. Both now have `wrongProduction: true` +
   explanatory notes. Commit `d38ba5b809b`.
4. **Added regression test** `scripts/gather-reviews.test.mjs` (registered in
   `tests/unit-test-manifest.txt`) — requires the real `quickDateCheck`/`verifyProduction`
   from `scripts/lib/production-verifier.js` against this exact show's real data. Passes:
   `node --test scripts/gather-reviews.test.mjs` → 4/4 pass.
5. **Fixed a local-run hazard I caused**: `node scripts/gather-reviews.js --shows=...` run
   locally (before I understood this worktree's `data/review-texts` is a 1-show stub, not the
   full private repo) triggered its internal `rebuild-all-reviews.js` call, which nearly wiped
   `reviews.json` (19912→35 reviews) in the symlinked `~/broadway-scorecard-data` clone, plus
   truncated `data/audit/needs-human-review.json`, `rebuild-regression.json`,
   `stage-latency.jsonl`, `public/data/admin/critic-coverage.json`, `public/data/admin/locks.json`
   in this worktree. **All reverted** (`git restore`) before anything was pushed — verified
   `~/broadway-scorecard-data` reviews.json back to 19912 reviews, worktree back to clean.
   Nothing bad was ever pushed to any remote.
6. Committed + pushed worktree branch `job/linear-BRO-749-mt2mvixt` (test file + manifest entry).
7. This worktree's `scripts/gather-reviews.js` run also dispatched CI's `gather-reviews.yml`
   remotely for this show (run `32459884148`) as a second, safer discovery pass (full fresh
   checkout, no local-clone hazard) — it completed successfully and is what surfaced the 2
   wrong-production stubs I then flagged (item 3 above).

## Pending / needs a follow-up check
- CI's `rebuild-reviews.yml` (dispatched as a retry, run `32464131156`, plus my own explicit
  dispatch `32464574627`) was still `in_progress` at handoff. The FIRST attempt (inside
  `gather-reviews.yml` run `32459884148`'s own `rebuild` job) **failed** — not a data bug, a
  push race against other concurrent automation on the busy `Broadwayscore` repo (7 retries,
  `push-with-retry.sh` gave up after 240s). This only affects the *derived* `reviews.json`
  aggregate — the source-of-truth review-text files are already safely committed+pushed
  (confirmed live via `gh api repos/thomaspryor/broadway-review-texts/contents/...`).
- **Next step**: check whether `gh run view 32464131156` (or the latest `rebuild-reviews.yml`
  run) succeeded. If still failing, just re-dispatch:
  `gh workflow run rebuild-reviews.yml -f reason="BRO-749 retry"` — it's idempotent, just
  rebuilds `reviews.json` from the already-correct review-texts state.
- Once rebuilt, spot check: `node scripts/query.js "SELECT * FROM reviews WHERE showId='the-boy-at-the-back-of-the-class-west-end-2026'"` (after `npm run db:build`) should show the
  new London With a Teenager review and should NOT show the 2 Lowry Salford stubs as valid.
- The new review has no explicit score — will need `LLM Ensemble Score Reviews` workflow (or
  it runs automatically post-rebuild) to get a score.
- Did NOT open a PR for the `job/linear-BRO-749-mt2mvixt` branch (data-only test file addition,
  low risk) — branch is pushed, can be merged directly or via PR per normal flow.

## Linear
Comment posted on BRO-749 documenting the above; issue moved to "In Review"
(state id `1af3f235-9020-4c77-ba57-2cc7aa9f27c9`).
