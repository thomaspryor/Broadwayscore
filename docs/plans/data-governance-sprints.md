# Data Governance Sprint Plan - Final

**Goal:** Fix data quality issues systematically with atomic, testable tasks.

**Reviewed by:** Claude Agent, OpenAI GPT-4o

---

## Current State (Baseline)

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

## Sprint 0: Infrastructure & Baseline

**Goal:** Establish baseline metrics, backup strategy, and testing infrastructure.

**Demo:** Run `node scripts/audit-data-quality.js` → saves baseline report.

### Task 0.1: Create backup script for reviews.json
**Description:** Script to backup reviews.json before any rebuild operation.
**Acceptance Criteria:**
- Script at `scripts/backup-reviews.js`
- Creates timestamped backup in `data/backups/`
- Returns path to backup file

**Validation:**
```bash
node scripts/backup-reviews.js
ls data/backups/reviews-*.json
```

### Task 0.2: Create audit-data-quality.js scaffold
**Description:** Create the main audit script with CLI interface.
**Acceptance Criteria:**
- Script at `scripts/audit-data-quality.js`
- Accepts `--save-baseline` and `--compare-to` flags
- Outputs JSON to stdout or file

**Validation:**
```bash
node scripts/audit-data-quality.js --help
```

### Task 0.3: Add duplicate check module to audit
**Description:** Module that counts duplicate reviews.
**Acceptance Criteria:**
- Counts reviews with same showId + outletId + criticName
- Returns count and list of duplicates

**Validation:**
```bash
node scripts/audit-data-quality.js | grep duplicates
```

### Task 0.4: Add null critic check module to audit
**Description:** Module that counts null/empty critic names.
**Acceptance Criteria:**
- Counts reviews where criticName is null, undefined, or empty string
- Returns count and list

**Validation:**
```bash
node scripts/audit-data-quality.js | grep nullCritics
```

### Task 0.5: Add null date check module to audit
**Description:** Module that counts null publish dates.
**Acceptance Criteria:**
- Counts reviews where publishDate is null or undefined
- Excludes reviews with `dateUnknown: true`

**Validation:**
```bash
node scripts/audit-data-quality.js | grep nullDates
```

### Task 0.6: Add unknown outlet check module to audit
**Description:** Module that counts unknown outlets.
**Acceptance Criteria:**
- Counts reviews where outletId is "unknown"
- Returns count and list

**Validation:**
```bash
node scripts/audit-data-quality.js | grep unknownOutlets
```

### Task 0.7: Add bad display name check module to audit
**Description:** Module that counts outlets where display name equals outletId.
**Acceptance Criteria:**
- Counts reviews where outlet === outletId (no proper display name)
- Returns count and breakdown by outlet

**Validation:**
```bash
node scripts/audit-data-quality.js | grep badDisplayNames
```

### Task 0.8: Add JSON report generation to audit
**Description:** Save audit results to JSON file.
**Acceptance Criteria:**
- Creates `data/audit/quality-report-{YYYY-MM-DD}.json`
- Includes all metrics, timestamp, and details

**Validation:**
```bash
node scripts/audit-data-quality.js --save-baseline
cat data/audit/quality-report-*.json
```

### Task 0.9: Save initial baseline
**Description:** Run audit and save as baseline for comparison.
**Acceptance Criteria:**
- Baseline file exists at `data/audit/baseline.json`
- Contains all current metrics

**Validation:**
```bash
node scripts/audit-data-quality.js --save-baseline
cat data/audit/baseline.json
```

### Task 0.10: Create tests/unit directory structure
**Description:** Set up unit test infrastructure.
**Acceptance Criteria:**
- Directory `tests/unit/` exists
- Jest or similar configured in package.json
- Sample test passes

**Validation:**
```bash
npm test -- tests/unit/sample.test.js
```

---

## Sprint 1: Outlet Registry & Display Names

**Goal:** Create single source of truth for outlets and fix all 218 bad display names.

**Demo:** Run audit → shows 0 bad display names.

### Task 1.1: Extract unique outlets from current data
**Description:** Script to list all unique outlet IDs in review data.
**Acceptance Criteria:**
- Script at `scripts/extract-unique-outlets.js`
- Outputs list of all unique outletId values
- Outputs count

**Validation:**
```bash
node scripts/extract-unique-outlets.js | head -20
```

### Task 1.2: Create outlet-registry.json schema
**Description:** Define JSON schema for outlet registry.
**Acceptance Criteria:**
- Schema file at `data/schemas/outlet-registry.schema.json`
- Defines required fields: id, displayName, tier, aliases
- Tier must be 1, 2, or 3

**Validation:**
```bash
cat data/schemas/outlet-registry.schema.json
```

### Task 1.3: Create outlet-registry.json with Tier 1 outlets
**Description:** Add all Tier 1 (major) outlets with display names.
**Acceptance Criteria:**
- File at `data/outlet-registry.json`
- Contains: nytimes, wsj, latimes, variety, hollywood-reporter, vulture, etc.
- Each has displayName, tier: 1, aliases array

**Validation:**
```bash
node -e "const r = require('./data/outlet-registry.json'); const t1 = Object.values(r.outlets).filter(o => o.tier === 1); console.log('Tier 1 outlets:', t1.length)"
```

### Task 1.4: Add Tier 2 outlets to registry
**Description:** Add Tier 2 (regional/specialty) outlets.
**Acceptance Criteria:**
- Contains: theatermania, deadline, chicago-tribune, etc.
- All have proper displayName and tier: 2

**Validation:**
```bash
node -e "const r = require('./data/outlet-registry.json'); const t2 = Object.values(r.outlets).filter(o => o.tier === 2); console.log('Tier 2 outlets:', t2.length)"
```

### Task 1.5: Add Tier 3 outlets to registry
**Description:** Add all remaining outlets (blogs, small sites).
**Acceptance Criteria:**
- All outlets from Task 1.1 exist in registry
- All have proper displayName and tier: 3

**Validation:**
```bash
node scripts/audit-outlet-registry.js && echo "All outlets covered"
```

### Task 1.6: Add aliases for common variations
**Description:** Add aliases for outlets with multiple name variations.
**Acceptance Criteria:**
- Each outlet has aliases array
- Common variations included (e.g., "nyt" → "nytimes")

**Validation:**
```bash
node -e "const r = require('./data/outlet-registry.json'); const aliasCount = Object.values(r.outlets).reduce((sum, o) => sum + o.aliases.length, 0); console.log('Total aliases:', aliasCount)"
```

### Task 1.7: Create audit-outlet-registry.js
**Description:** Script to compare reviews against registry.
**Acceptance Criteria:**
- Lists outlets in reviews but not in registry
- Exit code 0 if all outlets covered, 1 if gaps

**Validation:**
```bash
node scripts/audit-outlet-registry.js
```

### Task 1.8: Update getOutletDisplayName to use registry
**Description:** Modify function to read from registry file.
**Acceptance Criteria:**
- `getOutletDisplayName()` reads from `outlet-registry.json`
- Falls back to capitalized outletId if not found
- Logs warning for unknown outlets

**Validation:**
```bash
node -e "const {getOutletDisplayName} = require('./scripts/lib/review-normalization'); console.log(getOutletDisplayName('lighting-and-sound-america'))"
```

### Task 1.9: Rebuild reviews.json with new display names
**Description:** Run rebuild to apply new display names.
**Acceptance Criteria:**
- Backup created before rebuild
- Rebuild completes successfully

**Validation:**
```bash
node scripts/backup-reviews.js && node scripts/rebuild-all-reviews.js
```

### Task 1.10: Verify 0 bad display names
**Description:** Audit should show no bad display names.
**Acceptance Criteria:**
- `badDisplayNames: 0` in audit output

**Validation:**
```bash
node scripts/audit-data-quality.js | grep "badDisplayNames"
# Should output: badDisplayNames: 0
```

### Task 1.11: Unit tests for outlet registry
**Description:** Tests for registry integrity.
**Acceptance Criteria:**
- Test file at `tests/unit/outlet-registry.test.js`
- Tests: all outlets have displayName, valid tiers, no duplicate aliases

**Validation:**
```bash
npm test -- tests/unit/outlet-registry.test.js
```

---

## Sprint 2: Centralized Validation

**Goal:** Create ReviewValidator class and garbage detection.

**Demo:** Call `validator.validate(review)` → returns pass/fail with errors.

### Task 2.1: Create ReviewValidator class scaffold
**Description:** Create the validator class with basic structure.
**Acceptance Criteria:**
- File at `scripts/lib/review-validator.js`
- Class with `validate(review)` method stub
- Returns `{ valid: boolean, errors: [], warnings: [] }`

**Validation:**
```bash
node -e "const {ReviewValidator} = require('./scripts/lib/review-validator'); const v = new ReviewValidator(); console.log(v.validate({}))"
```

### Task 2.2: Add outlet validation to ReviewValidator
**Description:** Validate that outletId exists in registry.
**Acceptance Criteria:**
- Returns error if outletId not in registry
- Returns warning if outlet is Tier 3

**Validation:**
```bash
node -e "const {ReviewValidator} = require('./scripts/lib/review-validator'); const v = new ReviewValidator(); console.log(v.validate({outletId: 'fake-outlet'}))"
# Should show error: Unknown outlet
```

### Task 2.3: Create isGarbageCriticName function
**Description:** Function to detect garbage critic names.
**Acceptance Criteria:**
- Function in `review-normalization.js`
- Detects: "Unknown", "Photo Credit", "Advertisement", "&nbsp;", empty strings
- Returns true for garbage, false for valid

**Validation:**
```bash
node -e "const {isGarbageCriticName} = require('./scripts/lib/review-normalization'); console.log('Photo Credit:', isGarbageCriticName('Photo Credit')); console.log('Jesse Green:', isGarbageCriticName('Jesse Green'))"
```

### Task 2.4: Add critic validation to ReviewValidator
**Description:** Validate critic name is not null or garbage.
**Acceptance Criteria:**
- Returns error if criticName is null/empty
- Returns error if isGarbageCriticName returns true

**Validation:**
```bash
node -e "const {ReviewValidator} = require('./scripts/lib/review-validator'); const v = new ReviewValidator(); console.log(v.validate({outletId: 'nytimes', criticName: 'Photo Credit'}))"
```

### Task 2.5: Add normalizeAndValidate method
**Description:** Method that normalizes review data then validates.
**Acceptance Criteria:**
- Normalizes outletId using normalizeOutlet()
- Normalizes criticName using normalizeCritic()
- Sets outlet display name from registry
- Then validates

**Validation:**
```bash
node -e "const {ReviewValidator} = require('./scripts/lib/review-validator'); const v = new ReviewValidator(); console.log(v.normalizeAndValidate({outletId: 'NYT', criticName: 'jesse green'}))"
```

### Task 2.6: Unit tests for ReviewValidator
**Description:** Comprehensive tests for validator.
**Acceptance Criteria:**
- Tests: valid review passes, missing outlet fails, garbage critic fails
- All tests pass

**Validation:**
```bash
npm test -- tests/unit/review-validator.test.js
```

### Task 2.7: Unit tests for garbage detection
**Description:** Tests for isGarbageCriticName.
**Acceptance Criteria:**
- Tests all known garbage patterns
- Tests valid names don't false positive

**Validation:**
```bash
npm test -- tests/unit/garbage-detection.test.js
```

### Task 2.8: Create compare-audits.js
**Description:** Compare two audit reports.
**Acceptance Criteria:**
- Takes two JSON file paths as arguments
- Shows delta for each metric with ↑/↓
- Exit code 0 if improved, 1 if regressed

**Validation:**
```bash
node scripts/compare-audits.js data/audit/baseline.json data/audit/quality-report-*.json
```

---

## Sprint 3: Null Critic Cleanup

**Goal:** Fix all 8 null critics.

**Demo:** Run audit → shows 0 null critics.

### Task 3.1: Create audit-critics.js
**Description:** Find all reviews with null or garbage critics.
**Acceptance Criteria:**
- Lists all null critic reviews with show, outlet, URL
- Lists all garbage critic reviews
- Outputs to `data/audit/critic-issues.json`

**Validation:**
```bash
node scripts/audit-critics.js
cat data/audit/critic-issues.json
```

### Task 3.2: Identify recoverable critic names
**Description:** Analyze null critic reviews to find recoverable names.
**Acceptance Criteria:**
- Check URLs for author patterns
- Check excerpts for bylines
- Output list of recoverable vs unrecoverable

**Validation:**
```bash
# Manual review of critic-issues.json
```

### Task 3.3: Create fix-critic-names.js scaffold
**Description:** Script to fix recoverable critic names.
**Acceptance Criteria:**
- Script at `scripts/fix-critic-names.js`
- Supports `--dry-run` flag
- Logs all changes

**Validation:**
```bash
node scripts/fix-critic-names.js --dry-run
```

### Task 3.4: Add URL pattern extraction to fix-critic-names
**Description:** Extract critic from URL patterns.
**Acceptance Criteria:**
- Parses `/author/{name}`, `/writers/{name}`
- Updates review files

**Validation:**
```bash
node scripts/fix-critic-names.js --dry-run | grep "URL extraction"
```

### Task 3.5: Run fix-critic-names
**Description:** Apply fixes to review files.
**Acceptance Criteria:**
- Backup created first
- Fixes applied
- Changes logged

**Validation:**
```bash
node scripts/backup-reviews.js && node scripts/fix-critic-names.js
```

### Task 3.6: Delete unrecoverable garbage reviews
**Description:** Reviews with no value should be deleted.
**Acceptance Criteria:**
- Script at `scripts/delete-garbage-reviews.js`
- Only deletes if: no outlet AND no critic AND no fullText
- Supports `--dry-run`

**Validation:**
```bash
node scripts/delete-garbage-reviews.js --dry-run
```

### Task 3.7: Rebuild and verify 0 null critics
**Description:** Rebuild and verify fix.
**Acceptance Criteria:**
- Rebuild completes
- Audit shows nullCritics: 0

**Validation:**
```bash
node scripts/rebuild-all-reviews.js
node scripts/audit-data-quality.js | grep nullCritics
```

---

## Sprint 4: Null Date Handling

**Goal:** Reduce null dates from 253 to <50.

**Demo:** Run audit → shows <50 null dates.

### Task 4.1: Analyze null dates to determine target
**Description:** Categorize null dates to set realistic target.
**Acceptance Criteria:**
- Script at `scripts/audit-null-dates.js`
- Categories: recoverable, researchable (<5 min), unknown
- Output with counts per category

**Validation:**
```bash
node scripts/audit-null-dates.js
```

### Task 4.2: Create extract-dates-from-text.js
**Description:** Parse dates from review text fields.
**Acceptance Criteria:**
- Searches fullText, dtliExcerpt, bwwExcerpt, showScoreExcerpt
- Regex patterns for: "January 15, 2025", "1/15/2025", "2025-01-15"
- Requires full date (year/month/day), not just year

**Validation:**
```bash
node scripts/extract-dates-from-text.js --dry-run | head -20
```

### Task 4.3: Create extract-dates-from-urls.js
**Description:** Parse dates from review URLs.
**Acceptance Criteria:**
- Parses `/2025/01/15/` patterns
- Requires full date, not just year
- Updates review files

**Validation:**
```bash
node scripts/extract-dates-from-urls.js --dry-run | head -20
```

### Task 4.4: Create use-show-opening-as-fallback.js
**Description:** For reviews with no date, use show opening date as estimate.
**Acceptance Criteria:**
- Sets `publishDate` to show's `openingDate`
- Sets `dateEstimated: true` flag
- Only for reviews published around opening

**Validation:**
```bash
node scripts/use-show-opening-as-fallback.js --dry-run
```

### Task 4.5: Create mark-unknown-dates.js
**Description:** Mark legitimately unknown dates.
**Acceptance Criteria:**
- Sets `dateUnknown: true` for unrecoverable dates
- These excluded from null date count

**Validation:**
```bash
node scripts/mark-unknown-dates.js --dry-run
```

### Task 4.6: Run all date extraction scripts
**Description:** Apply all date fixes.
**Acceptance Criteria:**
- Backup first
- Run in order: text → URL → fallback → mark unknown

**Validation:**
```bash
node scripts/backup-reviews.js
node scripts/extract-dates-from-text.js
node scripts/extract-dates-from-urls.js
node scripts/use-show-opening-as-fallback.js
node scripts/mark-unknown-dates.js
```

### Task 4.7: Standardize date formats
**Description:** Normalize all dates to consistent format.
**Acceptance Criteria:**
- Script at `scripts/standardize-dates.js`
- Converts all dates to "YYYY-MM-DD" format
- Preserves original in `publishDateOriginal` if different

**Validation:**
```bash
node scripts/standardize-dates.js --dry-run
```

### Task 4.8: Rebuild and verify <50 null dates
**Description:** Verify target achieved.
**Acceptance Criteria:**
- Audit shows nullDates < 50
- All remaining nullDates have `dateUnknown: true`

**Validation:**
```bash
node scripts/rebuild-all-reviews.js
node scripts/audit-data-quality.js | grep nullDates
```

---

## Sprint 5: Duplicate Prevention

**Goal:** Make duplicate creation impossible.

**Demo:** Attempt to add duplicate → rejected with clear message.

### Task 5.1: Add isDuplicateReview to ReviewValidator
**Description:** Method to check if review already exists.
**Acceptance Criteria:**
- Checks against existing files in review-texts/
- Returns true if duplicate found
- Returns path to existing file

**Validation:**
```bash
node -e "const {ReviewValidator} = require('./scripts/lib/review-validator'); const v = new ReviewValidator(); console.log(v.isDuplicateReview('hamilton-2015', 'nytimes', 'Ben Brantley'))"
```

### Task 5.2a: Add duplicate check to gather-reviews.js
**Description:** Check before saving in gather-reviews.
**Acceptance Criteria:**
- Skips if duplicate exists
- Logs: "SKIPPED: Duplicate. {file} already exists"

**Validation:**
```bash
# Run gather-reviews on show with existing reviews
# Should skip all existing
```

### Task 5.2b: Add duplicate check to extract-bww-reviews.js
**Description:** Check before saving in BWW extractor.
**Acceptance Criteria:**
- Same as 5.2a

**Validation:**
```bash
# Run on show with existing BWW reviews
```

### Task 5.2c: Add duplicate check to extract-dtli-reviews.js
**Description:** Check before saving in DTLI extractor.
**Acceptance Criteria:**
- Same as 5.2a

**Validation:**
```bash
# Run on show with existing DTLI reviews
```

### Task 5.2d: Add duplicate check to extract-show-score-reviews.js
**Description:** Check before saving in Show Score extractor.
**Acceptance Criteria:**
- Same as 5.2a

**Validation:**
```bash
# Run on show with existing Show Score reviews
```

### Task 5.3: Create scan-for-duplicates.js
**Description:** Scan all review files for duplicates.
**Acceptance Criteria:**
- Outputs list of duplicate file pairs
- Exit code 0 if none, 1 if found

**Validation:**
```bash
node scripts/scan-for-duplicates.js && echo "No duplicates"
```

### Task 5.4: Unit tests for duplicate detection
**Description:** Tests for isDuplicateReview.
**Acceptance Criteria:**
- Test exact match detection
- Test case-insensitivity
- Test different shows don't collide

**Validation:**
```bash
npm test -- tests/unit/duplicate-detection.test.js
```

---

## Sprint 6: CI/CD & Prevention

**Goal:** Block bad data at commit time.

**Demo:** Attempt to commit bad review → blocked.

### Task 6.0: Verify all existing files pass validation
**Description:** Ensure validation won't break CI immediately.
**Acceptance Criteria:**
- Run validator on all files
- Fix any issues found
- All files pass

**Validation:**
```bash
node scripts/validate-review-files.js && echo "All valid"
```

### Task 6.1: Create validate-review-files.js
**Description:** Script to validate all review files.
**Acceptance Criteria:**
- Validates all files in `data/review-texts/`
- Supports `--staged-only` for pre-commit
- Performance target: <2 seconds for staged files
- Exit code 0 if valid, 1 if errors

**Validation:**
```bash
time node scripts/validate-review-files.js --staged-only
# Should be <2 seconds
```

### Task 6.2a: Install Husky
**Description:** Install Husky for git hooks.
**Acceptance Criteria:**
- Husky installed via npm
- .husky directory created

**Validation:**
```bash
ls .husky/
```

### Task 6.2b: Create pre-commit hook
**Description:** Hook that runs validation.
**Acceptance Criteria:**
- File at `.husky/pre-commit`
- Runs `validate-review-files.js --staged-only`
- Blocks commit on failure

**Validation:**
```bash
# Create bad file, try to commit
# Should be blocked
```

### Task 6.3: Add validation to CI workflow
**Description:** Add to test.yml.
**Acceptance Criteria:**
- Uses SAME script as pre-commit
- Fails CI if invalid files

**Validation:**
```bash
# Check .github/workflows/test.yml includes validation step
```

### Task 6.4: Create weekly-data-quality.yml workflow
**Description:** Weekly audit with issue creation.
**Acceptance Criteria:**
- Runs every Sunday
- Compares to baseline
- Creates issue if ANY metric is worse than baseline

**Validation:**
```bash
gh workflow run "Weekly Data Quality Check"
```

### Task 6.5: Define regression thresholds
**Description:** Document what counts as regression.
**Acceptance Criteria:**
- Regression = any metric worse than baseline
- Documented in workflow file comments

**Validation:**
```bash
# Review workflow file
```

### Task 6.6: Create test-bad-review.json for demos
**Description:** Intentionally invalid file for testing.
**Acceptance Criteria:**
- File at `tests/fixtures/test-bad-review.json`
- Has invalid outlet, null critic, etc.
- Used for demo purposes only

**Validation:**
```bash
node scripts/validate-review-files.js tests/fixtures/test-bad-review.json
# Should fail
```

---

## Sprint 7: Final Cleanup & Documentation

**Goal:** All metrics green, documented.

**Demo:** Full audit → all green. Stakeholder sign-off.

### Task 7.1: Run final audit
**Description:** Comprehensive audit of all data.
**Acceptance Criteria:**
- Duplicates: 0
- Null critics: 0
- Null dates: <50
- Unknown outlets: 0
- Bad display names: 0

**Validation:**
```bash
node scripts/audit-data-quality.js
```

### Task 7.2: Fix any remaining issues
**Description:** Address any outstanding problems.
**Acceptance Criteria:**
- All audit metrics at target

**Validation:**
```bash
node scripts/audit-data-quality.js --compare-to data/audit/baseline.json
# Should show all improvements
```

### Task 7.3: Update CLAUDE.md with new scripts
**Description:** Document all new scripts.
**Acceptance Criteria:**
- Each new script listed with purpose
- Validation commands documented

**Validation:**
```bash
# Verify each script mentioned
grep -l "audit-data-quality\|validate-review-files\|outlet-registry" CLAUDE.md
```

### Task 7.4: Create data-quality-runbook.md
**Description:** Maintenance documentation.
**Acceptance Criteria:**
- File at `docs/data-quality-runbook.md`
- Covers: adding outlets, fixing issues, running audits
- Troubleshooting guide

**Validation:**
```bash
cat docs/data-quality-runbook.md | head -50
```

### Task 7.5: Save final baseline
**Description:** Archive final metrics.
**Acceptance Criteria:**
- Saved to `data/audit/baseline-final.json`
- Includes date and all metrics

**Validation:**
```bash
node scripts/audit-data-quality.js --save-baseline
cp data/audit/baseline.json data/audit/baseline-final.json
```

### Task 7.6: Stakeholder demo and sign-off
**Description:** Present results and get approval.
**Acceptance Criteria:**
- Demo completed
- Stakeholder approved

**Validation:**
```bash
# Manual sign-off
```

---

## Summary

| Sprint | Goal | Key Metric |
|--------|------|------------|
| 0 | Infrastructure | Baseline established |
| 1 | Outlet Registry | badDisplayNames: 0 |
| 2 | Validation | ReviewValidator works |
| 3 | Critics | nullCritics: 0 |
| 4 | Dates | nullDates: <50 |
| 5 | Duplicates | Prevention works |
| 6 | CI/CD | Pre-commit blocks bad data |
| 7 | Cleanup | All metrics green |

---

## Execution Notes

### Running Sprints
Each sprint should be executed sequentially. Within a sprint, tasks can often be parallelized where there are no dependencies.

### Testing Strategy
- Unit tests for all new functions
- Integration tests for scripts
- Manual verification for demos

### Rollback Strategy
- Backup before every rebuild
- Git revert for code changes
- Restore from `data/backups/` for data

### Performance Targets
- Pre-commit validation: <2 seconds
- Full audit: <30 seconds
- Rebuild: <60 seconds

---

Use subagents liberally! For all parts.
