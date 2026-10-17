---
name: Protected fields must be checked in EVERY write path
description: "Every write path must check humanReviewedWrongProduction/humanReviewScore."
type: feedback
originSessionId: 57921dad-e1d4-456d-a729-6ad575af8f93
---
# Protected fields must be checked in EVERY write path

**Rule:** Any script that overwrites, clears, or deletes review-text file fields MUST check for human-reviewed flags before making destructive changes.

**Why:** On DoaS 2026 opening night (Apr 9), the same meta-bug fired in 5 different scripts simultaneously, each independently wiping human-set fields. Each script had its own write/merge/filter logic that didn't check for the protected fields. Result: ~6 hours of manual whack-a-mole fixing the same issues over and over because each poller cycle re-fired the bugs.

## The 5 scripts that needed fixing

1. **`rebuild-fast.yml`** commit step — didn't stage `public/data/shows/*.json` at all
2. **`scripts/lib/review-normalization.js` mergeReviews** — deleted wrongShow/wrongProduction on URL change via `-X theirs`
3. **`scripts/gather-reviews.js` junk override** (line 2532) — replaced human-flagged files entirely on URL change
4. **`scripts/collect-review-texts.js` skip logic** (line 5096) — refused to re-fetch human-verified files
5. **`scripts/collect-review-texts.js` checkpoint** — `git pull --rebase -X theirs` dropped humanReviewScore

All 5 were fixed (commits in `memory/project_doas_opening_night_issues.md`).

## How to apply

Before merging any PR that touches review-text files, grep for destructive operations and verify they check protected fields:

```bash
# Find every place that writes review-text files
grep -rn "writeFileSync.*review.*json\|fs\.writeFileSync.*filePath" scripts/

# For each hit, verify it checks:
# - data.humanReviewedWrongProduction === false
# - data.humanReviewScore != null
# - data.wrongShowReason (if clearing wrongShow)
# - data.isCriticsPick (if clearing designation)
```

## Protected fields reference

From `.github/actions/push-review-texts/action.yml` PROTECTED_FIELDS (single source of truth):

```
assignedScore, llmScore, llmMetadata, fullText, contentTier,
contentTierReason, contentVerification, ensembleData, tierReason,
showTitle, textFetchedAt, textWordCount, textStatus, sourceMethod,
isFullReview, wrongFullText, wrongShow, wrongShowReason, wrongProduction,
wrongProductionNote, incompleteReason, incompleteDetail,
originalScoreCleared, originalScoreClearedReason, previousOriginalScore,
humanReviewScore, humanReviewNote, humanReviewedWrongProduction,
designation, isCriticsPick, originalScore, duplicateOf, duplicateReason,
publishDateVerified, publishDateSource, allowEarlyDate
```

**Systemic fix (still needed):** Centralize this logic in `scripts/lib/review-write-guard.js` which already exists but isn't universally used. Every write path should go through that helper.

## Related incidents

- **Cats opening night (Apr 7)** — same meta-bug on issue #15 (Guardian wrongProduction)
- **Becky Shaw (Apr 6)** — same meta-bug earlier
- **DoaS (Apr 9)** — 5 concurrent instances of the bug, ~6 hours wasted
- **DoaS postmortem:** `memory/project_doas_opening_night_issues.md`

## Red flag phrases in code reviews

- `git pull --rebase -X theirs` without a following call to `restore-protected-fields.js`
- `fs.writeFileSync(filePath, JSON.stringify(data))` without reading existing data first
- `delete data.wrongShow` / `delete data.wrongProduction` without checking manual flags
- Any spread operator overwrite like `{...existing, ...incoming}` in a file write path
