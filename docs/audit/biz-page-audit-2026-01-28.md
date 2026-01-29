# /biz Page Comprehensive Audit Report
**Date:** January 28, 2026
**Audited by:** Claude (internal) + ChatGPT (GPT-5-2) + Data Analysis

---

## Executive Summary

Found **31 data quality issues** and **3 bugs** in the /biz Broadway Investment Tracker. Also gathered feedback from 4 personas representing different stakeholder perspectives.

### Severity Summary
| Category | Count |
|----------|-------|
| Critical Bugs | 3 |
| Data Issues - Critical | 7 |
| Data Issues - High | 7 |
| Data Issues - Medium | 11 |
| Data Issues - Low | 1 |

---

## PART 1: BUGS FOUND

### BUG 1: Misleading "At Risk" Description (Critical)
**Location:** `src/app/biz/page.tsx:64`

**Issue:** The Recent Developments section hardcodes "operating below break-even" for all at-risk shows, but shows can be at-risk due to declining trend while still operating ABOVE break-even.

**Example:** Death Becomes Her shows $949K weekly gross vs $900K break-even = ABOVE break-even, but listed as "operating below break-even"

**Fix Required:**
```javascript
// Change line 64 from:
description: 'operating below break-even',
// To:
description: show.weeklyGross < show.weeklyRunningCost
  ? 'operating below break-even'
  : 'declining trajectory',
```

### BUG 2: Date Parsing Issue with Full ISO Dates
**Location:** `src/app/biz/page.tsx:43-45`

**Issue:** The `generateRecentDevelopments()` function splits `recoupDate` by `-` expecting `YYYY-MM` format. `the-outsiders` has `2025-12-28` (YYYY-MM-DD format), which would split into 3 parts and cause incorrect date display.

**Data affected:** `the-outsiders` with `recoupedDate: "2025-12-28"`

**Fix Required:** Either normalize the data to `YYYY-MM` or update the parsing logic.

### BUG 3: Orphaned Shows in Commercial Data
**Location:** `data/commercial.json`

**Issue:** 5 shows exist in commercial.json but NOT in shows.json, causing potential lookup failures:
- `mamma-mia-2001`
- `art-2025`
- `othello-2025`
- `glengarry-glen-ross-2025`
- `waiting-for-godot-2025`

**Impact:** These shows export with `status: "unknown"` which looks unprofessional in API exports.

---

## PART 2: DATA QUALITY ISSUES

### Critical Issues (7)

1. **5 orphaned shows** (listed above) - exist in commercial.json but not shows.json
2. **Easy Winner status conflict** - `the-roommate` and `our-town` have designation="Easy Winner" but `recouped: null` (should be `true`)

### High Priority Issues (7)

1. **Missing recoupedDate** for `oedipus` (recouped: true but no date)
2. **Missing capitalization** for `othello-2025` and `glengarry-glen-ross-2025` (orphaned)
3. **Status-Designation mismatch**: `hells-kitchen` and `liberation` have status="open" but designation="Fizzle" (closing soon)
4. **Format inconsistency**: `the-outsiders` uses `YYYY-MM-DD` format while others use `YYYY-MM`

### Medium Priority Issues (11)

11 shows have `weeklyRunningCost` data but are missing `weeklyRunningCostSource`:
- hamilton, harry-potter, hells-kitchen, cabaret-2024, water-for-elephants
- boop, the-outsiders, stranger-things, ragtime, maybe-happy-ending, mamma-mia

### Low Priority Issues (1)

- `just-in-time`: Has 90-100% estimated recoupment but still designated "TBD" (borderline Windfall)

---

## PART 3: AI PERSONA FEEDBACK

### PERSONA 1: Broadway Industry Insider (10+ years in theater management)

**What's Most Useful:**
- Season Stats provide industry-wide snapshot for strategic planning
- Recent Recoupments table enables post-mortem analysis of successful shows
- Approaching Recoupment section useful for forecasting

**Missing Metrics Needed:**
1. **Production cost breakdown** - marketing spend, talent costs, technical costs
2. **Advance sales trends** - trajectory of ticket sales over time
3. **Revenue split** - box office vs merchandising vs other streams
4. **Historical comparison** - how does current season compare to previous seasons?

**Terminology Issues:**
- "Miracle" and "Windfall" may confuse newcomers - consider "Exceptional Success" and "Above Expectations"

**Actionable Suggestions:**
1. Add production cost breakdown section
2. Include historical advance sales data by week/month
3. Add year-over-year comparison of recoupment rates
4. Include genre/type filters for more targeted analysis

---

### PERSONA 2: Occasional Dabbler Investor (invested in 2-3 shows)

**Accessibility Assessment:**
- High-level information is accessible
- Terminology like "Miracle" and "Flop" is subjective and needs context

**What Would Help Investment Decisions:**
1. **Investment breakdown** - capital needed at various stages
2. **Risk assessment metrics** - clear scoring based on trend data
3. **Producer track records** - team history and past performance
4. **Minimum investment amounts** - what's needed to participate?

**Confusing Elements:**
- "TBD" label is ambiguous - imminent recoupment or undetermined?
- "Nonprofit" shows confusing for commercial investors

**Actionable Suggestions:**
1. Add tooltip/hover definitions for all designation terms
2. Create "Investor Quick View" showing minimum investment, expected timeline, risk score
3. Add producer/creative team performance history
4. Include glossary or FAQ for industry terms
5. Add clear risk rating (Low/Medium/High) for each show

---

### PERSONA 3: Professional Broadway Producer (currently producing 2+ shows)

**Useful Competitive Intelligence:**
- At-Risk shows section reveals struggling competitors
- Approaching Recoupment shows competitive landscape
- Recoupment timelines help benchmark own productions

**Appropriate vs. Sensitive Data:**
- **Keep public:** Recoupment status, At-risk indicators, General capital ranges
- **Consider limiting:** Detailed budget breakdowns, Specific investor shares, Real-time box office per show

**Accuracy Assessment:**
- Estimates would be more effective with real-time ticket sales data
- Weekly costs seem accurate for well-documented shows
- Some capitalization figures appear to be educated guesses

**Actionable Suggestions:**
1. Add data freshness indicators (when was this last updated?)
2. Include confidence ratings for estimated vs. confirmed figures
3. Add filters by genre/production type for targeted competitive analysis
4. Provide downloadable filtered datasets
5. Consider tiered access - more detail for verified industry professionals

---

### PERSONA 4: Broadway Performer (currently in a running show)

**Relevance to Performers:**
- Recoupment status impacts job security and contract renewals
- At-risk shows indicate potential early closings
- Not directly relevant to day-to-day work

**What Performers Want to Know:**
1. **Timeline for recoupment** - signals longer run and job stability
2. **Ticket sales trends** - gauge show's popularity
3. **Producer's plans** - tours, international productions, extensions

**Potentially Invasive Elements:**
- Detailed financial data feels like overstepping
- Some performers prefer not knowing commercial pressure

**Actionable Suggestions:**
1. Create simplified "Performer View" with just: recoupment status, run likelihood, extension news
2. Add "Show Health" score (1-5 stars) instead of detailed financials
3. Include "Future Plans" section (tours, extensions, cast additions)
4. Avoid exposing specific investment amounts on main page
5. Add opt-in for more detailed financial view

---

## PART 4: RECOMMENDED FIXES

### Immediate Fixes (Before Next Deploy)

1. **Fix at-risk description bug** in `src/app/biz/page.tsx:64`
2. **Normalize recoupedDate** for `the-outsiders` to `YYYY-MM` format
3. **Set recouped: true** for `the-roommate` and `our-town`

### Short-Term Fixes (This Week)

4. Remove or add proper entries for 5 orphaned shows
5. Add `recoupedDate` for `oedipus`
6. Add `weeklyRunningCostSource` for 11 missing shows
7. Add tooltips for designation terms

### Medium-Term Improvements (This Month)

8. Add data freshness indicator ("Last updated: X days ago")
9. Add confidence indicators (~= estimated vs confirmed)
10. Create simplified "Show Health" summary
11. Add filters by genre/budget tier

### Future Considerations

12. Tiered access for industry professionals
13. Producer track record section
14. Advance sales trend visualization
15. Historical season comparison
16. Performer-focused simplified view

---

## APPENDIX: Current Data Display (Captured Jan 28, 2026)

### Season Stats
| Season | Capital at Risk | Recouped |
|--------|----------------|----------|
| 2024-2025 | ~$90.7M | 2 of 10 |
| 2023-2024 | ~$25.0M | 2 of 9 |
| 2022-2023 | ~$0 | 1 of 1 |

### At-Risk Shows (displayed but some above break-even)
| Show | Weekly Gross | Break-even | Actual Status |
|------|-------------|------------|---------------|
| The Great Gatsby | $893K | ~$850K | ABOVE (BUG) |
| Death Becomes Her | $949K | ~$900K | ABOVE (BUG) |
| Two Strangers | $621K | ~$480K | ABOVE |
| Buena Vista Social Club | $862K | ~$700K | ABOVE |
| Operation Mincemeat | $742K | ~$500K | ABOVE |
| Maybe Happy Ending | $1.01M | ~$765K | ABOVE |

Note: All listed shows are ABOVE break-even. They're "at-risk" due to declining trends, not operating losses. The description is misleading.
