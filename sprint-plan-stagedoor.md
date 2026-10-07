# Sprint Plan: Stagedoor WE Critic Review Scraper

## Overview
Build a Playwright-based scraper for Stagedoor.com, the only structured multi-outlet WE critic review aggregator. Extracts per-critic star ratings (1-5) from 10-15 UK outlets per show, integrates into the existing review pipeline via `extract-stagedoor-reviews.js`. Validated by `/gut-check` (A+B approach) and `/war-room` (3 reviewers).

## Sprint Summary
| Sprint | Goal | Tasks | Complexity |
|--------|------|-------|------------|
| 1 | Scraper extracts data for 5 shows locally | 5 | 3S, 2M |
| 2 | Extraction creates valid review files | 4 | 2S, 2M |
| 3 | Full backfill + CI automation | 3 | 1S, 2M |

## Sprint 1: Working Scraper (Local, 5 Shows)
**Demo:** Run scraper locally on 5 WE shows, see per-critic star ratings + excerpts saved as JSON archives
**Risks:** Cloudflare blocks headless Playwright in CI (works locally). HTML selectors change between shows.

### Task S1-T1: Validate Stagedoor HTML selectors via Playwright MCP
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** None (exploratory — document findings in script comments)
- **Description:** Use Playwright MCP to visit Hamilton AND Hadestown critic-reviews pages. Document exact selectors for: outlet name element, star rating aria label pattern, excerpt text element. Confirm they work on both pages (different review counts). This prevents building against wrong assumptions.
- **Acceptance criteria:**
  - VERIFY: Can extract outlet name, star count (1-5), and excerpt from Hamilton page
  - VERIFY: Same selectors work on Hadestown (14 reviews vs Hamilton's 5)
  - VERIFY: Documented in comments at top of scraper script (Step S1-T3)

### Task S1-T2: Add `stagedoorExcerpt` handling to rebuild-all-reviews.js
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes (can be done while S1-T1 runs)
- **Files:** `scripts/rebuild-all-reviews.js` (modify)
- **Description:** Add `stagedoorExcerpt` to the excerpt selection chain in rebuild, after `nycTheatreExcerpt` and before fullText fallback. Follow exact pattern of `dtliExcerpt` handling. Also add to `hasExcerpt` checks.
- **Acceptance criteria:**
  - VERIFY: `grep -n 'stagedoorExcerpt' scripts/rebuild-all-reviews.js` returns 3+ lines (selection, hasExcerpt check, field preservation)
  - VERIFY: `node -c scripts/rebuild-all-reviews.js` passes (no syntax errors)

### Task S1-T3: Build scraper — single-pass discover + extract
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** `scripts/scrape-stagedoor-critics.js` (new)
- **Description:** Playwright script that: (1) visits category listing pages to discover shows, (2) matches to our shows.json via `matchTitleToShow({ market: 'west-end' })`, (3) visits each show's /critic-reviews page, (4) extracts outlet + stars + excerpt, (5) saves to `data/aggregator-archive/stagedoor/{show-id}.json`. Health gate: abort if total reviews < 50% of previous run. CLI: `--show=ID`, `--dry-run`, `--limit=N`. Rate limit 3s. Checkpoint after each show.
- **Acceptance criteria:**
  - VERIFY: `node scripts/scrape-stagedoor-critics.js --limit=5 --dry-run` completes without error
  - VERIFY: Output logs show 5 shows discovered + matched + critic reviews extracted

### Task S1-T4: Run scraper on 5 shows (non-dry-run), inspect output
- **Complexity:** S
- **Depends on:** S1-T3
- **Parallel:** No
- **Files:** `data/aggregator-archive/stagedoor/` (new, 5 JSON files)
- **Description:** Run `--limit=5` without dry-run. Inspect the 5 archive files. Verify star ratings match Stagedoor website manually. Review the match results log — confirm no cross-market contamination (WE shows matched to Broadway). This is the human sign-off step flagged by /war-room pre-mortem.
- **Acceptance criteria:**
  - VERIFY: 5 files in `data/aggregator-archive/stagedoor/`
  - VERIFY: Hamilton archive has 5+ critic reviews with stars 1-5
  - VERIFY: Hadestown archive has 10+ critic reviews
  - VERIFY: No Broadway show IDs in the output files

### Task S1-T5: Commit scraper + 5-show archives
- **Complexity:** S
- **Depends on:** S1-T4
- **Parallel:** No
- **Files:** `scripts/scrape-stagedoor-critics.js`, `data/aggregator-archive/stagedoor/*.json` (5 files)
- **Description:** Commit the scraper script and the 5 verified archive files. Push to main.
- **Acceptance criteria:**
  - VERIFY: `git status` shows only expected files
  - VERIFY: Push succeeds

---

## Sprint 2: Extraction Pipeline (Review Files)
**Demo:** Run extraction on Stagedoor archives → review files appear in `data/review-texts/` → rebuild includes them in reviews.json
**Risks:** Outlet name normalization mismatches. Duplicate files from same outlet via different aggregator.

### Task S2-T1: Build extraction script following DTLI pattern
- **Complexity:** M
- **Depends on:** S1-T5, S1-T2
- **Parallel:** No
- **Files:** `scripts/extract-stagedoor-reviews.js` (new)
- **Description:** Read each `data/aggregator-archive/stagedoor/{show-id}.json`. For each critic review: `normalizeOutletFull()` for outlet, `generateReviewFilename()` for filename, `findExistingReviewFile()` to check for existing. Set `stagedoorExcerpt`, `originalScore: "N/5 stars"`, `source: 'stagedoor'`. Merge pattern: preserve existing non-Stagedoor fields. Never overwrite with strictly less data.
- **Acceptance criteria:**
  - VERIFY: `node scripts/extract-stagedoor-reviews.js` creates review files in `data/review-texts/hamilton-west-end-2021/`
  - VERIFY: Filenames use `generateReviewFilename()` format (e.g., `telegraph--*.json`)
  - VERIFY: Files contain `stagedoorExcerpt` field and `originalScore: "N/5 stars"`

### Task S2-T2: Run rebuild and verify Stagedoor reviews appear
- **Complexity:** S
- **Depends on:** S2-T1
- **Parallel:** No
- **Files:** None (verification only)
- **Description:** Run `node scripts/rebuild-all-reviews.js` locally. Check reviews.json for WE shows — Stagedoor-sourced reviews should appear with `originalScore` populated.
- **Acceptance criteria:**
  - VERIFY: `grep 'stagedoor' data/reviews.json | head -5` returns results
  - VERIFY: Hamilton WE has reviews from Telegraph, Guardian, Time Out (Stagedoor outlets)

### Task S2-T3: Test outlet dedup — verify no duplicates
- **Complexity:** M
- **Depends on:** S2-T2
- **Parallel:** No
- **Files:** None (verification only)
- **Description:** Check that outlets appearing in BOTH Stagedoor AND other aggregators (e.g., Guardian via DTLI + Guardian via Stagedoor) produce a single merged file, not two files. Run `validate-data.js` and check for duplicate warnings.
- **Acceptance criteria:**
  - VERIFY: `ls data/review-texts/hadestown-west-end-2024/ | grep guardian` returns exactly 1 file (not 2)
  - VERIFY: That file contains BOTH `dtliExcerpt` (if DTLI had it) AND `stagedoorExcerpt`
  - VERIFY: `node scripts/validate-data.js 2>&1 | grep -i duplicate` shows no new duplicates

### Task S2-T4: Commit extraction script + sync review-texts
- **Complexity:** S
- **Depends on:** S2-T3
- **Parallel:** No
- **Files:** `scripts/extract-stagedoor-reviews.js`, review-text files
- **Description:** Commit extraction script. Run `bash scripts/sync-review-texts.sh` to push review files to private repo. Push main.
- **Acceptance criteria:**
  - VERIFY: Both pushes succeed

---

## Sprint 3: Full Backfill + CI Automation
**Demo:** All ~70+ WE shows have Stagedoor critic data. Weekly cron keeps it fresh.
**Risks:** Full run takes longer than expected (100+ page loads). Cloudflare rate-limits.

### Task S3-T1: Run full scraper locally (all WE shows)
- **Complexity:** M
- **Depends on:** S2-T4
- **Parallel:** No
- **Files:** `data/aggregator-archive/stagedoor/` (40-70 new files)
- **Description:** Run scraper without `--limit`. Expect 70-100 shows discovered, 40-70 matched. Extract critic reviews for all. Run extraction script. Run rebuild. Inspect results. Commit all archives + review files. This is the one-time backfill.
- **Acceptance criteria:**
  - VERIFY: 40+ archive files in `data/aggregator-archive/stagedoor/`
  - VERIFY: Rebuild completes without errors
  - VERIFY: WE shows in reviews.json have Stagedoor critic data
  - VERIFY: Health gate comparison works (store initial counts for future runs)

### Task S3-T2: Create CI workflow
- **Complexity:** M
- **Depends on:** S3-T1
- **Parallel:** No
- **Files:** `.github/workflows/scrape-stagedoor.yml` (new)
- **Description:** Weekly cron Monday 6 AM UTC. Steps: checkout → checkout-review-texts → setup node → `npx playwright install chromium --with-deps` → run scraper → run extraction → commit archives + review-texts with `if: always()` → push via push-review-texts action → push archives via push-core-data → trigger rebuild → notify-failure. Concurrency: `stagedoor-scrape`. Inputs: show, dry_run.
- **Acceptance criteria:**
  - VERIFY: `actionlint .github/workflows/scrape-stagedoor.yml` passes
  - VERIFY: Workflow dispatch succeeds (manual trigger, `--dry-run`)

### Task S3-T3: Commit workflow + update roadmap
- **Complexity:** S
- **Depends on:** S3-T2
- **Parallel:** No
- **Files:** `.github/workflows/scrape-stagedoor.yml`, roadmap
- **Description:** Commit workflow. Mark roadmap item #33 as done. Post session summary.
- **Acceptance criteria:**
  - VERIFY: Push succeeds
  - VERIFY: Roadmap item #33 marked done

---

## Dependencies Graph
```
S1-T1 (validate selectors) ──→ S1-T3 (build scraper) ──→ S1-T4 (test 5 shows) ──→ S1-T5 (commit)
S1-T2 (rebuild excerpt)    ──────────────────────────────────────────────────────→ S2-T1 (extraction)
                                                                                    ↓
                                                                              S2-T2 (rebuild test)
                                                                                    ↓
                                                                              S2-T3 (dedup test)
                                                                                    ↓
                                                                              S2-T4 (commit)
                                                                                    ↓
                                                                              S3-T1 (full backfill)
                                                                                    ↓
                                                                              S3-T2 (CI workflow)
                                                                                    ↓
                                                                              S3-T3 (commit + roadmap)
```

## Parallel Execution Map
```
Track 1:  S1-T1 → S1-T3 → S1-T4 → S1-T5 → S2-T1 → S2-T2 → S2-T3 → S2-T4 → S3-T1 → S3-T2 → S3-T3
Track 2:  S1-T2 ─────────────────────────↗ (merges at S2-T1)
```

**Parallel sprints:** S1-T1 and S1-T2 can run simultaneously (selector validation + rebuild excerpt handling).
**Critical path:** S1-T1 → S1-T3 → S1-T4 → S1-T5 → S2-T1 → S2-T2 → S2-T3 → S2-T4 → S3-T1 → S3-T2 → S3-T3
**Max parallelism:** 2 (only during Sprint 1 start)

## Known Edge Cases
- Stagedoor outlet names may not match outlet-registry.json (e.g., "The Telegraph" vs "Daily Telegraph") — `normalizeOutlet` handles this, but new UK outlets may need registry entries
- Some shows have 0 critic reviews on Stagedoor — scraper skips gracefully
- Stagedoor has duplicate entries for some outlets (e.g., "Broadway World" appears twice for Hadestown) — `findExistingReviewFile` handles dedup
- Stagedoor categories include non-WE content (opera, dance, immersive) — `matchTitleToShow` with market hint filters correctly
- Cloudflare may tighten headless detection — BrowserBase fallback exists in CI

## Changes from /war-room Critique
| Change | Reason | Source |
|--------|--------|--------|
| Drop `stagedoor-shows.json` — discover + scrape in one pass | No other aggregator maintains separate URL map | Production reviewer |
| Drop `--discover-only` CLI flag | YAGNI | Production reviewer |
| Use `normalizeOutlet` + `generateReviewFilename` + `findExistingReviewFile` | Prevents duplicate review files | Structure reviewer (P0) |
| Add health gate (abort if reviews < 50% of previous) | Prevents silent data corruption on HTML change | Pre-mortem |
| Never overwrite existing with strictly less data | Prevents score regression | Pre-mortem |
| Use `stagedoorExcerpt` field (not generic `excerpts`) | Matches dtliExcerpt/bwwExcerpt pattern | Structure reviewer |
| Initial backfill runs locally with human inspection | Need to verify match results before pipeline | Production + PreMortem |
| Workflow commit step needs `if: always()` | CLAUDE.md §7 violation | Production reviewer |
| Use `.github/actions/push-review-texts` composite action | Inline push misses retry logic | Structure reviewer |
| Install Playwright with `--with-deps` | Fails on fresh Ubuntu runners without system libs | Structure reviewer |
| Don't extract audience rating | Nothing consumes it — dead data | Production reviewer |
| Budget 8-10 hours (was 6) | Selector debugging for unfamiliar site | Production reviewer |

## Key Risks
1. **Cloudflare blocks Playwright** — Works today, could break. Mitigation: BrowserBase fallback, monitor CI run success rate.
2. **Stagedoor HTML structure changes** — Health gate catches it (abort if reviews < 50% of previous). Notify on failure alerts the user.
3. **Outlet name mismatches** — New UK outlets not in registry. Mitigation: `normalizeOutlet` handles aliases, log unknown outlets for manual addition.
