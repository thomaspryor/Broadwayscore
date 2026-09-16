# Workflow Dependency Graph (BRO-917)

Documents the cross-repo/cross-workflow dispatch graph so a future race can be traced to
its trigger chain instead of re-discovered from scratch. Companion to the "Data Sync
Architecture" table in `.github/workflows/CLAUDE.md`, which lists per-workflow
review-texts/rebuild behavior — this file is about *what triggers what*, not what each
workflow does internally.

## Background (original incident, 2026-04-16)

One opening night: 7 git rebases, 4 force-resolved conflicts, 3 data losses. Root cause —
`Broadwayscore` (public), `broadway-review-texts` (private), `broadway-scorecard-data`
(private) are three separate git repos wired together by `workflow_run` triggers and `gh
workflow run` dispatches, with no `concurrency:` group on the two hottest writers
(`opening-night-poller.yml`, `rebuild-reviews.yml`). Multiple pollers and rebuilds raced
to push the same files; GitHub's own cancel-on-dispatch behavior for `workflow_run` chains
made it worse (a cascade of triggers cancelling each other mid-push).

## What's already fixed (as of this doc, 2026-09-15)

The three original action items have all landed, well before this doc:

1. **Concurrency groups on the two named workflows** — both have had a `concurrency:` block
   for months:
   - `opening-night-poller.yml`: per-show/per-market group (`opening-night-poller-{show_id|market|auto-discovery}`), `cancel-in-progress: false`. Deliberately NOT a single global group — an early single-group version let unrelated per-show runs contend; see the file's own comment for the Cats postmortem (2026-04-07) that shaped this.
   - `rebuild-reviews.yml`: single `rebuild-reviews` group, `cancel-in-progress: false` (queued, not cancelled — a second trigger waits rather than killing an in-flight rebuild).
2. **Pre-push pull-before-push** — `.github/actions/push-review-texts/action.yml` does a
   `git pull --rebase --autostash origin main` *before* staging/committing (added
   2026-07-20 after three whole-file review clobbers), then a second `git pull --rebase`
   immediately before every push attempt inside its 5-attempt retry loop, with
   content-aware conflict resolution (keeps whichever side has the longer `fullText`,
   restores `PROTECTED_FIELDS`, merges `failed-fetches.json` by `reviewId`). Same pattern
   in `.github/actions/push-core-data/action.yml` and the general-purpose
   `scripts/lib/push-with-retry.sh` (used by every other push-to-main step).
3. **This file** — closes the last open acceptance criterion.

Additional defense-in-depth added since the original issue, not asked for but relevant:
- `scripts/lib/push-mutex.sh` — local `mkdir`-based mutex serializing `git push origin main` across concurrent Claude Code worktree sessions on the same machine (doesn't help CI-vs-CI races; different problem, same symptom).
- `scripts/lib/rebuild-staleness-guard.js` + the "Record/re-check review-texts checkout SHA" steps in `rebuild-reviews.yml` — detects a review-texts push that landed *during* a rebuild job and re-syncs just the drifted files before publishing.
- Per-review `_locked` flag + `PROTECTED_FIELDS` (see `scripts/lib/review-write-guard.js`) — belt-and-braces field-level protection independent of which side "wins" a rebase.

**This session's change:** `adjudicate-review-queue.yml` was the one review-texts-writing
cron left without a `concurrency:` group (daily 5:15 AM UTC + manual dispatch, writes
`humanReviewScore`). Added `group: adjudicate-review-queue`, `cancel-in-progress: false`,
matching the pattern above.

## The sync-critical cluster

These workflows read and/or write `data/review-texts/` (private repo) and/or
`data/reviews.json` (derived, private repo), so they're the ones that can actually race on
the same files. Every one of them now has a `concurrency:` group (`cancel-in-progress:
false` — queue, never cancel a write mid-flight):

| Workflow | Writes review-texts | Rebuilds reviews.json | Concurrency group |
|---|---|---|---|
| `rebuild-reviews.yml` | ✅ (pre-rebuild flag-setters) | ✅ (primary) | `rebuild-reviews` |
| `rebuild-fast.yml` | ❌ | ✅ (lightweight) | per-run (`rebuild-fast-${{ run_id }}` — intentionally parallel, see file comment) |
| `enrich-reviews.yml` | ✅ | ❌ | per-run (intentionally parallel, see file comment) |
| `gather-reviews.yml` | ✅ | ✅ | `review-texts-backfill-write` |
| `collect-review-texts.yml` | ✅ | ✅ (inline) | per-filter-combo (parallel-safe by design — different `show_filter`/`content_tier`/`domain_filter` values are disjoint) |
| `opening-night-poller.yml` | ✅ | ✅ (inline, fast_path) or dispatches `rebuild-reviews.yml` | per-show/market |
| `opening-night-broadcast.yml` | ✅ | ✅ | `broadcast-send` |
| `opening-night-express.yml` | ✅ | ✅ | per-show (`opening-night-express-{show_id}`) |
| `opening-night-reviews.yml` | ❌ (dispatches `gather-reviews.yml`) | ❌ | `opening-night-reviews` |
| `opening-night-completeness-check.yml` | ❌ (read-only diff) | ❌ | `opening-night-completeness-check` |
| `opening-night-checklist.yml` | ❌ (read-only) | ❌ | `opening-night-checklist` |
| `adjudicate-review-queue.yml` | ✅ | ❌ (dispatches `rebuild-reviews.yml`) | `adjudicate-review-queue` (added this session) |
| `fetch-guardian-reviews.yml` | ✅ | ✅ | (single-threaded caller only — dispatched per-show by the poller) |
| `process-review-submission.yml` | ✅ | ✅ | (single-threaded — one GH Issue at a time) |
| `llm-ensemble-score.yml` | ✅ (writes scores) | ❌ (triggers rebuild) | `scoring-reviews[-{rescore_reason}]` |
| `update-critic-consensus.yml` | ❌ (separate file, `critic-consensus.json`) | ❌ | `update-critic-consensus` |
| `scrape-bww-reviews.yml`, `scrape-new-aggregators.yml`, `scrape-dtli-show-score.yml`, `scrape-westendtheatre.yml`, `scrape-stagedoor.yml`, `scrape-thestage-roundups.yml`, `sweep-we-aggregators.yml`, `collect-we-ob-reviews.yml`, `collect-free-reviews.yml`, `collect-soft-paywall.yml`, `collect-hard-paywall.yml` | ✅ | ✅ or dispatches `rebuild-reviews.yml` | own per-workflow groups (weekly cadence, low collision risk by schedule spacing) |
| `opening-night-orchestrator.yml` | ❌ (dispatches poller) | ❌ | **intentionally no workflow-level group** — see `memory/feedback_concurrency_group_must_serialize_work_not_runs.md`; it serializes externally by waiting on each poller run instead |
| `vercel-deploy.yml` | ❌ | ❌ | job-level, per-run group (deliberate — see file comment, `memory/feedback_gha_concurrency_queue_limit.md`) |

`opening-night-orchestrator.yml` and `vercel-deploy.yml` are deliberate exceptions with
documented rationale in the files themselves — not gaps.

## Dispatch graph

### Native `workflow_run` triggers (GitHub-managed, fires on completion)

```
Collect Review Texts ─────────────▶ Rebuild Reviews Data
                                     (safety net; explicit gh workflow run dispatch
                                      from collect-review-texts.yml is the primary path,
                                      this is the backup)

Rebuild Reviews Data ─────────────▶ Check Corpus Drift
Rebuild Reviews (Fast) ───────────▶ (not wired to corpus drift — fast path skips it)

Rebuild Reviews Data ─────────────▶ Deploy to Vercel
Rebuild Reviews (Fast) ───────────▶ Deploy to Vercel

LLM Ensemble Score Reviews ───────▶ Opening Night Broadcast (preview-only retry)

Deploy to Vercel ──────────────────▶ Demo Alias Watchdog
Deploy Demo Site ──────────────────▶ test-ugc-roundtrip.yml (keep-alive)

Collect Review Texts,
Bulk Collect Review Texts,
Rebuild Reviews Data,
Re-scrape Truncated Reviews,
Collect Free-Outlet Reviews,
Collect Hard-Paywall Reviews (Archive.org) ──▶ Mirror Review Texts to GitLab
```

### Explicit `gh workflow run` dispatches (fire-and-forget, not GitHub-tracked as a chain)

These are the ones that matter for the review-texts/reviews.json race — anything that
dispatches `rebuild-reviews.yml`:

```
adjudicate-review-queue.yml, audit-aggregator-gap.yml, audit-touring-contamination.yml,
backfill-review-dates.yml, bulk-collect-review-texts.yml, collect-outlet-reviews.yml (x2),
collect-review-texts.yml, collect-we-ob-reviews.yml, discover-regional-serp-reviews.yml,
drain-not-attempted.yml, fix-autoclear-ensemble-conflicts.yml, opening-night-poller.yml
(legacy/non-fast_path), outlet-listing-poller.yml, overnight-collect.yml,
recollect-for-scores.yml, recover-explicit-ratings.yml, recover-wayback-reviews.yml,
recover-wsj-subscriber.yml, retry-wrong-urls.yml, scrape-bww-reviews.yml,
scrape-dtli-show-score.yml (via collect-review-texts.yml), scrape-stagedoor.yml,
scrape-thestage-roundups.yml, scrape-westendtheatre.yml, sweep-we-aggregators.yml
                                        │
                                        ▼
                              Rebuild Reviews Data
                       (single `rebuild-reviews` concurrency group absorbs
                        all of the above into one queue — this is the fix)
```

Every one of these callers dispatches into the **same** `rebuild-reviews` concurrency
group, so no matter how many of them fire in the same hour, at most one `rebuild-reviews.yml`
run executes at a time and the rest queue (GitHub keeps at most 1 pending run — rapid-fire
triggers debounce naturally).

Other notable dispatch chains (lower collision risk — different target files or already
serialized by their own groups):

```
gather-reviews.yml ──▶ collect-review-texts.yml, llm-ensemble-score.yml, vercel-deploy.yml
collect-review-texts.yml ──▶ rebuild-reviews.yml, llm-ensemble-score.yml
rebuild-reviews.yml ──▶ vercel-deploy.yml, llm-ensemble-score.yml, update-critic-consensus.yml
llm-ensemble-score.yml ──▶ llm-ensemble-score.yml (self, batch chaining), extract-pull-quotes.yml
opening-night-poller.yml ──▶ fetch-guardian-reviews.yml, vercel-deploy.yml (fast_path),
                              rebuild-reviews.yml (legacy path), opening-night-broadcast.yml,
                              investigate-alert.yml (on failure)
opening-night-orchestrator.yml ──▶ opening-night-poller.yml (per-show, waited-on synchronously)
opening-night-broadcast.yml ──▶ gather-reviews.yml, vercel-deploy.yml, send-notifications.yml,
                                 investigate-alert.yml (on failure)
opening-night-reviews.yml ──▶ gather-reviews.yml
update-show-status.yml ──▶ gather-reviews.yml, vercel-deploy.yml, check-opening-night-readiness.yml,
                            + (on previews→open) opening-night-poller.yml, opening-night-broadcast.yml,
                              update-reddit-sentiment.yml, update-show-score.yml, update-mezzanine.yml,
                              fetch-all-image-formats.yml
vercel-deploy.yml ──▶ update-deploy-watermark.yml, investigate-alert.yml (on failure)
scrape-new-aggregators.yml ──▶ collect-review-texts.yml, update-reddit-sentiment.yml, update-mezzanine.yml
scrape-dtli-show-score.yml ──▶ collect-review-texts.yml
bulk-collect-review-texts.yml ──▶ rebuild-reviews.yml, bulk-collect-review-texts.yml (self, round-chaining),
                                   extract-pull-quotes.yml
data-health-check.yml, check-cron-health.yml ──▶ investigate-alert.yml (on anomaly)
```

## How to extend this doc

When adding a new workflow that writes `data/review-texts/` or `data/reviews.json`,
or that dispatches `rebuild-reviews.yml`/`opening-night-poller.yml`:
1. Add a `concurrency:` group (queued, `cancel-in-progress: false`, unless there's a
   documented reason to run in parallel — see the exceptions table above for the pattern).
2. Add a row to the sync-critical cluster table above.
3. Add its dispatch edges to the graph above if it fires `gh workflow run` for anything
   in this file.

Regenerate the dispatch-edge lists with:
```bash
grep -B6 "workflows: \[" .github/workflows/*.yml | grep -E "^\.github/workflows|workflows: \["
grep -n "gh workflow run" .github/workflows/*.yml | grep -v "^\s*#"
```
