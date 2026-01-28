# Plan: Automated Commercial Scorecard Updates

## Problem

The Commercial Scorecard (`data/commercial.json`) tracks financial performance of 47 Broadway shows — capitalization, recoupment status, weekly running costs, designations (Miracle/Windfall/Fizzle/Flop/etc.), and editorial notes. It was last manually updated Jan 25, 2026. There is no automated update process.

Commercial data changes infrequently but meaningfully: a show recouping its investment, a show closing without recouping, a new show opening and needing an initial entry, or running cost estimates becoming available. Missing an update means stale data on the site.

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

This post also announces major events (e.g., "Outsiders announced this morning that they have finally recouped their initial $22 million investment").

### Secondary Data Sources (actively searched each week)

**r/Broadway broader search** — Beyond the Grosses Analysis post, r/Broadway frequently has standalone threads about recoupment, capitalization, closing announcements, and financial news. Examples:
- "The Outsiders has recouped!" (announcement threads)
- "What's the capitalization of [new show]?" (discussion threads)
- SEC filing breakdowns shared by community members
- Industry insider comments on financial viability

**Trade press** — Recoupment announcements and capitalization figures often break first in:
- **Deadline** (deadline.com/tag/broadway) — Best source for recoupment scoops
- **Variety** (variety.com/t/broadway) — Financial reporting
- **Broadway Journal** (broadwayjournal.com) — SEC filing analysis, capitalization deep-dives
- **Playbill** (playbill.com/news) — Official announcements
- **Broadway News** (broadwaynews.com) — Industry reporting
- **BroadwayWorld** (broadwayworld.com) — Ben Waterhouse's articles (same author as Reddit posts)
- **Forbes** (broadway coverage) — Occasionally breaks capitalization numbers
- **The New York Times** (theater section) — Major financial stories

These are not optional fallbacks — they are actively searched every week alongside the Grosses Analysis post.

## Design Goals

1. **Fully automated** — runs weekly with zero manual intervention
2. **Notification on every change** — GitHub issue created with a diff so the user can review/correct
3. **Easy insider info submission** — simple way for the user to share tips (e.g., "I heard Show X recouped")
4. **Conservative by default** — only make high-confidence updates; flag ambiguous cases for review rather than guessing
5. **Additive** — never delete data, only add or update fields

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ GitHub Action: update-commercial.yml                 │
│ Runs: Weekly (Wednesday 4pm UTC / 11am ET)           │
│ After grosses data is refreshed on Tuesday           │
├──────────────────────────────────────────────────────┤
│                                                      │
│  1. GATHER: Scrape latest r/Broadway Grosses         │
│     Analysis post + top comments (via ScrapingBee)   │
│                                                      │
│  2. GATHER: Search r/Broadway for other threads      │
│     mentioning recoupment, capitalization, closing,  │
│     investment, or financial news (past 7 days)      │
│                                                      │
│  3. GATHER: Search trade press for Broadway          │
│     financial news (past 7 days):                    │
│     - Deadline, Variety, Broadway Journal, Playbill  │
│     - BroadwayWorld, Broadway News, Forbes, NYT      │
│     Uses Claude web search (tool_use) or             │
│     ScrapingBee Google search                        │
│                                                      │
│  4. LOAD: Current commercial.json + grosses.json     │
│     + shows.json for context                         │
│                                                      │
│  5. ANALYZE: Feed ALL gathered data into Claude      │
│     API (Sonnet) with structured prompt:             │
│     - Current commercial data for each show          │
│     - Box office math (cumulative gross vs cap)      │
│     - Grosses Analysis post + recoupment %           │
│     - Other Reddit threads + comments                │
│     - Trade press articles found                     │
│                                                      │
│  6. Claude returns JSON with proposed changes        │
│     (structured output, not freeform)                │
│                                                      │
│  7. Apply changes to commercial.json                 │
│                                                      │
│  8. Create GitHub issue with change summary +        │
│     links to all sources found                       │
│                                                      │
│  9. Commit + push                                    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Find and Scrape the Latest Grosses Analysis Post

Search r/Broadway for the most recent post with flair "Grosses Analysis" by u/Boring_Waltz_9545.

- Use ScrapingBee (premium proxy) to hit Reddit's JSON API: `https://www.reddit.com/r/Broadway/search.json?q=flair%3A%22Grosses+Analysis%22+author%3ABoring_Waltz_9545&sort=new&limit=1`
- Fetch the post body (markdown text)
- Fetch top-level comments (often contain recoupment data, capitalization info, insider knowledge)
- Store the week-ending date from the post title

### Step 2: Search r/Broadway for Financial Discussions (past 7 days)

Beyond the Grosses Analysis post, search r/Broadway for other threads discussing financial topics. These standalone threads often break news faster than the weekly analysis.

**Search queries** (via ScrapingBee → Reddit JSON API):
- `r/Broadway recouped OR recoupment` (past week)
- `r/Broadway capitalization OR investment OR "SEC filing"` (past week)
- `r/Broadway closing OR "final performance" OR "last show"` (past week)
- `r/Broadway "running costs" OR "weekly nut" OR "break even"` (past week)

For each matching thread:
- Fetch the post body
- Fetch top comments (often the real info is in replies)
- Tag with the show name(s) mentioned

**Example finds:**
- "The Outsiders has officially recouped!" — standalone celebration thread
- "SEC filing for [new show] shows $18.5M capitalization" — community analysis
- "Industry insider: [show] is losing $200K/week" — unverified but useful signal

### Step 3: Search Trade Press for Broadway Financial News (past 7 days)

Search major trade publications for recent articles about Broadway show finances. Use ScrapingBee Google search (or Claude web search if available in the workflow).

**Search queries:**
```
"Broadway" "recouped" site:deadline.com (past 7 days)
"Broadway" "recouped" site:variety.com (past 7 days)
"Broadway" "capitalization" OR "investment" site:broadwayjournal.com (past 7 days)
"Broadway" "recoup" OR "closing" site:playbill.com (past 7 days)
"Broadway" financial OR investment site:broadwaynews.com (past 7 days)
"Broadway" recoup OR capitalization site:broadwayworld.com (past 7 days)
```

For each article found:
- Scrape the article text (or at minimum the title + snippet from search results)
- Extract show name, financial figure, and key fact
- Include the article URL for source attribution

**What we're looking for:**
- Recoupment announcements ("Show X has recouped its $YM investment")
- Capitalization disclosures ("The musical is capitalized at $ZM, per SEC filings")
- Running cost reporting ("Weekly operating expenses of $Xk")
- Closing announcements with financial context
- Investor lawsuit or financial dispute reporting
- Tour/international production revenue affecting Broadway recoupment

### Step 4: Build Context for AI Analysis

Assemble a structured prompt with ALL gathered data:

**A. Current state** — For each show in `commercial.json`:
```
Show: Just in Time
Current designation: TBD
Capitalization: $9.4M (source: Broadway Journal)
Weekly running cost: null
Recouped: false
Notes: "Jonathan Groff star vehicle..."
```

**B. Box office math** — From `grosses.json`:
```
Show: Just in Time
All-time gross: $48.2M
All-time performances: 312
This week gross: $1.3M
This week capacity: 102%
```

**C. Grosses Analysis post excerpt** — The relevant section from the weekly post:
```
Just in Time - $1.3M gross, 102% capacity, $248 atp
Estimated Weekly Operating Cost: $600k/week
Estimated Profit (Loss): $150k+
Estimated percentage recouped: 80%-100%
Commentary: "Jonathan Groff was back, and so were the sky high grosses...
Just in Time should soon follow [Outsiders recoupment] in the next few weeks"
```

**D. Grosses Analysis comments** — Relevant comments from the weekly post

**E. Other Reddit threads** — Any r/Broadway threads from the past week mentioning financial topics for tracked shows

**F. Trade press articles** — Headlines, snippets, and URLs from Deadline/Variety/Broadway Journal/etc. found in Step 3

**G. Shows needing initial entries** — Any shows in `shows.json` that don't have a `commercial.json` entry yet

### Step 5: AI Analysis via Claude API

Send the assembled context to Claude Sonnet with a structured prompt. The prompt instructs Claude to:

1. **Compare** Reddit's estimated recoupment % against our current data
2. **Detect** recoupment announcements or closing announcements
3. **Update** weekly running costs if Reddit provides estimates we don't have
4. **Flag** designation changes (e.g., TBD show closing = Fizzle or Flop)
5. **Create** initial entries for new shows using available data
6. **Propose** notes updates only when significant new info exists

**Claude returns structured JSON:**
```json
{
  "changes": [
    {
      "showId": "just-in-time",
      "field": "weeklyRunningCost",
      "oldValue": null,
      "newValue": 600000,
      "newSource": "Reddit Grosses Analysis (u/Boring_Waltz_9545)",
      "confidence": "high",
      "reasoning": "Consistently reported as $600k/week across multiple weeks"
    },
    {
      "showId": "the-outsiders",
      "field": "recouped",
      "oldValue": false,
      "newValue": true,
      "confidence": "high",
      "reasoning": "Official recoupment announced in Grosses Analysis post: 'Outsiders announced this morning that they have finally recouped their initial $22 million investment'"
    },
    {
      "showId": "the-outsiders",
      "field": "designation",
      "oldValue": "TBD",
      "newValue": "Windfall",
      "confidence": "medium",
      "reasoning": "Recouped $22M investment over 744 performances + $121M total grosses. Meets Windfall threshold (>1.5x investment)."
    }
  ],
  "newShows": [],
  "noChanges": ["hamilton", "wicked", "the-lion-king", "..."]
}
```

### Step 6: Apply Changes

- Only apply changes with `confidence: "high"` automatically
- For `confidence: "medium"`, apply but flag in the notification issue
- For `confidence: "low"`, do NOT apply — only mention in the notification issue

### Step 7: Notification via GitHub Issue

If any changes were made (or medium/low-confidence suggestions exist), create a GitHub issue:

```markdown
## Commercial Scorecard Update — Week Ending Jan 25, 2026

### Changes Applied (High Confidence)
| Show | Field | Old → New | Source |
|------|-------|-----------|--------|
| The Outsiders | recouped | false → true | Reddit Grosses Analysis |
| The Outsiders | recoupedDate | null → "2026-01" | Reddit announcement |
| The Outsiders | capitalization | $19M → $22M | Reddit (official announcement cited $22M) |
| Just in Time | weeklyRunningCost | null → $600,000 | Reddit estimate |

### Changes Applied (Medium Confidence — Review Recommended)
| Show | Field | Old → New | Reasoning |
|------|-------|-----------|-----------|
| The Outsiders | designation | TBD → Windfall | $22M recouped from $121M gross |

### Suggestions Not Applied (Low Confidence)
- **Great Gatsby**: Consider changing TBD → Fizzle. Grosses declining, estimated 10-30% recouped. But show is still open so premature.

### Sources Consulted This Week
**Reddit:**
- [Grosses Analysis - Week Ending January 25](https://reddit.com/r/Broadway/comments/...) (u/Boring_Waltz_9545)
- [The Outsiders has recouped!](https://reddit.com/r/Broadway/comments/...) — 347 upvotes, confirms $22M figure

**Trade Press:**
- [Deadline: "The Outsiders Musical Recoups $22M Broadway Investment"](https://deadline.com/...)
- No other relevant articles found this week

### No Changes Needed
hamilton, wicked, the-lion-king, chicago, ... (37 shows unchanged)
```

Labels: `commercial-update`, `automated`

### Step 8: Insider Info Submission

**Option A: GitHub Issue Template** (recommended — matches existing pattern)

A new issue template (`commercial-tip.yml`) that lets the user submit info:

```yaml
name: Commercial Scorecard Tip
description: Share financial info about a Broadway show
title: "[Biz Tip] "
labels: ["commercial-tip"]
body:
  - type: input
    id: show_name
    attributes:
      label: Show Name
  - type: dropdown
    id: tip_type
    attributes:
      label: What kind of info?
      options:
        - Recoupment announcement
        - Capitalization figure
        - Weekly running cost
        - Closing announcement (financial context)
        - Designation suggestion
        - Other financial info
  - type: textarea
    id: details
    attributes:
      label: Details
      description: What did you learn? Include source if possible.
      placeholder: "Just in Time recouped per Deadline article..."
  - type: input
    id: source
    attributes:
      label: Source (optional)
      placeholder: "Deadline article, personal knowledge, industry contact, etc."
```

A companion workflow (`process-commercial-tip.yml`) watches for issues labeled `commercial-tip`, uses Claude to validate and apply the update, then closes the issue.

**Option B: Formspree form** (like the existing feedback system)

A form at `/biz-tip` on the site. Simpler UX but requires Formspree polling.

**Recommendation:** Option A (GitHub Issues). It's consistent with the existing review submission system, provides a paper trail, and the user can submit from their phone via GitHub's mobile app or even by emailing the repo's issue address.

## Schedule & Dependencies

| Workflow | Schedule | Depends On |
|----------|----------|------------|
| `update-grosses.yml` | Tue/Wed 3pm UTC | BWW data release (Mon/Tue) |
| **`update-commercial.yml`** | **Wed 4pm UTC** | Grosses data refreshed, Reddit post usually up by Wed |
| `process-commercial-tip.yml` | On issue creation | User submits tip |

## Secrets Required

| Secret | Purpose | Already Exists? |
|--------|---------|-----------------|
| `SCRAPINGBEE_API_KEY` | Scrape Reddit JSON | Yes |
| `ANTHROPIC_API_KEY` | Claude analysis | Yes |
| `GITHUB_TOKEN` | Create issues, commit | Yes (built-in) |

No new secrets needed.

## What Gets Updated

Fields in `commercial.json` that automation can reliably update:

| Field | How | Confidence |
|-------|-----|------------|
| `weeklyRunningCost` | Reddit estimates | High (consistent across weeks) |
| `recouped` | Reddit announcements + trade press | High (binary fact) |
| `recoupedDate` | Reddit/press announcement date | High |
| `recoupedWeeks` | Calculate from opening date | High (math) |
| `designation` | Rules-based from recoupment + closing status | Medium (needs judgment) |
| `notes` | AI-generated update with new facts | Medium |
| `capitalization` | SEC filings / press (for new shows) | High when source found |
| New show entries | From `shows.json` diff | High (structural) |

Fields that are NOT auto-updated (require manual/insider input):
| Field | Why |
|-------|-----|
| `capitalizationSource` | Needs verification |
| `recoupedSource` | Should cite specific article |
| Historical show data | No Reddit coverage for closed shows |

## Designation Rules (for AI prompt)

When determining designations, the AI should follow these rules:

```
IF show.recouped == true:
  IF allTimeGross > 3 * capitalization → "Miracle"
  IF allTimeGross > 1.5 * capitalization → "Windfall"
  ELSE → "Trickle"

IF show is closing/closed AND show.recouped == false:
  IF estimatedRecoupmentPct < 30% → "Flop"
  IF estimatedRecoupmentPct >= 30% → "Fizzle"

IF show is limited run AND recouped (or likely):
  → "Easy Winner"

IF show has nonprofitOrg:
  → "Nonprofit" (never changes)

IF show is still running AND not recouped:
  → "TBD" (keep waiting)
```

These are guidelines, not hard rules — the AI should use judgment and flag edge cases.

## Cost Estimate

Per weekly run:
- ScrapingBee: ~15 API calls (Reddit search + post + comments + Google searches for ~8 trade sites) = ~50 credits
- Claude Sonnet: ~1-2 calls with ~15-25K tokens input, ~3K output = ~$0.10-0.15
- **Total: ~$0.15/week, ~$8/year**

Negligible cost.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Reddit post format changes | AI handles natural language; not dependent on exact format |
| u/Boring_Waltz_9545 stops posting | Fallback: trade press search + grosses.json box office math still run |
| Wrong designation applied | Medium-confidence changes flagged in GitHub issue; user can correct |
| Stale data if Reddit post is late | Script checks post date; skips Grosses Analysis if >7 days old but still runs trade press search |
| AI hallucinates a recoupment | Require explicit evidence in source text; high bar for recouped=true changes |
| Trade press paywalls (Deadline, Variety) | Use search result snippets (title + description) which are always visible; only full-scrape free sites |
| False positive from Reddit comments | Comments treated as lower confidence than the OP Grosses Analysis; require corroboration for major changes |
| Too many irrelevant search results | Targeted search queries scoped to Broadway + financial terms; AI filters noise |

## Designation System Evaluation

### Current Problem: Thresholds Aren't Codified

The thresholds ("Profit > 3x investment", "Profit > 1.5x investment") exist **only as display strings** in the UI and JSON metadata. There is no calculation logic anywhere in the codebase. Every designation was manually assigned by vibes. This is a problem for automation — the AI needs clear rules.

### Current Problem: "Profit" Is Usually Unknowable

The definitions reference "Profit > Nx investment" but true profit requires knowing total running costs over the full life of the show. We have weekly running cost data for only 10 of 47 shows, and even then "running costs" is an estimate that excludes royalties, advertising, and other variable expenses. This makes the current definitions impossible to apply systematically.

### Gross/Cap Ratio Audit of Current Designations

Using all-time Broadway gross / capitalization as a rough proxy (sorted by ratio):

| Show | Current | Gross/Cap | Recouped | Issue? |
|------|---------|-----------|----------|--------|
| Chicago | Miracle | 334x | Yes | Correct |
| Wicked | Miracle | 131x | Yes | Correct |
| Hamilton | Miracle | 91x | Yes | Correct |
| Lion King | Miracle | 86x | Yes | Correct |
| Book of Mormon | Miracle | 77x | Yes | Correct |
| **Mamma Mia** | **Windfall** | **67x** | Yes | **Should be Miracle** — $668M on $10M cap, ran 14 years. Even with running costs, profit is many multiples of the $10M investment. |
| Aladdin | Miracle | 54x | Yes | Correct |
| **Hadestown** | **Windfall** | **22x** | Yes | **Borderline Miracle** — $253M on $11.5M, recouped in 30 weeks. Grosses softening but total returns are enormous. |
| **Oh Mary** | **Windfall** | **20x** | Yes | **Borderline Miracle** — $92M on $4.5M, recouped in just 19 weeks (one of fastest ever). Low cap + explosive grosses. |
| MJ | Windfall | 14x | Yes | Correct |
| And Juliet | Windfall | 10x | Yes | Correct |
| Stereophonic | Windfall | 7x | Yes | Correct (closed, modest profit on small cap) |
| **Outsiders** | **TBD** | **6.4x** | **Yes (just announced!)** | **Needs update** — recouped $22M per Reddit announcement. Should be Windfall. |
| Just in Time | TBD | 5.8x | No | Correct TBD (80-100% recouped per Reddit, likely recouping soon) |
| Hell's Kitchen | Fizzle | 5.1x | No | Correct (closing Feb 2026, ~60% recouped) |
| **Harry Potter** | **Windfall** | **4.9x** | Yes | **Should be Miracle?** — See analysis below |
| Great Gatsby | TBD | 4.4x | No | Correct TBD (10-30% recouped per Reddit) |
| Back to the Future | Flop | 3.8x | No | Correct |
| Maybe Happy Ending | TBD | 3.8x | No | Correct TBD (20-40% per Reddit) |
| Cabaret 2024 | Fizzle | 3.5x | No | Correct (closed, lawsuit filed) |
| Buena Vista | TBD | 3.1x | No | Correct TBD |
| Death Becomes Her | TBD | 2.6x | No | Correct TBD (10-30% per Reddit) |
| **Moulin Rouge** | **Windfall** | **2.6x** | Yes | **Data issue** — Notes say $194M+ gross but grosses.json shows only $72M (284 perfs tracked vs actual ~2,000+). Designation may be correct but data is incomplete. |
| Operation Mincemeat | TBD | 2.4x | No | Correct TBD (0-20% per Reddit) |
| Notebook | Fizzle | 2.3x | No | Correct |
| Stranger Things | TBD | 1.9x | No | Correct TBD |
| Suffs | Fizzle | 1.8x | No | Correct |
| Oedipus | Easy Winner | 1.7x | Yes | Correct |
| Roommate | Easy Winner | 1.5x | Unknown | Correct (limited run, low cap) |
| Water for Elephants | Fizzle | 1.4x | No | Correct |
| Two Strangers | TBD | 1.0x | No | Correct TBD (0% per Reddit) |
| All Out | TBD | 1.0x | No | Correct TBD |
| Liberation | Fizzle | 0.9x | No | Correct (just closed) |
| Queen of Versailles | Flop | 0.4x | No | Correct |
| Boop | Flop | 0.3x | No | Correct |
| Our Town | Easy Winner | 0.1x | Unknown | **Data issue** — $1.6M all-time gross is clearly wrong for a show that ran months with Jim Parsons. |
| Six | Windfall | N/A | Yes | Missing grosses data |

### The Harry Potter Case

Harry Potter is the most interesting edge case:
- **Cap:** $35.5M (most expensive play to ever recoup)
- **Gross:** $174M and counting
- **Weekly:** $2.1M at 96% capacity — still running strong
- **Running costs:** $1M/week (one of the few shows where we know this)
- **Estimated profit so far:** ~$174M gross - ~$102M running costs (102 weeks × $1M) - $35.5M cap = ~$36.5M, which is ~1.03x the investment
- **But:** It's generating ~$1.1M/week in profit going forward. In 1 more year that's another $57M. In 2 more years, total profit approaches $150M = 4.2x the investment.

By a strict snapshot of "profit today > 3x investment," it's not a Miracle yet. By trajectory and significance (most expensive play ever to recoup, still running at near-full capacity), calling it merely a "Windfall" undersells it.

**This reveals a core issue:** snapshot-based designations penalize still-running shows. A show that closed 10 years ago with 3.1x profit is a "Miracle" while a still-running show generating $1M/week in profit is just a "Windfall" because it hasn't accumulated enough yet.

### Proposed Designation Improvements

#### 1. Replace "Profit > Nx" with clearer metrics

Since true profit is usually unknowable, base designations on a combination of:
- **Recoupment speed** (weeks to recoup — this IS knowable and widely reported)
- **Gross/Cap ratio** (a proxy for total returns)
- **Ongoing profitability** (for still-running shows, is it generating weekly profit?)

Proposed thresholds:

| Designation | Criteria (any ONE qualifies) |
|-------------|------------------------------|
| **Miracle** | Gross/Cap > 10x AND recouped, OR Recouped in < 30 weeks AND Gross/Cap > 5x, OR Running 5+ years profitably after recouping |
| **Windfall** | Recouped AND Gross/Cap > 3x, OR Recouped in < 52 weeks |
| **Trickle** | Recouped but took > 100 weeks, OR Recouped with Gross/Cap < 3x |
| **Easy Winner** | Limited run, recouped (or pre-recouped from prior production), low risk profile |
| **Nonprofit** | Produced by nonprofit (unchanged) |
| **Fizzle** | Closed without recouping, estimated recoupment 30%+ |
| **Flop** | Closed without recouping, estimated recoupment < 30% |
| **TBD** | Still running, not yet recouped, insufficient data to classify |

Under these proposed thresholds, the reclassifications would be:
- **Mamma Mia: Windfall → Miracle** (67x ratio, ran 14 years — clearly qualifies)
- **Harry Potter: Windfall → Miracle** (recouped, 4.9x and growing, running 5+ years profitably)
- **Oh Mary: Windfall → Miracle** (recouped in 19 weeks AND 20x ratio)
- **Hadestown: Windfall → Miracle** (recouped in 30 weeks AND 22x ratio)
- **Outsiders: TBD → Windfall** (just recouped)

#### 2. Sub-divide TBD (optional, for discussion)

Split TBD into sub-states visible in the UI:

| Sub-state | Criteria | Example |
|-----------|----------|---------|
| **On Track** | Profitable weekly + recoupment % > 40% | Just in Time (80-100%) |
| **Uncertain** | Breaking even or mixed signals | Death Becomes Her, Chess |
| **At Risk** | Losing money weekly or recoupment % < 15% | Two Strangers (0%) |

This makes the /biz-buzz page more informative for currently running shows. The Grosses Analysis post provides the recoupment % estimates needed to make this distinction each week.

**Alternative:** Keep TBD as a single category but add the recoupment % as a visible data point on the card (e.g., "TBD — Est. 80-100% recouped"). This is simpler and may be enough.

#### 3. Define Fizzle/Flop boundary explicitly

Current: No numeric boundary. Proposed: **30% recouped = the line**.
- Recouped 30%+ of investment → Fizzle ("lost money but not catastrophically")
- Recouped < 30% → Flop ("lost most/all investment")

Audit of current assignments against this threshold:
- Hell's Kitchen (60% recouped) → Fizzle ✓
- Cabaret 2024 (~35% recouped, $90M gross / $26M cap, but $1.5M/week costs) → Fizzle ✓
- Water for Elephants ($35.8M / $25M, ~$960K/week costs) → Fizzle ✓
- Suffs ($33.4M / $19M) → Fizzle ✓
- Notebook ($31.8M / $14M) → Fizzle ✓
- Liberation ($6M / $6.5M, ~$450K/week) → Fizzle ✓ (tax credits soften losses)
- Back to the Future ($89.5M / $23.5M) → Hard to tell without running costs
- Boop ($8.8M / $26M = 0.34x) → Flop ✓
- Queen of Versailles ($9.3M / $22.5M = 0.41x) → Borderline — maybe Fizzle by gross/cap but closed very quickly

#### 4. Data Issues to Fix

These shows have data problems that should be resolved regardless of designation rules:
- **Moulin Rouge:** All-time gross shows $72M (284 perfs) but should be ~$194M+ (2,000+ perfs). BWW scraper likely has wrong slug or incomplete data.
- **Our Town:** All-time gross shows $1.6M which is clearly wrong for a show that ran months with Jim Parsons at the Barrymore.
- **Six:** No grosses data at all despite being a long-running show.
- **Outsiders:** Capitalization listed as $19M in our data but Reddit recoupment announcement cited $22M.

## Open Questions for Review

### Automation Questions

1. **Should medium-confidence changes auto-apply or require approval?** Current plan: auto-apply but flag in the GitHub issue notification. Alternative: create a PR instead of direct commit, requiring manual merge for medium-confidence items.

2. **PR-based workflow vs direct commit?** For maximum safety, changes could go to a `staging` branch as a PR for user review before merging. But this adds friction to the "set and forget" goal.

3. **Trade press article scraping depth:** Should we just use search result snippets (title + description from Google), or fully scrape each article found? Snippets are faster and cheaper but may miss key details buried in the article body. Full scraping costs more ScrapingBee credits and may hit paywalls.

### Designation System Questions

4. **Should we switch from "Profit > Nx" to the proposed multi-factor thresholds** (recoupment speed + gross/cap ratio + years running profitably)? The current profit-based definitions are impossible to apply systematically since we rarely know true profit.

5. **Are the proposed Miracle thresholds right?** The proposed criteria (Gross/Cap > 10x AND recouped, OR recouped in < 30 weeks AND > 5x, OR running 5+ years after recouping) would reclassify Mamma Mia, Harry Potter, Oh Mary, and Hadestown from Windfall to Miracle. Does that feel right, or is Miracle being diluted?

6. **Should TBD be sub-divided?** Options:
   - **Option A:** Split into "On Track" / "Uncertain" / "At Risk" (more informative but adds complexity)
   - **Option B:** Keep TBD but add estimated recoupment % as a visible field (simpler)
   - **Option C:** Keep TBD as-is (simplest, but 11 shows with wildly different trajectories look the same)

7. **Is 30% the right Fizzle/Flop boundary?** Or should it be higher (40%? 50%?) or based on something else entirely?

8. **How should we handle the "estimated recoupment %" from Reddit?** Options:
   - Store it as a new field (`estimatedRecoupmentPct`) for display on the site
   - Only use it internally to inform designation decisions
   - Both

9. **Should we add a "recoupment tracker" visual to show pages?** (e.g., a progress bar showing estimated % recouped, sourced from Reddit data) This would make the commercial section more dynamic and interesting.

## File Changes Summary

New files to create:
- `scripts/update-commercial-data.js` — Main script
- `.github/workflows/update-commercial.yml` — Weekly automation
- `.github/workflows/process-commercial-tip.yml` — Insider tip processing
- `.github/ISSUE_TEMPLATE/commercial-tip.yml` — Tip submission template

Files modified:
- `data/commercial.json` — Updated by automation

No UI changes needed — the existing BizBuzzCard and /biz-buzz page already display the data correctly.
