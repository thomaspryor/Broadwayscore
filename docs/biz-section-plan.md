# Broadway Business Intelligence Section - Plan Review

## Context

I run Broadway Scorecard (broadwayscorecard.com), a review aggregator for Broadway shows. I have unique commercial/financial data that's hard to find elsewhere:

- **Capitalization** (investment amounts) for 40+ shows ($2.5M - $35M range)
- **Recoupment status** (did it pay back investors?)
- **Weeks to recoup** (how fast?)
- **Weekly running costs** for ~20 shows
- **Commercial designations** (Miracle, Windfall, Fizzle, Flop, etc.)
- **55+ weeks of historical grosses** data

This data is valuable to industry insiders (producers, investors, theater professionals). Weekly box office grosses are published everywhere (BroadwayWorld, Playbill) - but recoupment/investment data is NOT.

## Current State

I have a `/biz-buzz` page that shows:
- "Fastest to Recoup" sortable table
- "Most Expensive Productions" sortable table
- Shows grouped by designation (Miracle, Windfall, Flop, etc.)

Individual show pages (`/show/[slug]`) have a "Commercial Scorecard" card showing designation, capitalization, recoupment status.

## Proposed Plan

Create a `/biz` section focused on **recoupment tracking and investment analysis**.

### Option A: Simple Enhancement (Minimal)
Just enhance the existing `/biz-buzz` page:
- Add key stats at top (recoupment rate, avg weeks to recoup, fastest recouper)
- Add "shows in progress" section with recoupment estimates
- Rename route from `/biz-buzz` to `/biz`

### Option B: Dashboard + Deep Dives (Moderate)
- `/biz` - Dashboard with key metrics and status grid
- `/biz/[slug]` - Individual show financial deep dive (more detail than current show page card)
- Redirect `/biz-buzz` to `/biz`

### Option C: Full Section (Original Plan)
- `/biz` - Dashboard
- `/biz/recoupment` - Detailed recoupment tracker
- `/biz/investments` - Investment comparison by budget tier
- `/biz/[slug]` - Show deep dive

## Key Questions for Review

1. **Scope**: Is Option C over-engineered? The data is already unique and valuable - does it need 4 separate pages or would Option A/B suffice?

2. **Metrics to highlight**: What aggregate stats matter to industry insiders?
   - Recoupment rate (~25% of shows recoup)
   - Average weeks to recoup
   - Capital at risk (sum of investments for shows that haven't recouped)
   - Fastest recoupers

3. **Progress visualization**: For shows still running (TBD status), I have estimated recoupment ranges like "70-80% recouped". Should I show:
   - Progress bars (may imply false precision)
   - Just the percentage range as text
   - Color-coded status (on-track/at-risk)

4. **Individual show pages**: Should `/biz/[slug]` exist separately, or just enhance the existing `/show/[slug]` page with more commercial detail?

5. **What's missing?** Is there something obvious that industry insiders would want that I'm not considering?

6. **What's unnecessary?** Am I planning features that don't add value?

## Available Data Fields

```
Per show (commercial.json):
- designation: Miracle | Windfall | Trickle | Easy Winner | Fizzle | Flop | Nonprofit | TBD | Tour Stop
- capitalization: number (e.g., 12500000 for Hamilton)
- weeklyRunningCost: number | null (only ~20 shows have this)
- recouped: boolean | null
- recoupedDate: "YYYY-MM" format
- recoupedWeeks: number (e.g., 26 for Hamilton)
- estimatedRecoupmentPct: [min, max] for TBD shows (e.g., [70, 80])
- notes: string (detailed narrative)
- sources: SEC filings, trade press, Reddit analysis

Per show (grosses.json - weekly):
- gross, capacity %, average ticket price, attendance
- Week-over-week and year-over-year comparisons
- All-time totals (gross, performances, attendance)
```

## Constraints

- Next.js 14 with static export (no server runtime)
- All data loaded from JSON at build time
- Mobile-responsive required
- Target audience: Industry insiders, not casual theatergoers

## What I Want From This Review

1. Which option (A, B, or C) best balances value vs complexity?
2. What features should I cut?
3. What am I missing that would be high-value/low-effort?
4. Any UX or technical red flags?

The data itself is the value proposition. I don't need bells and whistles - just the right presentation.
