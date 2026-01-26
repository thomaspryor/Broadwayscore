# Broadway Scorecard Expansion Plan

**Created:** January 25, 2026
**Status:** Planning - Awaiting User Feedback

---

## Executive Summary

This document prioritizes the expansion features into **parallel workstreams** that can run in separate Claude Code sessions alongside your main COMPLETENESS work.

### Recommended Priority Order

| Priority | Feature | Complexity | Data Ready? | Parallel Safe? |
|----------|---------|------------|-------------|----------------|
| 1 | **Awards Card** | Low | 80% | Yes |
| 2 | **Audience Buzz (Phase 1)** | Medium | 70% | Yes |
| 3 | **Biz Buzz** | High | 30% | Yes |
| 4 | **Submit Missing Review** | Low | N/A | Yes |
| 5 | **Lottery/Rush** | Medium | 0% | Yes |
| 6 | **Site Feedback Form** | Low | N/A | Yes |
| 7 | **Audience Buzz (Phase 2 - Reddit)** | High | 0% | Yes |

---

## Workstream A: Awards Card (Recommended First)

**Why first:** Structured data, high value, adds credibility, no external dependencies

### Data Sources
- **Tony Awards** - tonyawards.com/winners/ (searchable database)
- **Drama Desk Awards** - dramadesk.org
- **Outer Critics Circle** - outercritics.com
- **Wikipedia** - Has well-structured tables per season

### Proposed Schema Addition to shows.json
```json
{
  "awards": {
    "tony": {
      "season": "2024-25",
      "wins": ["Best Musical", "Best Actor in a Musical"],
      "nominations": ["Best Book", "Best Score", "Best Direction"]
    },
    "dramadesk": {
      "season": "2024-25",
      "wins": ["Outstanding Musical"],
      "nominations": ["Outstanding Actor"]
    }
  },
  "awardsDesignation": "Lavished" // or "Recognized" or "Shut-out"
}
```

### Award Bodies to Track
1. **Tony Awards** - The headline, most prestigious
2. **Drama Desk Awards** - Broadway + Off-Broadway
3. **Outer Critics Circle Awards** - Commonly referenced; Broadway + Off-Broadway
4. **Drama League Awards** - Oldest, appears in bios/press constantly
5. **New York Drama Critics' Circle Awards** - Critics' "best of season" signal
6. **Pulitzer Prize for Drama** - Rare but huge (special badge treatment)

### Designation Definitions
- **Lavished** - 3+ major wins across all bodies
- **Recognized** - 1-2 wins OR 4+ nominations with 0-1 wins
- **Shut-out** - Eligible but received 0 nominations
- **Pre-Season** - Not yet eligible (show opened after cutoff)
- **Pulitzer Winner** - Special badge overlay if won Pulitzer

### Tasks for this Workstream
1. Research: Scrape Tony Awards data for all 40 shows (Wikipedia is cleanest)
2. Research: Scrape Drama Desk data
3. Create `data/awards.json` with structured data
4. Add `awardsDesignation` calculation logic to `src/lib/data.ts`
5. Build `AwardsCard` component for show pages
6. Decide homepage treatment (badge? filter?)

**Estimated files touched:** 4-5 new/modified files
**Can run parallel to:** All other workstreams

---

## Workstream B: Audience Buzz (Phase 1 - Show Score + Mezzanine)

**Why second:** We already have 70% of Show Score data locally!

### Current State
- `data/show-score.json` has audience scores for ~22 shows
- 41 HTML archives in `data/aggregator-archive/show-score/`
- Missing: extraction for remaining shows, Mezzanine data

### Phase 1 Tasks (No Reddit Yet)

1. **Complete Show Score extraction**
   - Run `scripts/extract-show-score-reviews.js` on remaining archives
   - Fetch missing pages via Playwright for new shows
   - Add `audienceScore` and `audienceReviewCount` to shows.json

2. **Mezzanine Stars integration**
   - Create `data/mezzanine.json` structure
   - User uploads screenshots directly to Claude Code chat
   - Claude extracts: show name, star rating (X.X/5), review count
   - Data stored in `data/mezzanine.json`

3. **Combined Audience Score calculation**
   - Weighted average: Show Score (50%) + Mezzanine (50%)
   - Fallback to single source if only one available

4. **Audience Buzz designation logic**
   ```
   90-100: "Loving It"
   75-89:  "Liking It"
   60-74:  "Take-it-or-Leave-it"
   0-59:   "Loathing It"
   ```

5. **UI Components**
   - `AudienceBuzzCard` - main designation display
   - `AudienceSourceCards` - row of 3 source cards (Show Score, Mezzanine, Reddit placeholder)
   - Links to Show Score pages

### Schema Addition
```json
{
  "audienceBuzz": {
    "designation": "Loving It",
    "combinedScore": 92,  // hidden from users
    "sources": {
      "showScore": { "score": 95, "reviews": 3213 },
      "mezzanine": { "score": 89, "reviews": 847 },
      "reddit": null  // Phase 2
    }
  }
}
```

**Can run parallel to:** Awards (different data), Biz Buzz (different section)

---

## Workstream C: Biz Buzz (Commercial Performance)

**Why complex:** Requires significant research from external sources

### Components

1. **Box Office (Already Done)**
   - Weekly grosses ✅
   - All-time stats ✅
   - Just need UI reorganization

2. **Capitalization Estimates (Research Heavy)**
   - Sources: Trade press, Reddit u/thebroadwaygrossesboy, press releases
   - Often announced: "Show X has a capitalization of $Y million"
   - Range: $5-8M (plays) to $15-30M (musicals) to $50M+ (spectacles)

3. **Recoupment Status (Research Heavy)**
   - Binary: Recouped / Not Recouped / Unknown
   - Sometimes: Weeks to recoup (if announced)
   - Source: Press releases, Reddit analysis posts

4. **Commercial Designation**
   ```
   Miracle    - Profit > 3x investment (Hamilton, Lion King)
   Windfall   - Profit > 1.5x investment
   Trickle    - Broke even or modest profit over time
   Sugar Daddy - Limited run that made money (not open-ended)
   Fizzle     - Lost money but not all
   Flop       - Lost most/all investment
   TBD        - Too early to tell (still running)
   ```

### Data Structure
```json
{
  "bizBuzz": {
    "designation": "TBD",
    "capitalization": 16500000,  // $16.5M
    "capitalizationSource": "press release",
    "recouped": null,  // true/false/null
    "recoupedWeek": null,  // "Week 34" if known
    "recoupedSource": null
  }
}
```

### Research Approach
1. Create `scripts/research-capitalization.js` that:
   - Searches Reddit r/broadway for "{show name} capitalization OR budget OR recoup"
   - Uses LLM to extract numbers from results
   - Flags confidence level (confirmed vs estimated)

2. Deep research session (you + me) for major shows
3. Manual data entry in `data/commercial.json`

**Can run parallel to:** All others (separate data concern)

---

## Workstream D: Submit Missing Review

**Why easy:** Standard form + LLM validation

### Flow
1. User submits URL + optional outlet name
2. GitHub Action triggered via form submission
3. LLM validates:
   - Is it a Broadway review?
   - Is the show in our database?
   - Is it from a legitimate outlet?
   - Is it already in our reviews?
4. If valid → auto-add to pending queue or directly to reviews
5. If invalid → log rejection reason

### Implementation
- Use Formspree, Netlify Forms, or simple GitHub Issues
- GitHub Action processes new submissions
- LLM via Claude API for validation

**Files:** 1 component, 1 GitHub Action, 1 validation script

---

## Workstream E: Lottery/Rush Information

**Challenge:** No APIs, data changes frequently

### Data Sources (must scrape/check regularly)
| Platform | URL | Data Available |
|----------|-----|----------------|
| Broadway Direct | lottery.broadwaydirect.com | Shows, prices, times |
| TodayTix | App only | Rush times, prices |
| LuckySeat | luckyseat.com | Digital lottery shows |
| Telecharge Rush | rush.telecharge.com | Shows, times, prices |
| Playbill | playbill.com/article/broadway-rush-lottery-policies | Comprehensive list |

### Recommended Approach
1. **Weekly scrape** of Playbill's comprehensive list (most stable source)
2. Store in `data/lottery-rush.json`:
   ```json
   {
     "hamilton-2015": {
       "lottery": {
         "platform": "Broadway Direct",
         "url": "https://lottery.broadwaydirect.com/show/hamilton/",
         "price": 10,
         "instructions": "Enter by 9am for matinees, 4pm for evening"
       },
       "rush": null,
       "standingRoom": {
         "price": 27,
         "availability": "When sold out",
         "instructions": "Box office opens at 10am day of"
       }
     }
   }
   ```

3. **Reddit intelligence** - Search r/broadway weekly for lottery/rush tips
4. UI: Simple card per show with platform links

**GitHub Action:** Weekly update on Mondays

---

## Workstream F: Site Feedback Form

**Simplest feature**

### Implementation
1. Add `/feedback` page with form
2. Use Formspree or similar (no backend needed)
3. Weekly GitHub Action:
   - Fetches new submissions
   - LLM categorizes: Bug, Feature Request, Content Error, Praise, Other
   - Sends email digest to you

**Files:** 1 page component, 1 GitHub Action

---

## Workstream G: Audience Buzz (Phase 2 - Reddit Sentiment)

**Why last:** Most complex, requires robust pipeline

### Technical Approach

1. **Reddit API Setup**
   - Free tier: 100 requests/minute (plenty for our needs)
   - PRAW (Python Reddit API Wrapper) or raw API
   - Read-only access sufficient

2. **Data Collection** (per show)
   - Search r/broadway for: `"{show name}" saw OR watched OR review`
   - Filter: Only posts/comments from last 2 years
   - Exclude: News articles, cast announcements
   - Target: 50-200 relevant comments per show

3. **LLM Sentiment Analysis**
   - Batch process comments through Claude API
   - Output per comment: positive/negative/mixed/neutral + confidence
   - Aggregate to show-level score

4. **Deduplication & Quality**
   - Detect same user posting multiple times
   - Weight by upvotes
   - Ignore very short comments (<50 chars)

### Schema
```json
{
  "reddit": {
    "score": 78,  // 0-100
    "sampleSize": 127,
    "lastUpdated": "2026-01-20",
    "sentiment": {
      "positive": 0.62,
      "mixed": 0.23,
      "negative": 0.15
    }
  }
}
```

### Scripts Needed
- `scripts/reddit-scraper.js` - Collect comments
- `scripts/reddit-sentiment.js` - LLM analysis
- `scripts/update-audience-buzz.js` - Combine all sources

**GitHub Action:** Monthly update (sentiment doesn't change fast)

---

## Parallel Session Recommendations

You can run these Claude Code sessions simultaneously:

### Session 1: COMPLETENESS (your main work)
Continue review gathering and analysis

### Session 2: Awards + Audience Buzz Phase 1
```
"Work on Awards Card and Show Score integration per EXPANSION-PLAN.md"
```
These share similar patterns (structured data → schema → UI)

### Session 3: Biz Buzz Research
```
"Research capitalization and recoupment data for all shows per EXPANSION-PLAN.md"
```
Research-heavy, can run independently

### Session 4: Forms + Lottery (Later)
```
"Implement feedback form and lottery/rush tracking per EXPANSION-PLAN.md"
```
Lower priority, simpler features

---

## Workstream H: Critic Consensus

**Status:** ✅ Completed (January 25, 2026)

LLM-generated 2-sentence editorial summaries for each show, similar to Rotten Tomatoes' Critic Consensus.

### Implementation
- **Data:** `data/critic-consensus.json` - Stores consensus text, review count, last updated date
- **Script:** `scripts/generate-critic-consensus.js` - Uses Claude API to generate summaries from review texts
- **Component:** `src/components/CriticConsensusCard.tsx` - Displays consensus with quote icon
- **Location:** Show page, between synopsis and critic reviews section
- **Automation:** `.github/workflows/update-critic-consensus.yml` - Runs weekly on Sundays

### Features
- Only regenerates if 3+ new reviews added (prevents unnecessary API calls)
- Uses `--force` flag to regenerate all shows
- Based on all available review texts (full text + excerpts)
- Temperature 0.7 for varied phrasing
- Validates 2-sentence format

### Update Policy
- Runs weekly on Sundays at 2 AM UTC (9 PM ET Saturday)
- Smart detection: only regenerates shows with 3+ new reviews since last update
- Manual trigger available via GitHub Actions UI with force flag

---

## Decisions Made (January 25, 2026)

1. **Awards:** Tony, Drama Desk, Outer Critics Circle, Drama League, NY Drama Critics' Circle, Pulitzer Prize for Drama

2. **Mezzanine:** User will upload screenshots to Claude Code chat for extraction

3. **Biz Buzz:** Research via Deep Research + Reddit scraping + LLMs. User has some financials, can get more.

4. **Reddit grosses:** Search for posts by same user titled "GROSSES ANALYSIS + {date}" - weekly posts with capitalization/recoupment data

5. **Commercial designations:** Renamed "Easy Lay" → "Sugar Daddy"

6. **Lottery/Rush:** Not urgent, but LLM can parse Playbill's comprehensive list easily

7. **Review submission:** GitHub Issues backend (simple, free)

---

## Next Steps

Once you answer the questions above, I can:
1. Start on **Awards Card** immediately (cleanest data, high value)
2. Complete **Show Score extraction** from existing archives
3. Create the data schemas for all new features
4. Draft the UI components

Let me know which workstream(s) you want to kick off first!
