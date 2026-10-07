---
name: Opening Night Fixes — Death of a Salesman (2026-04-09)
description: Actionable fix list from Cats postmortem, prioritized for DoaS tomorrow. Give this to a new session.
type: project
archived: true
---

# Opening Night Fixes for Death of a Salesman (Apr 9, 2026)

**Context:** Cats opening night (Apr 7) had 17 issues. This is the prioritized fix list to prevent them recurring tomorrow. DoaS is a revival (5 prior Broadway productions) — SERP contamination risk is HIGH.

**Show ID:** `death-of-a-salesman-2026` | **Venue:** Winter Garden | **Market:** broadway (already fixed)
**DTLI slug:** `death-of-a-salesman` (already mapped)
**Prior productions:** 1975, 1984, 1999, 2012, 2022 — 39 review files already exist, ALL wrongProduction from 2022 revival

## Pre-opening (do NOW, before tomorrow night)

### P0: Clear stale wrongProduction review files
The 39 existing files are from the 2022 Wendell Pierce revival. On opening night, the pipeline will try to match new Broadway URLs to these files. Clear all LLM scores for this show so they don't contaminate the 2026 scores.
- `data/llm-scores/death-of-a-salesman-2026/` — currently 0 files (clean ✓)
- Verify no stale `ensembleScore` fields in review-text files: `node -e "...forEach check ensembleScore"`

### P1: Aggregator-first discovery (CODE FIX)
**Root cause of Cats issue #2 (27/32 wrongProduction).** `gather-reviews.js` runs SERP first, finds old reviews. For revivals, it MUST check BWW RR + Playbill Verdict + DTLI first.
- **File:** `scripts/gather-reviews.js`
- **Fix:** When `--opening-night` flag is set (or show has openingDate = today), check aggregator pages BEFORE running SERP. The aggregator pages compile correct Broadway URLs.
- **Fallback:** If code fix isn't ready, have the user paste BWW RR + Playbill Verdict URLs manually (like we did for Cats).

### P2: Fix `contentTier: complete` on paywall-truncated text
**Root cause of Cats issue #17 (NYT text stuck at 3.4K chars).** When Bright Data returns truncated paywall text, the collector sets `contentTier: complete` because the text looks like real review content. The collector never retries.
- **File:** `scripts/collect-review-texts.js`
- **Fix:** For known paywalled outlets (NYT, WSJ, New Yorker, etc.), if text < 5,000 chars AND `sourceMethod` is `brightdata`, set `contentTier: truncated` instead of `complete`. ScrapingBee premium (`premium_proxy=true`) works for NYT — the collector should try SB premium before marking complete.

### P3: Fix `extract-safari-cookies.py` empty file bug
**Already fixed in this session.** The script picked a 0-byte cookie file over the real one because `os.path.isfile()` returns True for empty files. Fix: `os.path.getsize(p) > 0`.
- **Status:** ✓ Fixed locally, committed.

### P4: Rebuild must respect `humanReviewedWrongProduction` 
**Root cause of Cats issue #15 (Guardian kept getting re-flagged).** The rebuild's wrong-production audit uses Guardian API dates that are wrong (returns OB date for Broadway URL). It ignores `humanReviewedWrongProduction: false`.
- **File:** `scripts/rebuild-all-reviews.js` — wrong-production audit section (~line 2037)
- **Fix:** If `data.humanReviewedWrongProduction === false`, skip the wrong-production audit for that file.

### P5: NYT Critics' Pick extraction
**Root cause of Cats issue #14.** `collect-review-texts.js` doesn't extract `isCriticsPick` from NYT HTML. The badge appears 7 times in the page source but not in the extracted text.
- **File:** `scripts/collect-review-texts.js` — NYT-specific section
- **Fix:** After extracting text, check HTML for `/criticspick/i` pattern. If found, set `designation: "Critics_Pick"` on the review file.

## During opening night (when reviews drop)

### P6: Don't set `contentTier: complete` from manual fetches
If manually fetching review text (Bright Data, curl, etc.), set `contentTier: truncated` until the collector pipeline verifies completeness. Cats issue #17 was caused by a manual BD fetch setting `complete` on truncated NYT text.

### P7: Use ScrapingBee premium for NYT
`fetchPage()` with Bright Data returns truncated NYT text. ScrapingBee with `premium_proxy=true` returns full text. This works as of April 8 2026.

### P8: Don't push to review-texts repo while CI is scoring
**Root cause of Cats meta-problem (issues #5, #9, #15, #16, #17).** Concurrent pushes to review-texts cause `git pull --rebase` to silently drop scores. If CI scoring is running, wait for it to finish before pushing.

### P9: Ensemble scoring for manual reviews
After manually scoring with single-model GPT-4o, flag with `needsRescore: true` and trigger `gh workflow run llm-ensemble-score.yml -f show=SHOW_ID -f needs_rescore=true`. Don't wait for the daily 4:30 AM run.

## Unfixed from Becky Shaw postmortem (Apr 6)

### ~~P3.5: Playbill blocked by AGGREGATOR_DOMAINS~~
**NOT A BUG.** Playbill is correctly classified as an aggregator. They don't publish original critic reviews — only roundup articles ("Read the reviews for..."). Verified by checking all 8 Playbill files with text — all are aggregation pages or features.

### P4.5: Rebuild wrong-production audit ignores `humanReviewedWrongProduction`
Also from Becky Shaw — the `wrongProductionManualClear` field was introduced but the rebuild's audit may not check it consistently. Verify `humanReviewedWrongProduction` AND `wrongProductionManualClear` are both respected.

### P6.5: `adjudicatedScore` field handling
Created during Becky Shaw. Verify it's handled by ALL code paths: rebuild, scoring, export, frontend. Check `grep -r adjudicatedScore scripts/ src/`.

### P7.5: LLM scoring calibration — 0 Mixed reviews despite BWW/DTLI showing 2-3 Meh
Becky Shaw and Cats both had the LLM scoring too generous (all Positive/Rave, no Mixed). BWW and DTLI both flag 1-3 reviews as Meh/Down per show, but our pipeline produces 0 Mixed until manually corrected. The ensemble may need recalibration.

## Already fixed (no action needed)

- ✅ Market field: DoaS already set to `broadway`
- ✅ DTLI slug: already mapped as `death-of-a-salesman`
- ✅ PROTECTED_FIELDS: `humanReviewScore`, `designation`, `originalScore`, `duplicateOf`, `wrongShow`, `publishDateVerified` all added
- ✅ Safari cookie extraction: 0-byte file bug fixed
- ✅ Into The Woods duplicate: removed from private data repo

## Handoff prompt for new session

```
Opening night for Death of a Salesman is tomorrow (Apr 9). Read memory/project_opening_night_fixes_doas.md and memory/project_cats_opening_night_postmortem.md for full context.

Priority fixes before tomorrow:
1. P1: Make gather-reviews.js check aggregator pages (BWW RR, Playbill Verdict, DTLI) BEFORE SERP for shows with openingDate = today
2. P2: Fix contentTier detection for paywalled outlets in collect-review-texts.js
3. P4: Make rebuild's wrong-production audit respect humanReviewedWrongProduction field
5. P5: Extract NYT Critics' Pick designation in collect-review-texts.js

The show has 5 prior productions (1975-2022). SERP contamination risk is very high. 39 existing review files are ALL wrongProduction from the 2022 Wendell Pierce revival.

Also read the Becky Shaw postmortem context pasted in this file — several issues from that opening (Apr 6) recurred on Cats (Apr 7) because they weren't fixed between sessions.
```
