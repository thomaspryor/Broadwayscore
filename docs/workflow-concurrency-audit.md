# Workflow Concurrency Group Audit (BRO-3500)

Follow-up to BRO-917 (`docs/workflow-dependency-graph.md`). BRO-917 fixed the two
highest-traffic gaps (`opening-night-poller.yml`, `rebuild-reviews.yml`) but a systematic
sweep was never run. The session that filed this card found **22 more** workflows that
write `data/review-texts/` (private repo) with no `concurrency:` group at all — same race
class, just not the two workflows the original report happened to name.

## Method

```bash
grep -l "uses: ./.github/actions/push-review-texts" .github/workflows/*.yml
grep -l "cd data/review-texts" .github/workflows/*.yml
# union, minus every file with a top-level ^concurrency: line
```

This produced the 22-workflow list in BRO-3500's Evidence section. Verify current
coverage any time with:

```bash
for f in .github/workflows/*.yml; do
  { grep -lq "uses: \./\.github/actions/push-review-texts\|cd data/review-texts" "$f" \
    && ! grep -q "^concurrency:" "$f"; } && echo "$f"
done
```
(should print nothing once this card lands).

## A gotcha that changed two of the group choices below

`cancel-in-progress: false` only protects the currently-RUNNING job from being killed.
It does **not** protect a QUEUED/pending duplicate: per GitHub's docs, "any existing
pending job or workflow in the same concurrency group will be canceled and the new
queued job or workflow will take its place" — unconditionally, regardless of the
`cancel-in-progress` setting. Concretely: run A starts, run B queues behind it
(pending), run C arrives — C **cancels B**, not A. If A, B, C carry distinct
non-idempotent payloads (not "redo the same work"), B's payload is silently lost.

This is fine for every workflow below where a queued duplicate really is redundant
work (re-running the same script over the same data). It is NOT fine for two
workflows that were originally drafted with a naive shared group and got caught by
an adversarial review pass before landing:

- **`process-review-submission.yml`** — each run processes ONE GitHub issue (one
  user's review submission). A shared group meant: if issue B opens while issue A is
  still processing, and issue C opens before A finishes, issue B's submission is
  silently dropped (its pending run cancelled by C) with no retry. Fixed to a
  **per-issue group**: `process-review-submission-${{ github.event.issue.number ||
  inputs.issue_number }}`. Different issues never share a group, so they run in true
  parallel exactly like today (no serialization added at all, in practice) while a
  genuine double-dispatch of the SAME issue still serializes.
- **`fetch-guardian-reviews.yml`** — two independent callers
  (`opening-night-poller.yml`, `opening-night-orchestrator.yml`) dispatch this with
  DIFFERENT `shows` values, often close together during an opening-night window. A
  shared group risked the same B-gets-cancelled-by-C loss, dropping a distinct
  show's Guardian fetch. Fixed to a **per-`shows` group**:
  `fetch-guardian-reviews-${{ inputs.shows || 'scheduled' }}`. Different show-set
  requests never collide; the rare Wednesday cron (no `inputs.shows`) falls back to
  a stable key.

Every other workflow in the shared-group table below was checked against this same
question — "is a cancelled pending duplicate actually redundant work, or does it
carry distinct content that would be lost?" — using `grep -n "gh workflow run
<name>"` across the repo to find every caller and what it passes. None of the other
13 have more than one caller passing workflow-run-distinguishing inputs, so a plain
shared group is correct for them.

## Two group shapes used

**Shared group** (`group: <workflow-name>`, `cancel-in-progress: false`) — the default.
Serializes every trigger of the workflow (cron + manual + any external dispatch) into one
queue. Correct whenever a single workflow run is the natural unit of work, since GitHub
queues at most one pending run and coalesces rapid-fire triggers — same pattern as
`rebuild-reviews.yml`'s `rebuild-reviews` group and this session's earlier
`adjudicate-review-queue` fix.

**Per-run group** (`group: <workflow-name>-${{ github.run_id }}`, `cancel-in-progress:
false`) — used only where a shared group would be actively wrong. `github.run_id` is
unique per triggered run (and stable across "re-run failed jobs" on that same run), so this
shape:
- never queues two independent triggers behind each other (a matrix workflow's own
  parallel shards live inside ONE run and are never affected by top-level `concurrency:`
  either way — job-level parallelism is orthogonal to workflow-level run dedup)
- does still serialize a UI "re-run" against itself
- documents, rather than leaves silent, the fact that concurrent triggers of this
  workflow are intentional

This is the exact shape already in production on `rebuild-fast.yml`
(`rebuild-fast-${{ github.run_id }}`) and `enrich-reviews.yml`, both documented as
"intentionally parallel" in `docs/workflow-dependency-graph.md`.

**Why not skip these 8 entirely?** A missing `concurrency:` block is indistinguishable
from "nobody has looked at this yet" — the whole point of this audit is that every
review-texts writer has a documented, deliberate stance. The per-run shape gets that
documentation for free without introducing the queuing bug described below.

**The bug a naive shared group would reintroduce:** `rebuild-fast.yml`'s own file
comment documents a real incident (Beaches/Rocky Horror opening night) where a
single shared queue-depth-1 group cancelled 5+ legitimately-parallel queued runs. Any
workflow whose own matrix jobs partition a DISJOINT set of shows/domains per run, or
that self-chains additional rounds via `gh workflow run <self>`, is in the same risk
class — a shared group is fine for *those runs' own internal jobs* (unaffected either
way) but would be wrong to apply to the *idea* of "queue every trigger" if the intent
was ever to run two independent partitioned batches side by side. In practice none of
the 8 below are meant to run two full concurrent invocations on purpose (all are rare
manual/cron triggers, not high-frequency), so the per-run shape is the conservative
"document intent without deviating from current behavior" choice — it changes nothing
about how these workflows behave today, only adds the missing explicit statement.

## Per-workflow verdicts

### Per-run group (8) — matrix-partitioned and/or self-chaining

| Workflow | Why per-run, not shared |
|---|---|
| `bulk-collect-review-texts.yml` | `collect` job matrix-partitions shows into disjoint `SHOW_FILTER` shards (`prepare` job's round-robin split); `rebuild` job self-chains the next round via `gh workflow run bulk-collect-review-texts.yml` with a NEW run_id after checking remaining work. Named explicitly in the card as needing this treatment. |
| `collect-free-reviews.yml` | Same shape as above: `prepare` partitions eligible reviews into disjoint `SHOW_FILTER` shards for the `collect` matrix; `rebuild` job self-chains the next round. Not named in the card's exception list but structurally identical — confirmed via `grep -c matrix:` / self-dispatch audit during implementation. |
| `collect-hard-paywall.yml` | Two parallel paths: `collect-single` (one domain) or `prepare-all`→`collect-all` (matrix over 8 hard-paywall domains, disjoint `DOMAIN_FILTER`); both variants self-chain via `gh workflow run collect-hard-paywall.yml`. |
| `collect-soft-paywall.yml` | Same domain-matrix + self-chain shape as `collect-hard-paywall.yml` (soft-paywall domain list instead of hard). |
| `rescrape-truncated.yml` | `prepare` partitions truncated reviews into disjoint `SHOW_FILTER` shards for the `collect` matrix (parallel_jobs 1-10); self-chains next round. |
| `verify-existing-reviews.yml` | Same partition-matrix + self-chain shape, over reviews needing LLM verification instead of full-text collection. |
| `backfill-aggregators.yml` | `backfill` job matrix-partitions the 730+ show set into `parallel_jobs` shards. One-time/rare manual trigger, no self-chaining, but named in the card alongside `close-coverage-gaps.yml` for "same caution" — internal matrix parallelism a shared group must not queue against itself. |
| `close-coverage-gaps.yml` | `gather-gaps` job matrix-partitions era-filtered gap shows into disjoint batches (round-robin, same pattern as `backfill-aggregators.yml`). Named explicitly in the card. |

### Shared group (14) — single-job or sequential-DAG, no disjoint matrix, no problematic self-chain

| Workflow | Trigger cadence | Notes |
|---|---|---|
| `adjudicate-review-queue.yml` | Daily cron + manual | Already fixed in the BRO-917 session (not part of this card's 22, listed here for completeness). |
| `cleanup-multishow-flags.yml` | Manual only | Single job, no matrix, no self-dispatch. |
| `extract-pull-quotes.yml` | Manual + dispatched by 3 other workflows (`bulk-collect-review-texts.yml`, `llm-ensemble-score.yml`, `rebuild-reviews.yml`) | Self-chains via `chain=true`/`remaining_batches`; the "Chain next run" step is the LAST step of the single `extract` job, so the self-dispatch itself only ever queues briefly behind its own almost-finished run. The residual risk (confirmed by adversarial review, see below) is different: if a targeted manual run (`inputs.show` set) is queued behind an in-progress default "process everything" run, and a THIRD dispatch arrives before the targeted one starts, GitHub cancels the targeted one — not silent data loss, since `scripts/extract-pull-quotes.js` scans every review missing `llmPullQuote` each time it runs, so a cancelled targeted request is simply picked up by the next full pass. A shared group is still the actual fix for the primary bug: 3 independent external callers can dispatch around the same time, and without a group two of those could run concurrently and race on the same review-texts files. |
| `fetch-guardian-reviews.yml` | Weekly cron (Wed 8am UTC) + manual, dispatched by `opening-night-poller.yml` and `opening-night-orchestrator.yml` with different `shows` values | **Per-`shows` group, not plain shared** — see gotcha section above. A plain shared group would risk losing a distinct show's Guardian fetch when a third dispatch cancels a second one's pending run. |
| `overnight-collect.yml` | Manual only | Single job (`collect-batch`), dispatches `rebuild-reviews.yml` (already grouped) but does not self-dispatch. |
| `process-review-submission.yml` | GH issue label + manual | **Per-issue group, not plain shared** — see gotcha section above. A plain shared group would risk silently dropping a submission (a cancelled pending run for a different issue), which is worse than the original no-group state. |
| `recover-wsj-subscriber.yml` | Daily cron (7am UTC) + manual | No matrix, dispatches `rebuild-reviews.yml` only (no self-dispatch). |
| `rediscover-urls.yml` | Weekly cron (Sun 1am UTC) + manual | No matrix, dispatches `collect-review-texts.yml` only (no self-dispatch). |
| `retry-wrong-urls.yml` | Manual only | No matrix, dispatches `Rebuild Reviews Data` only. |
| `review-refresh.yml` | Daily cron (9am UTC, `0 9 * * *`) + manual | No matrix, no self-dispatch. `.github/workflows/CLAUDE.md` previously described this as "Weekly on Mondays" — stale/wrong, corrected in this session (the cron is daily). Doesn't change the group choice, just the accuracy of the record. |
| `scrape-bww-reviews.yml` | Weekly cron (Sun 1pm UTC) + manual | No matrix, no self-dispatch (wraps `gh workflow run` for OTHER workflows in retry logic per its own comment, not itself). |
| `scrape-dtli-show-score.yml` | Weekly cron (Sun 3pm UTC) + manual | 4 jobs but a sequential/fan-in DAG via `needs:` (`discover-dtli-slugs` → `fetch-dtli` + `fetch-show-score` in parallel → `extract-and-rebuild`), not a disjoint-partition matrix — a shared top-level group queues a second full *invocation* behind the first without touching this internal graph. Dispatches `collect-review-texts.yml` (twice, already grouped), not itself. |
| `scrape-nysr.yml` | Weekly cron (Sun 10am UTC) + manual | No matrix, no self-dispatch, no secrets (public API). |
| `scrape-wp-blogs.yml` | Weekly cron (Sun 10:30am UTC) + manual | No matrix, no self-dispatch. |
| `weekly-integrity.yml` | Weekly cron (Sun 3am UTC) + manual | No matrix, no self-dispatch. |

Count check: 8 per-run + 12 plain-shared + 2 per-partition-shared
(`process-review-submission.yml`, `fetch-guardian-reviews.yml`) = 22, matching the
card's Evidence list. (`extract-pull-quotes.yml` is counted among the 12 plain-shared;
its row above explains why a plain shared group is correct there despite also being a
self-chaining workflow.)

## What this doesn't change

No workflow's actual trigger behavior changes for the common case (a single scheduled or
manual run, or a poller/orchestrator dispatch with its own distinct show/issue key).
- **Plain-shared-group workflows** now queue instead of silently double-running if two
  triggers land close together — that IS the fix, and applies to workflows where a
  cancelled pending duplicate is genuinely redundant work.
- **Per-partition-group workflows** (`process-review-submission.yml`,
  `fetch-guardian-reviews.yml`) behave identically to today for the common case
  (different issues/show-sets already ran in true parallel with no group; they still
  do) — only a genuine duplicate of the SAME issue/show-set now serializes instead of
  double-running.
- **Per-run-group workflows** behave identically to today; only a UI "re-run" of the
  same run_id newly serializes against itself, and the group is now documented
  instead of absent.

## Independent review

This audit's group-shape choices were checked with an adversarial Codex review of the
full diff before landing (per CLAUDE.md rule 18, shared-infrastructure changes get a
pre-implementation or pre-merge second opinion). That review is what caught the
`process-review-submission.yml` / `fetch-guardian-reviews.yml` pending-cancellation bug
described above — both were originally drafted with plain shared groups, which would
have been a **regression** (introducing silent data loss that didn't exist before this
card, in the name of "fixing" an unrelated race). It also confirmed: no group-name
collisions with existing workflows; the 8 per-run groups don't introduce a new queuing
bug (matrix jobs within one run are unaffected by workflow-level concurrency either
way, since they're not what the top-level `concurrency:` key discriminates on); and the
`concurrency:` blocks are correctly placed at workflow scope (siblings of `jobs:`), not
misnested under `on:` or a job.
