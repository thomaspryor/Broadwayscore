# Aggregator Validation Summary

Generated: 2026-01-24

## Overview

Validated 3 test shows against DTLI archives from 2026-01-22.

| Show | DTLI Reviews | Our Reviews | All DTLI in Ours | Thumb Mismatches | Issues |
|------|--------------|-------------|------------------|------------------|--------|
| two-strangers-bway-2025 | 13 | 16 | ✅ Yes | 1 | 1 dtliThumb field error |
| the-outsiders-2024 | 14 | 24 | ✅ Yes | 4 | Duplicates in our data |
| hadestown-2019 | 5 | 23 | ✅ Yes | 0 | DTLI seems incomplete |

## Key Findings

### 1. Coverage
- **All DTLI reviews are present in our database** for all 3 test shows
- We have **more reviews than DTLI** in all cases (from BWW roundups, Show-Score, etc.)
- Additional sources we have: Cititour, Culture Sauce, One Minute Critic, Slant Magazine, etc.

### 2. Thumb Alignment Issues

#### two-strangers-bway-2025
| Outlet | Critic | DTLI | Ours | Status |
|--------|--------|------|------|--------|
| TheaterMania | Dan Rubins | Down | Flat | OK (dtliThumb=Down) |
| The Wrap | Robert Hofler | Down | Flat | OK (dtliThumb=Down) |
| New York Theater | Jonathan Mandell | Flat | Flat | **ERROR: dtliThumb field says Up** |

#### the-outsiders-2024
| Outlet | Critic | DTLI | Ours | Action Needed |
|--------|--------|------|------|---------------|
| New York Times | Jesse Green | Flat | Up | Review score |
| Entertainment Weekly | Emlyn Travis | Flat | Up | Review score |
| New York Daily News | Chris Jones | Down | Flat | Review score |
| The Wrap | Robert Hofler | Flat | Up | Review score |

#### hadestown-2019
- No mismatches - all 5 DTLI reviews align with our thumbs

### 3. Data Quality Issues

#### Duplicates in the-outsiders-2024
- Entertainment Weekly (Emlyn Travis): 2 entries with different scores
- New York Theatre Guide (Joe Dziemianowicz): 2 entries with conflicting thumbs
- Cititour: 2 entries for same critic with different name spellings
- Chris Jones: Listed under both NY Daily News and Chicago Tribune

#### Possible Duplicates in hadestown-2019
- WSJ: "Terry Teachout" vs "Terry Techout" (typo)
- NYT: Jesse Green vs Ben Brantley (different critics - both valid)

### 4. DTLI Coverage Gaps
- **hadestown-2019**: DTLI only has 5 reviews, we have 23 - DTLI appears incomplete for older shows
- Newer shows (two-strangers, the-outsiders) have better DTLI coverage

## Recommendations

### Immediate Fixes
1. **Fix dtliThumb for two-strangers/New York Theater** - change from "Up" to "Flat"
2. **Review the-outsiders thumb assignments** - 4 mismatches need investigation
3. **Remove duplicates in the-outsiders** - consolidate duplicate entries

### Process Improvements
1. **Cross-validate with Show-Score and BWW** - DTLI alone is insufficient
2. **Add validation script** - automate this comparison
3. **Standardize critic names** - avoid "Terry Teachout" vs "Terry Techout"

## Archive Status

All 3 test shows have DTLI archives from 2026-01-22 in:
- `data/aggregator-archive/dtli/{showId}.html`

New timestamped archive structure created:
- `data/archives/dtli/{showId}_2026-01-24.html`

## Next Steps

1. Run same validation for remaining 37 shows
2. Fetch fresh aggregator pages for any that are >7 days old
3. Create consolidated review-sources JSON files
4. Generate full validation report
