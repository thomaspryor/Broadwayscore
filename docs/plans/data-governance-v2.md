# Review Data Governance Plan v2

**Goal:** Fix the processes that create bad data, then clean the existing data.

**Core Insight:** This is a **data governance problem**, not just a data migration problem. We must fix the entry points before cleaning up.

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
   - 62 first-name variations not handled

---

## Phase 0: Fix the Broken Foundation (Day 1)

**Goal:** Fix the code that creates bad data BEFORE extracting anything new.

### Step 0.1: Create Outlet Registry (Single Source of Truth)

Create `data/outlet-registry.json`:
```json
{
  "_meta": {
    "description": "Canonical outlet registry - ALL scripts must use this",
    "lastUpdated": "2026-01-30"
  },
  "outlets": {
    "nytimes": {
      "displayName": "The New York Times",
      "tier": 1,
      "aliases": ["nytimes", "new york times", "the new york times", "ny times", "nyt"],
      "domain": "nytimes.com"
    },
    "latimes": {
      "displayName": "Los Angeles Times",
      "tier": 2,
      "aliases": ["latimes", "la times", "los angeles times"],
      "domain": "latimes.com"
    }
    // ... all 210+ outlets
  }
}
```

**Why:** Scattered aliases in code = inconsistency. Single registry = single source of truth.

### Step 0.2: Audit All Existing Outlets

Run audit to find all unique outlet names in existing data:
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

Run audit to find all critic name variations:
```bash
node scripts/audit-critics.js > data/audit/critic-audit.json
```

Output:
- All unique critic names by outlet
- Potential duplicates (same last name + same outlet)
- Names that look like garbage ("Photo Credit", "Advertisement", "&nbsp;Jeremy Gerard")

### Step 0.4: Fix Dangerous First-Name Matching

In `scripts/lib/review-normalization.js`, REMOVE this code (lines 427-433):
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

Replace with explicit aliases ONLY:
```javascript
// Only match critics that are KNOWN to be the same person
const CRITIC_ALIASES = {
  'jesse-green': ['jesse green', 'j. green', 'j green'],
  // NO first-name-only aliases
};
```

### Step 0.5: Fix Display Name Bug in rebuild-all-reviews.js

Change line 727-728 from:
```javascript
outlet: data.outlet || data.outletId || 'Unknown'
```

To:
```javascript
outlet: getOutletDisplayName(data.outletId) || data.outlet || 'Unknown'
```

### Step 0.6: Add Pre-Save Validation to All Extraction Scripts

Every script that creates review files must validate BEFORE saving:
```javascript
function validateBeforeSave(reviewData) {
  const errors = [];

  // Outlet must be in registry
  if (!outletRegistry[reviewData.outletId]) {
    errors.push(`Unknown outlet: ${reviewData.outletId}`);
  }

  // Critic name must not be garbage
  if (isGarbageCriticName(reviewData.criticName)) {
    errors.push(`Garbage critic name: ${reviewData.criticName}`);
  }

  // Must have valid tier
  if (!getOutletTier(reviewData.outletId)) {
    errors.push(`No tier for outlet: ${reviewData.outletId}`);
  }

  if (errors.length > 0) {
    console.error('VALIDATION FAILED:', errors);
    return false; // DO NOT SAVE
  }
  return true;
}
```

Add to:
- `gather-reviews.js`
- `extract-bww-reviews.js`
- `extract-dtli-reviews.js`
- `extract-show-score-reviews.js`
- `collect-review-texts.js`

### Step 0.7: Unify All Extraction Scripts to Use Registry

Every extraction script must:
1. Import from `outlet-registry.json`
2. Call `normalizeOutlet()` BEFORE generating filename
3. Call `normalizeCritic()` BEFORE generating filename
4. Validate before saving

---

## Phase 1: Proof of Concept with ONE Show (Day 1-2)

**Goal:** Validate the fixed pipeline works before scaling.

### Step 1.1: Choose Test Show

Pick a show with KNOWN issues:
- **oedipus-2025** - has duplicates, unknown outlets, bad display names

### Step 1.2: Manual Audit of Test Show

Before running any scripts:
1. List all files in `data/review-texts/oedipus-2025/`
2. Manually identify which are duplicates
3. Manually identify correct outlet/critic for each
4. Create `data/audit/oedipus-2025-ground-truth.json`

### Step 1.3: Run Fixed Extraction on Test Show

```bash
node scripts/extract-clean-reviews.js --show=oedipus-2025 --output=data/review-texts-test/
```

### Step 1.4: Compare to Ground Truth

```bash
node scripts/compare-to-ground-truth.js --show=oedipus-2025
```

Expected output:
- Matches ground truth: X/Y
- Missing reviews: [list]
- Extra reviews (false positives): [list]
- Wrong outlet assignments: [list]

### Step 1.5: Iterate Until Clean

If comparison fails:
1. Identify WHY it failed
2. Fix the root cause (add alias, fix regex, etc.)
3. Re-run extraction
4. Re-compare

**Do not proceed to Phase 2 until test show is 100% correct.**

---

## Phase 2: Expand to All Shows (Day 2-3)

**Goal:** Run the validated pipeline on all shows.

### Step 2.1: Batch Processing with Validation Gates

```bash
# Batch 1: 10 shows
node scripts/extract-clean-reviews.js --batch=1
node scripts/validate-batch.js --batch=1
# Must pass before continuing

# Batch 2: 10 shows
node scripts/extract-clean-reviews.js --batch=2
node scripts/validate-batch.js --batch=2
# etc.
```

### Step 2.2: Validation Gates (Hard Stops)

Each batch must pass these checks:
- Zero files with `outletId: "unknown"`
- Zero files with `criticName: "Unknown"`
- Zero files where `outlet === outletId` (display name missing)
- Zero duplicate critic+outlet combinations per show
- All outlets have valid tiers

If ANY check fails: **STOP. Fix. Re-run.**

### Step 2.3: Output

- `data/review-texts-clean/{showId}/` - Clean review files
- `data/audit/batch-{n}-report.json` - Per-batch validation results
- `data/audit/extraction-errors.json` - Any errors encountered

---

## Phase 3: Merge with Existing Data (Day 3-4)

**Goal:** Preserve valuable existing data (fullText, scores) while using clean metadata.

### Step 3.1: Hybrid Merge Strategy

For each show:
```
For each review in clean data:
  If matching review exists in old data:
    Use clean: outletId, outlet (display name), criticName, publishDate
    Keep old: fullText, llmScore, ensembleData, scrapedAt
  Else:
    Use clean data only
```

### Step 3.2: Handle Orphaned Old Reviews

Reviews in old data but not in clean:
- If `outlet === "unknown"` → DELETE (garbage)
- If duplicate of another review → DELETE
- If legitimate review we missed → FLAG for manual review

### Step 3.3: Validation After Merge

Run full validation suite:
- No duplicates
- No unknown outlets
- All display names proper
- All critics have names
- All dates valid or null (not garbage)

---

## Phase 4: Rebuild and Deploy (Day 4)

**Goal:** Rebuild reviews.json and deploy to production.

### Step 4.1: Final Rebuild

```bash
node scripts/rebuild-all-reviews.js
```

### Step 4.2: Pre-Deploy Validation

```bash
node scripts/validate-data.js
npm run test:data
```

### Step 4.3: Deploy

```bash
git add data/
git commit -m "fix: Complete review data cleanup - fixed duplicates, outlet names, critic normalization"
git push origin main
```

### Step 4.4: Post-Deploy Verification

Manually check 5 shows on live site:
- [ ] Oedipus - no duplicates, proper outlet names
- [ ] Hamilton - proper display names
- [ ] Wicked - no unknown outlets
- [ ] Book of Mormon - no null critics
- [ ] Cabaret - no designation in critic names

---

## Phase 5: Prevent Future Corruption (Day 5+)

**Goal:** Make it impossible to commit bad data.

### Step 5.1: Pre-Commit Hook

Add `.husky/pre-commit`:
```bash
#!/bin/sh
node scripts/validate-review-files.js --staged-only
if [ $? -ne 0 ]; then
  echo "ERROR: Review file validation failed"
  exit 1
fi
```

### Step 5.2: CI/CD Validation

Add to `.github/workflows/test.yml`:
```yaml
- name: Validate Review Data
  run: |
    node scripts/validate-review-files.js
    node scripts/check-for-duplicates.js
    node scripts/check-outlet-display-names.js
```

### Step 5.3: New Show Checklist

When adding a new show, the workflow must:
1. Validate all outlets are in registry
2. Validate all critics are normalized
3. Validate no duplicates
4. Validate all display names are proper
5. Only commit if ALL pass

### Step 5.4: Weekly Integrity Check

GitHub Action runs weekly:
- Scan all review files for issues
- Compare to outlet registry
- Flag any new unknown outlets
- Alert if any duplicates detected

---

## Files to Create

| File | Purpose |
|------|---------|
| `data/outlet-registry.json` | Single source of truth for outlets |
| `scripts/audit-outlets.js` | Find all unique outlets in data |
| `scripts/audit-critics.js` | Find all critic name variations |
| `scripts/validate-review-files.js` | Pre-commit and CI validation |
| `scripts/check-for-duplicates.js` | Detect duplicate reviews |
| `scripts/extract-clean-reviews.js` | Unified extraction with validation |
| `scripts/compare-to-ground-truth.js` | Compare extraction to manual audit |
| `.husky/pre-commit` | Pre-commit hook |

## Files to Modify

| File | Change |
|------|--------|
| `scripts/lib/review-normalization.js` | Remove dangerous first-name matching |
| `scripts/rebuild-all-reviews.js` | Fix display name bug (line 727-728) |
| `scripts/gather-reviews.js` | Add pre-save validation |
| `scripts/extract-bww-reviews.js` | Use outlet registry, add validation |
| `scripts/collect-review-texts.js` | Add pre-save validation |
| `.github/workflows/test.yml` | Add review file validation |

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Duplicate reviews | 0 |
| Unknown outlets | 0 |
| Missing display names | 0 |
| Designation in critic name | 0 |
| Null critic names | 0 |
| Pre-commit validation | 100% pass |
| CI validation | 100% pass |

---

## Key Principles

1. **Fix the process, not just the data** - Bad data will recur if we don't fix the entry points
2. **Single source of truth** - One registry, one normalization module, used everywhere
3. **Validate before save** - Never write a file without checking it first
4. **Proof of concept first** - Test on one show before scaling
5. **Hard stops on failure** - Don't proceed if validation fails
6. **Prevent > Detect > Fix** - In that order of priority

---

## Timeline

| Day | Phase | Deliverable |
|-----|-------|-------------|
| 1 | Phase 0 | Outlet registry, fixed normalization, fixed scripts |
| 1-2 | Phase 1 | Proof of concept on oedipus-2025 |
| 2-3 | Phase 2 | Clean extraction for all shows |
| 3-4 | Phase 3 | Merged data with preserved fullText/scores |
| 4 | Phase 4 | Deployed to production |
| 5+ | Phase 5 | Pre-commit hooks, CI validation |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Lose existing fullText | Hybrid merge preserves old fullText |
| Lose existing LLM scores | Hybrid merge preserves old scores |
| New extraction has bugs | Proof of concept catches bugs early |
| Rate limits during extraction | Batch processing with delays |
| Git conflicts | Single-threaded extraction, no parallel workflows |
| Miss legitimate reviews | Manual audit of outliers |
