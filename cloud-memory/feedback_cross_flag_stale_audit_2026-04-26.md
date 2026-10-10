---
name: Cross-flag stale-exclusion audit (2026-04-26)
description: Sweep of 6 exclusion flags found 11 stale fabricatedEntry on West End shows; wrongProduction is correctly flagged at scale; duplicateOf dangling pointers are auto-recovered. Don't redo this audit.
type: project
originSessionId: 12f33ad8-9781-43a0-8624-2f1fee3168aa
archived: true
---
After 2026-04-26 EBT 1 Minute Critic fix (memory/feedback_local_review_texts_conflict_markers.md), dispatched a read-only cross-flag audit on `~/broadway-review-texts/` to find similar stale-exclusion patterns. Walked all 36,479 review-text files in a single Node pass.

**Why:** the 1MC bug shape (URL set → flag set → URL auto-corrected → LLM revalidates → flag stays) could apply to other exclusion flags. Two prior audits already covered `suspectedMisattribution` (106/106 cleared, 40% stale rate) and `wrongAttribution` (0/273 stale, pattern doesn't generalize). Other flags were unchecked.

**How to apply:** before swepping any of these flags again, read this; the work is done. If extending the audit, run a NEW Node script in /tmp/ — don't iterate file-by-file in Bash.

## Counts (predicate: LLM contentVerification.isValid=true + does not contradict the flag + has score + has text)

| Flag | Total flagged | Liberal stale | Truly stale (after eyeball) |
|---|---|---|---|
| `wrongShow === true` | 2,182 | 23 | ~5-10 (mostly cross-show URL collisions are correct) |
| `wrongProduction === true` | 14,872 | 491 | small minority — DON'T BULK-CLEAR |
| `isRoundupArticle === true` | 133 | 6 | ~1 (`death-becomes-her-2024/the-interested-bystander`) |
| `fabricatedEntry === true` | 233 | 11 | **11 — all cleared 2026-04-26 in private commit `b57a5e36a0c`** |
| `incompleteReason === 'scraper_garbage'` | 948 | 1 | 0 |
| `duplicateOf` set, target missing | 522 | 66 dangling | 0 functional impact (auto-recovered) |

## Key findings

1. **STRICT predicate (urlCorrectedFrom-required) returns 0 across all flags.** Only 0.4-2% of flagged files have `urlCorrectedFrom`; the EBT lifecycle is real but rare. Use the LIBERAL predicate (LLM contradicts flag) for future sweeps.
2. **`fabricatedEntry` was the highest-yield cohort.** It was Broadway-only auto-flag from older code paths; West End reviews ingested before the logic became WE-aware all got flagged, and ~10 LLM-revalidated explicitly with `"Recovered: ... Original flag was due to Broadway-only verification context"`. All 11 cleared in commit `b57a5e36a0c` (West End, scores 42-88, recoveries: all-my-sons, im-sorry-pm, les-miserables, mj-the-musical, moulin-rouge, book-of-mormon, devil-wears-prada, the-producers, spy-who-came-in-from-the-cold, harold-fry × 2).
3. **`wrongProduction` is correctly flagged at scale.** Dominated by T1 outlets (Hollywood Reporter 34, Vulture 31, NYPost 28, TimeOut 27, EW 25, NYTimes 19) reviewing PRIOR productions of revivals. The flag catches cross-revival URL drift. Per-show review only — bulk-clear is dangerous.
4. **`duplicateOf` dangling pointers are already auto-recovered.** `scripts/rebuild-all-reviews.js:1570-1572` treats a missing target as `refAlsoDupe = true` and lets the file pass the duplicate guard. The 32 dangling-real-file refs are fine; the 34 sentinel-style values (`"northjerseycom"`, `"vulture"`, `"known-outlet-copy-exists"`, `"named-critic-version"`) are intentional skips, do not clear.
5. **Test-show pollution.** 6 of 23 wrongShow stale-suspects were `cats-express-test-2026/*` (the express pipeline simulation show, see memory/feedback_express_pipeline_simulation.md). Future cross-show audits should exclude `*-express-test-*` IDs.
6. **No flag has the same stale-drift severity as suspectedMisattribution.** That earlier audit cleared 42/106 (40%); fabricatedEntry was 11/233 (~5%); the rest are <1%. The EBT incident pattern does NOT generalize at scale to most other flag classes.

## Follow-ups (acted on 2026-04-26 in private commit `7e649e3262f`)

Re-queried wrongShow with `wrongShowReason = "Generic homepage URL"` predicate to find the full set — the audit's "~3-5" estimate was actually 8. Plus EBT NYSR + death-becomes-her = 10 files cleared.

**Heuristic FP — story-ID URL flagged as "Generic homepage URL":**
- a-dolls-house-part-2-2017 wolf-entertainment-guide ?record=7112 (78)
- charlie-and-the-chocolate-factory-2017 susangrangercom ?p=9674 (38)
- come-from-away-2017 susangrangercom ?p=9704 (86)
- moulin-rouge-the-musical-west-end-2021 london-theatre post.cfm?p=9545 (90)
- paranormal-activity-west-end-2025 london-theatre post.cfm?p=26429 (90)
- punch-2025 lighting-and-sound-america story.asp?ID=-LU2NUC (88)
- the-bands-visit-2017 susangrangercom ?p=10339 (80)
- waiting-for-godot-2025 lighting-and-sound-america story.asp?ID=-A5160S (45)

**Cross-show URL collision FP (same lifecycle as 1MC):**
- every-brilliant-thing-2026 nysr/Steven-Suskin (88)

**Dual-flag FP — URL slug "broadway-reviews-..." prefix:**
- death-becomes-her-2024 the-interested-bystander/Cary-Wong (88) — wrongProduction + isRoundupArticle both stale.

## Lesson on the homepage-URL heuristic

The `wrongShowReason: "Generic homepage URL"` heuristic is a known FP source for outlets that use story-ID query strings (`?p=NNNN`, `?ID=XXXX`, `?record=NNNN`, `post.cfm?p=NNNN`, `story.asp?ID=...`). Affected outlets so far: lightingandsoundamerica.com, susangranger.com, londontheatrereviews.co.uk, wolfentertainmentguide.com. The detector probably treats lack of a slug-style path component as "homepage." Long-term fix: the detector should accept story-IDs in query strings as valid; short-term, this audit predicate finds the FPs.

## Audit artifacts (deleted with /tmp lifecycle, do not re-derive)
- `/tmp/audit-stale-flags.js` and `/tmp/audit-v2.js` (the Node walker)
- `/tmp/audit-v2-report.json` (full per-file results with paths, URLs, CV reasoning)
