# Review Data Governance Plan - Final Version

**Goal:** Fix the processes that create bad data, then clean the existing data.

**Core Insight:** This is a **data governance problem**, not just a data migration problem. We must fix the entry points before cleaning up.

**Version:** Final (incorporates critiques from OpenAI GPT-4o, Claude agents)

---

## Current State (Baseline Metrics)

Before starting, we measure what we're fixing:

| Issue | Count | Target |
|-------|-------|--------|
| Duplicate critics | 141 | 0 |
| Unknown outlets | 48 | 0 |
| Bad display names | 24 | 0 |
| Null publish dates | 300 | <50 (some legitimately unknown) |
| Null critic names | 8 | 0 |
| Designation in critic name | 2 | 0 |

**Success Metric:** Run audit script before and after each phase to track progress.

---

## Root Cause Analysis

### Why We Have Bad Data

1. **Multiple entry points with inconsistent normalization**
   - `gather-reviews.js` - uses normalization module
   - `extract-bww-reviews.js` - has its own OUTLET_MAP (not synced)
   - `extract-dtli-reviews.js` - unknown normalization status
   - `extract-show-score-reviews.js` - unknown normalization status
   - `collect-review-texts.js` - creates files without normalization

2. **Normalization happens at the WRONG time**
   - Current: Extract raw data → Save to file → Normalize during rebuild
   - Should be: Normalize BEFORE saving → Filename is already canonical

3. **rebuild-all-reviews.js has a display name bug** (line 727-728)
   ```javascript
   outlet: data.outlet || data.outletId || 'Unknown'  // ← Never calls getOutletDisplayName()
   ```

4. **Dangerous first-name matching in areCriticsSimilar()**
   - "Jesse Green" matches "Jesse Oxfeld" (both real critics!)
   - Creates FALSE POSITIVES that merge different reviewers

5. **No pre-commit validation for review files**
   - Can commit `unknown--unknown.json` without any checks

6. **Incomplete outlet/critic alias registry**
   - 210 unique outlets in data, but only ~60 aliases defined

---

## Quick Wins (Ship Immediately)

These can be done TODAY before the main plan starts:

### QW-1: Fix Display Name Bug (30 minutes)

In `scripts/rebuild-all-reviews.js`, change line 727-728 from:
```javascript
outlet: data.outlet || data.outletId || 'Unknown'
```

To:
```javascript
outlet: getOutletDisplayName(data.outletId) || data.outlet || 'Unknown'
```

### QW-2: Remove Dangerous First-Name Matching (1 hour)

In `scripts/lib/review-normalization.js`, REMOVE lines 427-433:
```javascript
// DELETE THIS - it creates false positives
const firstName1 = c1.split(/\s+/)[0];
const firstName2 = c2.split(/\s+/)[0];
if (firstName1 === firstName2 && firstName1.length > 2) {
  if (c1.startsWith(firstName2) || c2.startsWith(firstName1)) {
    return true;
  }
}
```

### QW-3: Delete Garbage Reviews (1 hour)

Remove all review files where:
- `outletId === "unknown"` AND `criticName === "Unknown"`
- These are unparseable garbage that add noise

```bash
node scripts/delete-garbage-reviews.js --dry-run  # Preview
node scripts/delete-garbage-reviews.js            # Execute
```

### QW-4: Run Baseline Audit (30 minutes)

```bash
node scripts/audit-data-quality.js > data/audit/baseline-2026-01-30.json
```

This establishes our starting point for measuring improvement.

---

## Phase 0: Fix the Broken Foundation (Week 1, Days 1-3)

**Goal:** Fix the code that creates bad data BEFORE extracting anything new.

### Step 0.1: Create Outlet Registry (Single Source of Truth)

Create `data/outlet-registry.json`:
```json
{
  "_meta": {
    "description": "Canonical outlet registry - ALL scripts must use this",
    "version": "1.0.0",
    "lastUpdated": "2026-01-30"
  },
  "outlets": {
    "nytimes": {
      "displayName": "The New York Times",
      "tier": 1,
      "aliases": ["nytimes", "new york times", "the new york times", "ny times", "nyt"],
      "domain": "nytimes.com"
    }
  }
}
```

**Registry Safeguards (addressing critique):**
- Version controlled in git
- JSON schema validation on commit
- Backup copy in `data/outlet-registry.backup.json`
- Script to validate registry integrity: `scripts/validate-outlet-registry.js`

### Step 0.2: Audit All Existing Outlets

```bash
node scripts/audit-outlets.js > data/audit/outlet-audit.json
```

Output:
- All unique `outlet` values
- All unique `outletId` values
- Which ones have no display name mapping
- Which ones have no tier assignment

**Acceptance criteria:** Every outlet in the data must exist in outlet-registry.json

### Step 0.3: Audit All Existing Critics

```bash
node scripts/audit-critics.js > data/audit/critic-audit.json
```

Output:
- All unique critic names by outlet
- Potential duplicates (same last name + same outlet)
- Names that look like garbage ("Photo Credit", "Advertisement")

### Step 0.4: Create Centralized Validation Service

**Addressing critique about scattered validation:**

Create `scripts/lib/review-validator.js` - ONE place for all validation:

```javascript
const { getOutletRegistry } = require('./outlet-registry');
const { isGarbageCriticName, normalizeOutlet, normalizeCritic } = require('./review-normalization');

class ReviewValidator {
  constructor() {
    this.registry = getOutletRegistry();
    this.errors = [];
    this.warnings = [];
  }

  validate(reviewData) {
    this.errors = [];
    this.warnings = [];

    // Required fields
    if (!reviewData.outletId) {
      this.errors.push('Missing outletId');
    }
    if (!reviewData.criticName) {
      this.errors.push('Missing criticName');
    }

    // Outlet must be in registry
    if (reviewData.outletId && !this.registry[reviewData.outletId]) {
      this.errors.push(`Unknown outlet: ${reviewData.outletId}`);
    }

    // Critic name must not be garbage
    if (isGarbageCriticName(reviewData.criticName)) {
      this.errors.push(`Garbage critic name: ${reviewData.criticName}`);
    }

    // Warn on null dates (not an error, but track it)
    if (!reviewData.publishDate) {
      this.warnings.push('Missing publishDate');
    }

    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings
    };
  }

  // Normalize and validate in one call
  normalizeAndValidate(reviewData) {
    const normalized = {
      ...reviewData,
      outletId: normalizeOutlet(reviewData.outletId || reviewData.outlet),
      criticName: normalizeCritic(reviewData.criticName || reviewData.critic),
      outlet: null // Will be set from registry
    };

    // Set display name from registry
    if (this.registry[normalized.outletId]) {
      normalized.outlet = this.registry[normalized.outletId].displayName;
    }

    const validation = this.validate(normalized);
    return { normalized, validation };
  }
}

module.exports = { ReviewValidator };
```

**All extraction scripts use this ONE validator** - no scattered validation logic.

### Step 0.5: Update All Extraction Scripts

Every extraction script must:
1. Import `ReviewValidator`
2. Call `normalizeAndValidate()` BEFORE generating filename
3. Only save if validation passes
4. Log warnings for tracking

**Scripts to update:**
- `gather-reviews.js`
- `extract-bww-reviews.js`
- `extract-dtli-reviews.js`
- `extract-show-score-reviews.js`
- `collect-review-texts.js`

### Step 0.6: Run Audit After Phase 0

```bash
node scripts/audit-data-quality.js > data/audit/after-phase0.json
node scripts/compare-audits.js baseline-2026-01-30.json after-phase0.json
```

**Expected improvement:** Display name bug fixed, no new garbage can be created.

---

## Phase 1: Proof of Concept (Week 1, Days 4-5)

**Goal:** Validate the fixed pipeline works on multiple test shows.

### Step 1.1: Choose Test Shows (Progressive Rollout)

Instead of ONE show, test on FIVE shows with different characteristics:

| Show | Why Selected |
|------|--------------|
| oedipus-2025 | Known duplicates, unknown outlets |
| hamilton-2015 | High review count, long history |
| hadestown-2019 | Mix of outlet types |
| oh-mary-2024 | Recent, should be clean |
| wicked-2003 | Historical, potential legacy issues |

### Step 1.2: Automated Audit (Not Manual)

**Addressing critique about manual audit risk:**

Create `scripts/audit-show-reviews.js`:
```bash
node scripts/audit-show-reviews.js --show=oedipus-2025 > data/audit/oedipus-2025-audit.json
```

This automatically detects:
- Duplicate reviews (same critic + same outlet)
- Unknown outlets
- Missing display names
- Suspicious critic names
- Null dates

**Human review is only for EXCEPTIONS** flagged by automation, not for all reviews.

### Step 1.3: Run Fixed Rebuild on Test Shows

```bash
node scripts/rebuild-show-reviews.js --shows=oedipus-2025,hamilton-2015,hadestown-2019,oh-mary-2024,wicked-2003
```

### Step 1.4: Compare Before/After

```bash
node scripts/compare-show-quality.js --shows=oedipus-2025,hamilton-2015,hadestown-2019,oh-mary-2024,wicked-2003
```

Expected output:
```
oedipus-2025:
  - Duplicates: 4 → 0 ✓
  - Unknown outlets: 2 → 0 ✓
  - Bad display names: 3 → 0 ✓

hamilton-2015:
  - Duplicates: 0 → 0 ✓
  - Unknown outlets: 0 → 0 ✓
  ...
```

### Step 1.5: Iterate Until Clean

If issues found:
1. Identify WHY (add alias, fix regex, etc.)
2. Fix the root cause in the centralized validator/registry
3. Re-run rebuild
4. Re-compare

**Do not proceed to Phase 2 until all 5 test shows pass.**

---

## Phase 2: Full Cleanup (Week 2, Days 1-4)

**Goal:** Run the validated pipeline on all shows.

### Step 2.1: Batch Processing with Progress Tracking

Process in batches of 10 shows:

```bash
# Batch 1
node scripts/rebuild-show-reviews.js --batch=1
node scripts/audit-batch.js --batch=1
# Review results, proceed if clean

# Batch 2
node scripts/rebuild-show-reviews.js --batch=2
# etc.
```

### Step 2.2: Validation Gates (Hard Stops)

Each batch must pass:
- Zero files with `outletId: "unknown"` (except known edge cases)
- Zero files with `criticName: "Unknown"`
- Zero files where `outlet === outletId` (display name missing)
- Zero duplicate critic+outlet combinations per show
- All outlets have valid tiers

**If ANY check fails:** Stop, fix root cause, re-run batch.

### Step 2.3: Handle Null Dates (Addressing Critique Gap)

**New step specifically for the 300 null dates:**

1. **Audit null dates:**
   ```bash
   node scripts/audit-null-dates.js > data/audit/null-dates.json
   ```

2. **Categorize:**
   - **Recoverable:** Date exists in excerpt, URL, or filename → Extract it
   - **Researchable:** Can find date via web search → Queue for lookup
   - **Legitimately unknown:** Very old reviews, no date available → Mark as `dateUnknown: true`

3. **Fix what we can:**
   ```bash
   node scripts/fix-recoverable-dates.js
   ```

4. **Accept what we can't:**
   Some dates are genuinely unknown. Target: <50 null dates (down from 300).

### Step 2.4: Run Full Audit After Phase 2

```bash
node scripts/audit-data-quality.js > data/audit/after-phase2.json
node scripts/compare-audits.js baseline-2026-01-30.json after-phase2.json
```

---

## Phase 3: Deploy and Verify (Week 2, Day 5)

**Goal:** Rebuild reviews.json and deploy to production.

### Step 3.1: Final Rebuild

```bash
node scripts/rebuild-all-reviews.js
```

### Step 3.2: Pre-Deploy Validation

```bash
node scripts/validate-data.js
npm run test:data
```

### Step 3.3: Deploy

```bash
git add data/
git commit -m "fix: Complete review data cleanup - fixed duplicates, outlet names, critic normalization

Metrics improvement:
- Duplicates: 141 → 0
- Unknown outlets: 48 → 0
- Bad display names: 24 → 0
- Null dates: 300 → ~40 (legitimately unknown)
- Null critics: 8 → 0"
git push origin main
```

### Step 3.4: Post-Deploy Verification

Check these shows on live site:
- [ ] Oedipus - no duplicates, proper outlet names
- [ ] Hamilton - proper display names
- [ ] Wicked - no unknown outlets
- [ ] Book of Mormon - no null critics
- [ ] Oh Mary - clean recent show

---

## Phase 4: Prevention (Week 3)

**Goal:** Make it impossible to commit bad data.

### Step 4.1: Pre-Commit Hook

Add `.husky/pre-commit`:
```bash
#!/bin/sh
node scripts/validate-review-files.js --staged-only
if [ $? -ne 0 ]; then
  echo "ERROR: Review file validation failed"
  echo "Run 'node scripts/validate-review-files.js' for details"
  exit 1
fi
```

### Step 4.2: CI/CD Validation

Add to `.github/workflows/test.yml`:
```yaml
- name: Validate Review Data
  run: |
    node scripts/validate-review-files.js
    node scripts/audit-data-quality.js --fail-on-regression
```

### Step 4.3: Data Quality Dashboard (Addressing Critique)

Create simple dashboard that runs weekly:

```bash
node scripts/generate-quality-report.js
```

Outputs to `data/audit/weekly-report.json`:
```json
{
  "weekEnding": "2026-02-07",
  "metrics": {
    "totalReviews": 2195,
    "duplicates": 0,
    "unknownOutlets": 0,
    "nullDates": 42,
    "nullCritics": 0
  },
  "trend": {
    "duplicates": "stable",
    "unknownOutlets": "stable",
    "nullDates": "-2 from last week"
  }
}
```

### Step 4.4: Weekly Integrity Check (GitHub Action)

```yaml
name: Weekly Data Quality Check
on:
  schedule:
    - cron: '0 6 * * 0'  # Sundays at 6 AM UTC
jobs:
  quality-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run quality audit
        run: |
          node scripts/audit-data-quality.js --compare-to-baseline
      - name: Create issue if regression
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: 'Data Quality Regression Detected',
              body: 'Weekly audit found issues. Check workflow logs.',
              labels: ['data-quality', 'automated']
            })
```

### Step 4.5: Feedback Loop (Addressing Critique)

When users report data issues via `/feedback`:
1. AI categorizes as "Content Error"
2. If it's a duplicate/outlet issue, script checks if it's a known pattern
3. If new pattern found, add to registry/aliases
4. Close loop by fixing and notifying

---

## Files to Create

| File | Purpose | Phase |
|------|---------|-------|
| `data/outlet-registry.json` | Single source of truth for outlets | 0 |
| `scripts/lib/review-validator.js` | Centralized validation service | 0 |
| `scripts/audit-outlets.js` | Find all unique outlets | 0 |
| `scripts/audit-critics.js` | Find all critic variations | 0 |
| `scripts/audit-data-quality.js` | Comprehensive quality audit | 0 |
| `scripts/audit-null-dates.js` | Categorize null dates | 2 |
| `scripts/fix-recoverable-dates.js` | Extract dates from text | 2 |
| `scripts/delete-garbage-reviews.js` | Remove unknown--unknown files | QW |
| `scripts/compare-audits.js` | Before/after comparison | 1 |
| `scripts/generate-quality-report.js` | Weekly dashboard | 4 |
| `.husky/pre-commit` | Pre-commit validation hook | 4 |

## Files to Modify

| File | Change | Phase |
|------|--------|-------|
| `scripts/lib/review-normalization.js` | Remove dangerous first-name matching | QW |
| `scripts/rebuild-all-reviews.js` | Fix display name bug (line 727-728) | QW |
| `scripts/gather-reviews.js` | Use centralized validator | 0 |
| `scripts/extract-bww-reviews.js` | Use centralized validator | 0 |
| `scripts/extract-dtli-reviews.js` | Use centralized validator | 0 |
| `scripts/extract-show-score-reviews.js` | Use centralized validator | 0 |
| `scripts/collect-review-texts.js` | Use centralized validator | 0 |
| `.github/workflows/test.yml` | Add review file validation | 4 |

---

## Timeline (Realistic - 3 Weeks)

| Week | Day | Phase | Deliverable |
|------|-----|-------|-------------|
| 1 | 1 | Quick Wins | Fix display bug, remove first-name match, delete garbage, baseline |
| 1 | 2-3 | Phase 0 | Outlet registry, centralized validator, script updates |
| 1 | 4-5 | Phase 1 | POC on 5 test shows, iterate until clean |
| 2 | 1-4 | Phase 2 | Full cleanup all shows, null date handling |
| 2 | 5 | Phase 3 | Deploy to production, verify |
| 3 | 1-5 | Phase 4 | Pre-commit hooks, CI validation, dashboard, weekly checks |

**Buffer:** Week 3 also serves as buffer for any Phase 2 issues that spill over.

---

## Success Criteria

| Metric | Baseline | Target | Measured By |
|--------|----------|--------|-------------|
| Duplicate reviews | 141 | 0 | `audit-data-quality.js` |
| Unknown outlets | 48 | 0 | `audit-data-quality.js` |
| Missing display names | 24 | 0 | `audit-data-quality.js` |
| Null publish dates | 300 | <50 | `audit-data-quality.js` |
| Null critic names | 8 | 0 | `audit-data-quality.js` |
| Designation in critic name | 2 | 0 | `audit-data-quality.js` |
| Pre-commit validation | N/A | 100% pass | Git hooks |
| CI validation | N/A | 100% pass | GitHub Actions |
| Weekly regression | N/A | 0 new issues | Weekly audit |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Outlet registry corruption | Version control + backup file + validation script |
| Lose existing fullText | Rebuild preserves all existing data, only changes metadata |
| Lose existing LLM scores | Rebuild preserves all existing data |
| Timeline slips | Week 3 is buffer; prioritize quick wins for immediate impact |
| Miss legitimate reviews | Automated audit catches more than manual; human review only for exceptions |
| New bad data after deploy | Pre-commit hooks + CI validation + weekly checks |

---

## Key Principles

1. **Fix the process, not just the data** - Bad data will recur if we don't fix the entry points
2. **Single source of truth** - One registry, one validator, used everywhere
3. **Centralize validation** - One `ReviewValidator` class, not scattered checks
4. **Automate auditing** - Manual review only for exceptions
5. **Measure before and after** - Every phase has metrics
6. **Progressive rollout** - 5 test shows, then batches, not all at once
7. **Prevent > Detect > Fix** - In that order of priority
8. **Build in feedback loops** - Weekly checks, user reports close the loop

---

## Appendix: Critique Sources

This plan incorporates feedback from:
- Initial Claude agent critique
- OpenAI GPT-4o (two separate critiques)
- Final Claude agent critique

Key changes from v2 based on critiques:
1. Extended timeline from 5 days to 3 weeks
2. Added explicit null date handling phase
3. Centralized validation (single validator class)
4. Progressive rollout (5 shows, not 1)
5. Added metrics/measurements throughout
6. Added data quality dashboard
7. Added feedback loop mechanism
8. Reduced reliance on manual auditing
