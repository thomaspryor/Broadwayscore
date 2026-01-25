# Critical Fixes Report

Generated: 2026-01-24

## Summary

Fixed 4 critical issues identified in the aggregator validation, plus deduplication of 8 shows.

| Issue | Status | Reviews Before | Reviews After |
|-------|--------|----------------|---------------|
| just-in-time-2025 duplication | Fixed | 34 | 22 |
| our-town-2024 wrong production | Fixed | 1 | 8 |
| back-to-the-future-2023 missing | Fixed | 0 | 20 |
| moulin-rouge-2019 Boston tryout | Fixed | 28 | 27 |
| Other deduplication (8 shows) | Fixed | ~770 | ~751 |

---

## Issue 1: just-in-time-2025 - Heavy Duplication

### Problem
34 review entries when DTLI shows only 19. Many uppercase truncated duplicates like `THENEWYORK--unknown.json`.

### Fix Applied
1. **Deleted 19 junk files:**
   - 17 uppercase truncated `*--unknown.json` files
   - `advertisement--chris-jones.json` (not a real outlet)
   - `timeout-ny--adam-feldman.json` (duplicate of timeout)

2. **Cleaned reviews.json:**
   - Removed 12 duplicate entries
   - Consolidated to unique outlet+critic combinations

### Result
- **Before:** 34 reviews, 41 review-text files
- **After:** 22 reviews, 22 review-text files

### Valid Reviews (22)
| Outlet | Critic |
|--------|--------|
| The New York Times | Jesse Green |
| Vulture | Jackson McHenry |
| Variety | Christian Lewis |
| Time Out New York | Adam Feldman |
| The Hollywood Reporter | Frank Scheck |
| Deadline | Greg Evans |
| Entertainment Weekly | Shania Russell |
| The Guardian | Adrian Horton |
| The Daily Beast | Tim Teeman |
| The Wrap | Robert Hofler |
| New York Post | Johnny Oleksinski |
| Washington Post | Naveen Kumar |
| Chicago Tribune | Chris Jones |
| New York Sun | Elysa Gardner |
| Cititour | Brian Scott Lipton |
| Culture Sauce | Thom Geier |
| TheaterMania | Kenji Fujishima |
| Theatrely | Kobi Kassal |
| Broadway News | Brittani Samuel |
| NY Stage Review | Frank Scheck |
| NY Stage Review | Melissa Rose Bernardo |
| New York Theater | Jonathan Mandell |

---

## Issue 2: our-town-2024 - Wrong Production Data

### Problem
Review data was from 2002 Broadway revival (Paul Newman), not 2024 revival (Jim Parsons).

### Fix Applied
1. **Removed incorrect data:**
   - Deleted `alvin-klein.json` (2002 review)
   - Removed corresponding entry from reviews.json

2. **Added 8 reviews from Show-Score archive:**

| Outlet | Critic | Score |
|--------|--------|-------|
| The New York Times | Jesse Green | 85 |
| New York Theatre Guide | Austin Fimmano | 88 |
| Time Out New York | Adam Feldman | 82 |
| Vulture | Sara Holdren | 80 |
| The Wall Street Journal | Charles Isherwood | 75 |
| Variety | Aramide Tinubu | 88 |
| New York Post | Johnny Oleksinski | 55 |
| Entertainment Weekly | Shania Russell | 80 |

### Result
- **Before:** 1 review (wrong production)
- **After:** 8 reviews (2024 production)

**Note:** Show-Score indicates 19 total critic reviews; only 8 visible in initial HTML.

---

## Issue 3: back-to-the-future-2023 - Missing Reviews

### Problem
Show had 0 reviews in our database. DTLI archive was a cohort article, not show page.

### Fix Applied
Fetched 20 reviews from Show-Score and BWW Review Roundup.

### Reviews Added (20)

**Tier 1 (5 reviews):**
| Outlet | Critic | Score | Verdict |
|--------|--------|-------|---------|
| The New York Times | Jesse Green | 45 | Mixed-Negative |
| Vulture | Jackson McHenry | 40 | Mixed-Negative |
| Variety | Frank Rizzo | 48 | Mixed-Negative |
| Time Out New York | Adam Feldman | 30 | Pan |
| The Hollywood Reporter | Frank Scheck | 72 | Positive |

**Tier 2 (11 reviews):**
| Outlet | Critic | Score |
|--------|--------|-------|
| The Wall Street Journal | Charles Isherwood | 42 |
| Deadline | Greg Evans | 60 |
| New York Daily News | Chris Jones | 45 |
| Entertainment Weekly | Dalton Ross | 67 |
| The Daily Beast | Tim Teeman | 65 |
| New York Post | Johnny Oleksinski | 40 |
| The Wrap | Robert Hofler | 42 |
| USA Today | Patrick Ryan | 55 |
| NY Stage Review | Elysa Gardner | 38 |
| NY Stage Review | Steven Suskin | 68 |
| Observer | David Cote | 38 |

**Tier 3 (4 reviews):**
| Outlet | Critic | Score |
|--------|--------|-------|
| Theatrely | Kobi Kassal | 75 |
| Chicago Tribune | Chris Jones | 40 |
| New York Theatre Guide | Gillian Russo | 78 |
| New York Theater | Jonathan Mandell | 55 |

### Result
- **Before:** 0 reviews
- **After:** 20 reviews
- **Estimated Metascore:** Low 50s (mixed-to-negative reception)

---

## Issue 4: moulin-rouge-2019 - Boston Tryout Data

### Problem
Archive and some reviews were from Boston tryout (August 2018), not Broadway opening (July 25, 2019).

### Fix Applied
1. **Removed Boston tryout review:**
   - Deleted NYT review from August 2018

2. **Added missing NY1 review:**
   - Roma Torre's review was in review-texts but missing from reviews.json

3. **Deduplicated entries:**
   - Removed `vulture | Sarah Holdren` (duplicate of `VULT | Sara Holdren`)
   - Removed `ew | Leah Greenblatt` (duplicate)
   - Removed `ny-stage-review | Rose Bernardo` (same as Melissa Rose Bernardo)

4. **Normalized outlet IDs:**
   - Standardized lowercase to uppercase format

5. **Removed corrupted file:**
   - Deleted garbage parsing artifact file

### Result
- **Before:** 28 reviews (includes Boston tryout)
- **After:** 27 reviews (Broadway only)
- **Thumbs:** 22 Up, 4 Down, 1 Flat

---

## Other Deduplication (8 Shows)

### the-outsiders-2024
| Removed | Kept | Reason |
|---------|------|--------|
| EW (score 70) | EW (score 80) | Kept version with fullText |
| new-york-theatre-guide (score 58) | NYTG (score 78) | Kept version with URL |
| cititour (Scott Lipton) | CITI (Brian Scott Lipton) | Kept full name |
| chicago-tribune (Chris Jones) | NYDN (Chris Jones) | Same critic, kept primary outlet |

**Result:** 28 → 24 reviews

### book-of-mormon-2011
- Fixed Terry Teachout/Techout typo
- Removed 3 duplicate entries (bww-roundup versions)

### the-notebook-2024
| Removed | Reason |
|---------|--------|
| nypost--johnny-oleksinki.json | Typo in critic name |
| vulture--unknown.json | Stub duplicate |
| VU--unknown.json | Uppercase stub |
| NEWYORKPOS--unknown.json | Unknown critic stub |

**Result:** Deduplicated to 35 reviews

### hadestown-2019
- Deleted `wsj--terry-techout.json` (typo)
- Deleted `thewrap--thom-geier.json` (duplicate)
- Deleted `EW--unknown.json` (duplicate)

**Result:** 23 → 21 review-text files

### Other Shows Cleaned
- aladdin-2014: Removed 1 EW duplicate
- and-juliet-2022: Removed 1 NYTG duplicate
- hamilton-2015: Removed 2 duplicates (USA Today, WSJ)
- the-great-gatsby-2024: Removed 1 EW duplicate

---

## Summary of Changes

### Files Deleted
- 19 junk files from just-in-time-2025
- 4 duplicates from the-outsiders-2024
- 4 duplicates from the-notebook-2024
- 3 duplicates from hadestown-2019
- 1 wrong production file from our-town-2024
- 1 Boston tryout file from moulin-rouge-2019

### Files Created
- 8 review-text files for our-town-2024
- 20 review-text files for back-to-the-future-2023

### reviews.json Updates
- Total reviews: ~770 → ~751 (net after additions and removals)
- just-in-time-2025: 34 → 22
- our-town-2024: 1 → 8
- back-to-the-future-2023: 0 → 20
- moulin-rouge-2019: 28 → 27
- the-outsiders-2024: 28 → 24
- Various shows: removed ~11 additional duplicates

---

## Recommendations for Future

1. **Validate on import:** Check for duplicates before adding reviews
2. **Normalize outlet IDs:** Always use canonical IDs from src/config/outlets.ts
3. **Verify production dates:** Check review dates match production opening
4. **Cross-validate sources:** Don't rely on single aggregator

---

## Verification

All changes committed to branch: `claude/broadway-metascore-site-8jjx7`
