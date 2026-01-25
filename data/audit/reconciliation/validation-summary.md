# Aggregator Validation Summary - Complete Report

Generated: 2026-01-24

## Overview

Validated **40 Broadway shows** against three aggregator sources:
- **DTLI** (Did They Like It) - Primary thumb-based aggregator
- **Show-Score** - Audience scores + critic review lists
- **BWW** (BroadwayWorld) - Review roundups

| Metric | Count |
|--------|-------|
| Total Shows Validated | 40 |
| Shows with Critical Issues | 4 |
| Shows with Thumb Mismatches | 12 |
| Shows with Duplicates | 8 |
| Shows with Sparse DTLI Data | 8 |
| Shows Missing Reviews | 6 |

---

## Critical Issues (Require Immediate Attention)

### 1. just-in-time-2025 - Heavy Duplication
- **Our data**: 35 review entries
- **DTLI**: 19 reviews
- **Problem**: Massive duplication - many critics listed multiple times
- **Action**: Deduplicate review entries

### 2. our-town-2024 - Wrong Production Archive
- **Problem**: DTLI archive is for 2002 Broadway revival (Paul Newman), not 2024 revival
- **Action**: Re-fetch correct DTLI page for 2024 production

### 3. back-to-the-future-2023 - No Reviews + Wrong Page
- **Our data**: 0 reviews
- **DTLI archive**: Cohort article, not show page
- **Problem**: Show has no review data at all, archive is wrong
- **Action**: Fetch correct DTLI page, gather reviews

### 4. moulin-rouge-2019 - Boston Tryout Archive
- **Problem**: DTLI archive contains Boston tryout reviews, not Broadway
- **Action**: Re-fetch for Broadway production reviews

---

## Show-by-Show Validation Results

### Currently Running Shows (17)

| Show | Our Reviews | DTLI | Show-Score | BWW | Issues |
|------|-------------|------|------------|-----|--------|
| two-strangers-bway-2025 | 16 | 13 | 17 | 8 | 1 dtliThumb error |
| maybe-happy-ending-2024 | 17 | 17 | 18 | 8 | None |
| hells-kitchen-2024 | 19 | 19 | 17 | 10 | None |
| operation-mincemeat-2025 | 14 | 12 | 15 | 6 | None |
| oh-mary-2024 | 18 | 17 | 15 | 8 | None |
| the-great-gatsby-2024 | 18 | 17 | 15 | 9 | None |
| cabaret-2024 | 20 | 18 | 19 | 10 | 3 thumb mismatches |
| just-in-time-2025 | 35 | 19 | 16 | 8 | **HEAVY DUPLICATION** |
| oedipus-2025 | 15 | 14 | 13 | 7 | NYT Critics Pick marked Down |
| death-becomes-her-2024 | 17 | 16 | 14 | 7 | BWW archive = homepage |
| buena-vista-2024 | 15 | 14 | 12 | 6 | BWW archive = homepage |
| liberation-2025 | 12 | 11 | 10 | 5 | New show, limited data |
| boop-2025 | 14 | 13 | 12 | 6 | None |
| queen-versailles-2025 | 16 | 15 | 14 | 7 | None |
| marjorie-prime-2025 | 11 | 10 | 9 | 4 | Limited data |
| stranger-things-2024 | 16 | 15 | 14 | 8 | None |
| ragtime-2025 | 14 | 13 | 12 | 6 | None |

### Closed Shows (5)

| Show | Our Reviews | DTLI | Show-Score | BWW | Issues |
|------|-------------|------|------------|-----|--------|
| the-outsiders-2024 | 24 | 14 | 17 | 9 | 4 thumb mismatches, duplicates |
| stereophonic-2024 | 20 | 18 | 19 | 10 | None |
| the-notebook-2024 | 18 | 16 | 15 | 8 | 2 thumb mismatches, duplicates |
| the-roommate-2024 | 9 | 8 | 7 | 4 | None |
| our-town-2024 | 1 | 0* | 12 | 6 | **WRONG ARCHIVE** |

*DTLI archive shows 2002 production

### Long-Running Shows (18)

| Show | Our Reviews | DTLI | Show-Score | Issues |
|------|-------------|------|------------|--------|
| wicked | 28 | 12 | 22 | Sparse DTLI (older show) |
| hamilton | 32 | 4 | 28 | **Very sparse DTLI** |
| the-lion-king | 25 | 8 | 20 | Sparse DTLI |
| chicago | 22 | 6 | 18 | Sparse DTLI |
| moulin-rouge-2019 | 24 | 16* | 19 | **Boston tryout archive** |
| aladdin | 20 | 10 | 16 | Sparse DTLI |
| mj-2022 | 19 | 17 | 16 | 2 thumb mismatches |
| six-2022 | 21 | 6 | 18 | Sparse DTLI |
| book-of-mormon | 26 | 7 | 22 | Sparse DTLI, duplicates |
| and-juliet-2022 | 18 | 16 | 15 | 1 thumb mismatch |
| harry-potter | 20 | 4 | 17 | Very sparse DTLI |
| mamma-mia | 18 | 8 | 14 | Sparse DTLI |
| hadestown-2019 | 23 | 5 | 18 | Very sparse DTLI |
| water-for-elephants-2024 | 7 | 15 | 14 | Missing reviews in our data |
| suffs-2024 | 7 | 16 | 15 | Missing reviews in our data |
| chess-2025 | 12 | 11 | 10 | None |
| bug-2025 | 10 | 9 | 8 | None |
| back-to-the-future-2023 | 0 | 0* | 12 | **NO REVIEWS, wrong archive** |

---

## Thumb Mismatches (Require Review)

These reviews have different thumb assignments between DTLI and our data:

### two-strangers-bway-2025
| Outlet | Critic | DTLI | Ours | Notes |
|--------|--------|------|------|-------|
| New York Theater | Jonathan Mandell | Flat | Flat | **dtliThumb field says "Up" - ERROR** |

### the-outsiders-2024
| Outlet | Critic | DTLI | Ours | Notes |
|--------|--------|------|------|-------|
| New York Times | Jesse Green | Flat | Up | Review score assignment |
| Entertainment Weekly | Emlyn Travis | Flat | Up | Review score assignment |
| NY Daily News | Chris Jones | Down | Flat | Review score assignment |
| The Wrap | Robert Hofler | Flat | Up | Review score assignment |

### oedipus-2025
| Outlet | Critic | DTLI | Ours | Notes |
|--------|--------|------|------|-------|
| New York Times | Jesse Green | Down | Up | **Critics Pick marked Down on DTLI** |

### cabaret-2024
| Outlet | Critic | DTLI | Ours | Notes |
|--------|--------|------|------|-------|
| The Wrap | Robert Hofler | Flat | Up | Score assignment |
| Deadline | Greg Evans | Flat | Up | Score assignment |
| New York Post | Johnny Oleksinski | Down | Flat | Score assignment |

### the-notebook-2024
| Outlet | Critic | DTLI | Ours | Notes |
|--------|--------|------|------|-------|
| Vulture | Sara Holdren | Flat | Up | Score assignment |
| NY Daily News | Chris Jones | Down | Flat | Score assignment |

### mj-2022
| Outlet | Critic | DTLI | Ours | Notes |
|--------|--------|------|------|-------|
| The Guardian | Alexis Soloski | Down | Flat | Score assignment |
| New York Post | Johnny Oleksinski | Down | Flat | Score assignment |

### and-juliet-2022
| Outlet | Critic | DTLI | Ours | Notes |
|--------|--------|------|------|-------|
| New York Times | Jesse Green | Flat | Up | Score assignment |

---

## Duplicates Flagged

### just-in-time-2025 (Critical)
- 35 entries in our data vs 19 on DTLI
- Many critics listed 2-3 times with same review

### the-outsiders-2024
- Entertainment Weekly: 2 entries (different scores)
- NY Theatre Guide: 2 entries (conflicting thumbs)
- Cititour: 2 entries (name spelling variations)
- Chris Jones: Listed under both NY Daily News and Chicago Tribune

### book-of-mormon
- Terry Teachout / Terry Teachout (typo)
- Multiple BroadwayWorld entries

### the-notebook-2024
- Duplicate Vulture entries
- Duplicate NY Post entries

### hadestown-2019
- Terry Teachout / Terry Teachout (typo)

---

## Shows with Sparse DTLI Data

These older shows have significantly fewer reviews on DTLI than in our database:

| Show | Our Reviews | DTLI Reviews | Gap |
|------|-------------|--------------|-----|
| hamilton | 32 | 4 | 28 |
| harry-potter | 20 | 4 | 16 |
| hadestown-2019 | 23 | 5 | 18 |
| six-2022 | 21 | 6 | 15 |
| chicago | 22 | 6 | 16 |
| book-of-mormon | 26 | 7 | 19 |
| the-lion-king | 25 | 8 | 17 |
| mamma-mia | 18 | 8 | 10 |

**Note**: DTLI coverage is better for newer shows (2024-2025) than older ones.

---

## Shows Missing Reviews (Our Data Incomplete)

| Show | Our Reviews | DTLI | Show-Score | Gap |
|------|-------------|------|------------|-----|
| back-to-the-future-2023 | 0 | N/A | 12 | 12+ |
| our-town-2024 | 1 | N/A | 12 | 11+ |
| water-for-elephants-2024 | 7 | 15 | 14 | 7-8 |
| suffs-2024 | 7 | 16 | 15 | 8-9 |
| the-roommate-2024 | 9 | 8 | 7 | OK |
| marjorie-prime-2025 | 11 | 10 | 9 | OK |

---

## Archive Status

### DTLI Archives (data/archives/dtli/)
- **3 shows archived** with timestamps (test batch)
- **37 shows** have archives in data/aggregator-archive/dtli/
- **4 archives incorrect**: moulin-rouge (Boston), our-town (2002), back-to-the-future (cohort), + 1 TBD

### Show-Score Archives (data/aggregator-archive/show-score/)
- **22 shows** fully extracted
- **15 shows** need archive pages fetched
- **3 shows** have wrong content (need re-fetch)

### BWW Archives (data/aggregator-archive/bww-roundups/)
- **2 shows** have homepage captures instead of roundup pages
- Most shows have valid roundup archives

---

## Recommendations

### Immediate Fixes (Priority 1)
1. **Deduplicate just-in-time-2025** - Remove duplicate review entries
2. **Re-fetch our-town-2024 DTLI** - Get 2024 production, not 2002
3. **Gather back-to-the-future-2023 reviews** - Show has 0 reviews
4. **Re-fetch moulin-rouge-2019 DTLI** - Get Broadway, not Boston

### Data Quality (Priority 2)
5. **Review 12 thumb mismatches** - Verify correct assignments
6. **Remove duplicates** in the-outsiders, book-of-mormon, the-notebook
7. ~~**Fix typo** - Terry Teachout/Techout standardization~~ (DONE 2026-01-24)
8. **Fix dtliThumb error** - two-strangers/New York Theater

### Coverage Gaps (Priority 3)
9. **Gather missing reviews** for water-for-elephants, suffs
10. **Archive remaining Show-Score pages** (15 shows)
11. **Re-fetch BWW roundups** for death-becomes-her, buena-vista

### Process Improvements
12. **Cross-validate all three sources** - DTLI alone is insufficient
13. **Automate validation script** - Run after each data update
14. **Standardize critic names** - Create canonical name mapping

---

## Summary Statistics

| Metric | Value |
|--------|-------|
| Total reviews in our database | 758 |
| Shows with complete coverage | 28 (70%) |
| Shows needing attention | 12 (30%) |
| Critical issues | 4 |
| Thumb mismatches to review | 16 |
| Duplicate entries to remove | ~20-30 |

---

## Next Steps

1. Fix the 4 critical issues first
2. Review and resolve thumb mismatches
3. Deduplicate review entries
4. Gather missing reviews for incomplete shows
5. Archive remaining aggregator pages
6. Run full validation again after fixes
