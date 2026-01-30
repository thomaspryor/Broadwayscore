# Data Quality Improvements - Sprint Plan

**Last Updated:** 2026-01-30
**Status:** Ready for Implementation

---

## Executive Summary

This plan addresses critical data quality issues in the Broadway Scorecard review system. After two rounds of review (internal critique + architecture review), the scope has been reduced from 4 sprints/15 tasks to **2 sprints/8 tasks**.

### Key Issues to Fix

| Issue | Severity | Root Cause |
|-------|----------|------------|
| Levenshtein matching creates false positives | HIGH | `areCriticsSimilar()` matches "Helen Smith" with "Helen Smyth" |
| Outlet ID format mismatch | CRITICAL | `scoring.ts` uses 'NYT', registry uses 'nytimes' - scoring lookups fail |
| No CI validation for review-text files | MEDIUM | Bad data enters without detection |
| No ongoing integrity monitoring | LOW | Data drift goes unnoticed |

### What We Learned (Critique Findings)

1. ~~Display name bug~~ - **Does not exist** (code already calls `getOutletDisplayName()`)
2. ~~Create outlet registry~~ - **Already exists** at `data/outlet-registry.json`
3. ~~Critic registry~~ - **Scope creep** (existing `CRITIC_ALIASES` is sufficient)
4. **Outlet ID mismatch is critical** - Scoring may be defaulting to Tier 3 for Tier 1 outlets

---

## Sprint 1: Fix Scoring & Critic Matching

**Goal:** Fix the two bugs that corrupt data: Levenshtein false positives and outlet ID mismatch.

**Deliverable:** Scoring engine correctly applies tiers; no false positive critic matches.

### Task 1.1: Audit Levenshtein Matches

**Description:** Before removing Levenshtein matching, identify all critic pairs it currently matches. Categorize each as true positive (legitimate typo) or false positive (different people).

**Why:** We need to add true positives to `CRITIC_ALIASES` before removing Levenshtein, otherwise we'll create false negatives.

**Files to create:**
- `scripts/audit-levenshtein-matches.js`

**Script requirements:**
```javascript
// For each show's review-texts directory:
//   For each pair of critic names in that show:
//     If areCriticsSimilar() returns true via Levenshtein (not exact/alias):
//       Log the pair with file paths
// Output: JSON with all Levenshtein-matched pairs
```

**Acceptance Criteria:**
- [ ] Script runs without error: `node scripts/audit-levenshtein-matches.js`
- [ ] Output saved to `data/audit/levenshtein-matches.json`
- [ ] Each match categorized: `{"pair": ["name1", "name2"], "files": [...], "verdict": "true_positive|false_positive|unknown"}`

**Validation Command:**
```bash
mkdir -p data/audit && \
node scripts/audit-levenshtein-matches.js && \
cat data/audit/levenshtein-matches.json | jq '.matches | length'
```

**Pass Criteria:** Script completes, outputs valid JSON with match count.

---

### Task 1.2: Remove Levenshtein Matching + Add Aliases

**Description:** Remove Levenshtein distance matching from `areCriticsSimilar()`. Add all true positive typos from Task 1.1 audit to `CRITIC_ALIASES`.

**Files to modify:**
- `scripts/lib/review-normalization.js` (lines 520-524)
- `tests/unit/review-normalization.test.js` (line 419 and related)

**Changes:**
1. Comment out or remove Levenshtein check in `areCriticsSimilar()`:
   ```javascript
   // REMOVED: Levenshtein matching caused false positives
   // if (c1.length > 5 && c2.length > 5) {
   //   const distance = levenshteinDistance(c1, c2);
   //   if (distance <= 2) return true;
   // }
   ```
2. Add true positive typos from audit to `CRITIC_ALIASES` (lines 306-347)
3. Verify existing test at line 419 still passes (it tests aliased typo, not Levenshtein)
4. Add new test case: non-aliased similar names (e.g., "Helen Smith" vs "Helen Smyth") should return `false`

**Acceptance Criteria:**
- [ ] `areCriticsSimilar("Helen Smith", "Helen Smyth")` returns `false`
- [ ] `areCriticsSimilar("johnny oleksinki", "johnny oleksinski")` returns `true` (via alias)
- [ ] All unit tests pass: `node --test tests/unit/review-normalization.test.js`
- [ ] No regressions in existing critic matching

**Validation Command:**
```bash
node --test tests/unit/review-normalization.test.js && \
node -e "
const {areCriticsSimilar} = require('./scripts/lib/review-normalization');
console.assert(areCriticsSimilar('Helen Smith', 'Helen Smyth') === false, 'Should not match different critics');
console.assert(areCriticsSimilar('Jesse Green', 'Jesse Green') === true, 'Should match exact');
console.log('Critic matching tests passed');
"
```

**Pass Criteria:** All unit tests pass + manual verification passes.

---

### Task 1.3: Create Outlet ID Mapping Layer

**Description:** Create a mapping between `scoring.ts` uppercase IDs (NYT, VULT) and `outlet-registry.json` lowercase IDs (nytimes, vulture).

**Why:** The scoring engine's `getOutletConfig()` fails to find outlets because of ID format mismatch, causing incorrect tier assignments.

**Files to create:**
- `src/lib/outlet-id-mapper.ts`

**Files to modify:**
- `src/lib/engine.ts` (lines 236-256, `getOutletConfig()`)

**Implementation:**
```typescript
// outlet-id-mapper.ts
export const REGISTRY_TO_SCORING: Record<string, string> = {
  'nytimes': 'NYT',
  'vulture': 'VULT',
  'variety': 'VARIETY',
  'hollywood-reporter': 'THR',
  'ap': 'AP',
  // ... all tier 1 and 2 outlets
};

export const SCORING_TO_REGISTRY: Record<string, string> =
  Object.fromEntries(Object.entries(REGISTRY_TO_SCORING).map(([k, v]) => [v, k]));

export function toScoringId(registryId: string): string | undefined {
  return REGISTRY_TO_SCORING[registryId];
}

export function toRegistryId(scoringId: string): string | undefined {
  return SCORING_TO_REGISTRY[scoringId];
}
```

**Update engine.ts:**
```typescript
import { toScoringId } from './outlet-id-mapper';

export function getOutletConfig(outletId: string): OutletConfig {
  // Try direct lookup first
  if (outletId && OUTLET_TIERS[outletId]) {
    return { ...OUTLET_TIERS[outletId], id: outletId };
  }
  // Try mapping from registry format to scoring format
  const scoringId = toScoringId(outletId);
  if (scoringId && OUTLET_TIERS[scoringId]) {
    return { ...OUTLET_TIERS[scoringId], id: outletId };
  }
  // Default to tier 3
  return { tier: 3, weight: 0.4, id: outletId };
}
```

**Acceptance Criteria:**
- [ ] `toScoringId('nytimes')` returns `'NYT'`
- [ ] `toRegistryId('NYT')` returns `'nytimes'`
- [ ] `getOutletConfig('nytimes')` returns tier 1 config
- [ ] `getOutletConfig('NYT')` returns tier 1 config (backwards compatible)
- [ ] Build succeeds: `npm run build`

**Validation Command:**
```bash
npm run build && \
node -e "
const {getOutletConfig} = require('./dist/lib/engine');
const nyt = getOutletConfig('nytimes');
console.assert(nyt.tier === 1, 'nytimes should be tier 1, got: ' + nyt.tier);
const vult = getOutletConfig('vulture');
console.assert(vult.tier === 1, 'vulture should be tier 1, got: ' + vult.tier);
console.log('Outlet ID mapping tests passed');
"
```

**Pass Criteria:** Build succeeds + tier lookups return correct values.

---

### Task 1.4: Add Unit Tests for Outlet ID Mapper

**Description:** Create comprehensive unit tests for the outlet ID mapping layer.

**Files to create:**
- `tests/unit/outlet-id-mapper.test.mjs`

**Test cases:**
1. All tier 1 outlets map correctly (both directions)
2. All tier 2 outlets map correctly (both directions)
3. Unknown IDs return undefined (not throw)
4. Null/undefined inputs handled gracefully
5. `getOutletConfig()` integration test

**Acceptance Criteria:**
- [ ] Tests cover all tier 1 outlets (minimum 10)
- [ ] Tests cover all tier 2 outlets (minimum 15)
- [ ] Tests pass: `node --test tests/unit/outlet-id-mapper.test.mjs`

**Validation Command:**
```bash
node --test tests/unit/outlet-id-mapper.test.mjs
```

**Pass Criteria:** All tests pass.

---

### Sprint 1 Demo Verification

```bash
# 1. Run all unit tests
node --test tests/unit/

# 2. Verify scoring works correctly
npm run build && node -e "
const {getOutletConfig} = require('./dist/lib/engine');
['nytimes', 'vulture', 'variety', 'hollywood-reporter', 'nypost', 'theatremania'].forEach(id => {
  const cfg = getOutletConfig(id);
  console.log(id + ': tier ' + cfg.tier);
});
"

# 3. Verify critic matching is strict
node -e "
const {areCriticsSimilar} = require('./scripts/lib/review-normalization');
console.log('Helen Smith vs Helen Smyth:', areCriticsSimilar('Helen Smith', 'Helen Smyth'));
console.log('Jesse Green vs Jesse Green:', areCriticsSimilar('Jesse Green', 'Jesse Green'));
"
```

### Sprint 1 Rollback Plan

```bash
git checkout main -- \
  scripts/lib/review-normalization.js \
  tests/unit/review-normalization.test.js \
  src/lib/engine.ts

rm -f src/lib/outlet-id-mapper.ts tests/unit/outlet-id-mapper.test.mjs
rm -f scripts/audit-levenshtein-matches.js data/audit/levenshtein-matches.json
```

---

## Sprint 2: Validation & Monitoring

**Goal:** Prevent future data corruption through CI validation and ongoing monitoring.

**Deliverable:** CI catches bad review files; weekly integrity monitoring active.

**Prerequisites:** Sprint 1 completed.

### Task 2.1: Create Review-Text File Validator

**Description:** Create a validation script for individual review-text JSON files.

**Files to create:**
- `scripts/validate-review-texts.js`

**Validation checks (4 essential only):**
1. **Unknown outlets** - `outletId` must exist in `outlet-registry.json`
2. **Garbage critic names** - Must not match patterns: `/^photo/i`, `/^staff$/i`, `/^&nbsp;/`, `/^\s*$/`
3. **Duplicate reviews** - No two files with same outlet+critic in same show directory
4. **Required fields** - Must have `showId`, and either `outletId` or `outlet`

**NOT included (scope control):**
- Score distribution anomalies
- Text quality trends
- Date validation (too many edge cases)

**Output format:**
```json
{
  "summary": { "total": 1150, "passed": 1140, "failed": 10, "warnings": 5 },
  "errors": [
    { "file": "path/to/file.json", "check": "unknown_outlet", "message": "Outlet 'xyz' not in registry" }
  ],
  "warnings": [...]
}
```

**Acceptance Criteria:**
- [ ] Script exits 0 when all files valid
- [ ] Script exits 1 when any error found
- [ ] Can filter by show: `--show=hamilton-2015`
- [ ] Output is parseable JSON with `--json` flag

**Validation Command:**
```bash
node scripts/validate-review-texts.js --show=hamilton-2015 && echo "PASS" || echo "FAIL"
```

**Pass Criteria:** Script runs, produces valid output, catches intentionally bad test file.

---

### Task 2.2: Add Review-Text Validation to CI

**Description:** Integrate the new validator into the existing test.yml workflow.

**Files to modify:**
- `.github/workflows/test.yml`

**Changes:**
Add new step after existing data validation (around line 47):
```yaml
- name: Validate review-text files
  run: |
    node scripts/validate-review-texts.js --json > validation-results.json
    node -e "
      const r = require('./validation-results.json');
      console.log('Review-text validation:', r.summary.passed + '/' + r.summary.total + ' passed');
      if (r.summary.failed > 0) {
        console.error('Errors:', JSON.stringify(r.errors, null, 2));
        process.exit(1);
      }
    "
```

**Acceptance Criteria:**
- [ ] Workflow runs validation on push to main
- [ ] Workflow fails if validation errors found
- [ ] Validation results visible in workflow logs

**Validation Command:**
```bash
# Test locally
node scripts/validate-review-texts.js

# Verify workflow syntax
gh workflow view test.yml
```

**Pass Criteria:** Local validation passes; workflow syntax valid.

---

### Task 2.3: Create Weekly Integrity Monitoring Workflow

**Description:** Create a GitHub workflow that runs weekly, compares metrics to previous week, and creates issues on degradation.

**Files to create:**
- `.github/workflows/weekly-integrity.yml`
- `scripts/generate-integrity-report.js`

**Metrics tracked (4 essential only):**
1. Total review count (should not decrease)
2. Reviews with unknown outlets (should be 0)
3. Duplicate review count (should be 0)
4. reviews.json vs review-texts sync (counts should match)

**Workflow schedule:** Sundays 3 AM UTC

**Issue creation:** If any metric degrades by >5% or critical thresholds exceeded.

**History storage:** `data/integrity-history.json` (last 12 weeks)

**Acceptance Criteria:**
- [ ] Workflow runs on schedule without errors
- [ ] Report generated at `data/integrity-report.md`
- [ ] History updated at `data/integrity-history.json`
- [ ] Issue created when thresholds exceeded (test manually)

**Validation Command:**
```bash
# Test locally
node scripts/generate-integrity-report.js

# Trigger workflow
gh workflow run weekly-integrity.yml

# Check results
gh run list --workflow=weekly-integrity.yml --limit=1
```

**Pass Criteria:** Local script works; workflow runs successfully.

---

### Task 2.4: Create Audit Script for Outlet Registry Gaps

**Description:** Create a script that compares outlets in review-texts against the registry and identifies gaps.

**Files to create:**
- `scripts/audit-outlet-registry.js`

**Output:**
```json
{
  "summary": { "total_outlets_in_reviews": 95, "in_registry": 85, "missing": 10 },
  "missing_outlets": [
    { "outletId": "xyz", "count": 5, "example_file": "path/to/file.json" }
  ],
  "suggested_additions": [
    { "outletId": "xyz", "displayName": "XYZ News", "tier": 3, "aliases": ["xyz"] }
  ]
}
```

**Acceptance Criteria:**
- [ ] Script identifies all outlets not in registry
- [ ] Script suggests registry entry format for each missing outlet
- [ ] Can be run with `--update` to auto-add entries (with confirmation)

**Validation Command:**
```bash
mkdir -p data/audit && \
node scripts/audit-outlet-registry.js > data/audit/outlet-registry-gaps.json && \
cat data/audit/outlet-registry-gaps.json | jq '.summary'
```

**Pass Criteria:** Script runs, identifies any gaps, outputs valid JSON.

---

### Sprint 2 Demo Verification

```bash
# 1. Run review-text validation
node scripts/validate-review-texts.js

# 2. Check outlet registry completeness
node scripts/audit-outlet-registry.js | jq '.summary'

# 3. Generate integrity report
node scripts/generate-integrity-report.js
cat data/integrity-report.md

# 4. Verify CI integration
gh workflow run test.yml
gh run watch  # wait for completion
```

### Sprint 2 Rollback Plan

```bash
git checkout main -- .github/workflows/test.yml

rm -f scripts/validate-review-texts.js
rm -f scripts/generate-integrity-report.js
rm -f scripts/audit-outlet-registry.js
rm -f .github/workflows/weekly-integrity.yml
rm -f data/integrity-history.json data/integrity-report.md
rm -f data/audit/outlet-registry-gaps.json
```

---

## Task Dependency Graph

```
Sprint 1:
  1.1 Audit Levenshtein ─────┐
                             ├──► 1.2 Remove Levenshtein + Add Aliases
  (existing CRITIC_ALIASES) ─┘

  1.3 Create Outlet ID Mapper ──► 1.4 Unit Tests for Mapper

Sprint 2 (depends on Sprint 1):
  2.1 Create Review-Text Validator ──► 2.2 Add to CI

  2.3 Weekly Integrity Workflow (independent)

  2.4 Audit Outlet Registry Gaps (independent)
```

---

## Success Criteria

| Metric | Before | After | Verification |
|--------|--------|-------|--------------|
| False positive critic matches | Unknown | 0 | Unit tests pass |
| Tier 1 outlets scored as tier 1 | Unknown (likely failing) | 100% | `getOutletConfig('nytimes').tier === 1` |
| CI catches bad review files | No | Yes | Workflow blocks bad PRs |
| Weekly integrity monitoring | No | Yes | Workflow runs, history tracked |
| Unknown outlets in registry | ~10 | 0 | Audit script shows 0 gaps |

---

## Files Summary

### New Files (8)
| File | Sprint | Task |
|------|--------|------|
| `scripts/audit-levenshtein-matches.js` | 1 | 1.1 |
| `src/lib/outlet-id-mapper.ts` | 1 | 1.3 |
| `tests/unit/outlet-id-mapper.test.mjs` | 1 | 1.4 |
| `scripts/validate-review-texts.js` | 2 | 2.1 |
| `scripts/generate-integrity-report.js` | 2 | 2.3 |
| `scripts/audit-outlet-registry.js` | 2 | 2.4 |
| `.github/workflows/weekly-integrity.yml` | 2 | 2.3 |
| `data/integrity-history.json` | 2 | 2.3 |

### Modified Files (4)
| File | Sprint | Task |
|------|--------|------|
| `scripts/lib/review-normalization.js` | 1 | 1.2 |
| `tests/unit/review-normalization.test.js` | 1 | 1.2 |
| `src/lib/engine.ts` | 1 | 1.3 |
| `.github/workflows/test.yml` | 2 | 2.2 |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Removing Levenshtein creates false negatives | Audit first, add aliases for true positive typos |
| Outlet ID mapper incomplete | Start with tier 1/2, add others as discovered |
| CI validation too strict | Start with 4 essential checks only |
| Weekly workflow creates noise | Only create issues for >5% degradation |

---

## Execution Notes

1. **Each task is independently committable** - Commit after each task completion
2. **Run validation after each commit** - `npm run build && node --test tests/unit/`
3. **Sprint 1 must complete before Sprint 2** - Mapping layer needed for validation
4. **Parallel execution within sprints** - Tasks 1.3/1.4 can run parallel to 1.1/1.2

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-30 | Initial plan created |
| 2026-01-30 | Critique review: Removed display name bug (doesn't exist), removed outlet registry creation (already exists), removed critic registry (scope creep) |
| 2026-01-30 | Added outlet ID format mismatch task (critical gap identified) |
| 2026-01-30 | Reduced from 4 sprints to 2 sprints |

---

Use subagents liberally! For all parts.
