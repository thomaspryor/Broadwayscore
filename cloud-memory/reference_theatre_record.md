---
name: Theatre Record subscription and integration
description: "Paid UK review archive £53/yr; extraction script; wired into refresh pipeline."
type: reference
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
- No star ratings — all reviews need LLM scoring
