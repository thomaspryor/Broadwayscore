# Clean Review Data Collection - Sprint Plan

**Project Goal:** Get accurate, comprehensive, trustworthy review data from all aggregators with built-in sanity checks.

**Key Insight from Critique:** The original plan's "aggregator truth" concept is flawed - aggregator counts themselves are unreliable and vary. Instead, we should:
1. Use existing archives where possible (avoid re-scraping)
2. Unify the THREE different outlet normalization systems FIRST
3. Preserve existing valuable data (LLM scores, fullText)
4. Work incrementally rather than "fresh pull everything"

---

## Sprint 0: Foundation & Normalization Unification
**Goal:** Fix the root cause of duplicates - inconsistent outlet normalization across scripts.

**Demo:** Run a test showing that all 3 extraction scripts produce identical outlet IDs for the same outlets.

### Task 0.1: Audit Normalization Inconsistencies
**Description:** Document all outlet ID differences between the three normalization systems.
**Files:**
- `scripts/lib/review-normalization.js` (canonical)
- `scripts/extract-bww-reviews.js` (has own OUTLET_MAP at lines 14-68)
- `scripts/extract-dtli-reviews.js` (has own outlet mapping)
- `scripts/extract-show-score-reviews.js` (check for any normalization)

**Acceptance Criteria:**
- [ ] Create `data/audit/` directory if not exists
- [ ] Create `data/audit/normalization-diff.json` listing all inconsistencies
- [ ] Count outlets in BWW/DTLI not in canonical OUTLET_ALIASES
- [ ] Count outlets mapping to different IDs (e.g., `timeout-ny` vs `timeout`)
- [ ] Known conflicts to find: `timeout-ny` vs `timeout`, `ny-daily-news` vs `nydailynews`, `daily-beast` vs `dailybeast`

**Output format:**
```json
{
  "summary": { "totalConflicts": 5, "missingAliases": 12 },
  "conflicts": [
    { "outlet": "Time Out New York", "bww": "timeout-ny", "canonical": "timeout" }
  ],
  "missingFromCanonical": ["dc-theatre-scene", "nbc-ny"]
}
```

**Validation:**
```bash
node scripts/audit-normalization.js && cat data/audit/normalization-diff.json | jq '.summary'
# Should show counts of conflicts and missing aliases
```

### Task 0.2: Add Missing Outlet Aliases (DO THIS BEFORE 0.3)
**Description:** Add any outlet variations found during audit to OUTLET_ALIASES in `review-normalization.js`.

**Acceptance Criteria:**
- [ ] All variations from BWW's `outletNormalization` added to canonical OUTLET_ALIASES
- [ ] All variations from DTLI added to canonical OUTLET_ALIASES
- [ ] Resolve conflicts: `timeout-ny` → add as alias for `timeout`, etc.
- [ ] Add missing outlets: `dc-theatre-scene`, `nbc-ny`, `nj-com`, etc.

**Validation:**
```bash
node -e "
const n = require('./scripts/lib/review-normalization');
const tests = [
  ['Time Out New York', 'timeout'],
  ['timeout-ny', 'timeout'],
  ['New York Daily News', 'nydailynews'],
  ['ny-daily-news', 'nydailynews'],
  ['Daily Beast', 'dailybeast'],
  ['daily-beast', 'dailybeast'],
];
let pass = true;
for (const [input, expected] of tests) {
  const result = n.normalizeOutlet(input);
  if (result !== expected) {
    console.log('FAIL:', input, '→', result, '(expected', expected + ')');
    pass = false;
  }
}
if (pass) console.log('All alias tests passed');
process.exit(pass ? 0 : 1);
"
```

### Task 0.3: Unify Extraction Scripts
**Description:** Modify `extract-bww-reviews.js` and `extract-dtli-reviews.js` to import and use `normalizeOutlet()` from `review-normalization.js` instead of their own mappings.

**Acceptance Criteria:**
- [ ] BWW extraction imports `normalizeOutlet` from `review-normalization.js`
- [ ] BWW extraction removes its own `outletNormalization` object
- [ ] DTLI extraction imports from `review-normalization.js` (if it exists)
- [ ] Show Score extraction verified to use canonical (or updated)
- [ ] All critic names use `normalizeCritic()` or `slugify()` from canonical module

**Validation:**
```bash
# Verify no local outletNormalization objects remain
grep -r "outletNormalization\s*=" scripts/extract-*.js && echo "FAIL: Found local normalization" && exit 1
echo "PASS: No local normalization objects"

# Verify imports are correct
grep -l "require.*review-normalization" scripts/extract-bww-reviews.js && echo "BWW imports canonical"
```

### Task 0.4: Create Normalization Unit Tests
**Description:** Add unit tests for outlet and critic normalization.

**Files:** `tests/unit/review-normalization.test.js`

**Acceptance Criteria:**
- [ ] Test all canonical outlet IDs return themselves
- [ ] Test all known aliases map correctly
- [ ] Test critic name variations and typos
- [ ] Test edge cases (null, empty, unknown outlets)

**Validation:**
```bash
npm run test:unit -- review-normalization
# All tests pass
```

---

## Sprint 1: Baseline Assessment
**Goal:** Know exactly what we have vs what aggregators report, using existing archives.

**Demo:** Generate a report showing per-show: our count, Show Score count, DTLI count, BWW count, with flags.

### Task 1.1: Create Archive Inventory Script
**Description:** Inventory what aggregator archives we have and their freshness.

**Output:** `data/audit/archive-inventory.json`

**Acceptance Criteria:**
- [ ] List all shows with/without archives for each aggregator
- [ ] Include archive file date (from filesystem or embedded timestamp)
- [ ] Flag archives older than 90 days
- [ ] Summary: X shows with all 3, Y with 2, Z with 1, W with none

**Validation:**
```bash
node scripts/inventory-archives.js
cat data/audit/archive-inventory.json | jq '.summary'
# Should show counts per aggregator
```

### Task 1.2: Extract Counts from Existing Archives
**Description:** Parse existing HTML archives to get review counts WITHOUT re-scraping.

**Output:** `data/audit/aggregator-counts.json`

**Acceptance Criteria:**
- [ ] For each show with archives, extract review count
- [ ] Show Score: Parse from JSON-LD or visible count
- [ ] DTLI: Parse thumb count from image filename or DOM
- [ ] BWW: Count BlogPosting entries or articleBody reviews
- [ ] Record extraction method and confidence

**Validation:**
```bash
node scripts/extract-aggregator-counts.js
# Compare a few manually: pick 3 shows, manually check archive HTML, verify counts match
```

### Task 1.3: Count Local Review Files
**Description:** Count review files per show in `data/review-texts/`.

**Output:** Adds `localCount` to `data/audit/aggregator-counts.json`

**Acceptance Criteria:**
- [ ] Count `.json` files per show directory (excluding failed-fetches.json)
- [ ] Flag shows where local > max(aggregator counts) * 1.3 (likely duplicates)
- [ ] Flag shows where local < max(aggregator counts) * 0.8 (likely missing)

**Validation:**
```bash
node scripts/count-local-reviews.js
cat data/audit/aggregator-counts.json | jq '[.shows[] | select(.flags | length > 0)]'
# List of flagged shows
```

### Task 1.4: Generate Baseline Assessment Report
**Description:** Create human-readable report comparing local vs aggregator counts.

**Output:** `data/audit/baseline-assessment.md`

**Acceptance Criteria:**
- [ ] Table: Show | Local | SS | DTLI | BWW | Max Agg | Status
- [ ] Color-coded: Green (within range), Yellow (slight discrepancy), Red (major issue)
- [ ] Summary statistics at top
- [ ] List of shows needing attention (sorted by severity)

**Validation:**
```bash
node scripts/generate-baseline-report.js
cat data/audit/baseline-assessment.md
# Human-readable report with actionable items
```

---

## Sprint 2: Duplicate Cleanup
**Goal:** Eliminate existing duplicate review files using the now-unified normalization.

**Demo:** Run cleanup script, show reduction in total review files while preserving all unique data.

### Task 2.1: Dry-Run Duplicate Detection
**Description:** Run existing `cleanup-duplicate-reviews.js` with `--dry-run` to identify duplicates.

**Output:** `data/audit/duplicates-found.json`

**Acceptance Criteria:**
- [ ] List all duplicate file pairs/groups
- [ ] For each group: which file to keep, which to merge
- [ ] Total count of duplicates found
- [ ] No false positives (manually verify 5 random groups)

**Validation:**
```bash
node scripts/cleanup-duplicate-reviews.js --dry-run
cat data/audit/duplicates-found.json | jq '.summary'
# Review 5 random groups manually
```

### Task 2.2: Preserve LLM Scores Before Cleanup
**Description:** Create backup mapping of all LLM scores indexed by normalized review key.

**Output:** `data/audit/llm-scores-backup.json`

**Acceptance Criteria:**
- [ ] Map: `{showId}|{outletId}|{criticSlug}` → `{ llmScore, bucket, confidence }`
- [ ] Count: X reviews with LLM scores preserved
- [ ] Verify no data loss: count before/after should match

**Validation:**
```bash
node scripts/backup-llm-scores.js
node -e "const d = require('./data/audit/llm-scores-backup.json'); console.log(Object.keys(d).length, 'scores backed up')"
# Should be ~1900+ scores
```

### Task 2.3: Execute Duplicate Cleanup
**Description:** Run cleanup script to merge duplicates, preserving best data from each.

**Acceptance Criteria:**
- [ ] All duplicate files merged into single canonical file
- [ ] Merged file has: longest fullText, all excerpts, best URL, preserved LLM score
- [ ] Duplicate files removed
- [ ] Git commit with clear message

**Validation:**
```bash
node scripts/cleanup-duplicate-reviews.js
git diff --stat data/review-texts/
# Should show file deletions and modifications
node scripts/count-local-reviews.js
# Count should decrease but unique reviews preserved
```

### Task 2.4: Verify No Data Loss
**Description:** Verify LLM scores and fullText preserved after cleanup.

**Acceptance Criteria:**
- [ ] Compare LLM score count before/after
- [ ] Compare fullText count before/after
- [ ] No review lost (all unique outlet+critic combinations preserved)

**Validation:**
```bash
node scripts/verify-cleanup-integrity.js
# Should report: X LLM scores preserved (100%), Y fullText preserved (100%)
```

---

## Sprint 3: Incremental Review Addition
**Goal:** Add missing reviews from aggregators without losing existing data.

**Demo:** For a test show, add missing reviews from archives, show count increase with proper dedup.

### Task 3.1: Build Incremental Extraction Script
**Description:** Create script that extracts reviews from archives and adds ONLY missing ones.

**Files:** `scripts/extract-missing-reviews.js`

**Acceptance Criteria:**
- [ ] For each show, load existing review keys
- [ ] Extract from all available archives (SS, DTLI, BWW)
- [ ] Use unified normalization for matching
- [ ] Only create new files for reviews not already present
- [ ] Merge data if review exists but archive has more info (excerpts, thumbs)

**Validation:**
```bash
# Test on one show first
node scripts/extract-missing-reviews.js --show=hadestown-2019 --dry-run
# Should list: X existing, Y from archives, Z to add, W to merge
```

### Task 3.2: Test on 5 Flagged Shows
**Description:** Run incremental extraction on 5 shows flagged in baseline assessment.

**Acceptance Criteria:**
- [ ] Pick 5 shows with local < aggregator counts
- [ ] Run extraction, verify new reviews added
- [ ] Verify no duplicates created
- [ ] Local count now within expected range

**Validation:**
```bash
node scripts/extract-missing-reviews.js --shows=show1,show2,show3,show4,show5
node scripts/count-local-reviews.js --shows=show1,show2,show3,show4,show5
# All 5 shows should now be within expected range
```

### Task 3.3: Process All Flagged Shows
**Description:** Run incremental extraction on all shows with missing reviews.

**Acceptance Criteria:**
- [ ] Process all shows where local < max(aggregator) * 0.9
- [ ] Commit in batches of 10 shows
- [ ] Track progress in `data/audit/extraction-progress.json`

**Validation:**
```bash
node scripts/extract-missing-reviews.js --flagged-only
git log --oneline -10
# Should see incremental commits
```

### Task 3.4: Re-run Baseline Assessment
**Description:** Generate new baseline report to verify improvements.

**Acceptance Criteria:**
- [ ] Fewer shows flagged as missing reviews
- [ ] No shows flagged as having duplicates
- [ ] Overall coverage improved

**Validation:**
```bash
node scripts/generate-baseline-report.js
diff data/audit/baseline-assessment-v1.md data/audit/baseline-assessment.md
# Should show improvements
```

---

## Sprint 4: Fresh Archives for Stale Data
**Goal:** Update aggregator archives older than 90 days, then extract new reviews.

**Demo:** Show that stale archives are refreshed and new reviews discovered.

### Task 4.1: Identify Stale Archives
**Description:** List shows with archives older than 90 days or no archives at all.

**Output:** `data/audit/stale-archives.json`

**Acceptance Criteria:**
- [ ] List shows needing fresh Show Score scrape
- [ ] List shows needing fresh DTLI scrape
- [ ] List shows needing fresh BWW scrape
- [ ] Priority order: open shows first, then recently closed

**Validation:**
```bash
node scripts/identify-stale-archives.js
cat data/audit/stale-archives.json | jq '.showScore | length'
# Count of shows needing Show Score refresh
```

### Task 4.2: Create Archive Refresh Workflow
**Description:** GitHub Action to refresh stale archives in batches.

**Files:** `.github/workflows/refresh-stale-archives.yml`

**Acceptance Criteria:**
- [ ] Processes 10 shows per run (rate limiting)
- [ ] Uses existing `fetch-aggregator-pages.ts` script
- [ ] Commits after each show (parallel-safe)
- [ ] Triggers `extract-missing-reviews` after completion

**Validation:**
```bash
gh workflow run "Refresh Stale Archives" --field limit=2 --field dry_run=true
# Check workflow run log for expected behavior
```

### Task 4.3: Execute Archive Refresh
**Description:** Run archive refresh workflow until all stale archives updated.

**Acceptance Criteria:**
- [ ] All open shows have archives < 30 days old
- [ ] All closed shows have archives < 90 days old
- [ ] No scraping failures (or failures logged)

**Validation:**
```bash
node scripts/inventory-archives.js
cat data/audit/archive-inventory.json | jq '[.shows[] | select(.stale)] | length'
# Should be 0 or very low
```

### Task 4.4: Extract from Fresh Archives
**Description:** Run incremental extraction on all shows with newly refreshed archives.

**Acceptance Criteria:**
- [ ] New reviews discovered and added
- [ ] Baseline assessment shows improvement
- [ ] All shows within expected count range

**Validation:**
```bash
node scripts/extract-missing-reviews.js --recently-refreshed
node scripts/generate-baseline-report.js
# Check for improvements
```

---

## Sprint 5: Validation & CI Integration
**Goal:** Add ongoing validation to prevent future data drift.

**Demo:** CI fails when a PR introduces duplicate reviews or count anomalies.

### Task 5.1: Add Aggregator Count Validation to CI
**Description:** Extend `validate-data.js` to check review counts against expected ranges.

**Acceptance Criteria:**
- [ ] Load `aggregator-counts.json` as reference
- [ ] Error if any show has reviews > maxAggregator * 1.5
- [ ] Warn if any show has reviews < maxAggregator * 0.8
- [ ] Run as part of `npm run test:data`

**Validation:**
```bash
npm run test:data
# Should pass with current data
# Manually add a duplicate, re-run, should fail
```

### Task 5.2: Add Duplicate Detection to CI
**Description:** Run duplicate check on every PR.

**Acceptance Criteria:**
- [ ] Detect if new review file duplicates existing
- [ ] Block PR if duplicate detected
- [ ] Provide clear error message with resolution steps

**Validation:**
```bash
# Create a duplicate file manually
cp data/review-texts/hamilton-2015/nytimes--ben-brantley.json data/review-texts/hamilton-2015/nyt--ben-brantley.json
npm run test:data
# Should fail with duplicate error
rm data/review-texts/hamilton-2015/nyt--ben-brantley.json
```

### Task 5.3: Create Weekly Aggregator Sync Workflow
**Description:** Weekly workflow to check if aggregator counts have increased.

**Files:** `.github/workflows/weekly-aggregator-sync.yml`

**Acceptance Criteria:**
- [ ] Scrapes counts from all 3 aggregators for open shows
- [ ] Compares to previous week's counts
- [ ] Creates GitHub issue if significant new reviews detected
- [ ] Triggers review collection for shows with new reviews

**Validation:**
```bash
gh workflow run "Weekly Aggregator Sync" --field dry_run=true
# Check output for expected behavior
```

### Task 5.4: Add Rollback Safety
**Description:** Create tagged backup before any bulk data operations.

**Acceptance Criteria:**
- [ ] Pre-migration script creates git tag `data-backup-YYYY-MM-DD`
- [ ] Document rollback procedure in CLAUDE.md
- [ ] Test rollback on a test branch

**Validation:**
```bash
node scripts/create-data-backup-tag.js
git tag -l 'data-backup-*'
# Should show backup tag
```

---

## Sprint 6: Rebuild reviews.json
**Goal:** Rebuild the main reviews.json from clean review-texts data.

**Demo:** Site displays accurate review counts and scores for all shows.

### Task 6.1: Rebuild reviews.json
**Description:** Run rebuild script to regenerate reviews.json from review-texts.

**Acceptance Criteria:**
- [ ] All review-texts files included
- [ ] No duplicates in output
- [ ] LLM scores preserved
- [ ] Review counts match file counts

**Validation:**
```bash
node scripts/rebuild-all-reviews.js
node -e "const r = require('./data/reviews.json'); console.log(r.reviews.length, 'reviews')"
# Count should match sum of review-texts files
```

### Task 6.2: Verify Site Displays Correctly
**Description:** Run E2E tests to verify site displays review data correctly.

**Acceptance Criteria:**
- [ ] Show pages load without errors
- [ ] Review counts displayed correctly
- [ ] Scores calculated correctly
- [ ] No console errors

**Validation:**
```bash
npm run build
npm run test:e2e
# All tests pass
```

### Task 6.3: Final Baseline Report
**Description:** Generate final report showing improvements from sprint 0 to now.

**Output:** `data/audit/final-report.md`

**Acceptance Criteria:**
- [ ] Before/after comparison table
- [ ] Duplicate count: before → after (expect 100+ → 0)
- [ ] Missing review flags: before → after (expect reduction)
- [ ] Total unique reviews: documented

**Validation:**
```bash
node scripts/generate-final-report.js
cat data/audit/final-report.md
# Human-readable summary of all improvements
```

---

## Success Criteria (Project Complete)

| Metric | Before | Target | Validation |
|--------|--------|--------|------------|
| Duplicate review files | TBD | 0 | `cleanup-duplicate-reviews.js --dry-run` returns 0 |
| Shows with review count anomalies | TBD | <5% | `validate-data.js` passes |
| Normalization systems | 3 different | 1 unified | All extraction scripts import from `review-normalization.js` |
| LLM scores preserved | ~1959 | ~1959 | Count before/after matches |
| CI validation | None | Full | `npm run test:data` checks aggregator counts |
| Archive freshness | Unknown | <90 days | `inventory-archives.js` shows no stale |

---

## Appendix: Scripts to Create

| Script | Sprint | Purpose |
|--------|--------|---------|
| `scripts/audit-normalization.js` | 0.1 | Document normalization differences |
| `tests/unit/review-normalization.test.js` | 0.4 | Unit tests for normalization |
| `scripts/inventory-archives.js` | 1.1 | List archive files and freshness |
| `scripts/extract-aggregator-counts.js` | 1.2 | Get counts from existing archives |
| `scripts/count-local-reviews.js` | 1.3 | Count local review files |
| `scripts/generate-baseline-report.js` | 1.4 | Human-readable comparison |
| `scripts/backup-llm-scores.js` | 2.2 | Preserve scores before cleanup |
| `scripts/verify-cleanup-integrity.js` | 2.4 | Verify no data loss |
| `scripts/extract-missing-reviews.js` | 3.1 | Add missing reviews incrementally |
| `scripts/identify-stale-archives.js` | 4.1 | Find archives needing refresh |
| `scripts/create-data-backup-tag.js` | 5.4 | Create git backup tag |
| `scripts/generate-final-report.js` | 6.3 | Final improvement summary |

---

## Appendix: Workflow Modifications

| Workflow | Sprint | Change |
|----------|--------|--------|
| `.github/workflows/test.yml` | 5.1 | Add aggregator count validation |
| `.github/workflows/refresh-stale-archives.yml` | 4.2 | New - refresh old archives |
| `.github/workflows/weekly-aggregator-sync.yml` | 5.3 | New - weekly count check |

---

## Risk Mitigation

1. **Data Loss Prevention:**
   - Task 2.2 creates backup of all LLM scores
   - Task 5.4 creates git tag before bulk operations
   - All cleanup operations have `--dry-run` mode

2. **Scraping Rate Limits:**
   - Use existing archives first (Sprint 1-3)
   - Only scrape fresh for stale data (Sprint 4)
   - Batch processing with delays

3. **Git Conflicts:**
   - Per-show commits (atomic)
   - Retry logic with rebase (existing pattern)
   - Don't modify reviews.json until final rebuild

4. **Rollback Strategy:**
   - Git tags before major operations
   - All original files preserved until verification
   - Document rollback commands

---

For execution: Use subagents liberally!
