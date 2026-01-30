# Data Quality Audit Plan (Revised)

## Overview
Comprehensive audit of review data quality following archive URL fixes. Goal: Increase confidence from ~65% to 90%+.

## Confidence Score Formula
```
confidence = (
  (1 - duplicate_rate) * 0.25 +
  (1 - wrong_production_rate) * 0.25 +
  score_accuracy * 0.30 +
  content_verification_pass_rate * 0.20
) * 100
```

---

## Sprint 1: File Integrity & Deduplication Audit
**Goal:** Verify file integrity and identify duplicate review files.

**Demo:** Scripts that report file issues and duplicates with actionable details.

### Task 1.0: File integrity check
- **File:** `scripts/audit-file-integrity.js`
- **Logic:**
  - All files in review-texts/ parse as valid JSON
  - No empty files (0 bytes)
  - Required fields present: showId, outletId, outlet, criticName
- **Output:** `data/audit/file-integrity.json`
- **Pass criteria:** Zero corrupt files, zero missing required fields
- **Validation:** Script catches intentionally broken test fixture

### Task 1.1: Create duplicate detection script
- **File:** `scripts/audit-review-duplicates.js`
- **Logic:**
  - Group files by showId + normalized outlet + normalized critic
  - Use existing review-normalization.js for normalization
  - Flag groups with >1 file
- **Output:** JSON report of duplicates
- **Pass criteria:** Script runs without error

### Task 1.1.5: Add outlet alias mapping
- **Enhancement to 1.1**
- **Logic:** Cross-reference with OUTLET_ALIASES in review-normalization.js
- **Validation:** Treats "playbill" and "playbill.com" as same outlet

### Task 1.2: Add URL-based duplicate detection
- **Enhancement to 1.1**
- **Logic:** Flag files with identical URLs even if outlet/critic differs
- **Pass criteria:** Catches test case where same URL exists in 2 files

### Task 1.2.5: Cross-show URL deduplication
- **Logic:** Flag same URL appearing in DIFFERENT show directories
- **Alert level:** CRITICAL (same URL can't review 2 different shows)
- **Pass criteria:** Should be zero matches

### Task 1.3: Add excerpt sentiment consistency check
- **Enhancement to 1.1**
- **Logic:**
  - If file has multiple excerpts (dtli, bww, showScore), check sentiment
  - Flag if one excerpt positive, another negative (data merge error)
  - Do NOT flag for different wording (normal)
- **Validation:** Test on file with known-consistent excerpts

### Task 1.4: Generate consolidated duplicate report
- **Output:** `data/audit/duplicate-review-files.json`
- **Format:**
```json
{
  "summary": { "total_files": N, "duplicate_groups": N, "cross_show_dupes": N },
  "duplicates": [{ "showId": "", "outlet": "", "critic": "", "files": [], "reason": "" }],
  "cross_show": [{ "url": "", "shows": [] }]
}
```
- **Pass criteria:** duplicate_groups < 50, cross_show_dupes = 0

### Task 1.5: Sprint 1 validation
- **Test:** Run on full dataset
- **Pass criteria:**
  - All reports valid JSON
  - Zero file integrity issues
  - Duplicate groups < 50
  - Cross-show duplicates = 0
- **Commit:** Scripts + reports

---

## Sprint 2: Wrong Production Review Detection
**Goal:** Find reviews extracted from wrong production archives.

**Demo:** Script that flags reviews containing wrong-production indicators.

### Task 2.1: Create wrong-production detector base
- **File:** `scripts/audit-wrong-production-reviews.js`
- **Input:** Show ID, expected indicators, wrong indicators
- **Logic:** Scan fullText and excerpts for wrong indicators
- **Pass criteria:** Returns empty for known-good show (Hamilton)

### Task 2.2: Configure Our Town 2024 detection
- **Expected:** 2024, Barrymore Theatre, Jim Parsons, Zoey Deutch, Kenny Leon
- **Wrong:** 2002, Booth Theatre, Paul Newman
- **Pass criteria:** Flags test case with "Booth Theatre"

### Task 2.3: Configure Suffs 2024 detection
- **Expected:** 2024, Music Box Theatre, Broadway, Shaina Taub
- **Wrong:** 2022, Public Theater, off-Broadway
- **Pass criteria:** Flags test case with "Public Theater"

### Task 2.4: Configure Tommy 2024 detection
- **Expected:** 2024, Nederlander Theatre, Ali Louis Bourzgui
- **Wrong:** 2019, Kennedy Center, Casey Cott
- **Pass criteria:** Flags test case with "Kennedy Center"

### Task 2.5a: Create revival identification function
- **Logic:** Identify shows with -YYYY suffix where earlier production may exist
- **Output:** List of revival show IDs
- **Pass criteria:** Identifies our-town-2024, cabaret-2024, tommy-2024

### Task 2.5b: Extract expected metadata for revivals
- **Input:** Revival show IDs + shows.json
- **Output:** Map of showId → { year, venue, cast[] }
- **Pass criteria:** Data matches shows.json

### Task 2.5c: Build wrong-production indicators per revival
- **Logic:** For known revivals, manually specify wrong indicators
- **Output:** Map of showId → wrongIndicators[]
- **False positive mitigation:**
  - Ignore venue mentions near "moving to", "transferring"
  - Require 2+ wrong indicators
- **Pass criteria:** Our Town has "Booth Theatre" in wrong indicators

### Task 2.5d: Run generic revival audit
- **Logic:** Apply indicators to all revivals
- **Pass criteria:** No false positives on non-revivals

### Task 2.5.5: Handle shows without historical data
- **Logic:**
  - Skip wrong-production checks for shows opened <30 days ago
  - Skip if <5 reviews (insufficient data)
  - Mark as "baseline pending" in report
- **Output:** List of shows in baseline pending status

### Task 2.6: Generate wrong-production report
- **Output:** `data/audit/wrong-production-reviews.json`
- **Format:**
```json
{
  "summary": { "shows_checked": N, "files_flagged": N, "baseline_pending": N },
  "flagged": [{ "showId": "", "file": "", "indicators_found": [], "confidence": "high|medium|low" }],
  "baseline_pending": []
}
```
- **Pass criteria:** files_flagged correctly identifies known issues

### Task 2.7: Sprint 2 validation
- **Tests:**
  1. Our Town 2024 - flags files with "Booth Theatre" or "2002"
  2. Hamilton 2015 - ZERO flags (no prior production)
  3. Cabaret 2024 - flags "Studio 54" references
- **Pass criteria:**
  - Known wrong reviews flagged
  - False positive rate < 10%
- **Commit:** Scripts + report

---

## Sprint 3: Score Conversion Audit
**Goal:** Verify assignedScore correctly reflects originalRating.

**Demo:** Script that flags miscalculated scores with expected vs actual.

### Task 3.1: Document conversion rules
- **File:** `scripts/lib/score-conversion-rules.js`
- **Rules:**
  - Letter: A+=97, A=93, A-=90, B+=87, B=83, B-=80, C+=77, C=73, C-=70, D=60, F=50
  - Stars/5: 5=100, 4.5=90, 4=80, 3.5=70, 3=60, 2.5=50, 2=40, 1=20, 0=0
  - Stars/4: 4=100, 3.5=88, 3=75, 2.5=63, 2=50, 1=25, 0=0
  - Sentiment: Rave=90, Positive=75, Mixed=60, Negative=40, Pan=25
  - Thumbs: Up=80, Meh=60, Down=40
- **Exports:** validateScore(originalRating, assignedScore) → {valid, expected, difference}
- **Pass criteria:** Module exports work for all rating types

### Task 3.2: Create score audit script
- **File:** `scripts/audit-score-conversions.js`
- **Input:** `data/reviews.json`
- **Logic:**
  - Extract reviews with both originalRating and assignedScore
  - Parse originalRating format
  - Calculate expected score
  - Flag if |expected - actual| > 10
- **Pass criteria:** Parses all known rating formats

### Task 3.3a: Handle star rating variations
- **Patterns:** "X out of Y", "X/Y", "X stars", "X star"
- **Test cases:** "3.5 out of 5", "4/5", "3 stars"
- **Pass criteria:** All patterns parsed correctly

### Task 3.3b: Handle grade ranges
- **Patterns:** "B+/A-", "B+ to A-", "B+/A-"
- **Logic:** Average the two grades
- **Pass criteria:** "B+/A-" → 88.5

### Task 3.3c: Identify designation-only entries
- **Patterns:** "Recommended", "Critics Pick", "Must See"
- **Logic:** Flag as NOT scoreable (bumps, not base scores)
- **Pass criteria:** "Critics Pick" not flagged as miscalculation

### Task 3.3d: Handle null/missing original ratings
- **Logic:** Skip (don't flag as error)
- **Output:** Count for reference
- **Pass criteria:** Null ratings don't cause errors

### Task 3.4: Generate score audit report
- **Output:** `data/audit/score-conversion-audit.json`
- **Format:**
```json
{
  "summary": { "total_with_both": N, "correct": N, "miscalculated": N, "unparseable": N },
  "miscalculated": [{ "showId": "", "outlet": "", "originalRating": "", "assignedScore": N, "expectedScore": N }],
  "unparseable": [{ "showId": "", "outlet": "", "originalRating": "" }]
}
```
- **Pass criteria:** miscalculation_rate < 5%

### Task 3.5: Spot-check miscalculations
- **Logic:**
  - If <20 miscalculated: check ALL
  - If 20-100: check random 10%
  - If >100: prioritize by score difference
- **Pass criteria:** Spot-checks confirm actual errors

### Task 3.5.5: Audit AI-scored reviews
- **Logic:**
  - Count reviews with assignedScore but NO originalRating
  - These were likely AI-derived from fullText
  - Flag for documentation (not necessarily errors)
- **Output:** Count and list of AI-scored reviews
- **Pass criteria:** All AI-scored reviews have fullText

### Task 3.6: Sprint 3 validation
- **Test:** Run on full reviews.json
- **Pass criteria:**
  - Miscalculation rate < 5%
  - Unparseable rate < 10%
  - All AI-scored reviews documented
- **Commit:** Conversion rules + audit script + report

---

## Sprint 4: Review Content Verification
**Goal:** Verify review content matches claimed outlet and show.

**Demo:** Script that flags content/metadata mismatches.

### Task 4.1: Create URL-outlet matcher
- **File:** `scripts/audit-review-content.js`
- **Logic:**
  - Extract base domain (handle subdomains, archive.org)
  - Map domain to expected outlet
  - Flag if mismatch
- **Domain handling:**
  - Strip subdomains (artsbeat.blogs.nytimes.com → nytimes.com)
  - Archive.org: extract original domain from path
- **Pass criteria:** Correctly maps 10 known domains

### Task 4.1.5: Audit reviews without URLs
- **Logic:**
  - Count reviews where url is null/empty
  - Verify they have outlet + critic (minimum metadata)
- **Output:** List of URL-less reviews by show
- **Pass criteria:** All URL-less reviews have minimum metadata

### Task 4.2: Create show-mention checker
- **Logic (layered, any 1 must pass):**
  1. Exact title match (case-insensitive)
  2. Partial title match (first 2+ words)
  3. Venue mention (from shows.json)
  4. Cast/creative name (any match)
  5. Year match (for dated shows)
- **Flag:** Only if ZERO matches (high confidence wrong show)
- **Pass criteria:** Correctly identifies show mention in test reviews

### Task 4.2.5: Audit excerpt-only reviews
- **Logic:**
  - Flag reviews where fullText is null/empty
  - Verify at least one excerpt exists
  - Flag if excerpt < 50 chars (truncated?)
  - Flag if NO excerpt AND no fullText (orphan)
- **Output:** Orphan count, truncated count
- **Pass criteria:** Orphan count = 0

### Task 4.5: Sample and verify 50 reviews
- **Selection:** Random, stratified by outlet tier
- **Checks:** URL match, show mention, no red flags
- **Output:** Per-review pass/fail

### Task 4.6: Generate content verification report
- **Output:** `data/audit/review-content-audit.json`
- **Format:**
```json
{
  "summary": { "sampled": 50, "passed": N, "failed": N, "orphan_reviews": N, "url_less": N },
  "failures": [{ "file": "", "checks_failed": [], "details": "" }]
}
```
- **Pass criteria:** Pass rate > 90%

### Task 4.7: Date consistency check
- **Logic:** Flag reviews with publishDate:
  - >1 year after opening (except anniversary)
  - Before previews start (impossible)
- **Pass criteria:** Catches test case of review dated 2018 for 2024 show

### Task 4.8: Sprint 4 validation
- **Test:** Run content verification
- **Pass criteria:**
  - Pass rate > 90%
  - Orphan reviews = 0
  - Date anomalies < 5%
- **Commit:** Audit script + report

---

## Sprint 5: Consolidated Report & Fixes
**Goal:** Aggregate findings and execute fixes.

**Demo:** Single summary report with all fixes applied.

### Task 5.0: Conflict resolution protocol
- **Priority order:** Content issues > Duplicate merging > Score fixes
- **Logic:** If content flagged AND duplicate merge requested, hold merge
- **Document:** Resolution rules in report

### Task 5.1: Create consolidated audit runner
- **File:** `scripts/run-full-data-audit.js`
- **Logic:** Run all 4 audit scripts in sequence
- **Output:** Combined summary
- **Pass criteria:** All sub-audits complete

### Task 5.2: Generate master audit report
- **Output:** `data/audit/master-audit-report.json`
- **Format:**
```json
{
  "timestamp": "",
  "confidence_score": N,
  "audits": {
    "file_integrity": { "status": "", "issues": N },
    "duplicates": { "status": "", "issues": N },
    "wrong_production": { "status": "", "issues": N },
    "score_conversion": { "status": "", "issues": N },
    "content_verification": { "status": "", "issues": N }
  },
  "priority_fixes": []
}
```

### Task 5.3: Create fix scripts (if issues found)
- `scripts/fix-duplicate-reviews.js --dry-run`
- `scripts/fix-wrong-production-reviews.js --dry-run`
- `scripts/fix-score-conversions.js --dry-run`
- **All support --dry-run mode**
- **Pass criteria:** Dry-run shows reasonable changes

### Task 5.4: Execute fixes
- **Only if:** Dry-run approved
- **Run:** Each fix script
- **Pass criteria:** No errors

### Task 5.5: Re-run all audits
- **Test:** Full audit suite after fixes
- **Pass criteria:** Issue counts reduced to acceptable levels

### Task 5.6: Sprint 5 validation
- **Pass criteria:**
  - Confidence score >= 90
  - All critical issues resolved
  - Reports committed
- **Commit:** Fix scripts + final reports

---

## Execution Strategy

### Parallelization
- **Parallel:** Sprints 1, 2, 3, 4 (independent audits)
- **Sequential:** Sprint 5 after 1-4 complete
- **Within sprints:** Tasks 2.2-2.4 parallel, Tasks 3.3a-3.3d parallel

### Error Handling
- Scripts catch and log errors, don't crash
- Partial results acceptable
- Unknown formats logged, not failed

### Test Fixtures
- Create `tests/fixtures/audit/` with intentionally broken files
- Each audit script must catch planted errors
- Document expected catches per script

### Commit Strategy
- One commit per sprint completion
- Message: "audit: Sprint N - [goal]"

---

## Success Criteria

| Metric | Target | Weight |
|--------|--------|--------|
| File integrity issues | 0 | Required |
| Cross-show URL dupes | 0 | Required |
| Duplicate rate | < 5% | 25% |
| Wrong-production rate | 0% | 25% |
| Score accuracy | > 95% | 30% |
| Content pass rate | > 90% | 20% |
| **Overall confidence** | **>= 90** | - |

---

Use subagents liberally!
