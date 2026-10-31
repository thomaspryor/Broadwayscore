---
name: theatre-record-subscription-and-integration
description: Paid UK review archive £53/yr; extraction script; wired into refresh pipeline.
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5f71081d-465d-46a5-b460-4c8c6b29bed3
  modified: 2026-08-09T23:53:45.963Z
---

## Theatre Record Integration

**What it is:** UK's definitive theatre review archive — 58,000+ productions since 1981. Full unabridged review texts with critic names and outlet attribution.

**Access:** Annual subscription (£53/year). Credentials in `.env` (local) and GitHub secrets (`TR_EMAIL`, `TR_PASSWORD`).

**Script:** `scripts/extract-theatre-record.js`
- `--open-we` — all open WE shows
- `--long-running` — open WE shows opened before 2025
- `--show=ID` — single show
- `--dry-run` — preview without saving

**Content format:**
- Post-2022: Native HTML pages at `/archive/{year}/{month}/{id}-{slug}` — clean parsing
- 2016-2022: Digital PDF at `/archive/volume/{vol}/dest/{slug}` — pdftotext extraction
- Pre-2016: Scanned PDF — not yet supported (needs OCR)

**Pipeline:** Wired into `review-refresh.yml` weekly pipeline. Runs after aggregator extraction, before rebuild. `continue-on-error: true`.

**Production guards:** Title matching (strict, accent-normalized), date guard, tour/regional detection, panto guard, film/TV guard.

**First extraction (2026-04-03):** 233 valid reviews from HTML pages across 41 WE shows. PDF extraction adds ~17 more from pre-2022 issues.

**Known limitations:**
- PDF parser misses reviews in older volumes (pre-2017) with different formatting
- Search sometimes returns touring productions instead of WE — retry with location filter helps but not perfect
- **Captures NEITHER original review URLs NOR critics' star/explicit ratings (owner-confirmed 2026-08-09) — never treat TR as a sole source.** TR = full-text source only; URLs + stars must be recovered from WET roundup rows, the outlet page itself, or SERP. Star ratings matter because explicit stars anchor/cap LLM scores ([[feedback_star_score_cap]]); URL-less majors break dedup and verification. Policy set in the WE historical plan (~/Documents/claude-outputs/we-historical-scoring-plan.md): every T1/T2 review needs URL + star (where the outlet uses stars); T3 tail may stay URL-less with source metadata.
