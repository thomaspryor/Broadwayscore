# Validation Sprint Plan

**Goal:** Validate and fix all concerns from the autonomous pipeline work.

---

## Sprint V1: Rebuild reviews.json & Validate Site Data
**Purpose:** Ensure the live site reflects all our changes.

### Tasks:
1. Run `node scripts/rebuild-all-reviews.js`
2. Run `node scripts/validate-data.js`
3. Compare review counts before/after
4. Verify no broken references

### Validation:
- [ ] reviews.json regenerated successfully
- [ ] validate-data.js passes
- [ ] Review counts match review-texts file counts

---

## Sprint V2: Investigate needsRescore Discrepancy
**Purpose:** Find the 123 "missing" reviews (937 → 814 after rescoring 300).

### Tasks:
1. Count reviews in quarantine with needsRescore=true
2. Check for any deleted files
3. Audit the math: 937 - quarantined - rescored = remaining
4. Document findings

### Validation:
- [ ] Discrepancy explained
- [ ] No unexpected data loss

---

## Sprint V3: Spot-Check Rescoring Quality
**Purpose:** Verify rescored reviews have sensible scores.

### Tasks:
1. Find reviews with >15 point score changes
2. Read 10 samples and compare old vs new scores
3. Check if new scores align with review sentiment
4. Flag any systematic issues

### Validation:
- [ ] 10 samples reviewed
- [ ] No systematic scoring errors found
- [ ] Document any concerns

---

## Sprint V4: Investigate Test Suite Failures
**Purpose:** Ensure we didn't break anything.

### Tasks:
1. Run test suite locally: `npm run test:data`
2. Check recent test workflow logs
3. Fix any failures caused by our changes
4. Re-run tests to confirm

### Validation:
- [ ] All data validation tests pass
- [ ] No regressions from our changes

---

## Sprint V5: Test Production Verifier Integration
**Purpose:** Verify gather-reviews.js correctly rejects wrong productions.

### Tasks:
1. Create test cases for production verifier
2. Run gather-reviews in dry-run mode with test data
3. Verify it rejects wrong-year URLs
4. Verify it accepts valid reviews

### Validation:
- [ ] Verifier correctly rejects test wrong-production
- [ ] Verifier correctly accepts test valid-production

---

## Execution Order:
1. V1 (Rebuild) - Must happen first, site needs updated data
2. V2 (Discrepancy) - Quick investigation
3. V3 (Quality) - Important for confidence
4. V4 (Tests) - Ensure no regressions
5. V5 (Verifier) - Lower priority, future-proofing

---

## Success Criteria:
- reviews.json rebuilt and matches review-texts
- All discrepancies explained
- Rescoring quality validated (10 samples)
- Test suite passes
- Production verifier tested
