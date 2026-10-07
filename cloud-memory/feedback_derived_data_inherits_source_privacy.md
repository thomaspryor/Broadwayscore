---
name: feedback_derived_data_inherits_source_privacy
description: "A derived/snapshot/export file's publish target must match its SOURCE data's privacy classification, not a superficially-similar precedent"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 32341712-0306-4425-b1d7-276537b35a87
---

When adding a snapshot/export/history file derived from existing data, its public-vs-private destination is set by the SOURCE data's privacy class — not by copying a similar-looking workflow. Shipping a full weekly snapshot of `audience-buzz` to the PUBLIC repo (modeled on the Tony `data/audience-snapshots/` precedent) would have re-leaked competitive data that `purge-archives-history.yml` deliberately scrubbed from public history and moved to the private core-data repo. Caught by Codex in /ship-check, 2026-06-21.

**Why:** `audience-buzz.json` is gitignored in public and lives only in `thomaspryor/broadway-scorecard-data`. The Tony snapshot is public because it's a bounded ~161-show seasonal subset; the full 1,894-show corpus is the competitive asset. Same data shape, opposite privacy policy — a nearby public precedent is NOT sufficient justification.

**How to apply:**
1. Before committing any derived data file, check the source's privacy class: `git check-ignore data/<source>.json`, and grep `purge-archives-history.yml` + the `# competitive data` comments. Private source → derivative is private too.
2. Route private derivatives to the private repo via the **canonical `push-core-data` action**, NOT a hand-rolled `git push` loop. Write the file into `/tmp/core-data-checkout/<dir>/` (the clone `checkout-core-data` makes), then `uses: ./.github/actions/push-core-data`. Its `git add -A` picks up the new file and its reconciliation-aware retry (incl. audience-buzz merge) handles the ~60 other workflows pushing that repo concurrently. The first cut here hand-rolled an inline push loop with a `# hygiene-push-ok` exemption — that reinvented push-core-data and lacked its reconciliation; the user's "is that the right solution?" flagged it.
3. Gitignore the path in the public repo as defense-in-depth so a stray local/manual run can never leak it.
4. Add a freshness guard when reading a core file the checkout doesn't hard-fail on (checkout-core-data only canaries shows.json/reviews.json) — refuse to snapshot a stale/missing copy. See [[feedback_dual_repo_data_files]].
