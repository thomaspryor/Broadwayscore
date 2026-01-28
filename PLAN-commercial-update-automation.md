# Plan: Automated Commercial Scorecard Updates

## Problem

The Commercial Scorecard (`data/commercial.json`) tracks financial performance of 47 Broadway shows -- capitalization, recoupment status, weekly running costs, designations (Miracle/Windfall/Fizzle/Flop/etc.), and editorial notes. It was last manually updated Jan 25, 2026. There is no automated update process.

Commercial data changes infrequently but meaningfully: a show recouping its investment, a show closing without recouping, a new show opening and needing an initial entry, or running cost estimates becoming available. Missing an update means stale data on the site.

## Decisions (Locked In)

| Question | Answer |
|----------|--------|
| Medium-confidence changes | **Auto-apply**, flag in GitHub issue notification |
| Workflow | **Direct commit** to main (not high-stakes data) |
| Trade press scraping | **Archive.org first** then Playwright then ScrapingBee/Bright Data |
| Multi-factor designation heuristics | **Shadow classifier first** -- test internally, don't replace live designations until validated |
| TBD sub-categories | **No** -- keep TBD, add `estimatedRecoupmentPct` as a visible field instead |
| Fizzle/Flop boundary | **30% recouped** |
| Estimated recoupment % | **Store as new field + display**, clearly marked as rough estimate |
| Estimate display convention | **~ prefix** on all estimated commercial figures (e.g., `~65% recouped`, `~$1.0M weekly cost`) |
| Recoupment tracker UI | **Yes** -- simple progress bar on show pages, driven by `estimatedRecoupmentPct` |

## Primary Data Source

**The r/Broadway weekly "Grosses Analysis" post** by u/Boring_Waltz_9545 is the single best source. Published weekly, it includes for every currently running show:

- Weekly gross, capacity %, average ticket price
- **Estimated Weekly Operating Cost** (exactly what we track)
- **Estimated Profit/Loss per week**
- **Estimated percentage recouped** (e.g., "80%-100%", "10%-30%")
- Award wins
- Commentary on financial trajectory and outlook
- The **comments section** often contains additional insider info (recoupment lists, capitalization figures, comparisons)

Example from the Jan 25 post:
```
Just in Time - $1.3M gross, 102% capacity, $248 atp
Gross Less-Fees: $1.212M; Estimated Weekly Operating Cost: $600k/week
Estimated Profit (Loss): $150k+
Estimated percentage recouped: 80%-100%
```

### Secondary Data Sources (actively searched each week)

**r/Broadway broader search** -- Beyond the Grosses Analysis post, r/Broadway frequently has standalone threads about recoupment, capitalization, closing announcements, and financial news.

**Trade press** -- Actively searched every week:
- **Deadline**, **Variety**, **Broadway Journal**, **Playbill**, **Broadway News**, **BroadwayWorld**, **Forbes**, **The New York Times**

These are not optional fallbacks -- they are actively searched every week alongside the Grosses Analysis post.

## Design Goals

1. **Fully automated** -- runs weekly with zero manual intervention
2. **Notification on every change** -- GitHub issue created with a diff so the user can review/correct
3. **Easy insider info submission** -- GitHub issue template for tips from phone
4. **Conservative by default** -- only make high-confidence updates; flag ambiguous cases
5. **Additive** -- never delete data, only add or update fields
6. **Estimates clearly marked** -- all estimated figures prefixed with `~` on the site

## Architecture

```
+------------------------------------------------------+
| GitHub Action: update-commercial.yml                 |
| Runs: Weekly (Wednesday 4pm UTC / 11am ET)           |
+------------------------------------------------------+
|                                                      |
|  1. GATHER: Scrape r/Broadway Grosses Analysis       |
|     post + top comments (via ScrapingBee)            |
|                                                      |
|  2. GATHER: Search r/Broadway for other threads      |
|     re: recoupment, capitalization, closing (7 days) |
|                                                      |
|  3. GATHER: Search trade press for Broadway          |
|     financial news (7 days)                          |
|     Scraping: Archive.org > Playwright > ScrapingBee |
|                                                      |
|  4. LOAD: commercial.json + grosses.json + shows.json|
|                                                      |
|  5. ANALYZE: Claude Sonnet with structured prompt    |
|                                                      |
|  6. Apply changes to commercial.json                 |
|  7. Log changes to commercial-changelog.json         |
|  8. Create GitHub issue with change summary          |
|  9. Commit + push                                    |
+------------------------------------------------------+
```

## Detailed Steps

### Step 1: Scrape Latest Grosses Analysis Post

- Use ScrapingBee (premium proxy) to hit Reddit JSON API for latest post by u/Boring_Waltz_9545 with "Grosses Analysis" flair
- Fetch post body + top-level comments
- Store week-ending date from title

### Step 2: Search r/Broadway for Financial Discussions (past 7 days)

Search queries via ScrapingBee/Reddit JSON API:
- `recouped OR recoupment`
- `capitalization OR investment OR "SEC filing"`
- `closing OR "final performance"`
- `"running costs" OR "weekly nut" OR "break even"`

Fetch post body + top comments for each match.

### Step 3: Search Trade Press (past 7 days)

Google searches scoped to trade sites. For each article found:
1. Try **Archive.org Wayback Machine** first (most reliable for paywalled sites)
2. Then **Playwright** for direct scraping
3. Then **ScrapingBee / Bright Data** as fallback
4. At minimum, use title + snippet from search results

### Step 4: Build Context for AI Analysis

Assemble structured prompt with:
- **A.** Current `commercial.json` state per show
- **B.** Box office math from `grosses.json` (all-time gross vs cap)
- **C.** Grosses Analysis post excerpts + recoupment %
- **D.** Grosses Analysis comments
- **E.** Other Reddit threads found in Step 2
- **F.** Trade press articles found in Step 3
- **G.** Shows in `shows.json` without `commercial.json` entries

### Step 5: AI Analysis (Claude Sonnet)

Claude returns structured JSON with:
- Proposed changes (field, old/new value, isEstimate flag, source, confidence, reasoning)
- `estimatedRecoupmentPct` updates from Reddit ranges
- Shadow classifier disagreements
- New show entries

### Step 6: Apply Changes

- `confidence: "high"` and `confidence: "medium"` -- **auto-apply**
- `confidence: "low"` -- do NOT apply, mention in issue only
- Designation upgrades (e.g., Windfall to Miracle) -- **never auto-apply**, flag only

### Step 7: GitHub Issue Notification

Every week with changes, create an issue with:
- Changes Applied table (show, field, old/new, confidence, source)
- Suggestions Not Applied
- Shadow Classifier Disagreements
- Sources Consulted (Reddit links + trade press articles)
- Shows unchanged

Labels: `commercial-update`, `automated`

### Step 8: Insider Info Submission

GitHub issue template (`commercial-tip.yml`) with fields for show name, tip type (recoupment/capitalization/running cost/closing/other), details, and source. Companion workflow auto-processes tips via Claude.

## Data Model Changes

### New fields in `commercial.json` per show

```json
{
  "estimatedRecoupmentPct": [80, 100],
  "estimatedRecoupmentSource": "Reddit Grosses Analysis (u/Boring_Waltz_9545)",
  "estimatedRecoupmentDate": "2026-01-25",
  "weeklyRunningCostSource": "Reddit Grosses Analysis",
  "isEstimate": {
    "capitalization": false,
    "weeklyRunningCost": true,
    "recouped": false
  }
}
```

- `estimatedRecoupmentPct` -- `[low, high]` from Reddit ranges. Null if unknown.
- `isEstimate` -- per-field flags driving `~` prefix in the UI.

### Display convention: `~` prefix

- `~$1.0M` weekly cost (estimate) vs `$22M` capitalization (SEC filing -- no tilde)
- `~65% recouped` (estimate)
- `~32 weeks to recoup` (calculated)

### Change log (`data/commercial-changelog.json`)

Each weekly run appends an entry with: date, sources consulted, changes made, shadow classifier disagreements. Provides audit trail.

## Designation Rules

### Live rules (conservative)

```
NEVER CHANGE: Miracle, Nonprofit (stable categories)

IF recouped announced (official source):
  Set recouped=true, recoupedDate, recoupedWeeks
  IF currently TBD -> "Windfall" (conservative default)
  Flag if Miracle might be appropriate

IF closing/closed AND recouped==false:
  IF estimatedRecoupmentPct < 30% -> "Flop"
  IF estimatedRecoupmentPct >= 30% -> "Fizzle"

IF nonprofitOrg exists -> "Nonprofit" (never changes)

IF still running AND not recouped -> keep "TBD"
```

Designation upgrades (Windfall to Miracle) are **flagged but never auto-applied**.

### Shadow classifier (background experiment)

Compute heuristic designations using gross/cap ratio + recoupment speed. Log disagreements in the weekly GitHub issue. Over time, validate against shows where we have real profit estimates from the Reddit analyst. Only promote to live rules once validated.

**Why:** Broadway margins are thin. Outsiders had $122M gross on $22M cap but took 744 performances to recoup because operating costs were high. Gross/cap ratio alone doesn't reflect profitability.

### Display description updates

| Designation | New Description |
|-------------|-----------------|
| Miracle | Long-running mega-hit -- extraordinary returns |
| Windfall | Solid hit -- recouped and profitable |
| Trickle | Broke even or modest profit |
| Fizzle | Closed without recouping (~30%+ recovered) |
| Flop | Closed without recouping (~<30% recovered) |

Replace current "Profit > Nx" language which we can't actually compute.

### TBD + recoupment tracker

Keep TBD as single category. Add visible `estimatedRecoupmentPct` field:
- Show pages: `TBD -- ~80-100% recouped`
- Simple progress bar in BizBuzzCard
- Source attribution: `Source: Reddit Grosses Analysis (rough estimate)`

## Designation Audit (Current Data)

| Show | Current | Gross/Cap | Issue? |
|------|---------|-----------|--------|
| Chicago | Miracle | 334x | Correct |
| Wicked | Miracle | 131x | Correct |
| Hamilton | Miracle | 91x | Correct |
| Lion King | Miracle | 86x | Correct |
| Book of Mormon | Miracle | 77x | Correct |
| **Mamma Mia** | **Windfall** | **67x** | **Shadow classifier: Miracle** |
| Aladdin | Miracle | 54x | Correct |
| **Hadestown** | **Windfall** | **22x** | **Shadow classifier: Miracle** |
| **Oh Mary** | **Windfall** | **20x** | **Shadow classifier: Miracle** |
| MJ | Windfall | 14x | Correct |
| And Juliet | Windfall | 10x | Correct |
| Stereophonic | Windfall | 7x | Correct |
| **Outsiders** | **TBD** | **6.4x** | **Needs update: recouped $22M** |
| **Harry Potter** | **Windfall** | **4.9x** | **Shadow classifier: Miracle** (5+ years profitable, $2.1M/wk at 96% capacity) |

### Data issues to fix
- **Moulin Rouge:** grosses.json shows $72M (should be ~$194M+)
- **Our Town:** grosses.json shows $1.6M (clearly wrong)
- **Six:** no grosses data at all
- **Outsiders:** cap listed as $19M, should be $22M per announcement

## Remaining Open Questions

1. **Miracle reclassifications:** Should Mamma Mia, Harry Potter, Oh Mary, Hadestown be manually upgraded now, or wait for shadow classifier validation? Mamma Mia at 67x is the clearest case.

2. **Shadow classifier promotion timeline:** How many weeks of data before promoting heuristic rules to live? Suggestion: 8-12 weeks.

## Schedule, Secrets, Cost

- **Schedule:** Wednesday 4pm UTC (after Tuesday grosses refresh)
- **Secrets needed:** SCRAPINGBEE_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN (all exist)
- **Cost:** ~$0.15/week, ~$8/year

## File Changes Summary

**New files:**
- `scripts/update-commercial-data.js`
- `.github/workflows/update-commercial.yml`
- `.github/workflows/process-commercial-tip.yml`
- `.github/ISSUE_TEMPLATE/commercial-tip.yml`
- `data/commercial-changelog.json`

**Modified files:**
- `data/commercial.json` (+ new fields)

**UI changes:**
- Update designation descriptions (remove "Profit > Nx")
- Add `~` prefix rendering for estimated values
- Add recoupment progress bar to BizBuzzCard
- Add `estimatedRecoupmentPct` display to show pages and /biz-buzz table
