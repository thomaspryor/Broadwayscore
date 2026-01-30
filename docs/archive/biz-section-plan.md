# Broadway Investment Tracker - Final Plan

## Summary

Create a `/biz` section (renamed from `/biz-buzz`) focused on **recoupment tracking and investment data** - unique information that's hard to find elsewhere.

**Target audience:** Industry insiders (producers, investors, theater professionals)

**Core principle:** The data itself is the value. No bells and whistles.

## AI Review Consensus

Reviewed by Claude (Sonnet), GPT-4o, and Gemini 2.0 Flash. **All three recommend Option B.**

| Recommendation | All 3 Models Agree |
|----------------|-------------------|
| Option B (Dashboard + enhanced show pages) | ✓ |
| No separate `/biz/[slug]` pages | ✓ |
| No progress bars for TBD shows | ✓ (Gemini dissents, wants color-coding) |
| Cut `/biz/investments` page | ✓ |
| Add ROI metrics | ✓ |
| CSV/JSON data download | Gemini (high-value, low-effort) |

## Final Scope

### Route Structure

```
/biz                    # Dashboard (rename from /biz-buzz)
/biz-buzz               # Redirect to /biz
```

No sub-pages. Enhance existing `/show/[slug]` pages with more financial detail.

---

## Dashboard Layout (`/biz/page.tsx`)

### Header
- **"Broadway Investment Tracker"**
- Subtitle: "Recoupment data and investment metrics for industry insiders"
- Data download button (CSV/JSON) - requires email for lead gen (optional)

### Key Metrics Row (4 cards)

| Metric | Description |
|--------|-------------|
| **Capital at Risk** | Sum of capitalization for non-recouped shows currently running |
| **Recouped** | "X of Y shows" (not percentage - more impactful) |
| **Avg Time to Recoup** | XX weeks average |
| **Fastest** | [Show name] (XX weeks) |

### ROI Leaders Section (NEW)

For recouped shows still running, show:
- Show name
- Capitalization
- Weeks to recoup
- **Estimated ROI** (where calculable): `(Continued Earnings) / Capitalization`
  - e.g., "Hamilton: $12.5M invested → estimated 10x+ return"

### Recoupment Status Grid (3 columns, card-based)

| Recouped | In Progress | Did Not Recoup |
|----------|-------------|----------------|
| Shows with `recouped: true` | TBD shows | Fizzle/Flop shows |
| Weeks to recoup | Text: "~70-80% recouped" | % recovered if known |
| Link to show page | Link to show page | Link to show page |

**Mobile:** Stacks vertically as cards.

### Existing Tables (keep)
- Fastest to Recoup (sortable)
- Most Expensive Productions (sortable)
- Shows by Designation

### Data Download Section (NEW - from Gemini)

Simple button to download:
- `commercial-data.json` - Full commercial dataset
- `commercial-data.csv` - Flattened for Excel users

Optional: Gate behind email capture for lead generation.

---

## Enhanced Show Pages

Add to existing `/show/[slug]` Commercial Scorecard card:

1. **ROI indicator** for recouped shows still running
   - "Estimated 5x+ return on $12.5M investment"

2. **Recoupment estimate** for TBD shows
   - Text only: "Estimated 70-80% recouped"
   - No progress bars

3. **Weekly financial health** (where `weeklyRunningCost` exists)
   - "Current gross: $1.2M vs ~$600K break-even"
   - Only ~20 shows have this data

4. **Source attribution**
   - Show data sources (SEC filing, trade press, etc.)
   - Flag estimates vs confirmed data

---

## What We're NOT Building

- ❌ `/biz/recoupment` page (merged into dashboard)
- ❌ `/biz/investments` page (unnecessary)
- ❌ `/biz/[slug]` pages (enhance existing show pages)
- ❌ Progress bars for recoupment estimates
- ❌ Budget tier comparison tables
- ❌ Color-coded on-track/at-risk status (Gemini wanted this, but 2/3 said no)

---

## Implementation

### Phase 1: Dashboard
1. Move `/biz-buzz` to `/biz` (keep redirect)
2. Add key metrics row at top
3. Add ROI Leaders section
4. Add 3-column recoupment status grid
5. Add data download buttons
6. Keep existing sortable tables

### Phase 2: Enhanced Show Pages
1. Add ROI indicator to `BizBuzzCard.tsx`
2. Add recoupment estimate text for TBD
3. Add source attribution
4. Add weekly financial health (where data exists)

### Phase 3: Data Export
1. Create `/api/data/commercial.json` static export
2. Create CSV generation (build-time)
3. Optional: Email gate with simple form

---

## Data Functions to Add (`src/lib/data.ts`)

```typescript
// Capital at risk: sum of cap for open, non-recouped shows
function getCapitalAtRisk(): number

// Recoupment stats
function getRecoupmentStats(): {
  recoupedCount: number;
  totalCommercialShows: number;
  avgWeeksToRecoup: number;
  fastestRecoup: { slug: string; title: string; weeks: number };
}

// ROI leaders: recouped shows still running with estimated returns
function getROILeaders(): Array<{
  slug: string;
  title: string;
  capitalization: number;
  weeksToRecoup: number;
  estimatedROI: string | null;  // "10x+" or null if not calculable
}>

// For data export
function getCommercialDataExport(): object
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/app/biz-buzz/page.tsx` | Move to `src/app/biz/page.tsx` |
| `src/app/biz-buzz/` | Add redirect to `/biz` |
| `src/lib/data.ts` | Add new data functions |
| `src/components/BizBuzzCard.tsx` | Add ROI indicator, source attribution |
| `public/data/` | Add exportable JSON/CSV files |

---

## Mobile Considerations

- Key metrics row: 2x2 grid on mobile, 4-column on desktop
- Status grid: Stacks as cards vertically
- Tables: Horizontal scroll
- Download buttons: Full width on mobile

---

## Red Flags Addressed

| Concern | Resolution |
|---------|------------|
| Don't create parallel navigation | Enhance existing `/show/[slug]` pages |
| Mobile responsiveness | Card-based layouts that stack |
| Source reliability (Reddit) | Add source attribution, flag estimates |
| Static export limits | Accept limitation, offer data download for power users |

---

## Verification

1. `npm run build` passes
2. `/biz` loads with all sections
3. `/biz-buzz` redirects to `/biz`
4. Data download works (JSON + CSV)
5. Show pages display enhanced commercial data
6. Mobile layout stacks correctly
