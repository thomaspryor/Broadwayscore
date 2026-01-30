# Data Governance Sprint Plan

## Current State (Post-Quick Wins)

| Metric | Count | Target |
|--------|-------|--------|
| Total Reviews | 2,140 | - |
| Duplicates | 0 | 0 ✓ |
| Null Critics | 8 | 0 |
| Null Dates | 253 | <50 |
| Unknown Outlets | 1 | 0 |
| Bad Display Names | 218 | 0 |
| Shows | 72 | - |

---

## Sprint 1: Outlet Registry & Display Name Fix

**Goal:** Create single source of truth for outlets and fix all 218 bad display names.

**Demo:** Run `node scripts/audit-data-quality.js` → shows 0 bad display names.

### Task 1.1: Create outlet-registry.json
**Description:** Create a JSON file with all known outlets, their display names, tiers, and aliases.
**Acceptance Criteria:**
- File exists at `data/outlet-registry.json`
- Contains all 210+ unique outlets from current data
- Each outlet has: `id`, `displayName`, `tier` (1-3), `aliases` array
- JSON validates against schema

**Validation:**
```bash
node -e "const r = require('./data/outlet-registry.json'); console.log(Object.keys(r.outlets).length + ' outlets defined')"
```

### Task 1.2: Audit script to find missing outlets
**Description:** Create script that compares review data against registry and reports gaps.
**Acceptance Criteria:**
- Script at `scripts/audit-outlet-registry.js`
- Outputs list of outlets in reviews but not in registry
- Outputs list of outlets in registry but not in reviews (orphans)
- Exit code 0 if no missing outlets, 1 if gaps found

**Validation:**
```bash
node scripts/audit-outlet-registry.js && echo "PASS" || echo "FAIL - missing outlets"
```

### Task 1.3: Add all missing outlets to registry
**Description:** Add every outlet found by audit to the registry with proper display names.
**Acceptance Criteria:**
- `audit-outlet-registry.js` exits with code 0
- All 218 bad display name outlets now have proper entries

**Validation:**
```bash
node scripts/audit-outlet-registry.js
# Should output: "All outlets in registry"
```

### Task 1.4: Update getOutletDisplayName to use registry
**Description:** Modify `review-normalization.js` to read display names from registry instead of hardcoded map.
**Acceptance Criteria:**
- `getOutletDisplayName()` reads from `outlet-registry.json`
- Function returns proper display name for all 210+ outlets
- Existing unit tests pass

**Validation:**
```bash
node -e "const {getOutletDisplayName} = require('./scripts/lib/review-normalization'); console.log(getOutletDisplayName('lighting-and-sound-america'))"
# Should output: "Lighting & Sound America" (or similar proper name)
```

### Task 1.5: Rebuild reviews.json with new display names
**Description:** Run rebuild to apply new display names to all reviews.
**Acceptance Criteria:**
- `reviews.json` has 0 reviews where `outlet === outletId`
- All outlet display names are properly formatted (Title Case, etc.)

**Validation:**
```bash
node scripts/rebuild-all-reviews.js
node -e "const r = require('./data/reviews.json'); const bad = r.reviews.filter(x => x.outlet === x.outletId); console.log('Bad display names: ' + bad.length)"
# Should output: "Bad display names: 0"
```

### Task 1.6: Unit tests for outlet registry
**Description:** Create tests that validate registry integrity.
**Acceptance Criteria:**
- Test file at `tests/unit/outlet-registry.test.js`
- Tests: all outlets have displayName, all outlets have tier 1-3, no duplicate aliases
- Tests pass

**Validation:**
```bash
npm test -- tests/unit/outlet-registry.test.js
```

---

## Sprint 2: Centralized Validation & Audit Infrastructure

**Goal:** Create centralized validation and comprehensive audit dashboard.

**Demo:** Run `node scripts/audit-data-quality.js` → outputs full quality report with pass/fail.

### Task 2.1: Create ReviewValidator class
**Description:** Single class for all review validation logic.
**Acceptance Criteria:**
- File at `scripts/lib/review-validator.js`
- Methods: `validate(review)`, `normalizeAndValidate(review)`
- Returns `{ valid: boolean, errors: [], warnings: [] }`
- Uses outlet-registry.json for outlet validation

**Validation:**
```bash
node -e "
const {ReviewValidator} = require('./scripts/lib/review-validator');
const v = new ReviewValidator();
const result = v.validate({outletId: 'nytimes', criticName: 'Test'});
console.log('Valid:', result.valid);
"
```

### Task 2.2: Create comprehensive audit script
**Description:** Script that audits all review data and outputs quality metrics.
**Acceptance Criteria:**
- File at `scripts/audit-data-quality.js`
- Outputs: duplicates, null critics, null dates, unknown outlets, bad display names
- Saves JSON report to `data/audit/quality-report-{date}.json`
- Exit code 0 if all metrics at target, 1 otherwise

**Validation:**
```bash
node scripts/audit-data-quality.js
cat data/audit/quality-report-*.json | head -20
```

### Task 2.3: Create compare-audits script
**Description:** Compare two audit reports to show improvement/regression.
**Acceptance Criteria:**
- File at `scripts/compare-audits.js`
- Takes two report files as arguments
- Outputs delta for each metric with ↑/↓ indicators
- Exit code 0 if improvement, 1 if regression

**Validation:**
```bash
# Run audit, make a change, run audit again, compare
node scripts/compare-audits.js data/audit/quality-report-A.json data/audit/quality-report-B.json
```

### Task 2.4: Unit tests for ReviewValidator
**Description:** Comprehensive tests for validation logic.
**Acceptance Criteria:**
- Test file at `tests/unit/review-validator.test.js`
- Tests: valid review passes, missing outlet fails, garbage critic fails, unknown outlet fails
- All tests pass

**Validation:**
```bash
npm test -- tests/unit/review-validator.test.js
```

### Task 2.5: Integration test - full audit on real data
**Description:** Test that audit script runs successfully on actual review data.
**Acceptance Criteria:**
- Audit completes without errors
- Report JSON is valid
- All metrics are captured

**Validation:**
```bash
node scripts/audit-data-quality.js && echo "Audit completed successfully"
```

---

## Sprint 3: Null Critic & Garbage Name Cleanup

**Goal:** Fix all 8 null critics and any garbage critic names.

**Demo:** Run audit → shows 0 null critics, 0 garbage names.

### Task 3.1: Create garbage critic detection function
**Description:** Function to detect garbage critic names like "Photo Credit", "Advertisement", etc.
**Acceptance Criteria:**
- Function `isGarbageCriticName(name)` in `review-normalization.js`
- Detects: "Unknown", "Photo Credit", "Advertisement", "&nbsp;", empty strings
- Returns true for garbage, false for valid names

**Validation:**
```bash
node -e "
const {isGarbageCriticName} = require('./scripts/lib/review-normalization');
console.log('Photo Credit:', isGarbageCriticName('Photo Credit')); // true
console.log('Jesse Green:', isGarbageCriticName('Jesse Green')); // false
"
```

### Task 3.2: Audit null and garbage critics
**Description:** Find all reviews with null or garbage critic names.
**Acceptance Criteria:**
- Script at `scripts/audit-critics.js`
- Lists all null critic reviews with show, outlet, URL
- Lists all garbage critic reviews
- Outputs to `data/audit/critic-issues.json`

**Validation:**
```bash
node scripts/audit-critics.js
cat data/audit/critic-issues.json
```

### Task 3.3: Fix recoverable critic names
**Description:** For reviews where critic can be determined from URL or excerpt, fix them.
**Acceptance Criteria:**
- Script at `scripts/fix-critic-names.js`
- Extracts critic from URL patterns (e.g., `/author/jesse-green`)
- Updates review files with corrected names
- Logs all changes

**Validation:**
```bash
node scripts/fix-critic-names.js --dry-run
# Review output, then:
node scripts/fix-critic-names.js
```

### Task 3.4: Delete unrecoverable garbage reviews
**Description:** Reviews that are truly garbage (no outlet, no critic, no value) should be deleted.
**Acceptance Criteria:**
- Script identifies reviews with: no outlet AND no critic AND no fullText
- Deletes identified files
- Logs deletions

**Validation:**
```bash
node scripts/delete-garbage-reviews.js --dry-run
# Review output, then:
node scripts/delete-garbage-reviews.js
```

### Task 3.5: Rebuild and verify 0 null critics
**Description:** Rebuild reviews.json and verify null critic count is 0.
**Acceptance Criteria:**
- Rebuild completes
- Audit shows 0 null critics

**Validation:**
```bash
node scripts/rebuild-all-reviews.js
node scripts/audit-data-quality.js | grep "nullCritics"
# Should show: nullCritics: 0
```

### Task 3.6: Unit tests for garbage detection
**Description:** Tests for isGarbageCriticName function.
**Acceptance Criteria:**
- Test file covers all known garbage patterns
- Tests pass

**Validation:**
```bash
npm test -- tests/unit/garbage-detection.test.js
```

---

## Sprint 4: Null Date Handling

**Goal:** Reduce null dates from 253 to <50.

**Demo:** Run audit → shows <50 null dates with explanation.

### Task 4.1: Categorize null dates
**Description:** Analyze all 253 null date reviews and categorize.
**Acceptance Criteria:**
- Script at `scripts/audit-null-dates.js`
- Categories: recoverable (date in excerpt/URL), researchable (can find online), unknown (legitimately missing)
- Outputs `data/audit/null-dates-categorized.json`

**Validation:**
```bash
node scripts/audit-null-dates.js
cat data/audit/null-dates-categorized.json | head -30
```

### Task 4.2: Extract dates from excerpts
**Description:** Parse dates from review excerpts where present.
**Acceptance Criteria:**
- Script at `scripts/extract-dates-from-text.js`
- Regex patterns for: "January 15, 2025", "1/15/2025", "2025-01-15"
- Updates review files with extracted dates
- Logs all extractions

**Validation:**
```bash
node scripts/extract-dates-from-text.js --dry-run
```

### Task 4.3: Extract dates from URLs
**Description:** Parse dates from review URLs where present.
**Acceptance Criteria:**
- Parses URLs like `/2025/01/15/theater/review.html`
- Updates review files
- Logs extractions

**Validation:**
```bash
node scripts/extract-dates-from-urls.js --dry-run
```

### Task 4.4: Mark legitimately unknown dates
**Description:** For reviews where date truly cannot be determined, mark explicitly.
**Acceptance Criteria:**
- Reviews get `dateUnknown: true` field
- These are excluded from "null dates" count in audit
- Documented in data quality report

**Validation:**
```bash
node scripts/mark-unknown-dates.js
```

### Task 4.5: Rebuild and verify <50 null dates
**Description:** Final count of null dates should be under 50.
**Acceptance Criteria:**
- Audit shows null dates < 50
- Remaining null dates are documented/justified

**Validation:**
```bash
node scripts/rebuild-all-reviews.js
node scripts/audit-data-quality.js | grep "nullDates"
```

---

## Sprint 5: Duplicate Prevention & Detection

**Goal:** Ensure no duplicate reviews can be created or exist.

**Demo:** Attempt to add duplicate → rejected. Run audit → 0 duplicates.

### Task 5.1: Create duplicate detection function
**Description:** Function to check if a review already exists.
**Acceptance Criteria:**
- Function `isDuplicateReview(showId, outletId, criticName)` in ReviewValidator
- Checks against existing review files
- Returns true if duplicate exists

**Validation:**
```bash
node -e "
const {ReviewValidator} = require('./scripts/lib/review-validator');
const v = new ReviewValidator();
console.log(v.isDuplicateReview('hamilton-2015', 'nytimes', 'Ben Brantley'));
"
```

### Task 5.2: Add duplicate check to all extraction scripts
**Description:** Modify extraction scripts to skip duplicates.
**Acceptance Criteria:**
- `gather-reviews.js` checks before saving
- `extract-bww-reviews.js` checks before saving
- `extract-dtli-reviews.js` checks before saving
- `extract-show-score-reviews.js` checks before saving

**Validation:**
```bash
# Run extraction on a show that already has reviews
# Should skip all existing reviews without creating duplicates
```

### Task 5.3: Create scan-for-duplicates script
**Description:** Scan all review files and report any duplicates.
**Acceptance Criteria:**
- Script at `scripts/scan-for-duplicates.js`
- Outputs list of duplicate file pairs
- Exit code 0 if none, 1 if found

**Validation:**
```bash
node scripts/scan-for-duplicates.js && echo "No duplicates" || echo "Duplicates found!"
```

### Task 5.4: Unit tests for duplicate detection
**Description:** Tests for duplicate detection logic.
**Acceptance Criteria:**
- Tests various duplicate scenarios
- Tests pass

**Validation:**
```bash
npm test -- tests/unit/duplicate-detection.test.js
```

---

## Sprint 6: CI/CD & Prevention Infrastructure

**Goal:** Make it impossible to commit bad data.

**Demo:** Try to commit bad review file → blocked by pre-commit hook.

### Task 6.1: Create validate-review-files script
**Description:** Script that validates all review files using ReviewValidator.
**Acceptance Criteria:**
- Script at `scripts/validate-review-files.js`
- Validates all files in `data/review-texts/`
- Supports `--staged-only` flag for pre-commit
- Exit code 0 if all valid, 1 if errors

**Validation:**
```bash
node scripts/validate-review-files.js && echo "All valid"
```

### Task 6.2: Setup Husky for pre-commit hooks
**Description:** Configure Husky to run validation before commits.
**Acceptance Criteria:**
- Husky installed and configured
- Pre-commit hook at `.husky/pre-commit`
- Hook runs `validate-review-files.js --staged-only`

**Validation:**
```bash
# Create a bad review file, try to commit
# Should be blocked
```

### Task 6.3: Add validation to CI workflow
**Description:** Add review file validation to GitHub Actions test workflow.
**Acceptance Criteria:**
- `.github/workflows/test.yml` includes validation step
- CI fails if review files are invalid

**Validation:**
```bash
# Push a bad file, CI should fail
```

### Task 6.4: Create weekly integrity check workflow
**Description:** GitHub Action that runs weekly audit and creates issue on regression.
**Acceptance Criteria:**
- Workflow at `.github/workflows/weekly-data-quality.yml`
- Runs `audit-data-quality.js`
- Creates issue if any metric regresses
- Runs every Sunday

**Validation:**
```bash
# Manually trigger workflow
gh workflow run "Weekly Data Quality Check"
```

### Task 6.5: Integration test - end-to-end validation
**Description:** Test full flow from extraction to validation to commit.
**Acceptance Criteria:**
- Test creates a review, validates it, attempts commit
- Invalid reviews are rejected
- Valid reviews are accepted

**Validation:**
```bash
npm test -- tests/integration/review-workflow.test.js
```

---

## Sprint 7: Final Cleanup & Documentation

**Goal:** Clean slate - all metrics at target, documented.

**Demo:** Run full audit → all green. Documentation complete.

### Task 7.1: Final audit and fix any remaining issues
**Description:** Run comprehensive audit and fix any outstanding issues.
**Acceptance Criteria:**
- Duplicates: 0
- Null critics: 0
- Null dates: <50
- Unknown outlets: 0
- Bad display names: 0

**Validation:**
```bash
node scripts/audit-data-quality.js
# All metrics at target
```

### Task 7.2: Update CLAUDE.md with new scripts
**Description:** Document all new scripts and workflows.
**Acceptance Criteria:**
- All new scripts listed in CLAUDE.md
- Validation workflows documented
- Audit process documented

**Validation:**
```bash
# Manual review of CLAUDE.md
```

### Task 7.3: Create data quality runbook
**Description:** Document how to maintain data quality going forward.
**Acceptance Criteria:**
- File at `docs/data-quality-runbook.md`
- Covers: how to add new outlets, how to fix issues, how to run audits
- Clear step-by-step instructions

**Validation:**
```bash
# Manual review
```

### Task 7.4: Archive baseline metrics
**Description:** Save final baseline metrics for future comparison.
**Acceptance Criteria:**
- Baseline saved to `data/audit/baseline-final.json`
- Includes all metrics and date

**Validation:**
```bash
node scripts/audit-data-quality.js --save-baseline
cat data/audit/baseline-final.json
```

---

## Summary

| Sprint | Goal | Key Deliverable |
|--------|------|-----------------|
| 1 | Outlet Registry | 0 bad display names |
| 2 | Audit Infrastructure | Quality dashboard |
| 3 | Critic Cleanup | 0 null critics |
| 4 | Date Handling | <50 null dates |
| 5 | Duplicate Prevention | 0 duplicates possible |
| 6 | CI/CD | Pre-commit validation |
| 7 | Final Cleanup | All metrics green |

Each sprint builds on the previous and produces working, testable software.
