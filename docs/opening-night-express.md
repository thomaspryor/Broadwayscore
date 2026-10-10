# Opening Night Express — Pipeline & Manual Workarounds Playbook

BRO-860. Companion to `.github/workflows/opening-night-express.yml` (the single-job
collect→score→rebuild→deploy pipeline) and `.github/workflows/opening-night-express-retry-check.yml`
(hourly same-night retry dispatcher, card #1889).

## The problem this replaces

Before Express existed, opening night ran on four independent, cron-triggered workflows
(`gather-reviews.yml`, `collect-review-texts.yml`, `rebuild-reviews.yml`/`rebuild-fast.yml`,
`vercel-deploy.yml`) plus `opening-night-orchestrator.yml`/`opening-night-poller.yml` polling
every ~20 minutes. Each new poller-triggered rebuild cancelled the pending one, and CI rebuilds
check out `review-texts` fresh at startup — so a rebuild that started mid-scoring often ran
against stale text. Result: 30–60+ min from a scored review to a live page, and on bad nights
(Titanique, 2026-04-12) 2.5 hours from first review to the show going live, across multiple
cancelled rebuild cycles.

## Primary path: run Express

```bash
gh workflow run opening-night-express.yml -f show_id=<id> -f market=broadway
```

Express is a single job with its own per-show concurrency group
(`opening-night-express-${{ inputs.show_id }}`) that runs, in strict sequence: cancel competing
orchestrator/poller/scoring runs → pause the orchestrator (time-limited lease) → gather review
URLs → collect review texts → push to the review-texts repo → score (3-model ensemble) → push
scored texts → rebuild `reviews.json` → commit + push core data → dispatch a production deploy →
clear the orchestrator pause. It auto-fires on every real previews→open transition (via
`update-show-status.yml`); manual dispatch is for retries, corrections, or shows the auto-fire
missed. See the workflow file header for `skip_gather`/`skip_collect`/`skip_score`/`dry_run`/
`clear_stale_scores` flags and the same-night retry mechanics.

**Use Express first, always.** The manual workarounds below are a break-glass fallback for when
Express itself is failing (a step errors out, a show needs a fix Express doesn't do, or you need
finer-grained control than its flags give you) — not a parallel workflow to reach for by habit.
Each workaround here predates Express and is the reason a given Express step exists in its current
form; understanding them is what lets you diagnose *why* Express stalled, not just re-run it blindly.

## The 6 manual workarounds

### 1. Cancel competing CI jobs

Express does this automatically as its first two steps (cancel + orchestrator pause lease). Do
this manually only when Express itself isn't running yet and you need to stop the old
poller/orchestrator cycle from cancelling a fix you're about to push:

```bash
for id in $(gh run list --workflow=opening-night-orchestrator.yml --limit=5 \
    --json databaseId,status -q '.[] | select(.status=="in_progress" or .status=="queued") | .databaseId'); do
  gh run cancel "$id"
done
for id in $(gh run list --workflow=opening-night-poller.yml --limit=5 \
    --json databaseId,status -q '.[] | select(.status=="in_progress" or .status=="queued") | .databaseId'); do
  gh run cancel "$id"
done
gh variable set ORCHESTRATOR_PAUSED --body true   # re-enable: gh variable delete ORCHESTRATOR_PAUSED
```

Prefer `gh variable set ORCHESTRATOR_PAUSED --body true` over cancelling jobs repeatedly — it stops
the next cron tick from firing at all, instead of racing each new scheduled run.

### 2. Rebuild — never locally, always via workflow

**`node scripts/rebuild-all-reviews.js` must never be run on this machine.** It hardcodes
`data/review-texts` as its input, which on a local checkout or worktree is either stale (a second
clone that can lag the canonical `broadway-review-texts` repo by hundreds of commits) or, in a
worktree, doesn't exist at all and gets silently created empty. It also has no flag parsing —
`--help` starts a full rebuild — and as a side effect rewrites review-text JSON across the *entire*
catalog (stripping fields like `designation`/`wrongProduction` on files you never touched).
`scripts/gather-reviews.js --shows=X` is not safe either — it auto-chains into the same local
rebuild as its final phase, even scoped to one show.

Rebuild only via workflow:

```bash
gh workflow run rebuild-fast.yml -f reason="opening night — <show>"   # ~2 min, opening-night default
# or, if you need the full pre-rebuild flag/backfill pipeline:
gh workflow run "Rebuild Reviews Data" -f reason="..."                 # ~13-15 min
```

Then wait on it properly — `scripts/lib/wait-for-run.sh <run-id>`, never `gh run watch` (3s
polling burns API quota fast). Use `rebuild-fast.yml` for opening-night corrections; the full
rebuild costs ~13 extra minutes per attempt during a live wave for pre-rebuild steps
(classification, backfill) that rarely matter on opening night itself.

### 3. Score locally only as a last resort, and only via the real script

Express's "Score reviews" step already runs the 3-model ensemble scoped to the show
(`npx ts-node scripts/llm-scoring/index.ts --show=<id> --unscored-only --limit=30`). If that step
failed or you're diagnosing outside Express:

```bash
source .env
npx ts-node scripts/llm-scoring/index.ts --show=<id> --unscored-only --limit=20
```

Rules:
- **`humanReviewScore` is the only score field the rebuild treats as an override.** `assignedScore`
  is always recalculated from `llmScore`/`humanReviewScore` — setting it directly does nothing.
- Score resolution prefers `llmScore.score` over `humanReviewScore` when both exist unless
  `humanReviewScoreProvisional` is explicitly `false`. To force a human override, set
  `humanReviewScore`, `llmScore.score`, and `assignedScore` to the same value.
- Don't push to the review-texts repo while a CI scoring run is in flight — `push-review-texts`
  does `git pull --rebase`, which can drop a locally-written score that lands mid-rebase.
- Flag any manually-scored file `needsRescore: true` and re-run scoring for the show rather than
  waiting for the next daily ensemble pass.

### 4. Collect text locally only when CI collection is actually broken

Express's "Collect review texts" step covers the normal case
(`node scripts/collect-review-texts.js --aggressive --max-reviews=50`). Reach for a local run only
when CI collection is failing for a specific outlet/show and you need to iterate faster than a full
Express re-run:

```bash
# Clear a stale blocker first if one is set (incompleteReason / wrongProduction on the wrong file)
node -e "
  const fs = require('fs');
  const f = '<path to the review-text json>';
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete d.incompleteReason; delete d.wrongProduction;
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
"
source .env
SHOW_FILTER=<show-id> MAX_REVIEWS=5 node scripts/collect-review-texts.js --aggressive
```

Never `rm` a wrong-production/wrong-show file to force re-collection — the poller recreates it next
cycle from the same source. Mark it `wrongProduction: true` (or `duplicateOf`) instead; the merge
logic preserves those flags across re-ingestion.

### 5. `humanReviewScore` for instant corrections

The single fastest fix for a wrong score on a live show. Set it directly on the review-text file
(never on the derived `reviews.json`):

```bash
node -e "
  const fs = require('fs');
  const f = '<path to the review-text json>';
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.humanReviewScore = 70;
  d.humanReviewScoreProvisional = false;
  d.humanReviewNote = 'reason for override';
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
"
```

Before touching scores on opening night: pause the orchestrator first
(`gh variable set ORCHESTRATOR_PAUSED --body true`), audit every affected review file and compile
all corrections, then make them in one commit — iterative fix→push→rebuild cycles compound at
~15-25 min per cycle. For multiple corrections on one show, `batch-correct-reviews.js
--show=<id> --corrections='outlet:score,outlet:score'` auto-commits, pushes, and triggers a
rebuild in one step. Verify against the live JSON (`curl broadwayscorecard.com/data/shows/<id>.json`),
not local files, which are frequently stale.

### 6. Push order: review-texts repo first, always

CI rebuild reads from `broadway-review-texts` HEAD. If you push the public repo or trigger a
rebuild before your review-text changes land in the private repo, the rebuild runs without them
and you have to repeat the cycle. Order:

1. Push to `thomaspryor/broadway-review-texts` (private) first.
2. Trigger/wait for the rebuild.
3. Push core data (`broadway-scorecard-data`) if anything needs a direct write there.
4. Deploy — and confirm the rebuild's commit SHA is actually on `origin/main` of the data repo
   (`git fetch origin main`) *before* dispatching `vercel-deploy.yml`. Dispatching deploy before
   the rebuild commit lands ships stale data that looks like a successful deploy.

Never recover a rejected push with `git reset --hard origin/main && rsync` — it wipes any
CI-added fields (`llmScore`, `ensembleData`, `pullQuote`, etc.) that landed between your pulls, not
just your own conflicting lines. Use the canonical safe-sync helper instead:

```bash
bash scripts/lib/safe-sync-review-texts.sh ~/broadway-review-texts
bash scripts/lib/safe-sync-review-texts.sh ~/broadway-scorecard-data
```

It rebases with `-X theirs`, then runs `scripts/lib/restore-protected-fields.js` against
`origin/main` to restore anything the rebase strategy dropped, then pushes — refusing to proceed on
an unresolvable conflict rather than forcing one side to win. `push-with-retry.sh` and the
`push-review-texts`/`push-core-data` composite actions already call the equivalent restore step
after every rebase; do the same for any new manual push path you add. The field list that this
restore step protects (`humanReviewScore`, `manualContentTier`, `wrongProductionManualClear`, …)
must stay in sync across three files — `scripts/lib/review-write-guard.js` (`PROTECTED_FIELDS`),
`.github/actions/push-review-texts/action.yml` (inline `PROTECTED` array), and
`scripts/lib/restore-protected-fields.js` (`MANUAL_FIELDS`) — a field present in only one or two of
the three is silently dropped by CI. `tests/unit/protected-fields-sync.test.mjs` and
`tests/unit/protected-fields-three-way-sync.test.mjs` guard both drift directions.

## Verification (mandatory after any manual intervention)

```bash
node scripts/verify-review-recovery.js --show=<id> --production
```

Checks the pipeline's independent silent-failure points (conflict markers, scoring cancellation,
rebuild timing, stale deploy) and prints the exact fix command for whatever it finds broken. Follow
with a direct check of the live page:

```bash
curl -sL https://broadwayscorecard.com/show/<slug> | grep -i "<critic name>"
```

Deploy-lag and stale-cache issues are silent otherwise — a workflow reporting green does not mean
the fix is visible on the live site.

## Failure path

If Express itself fails mid-run, its `Notify on failure` step already states the fallback inline:
cancel orchestrator → local rebuild via workflow (never `rebuild-all-reviews.js` directly) → push
data repo → `gh workflow run vercel-deploy.yml`. Work through workarounds 1–6 above in order; they
map directly onto Express's own step sequence (cancel → collect → score → rebuild → push order →
deploy), so whichever Express step errored tells you which workaround section to start from.
