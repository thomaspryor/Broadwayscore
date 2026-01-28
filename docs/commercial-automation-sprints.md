# /biz Section Sprint Plan

## Project Overview

Create a `/biz` section (Broadway Investment Tracker) focused on recoupment tracking and investment analysis for industry insiders. Season-based thinking, recent developments focus, trend indicators.

**Target:** Industry insiders (producers, investors, theater professionals)
**Core Principle:** The data itself is the value. No bells and whistles.

---

## Sprint 0: Infrastructure Setup

**Goal:** Test infrastructure ready, TypeScript types defined
**Demo:** `npm run test:unit` runs (even if no tests yet)

### Task 0.1: Create Unit Test Infrastructure
**Files:** `tests/unit/setup.ts`, `jest.config.js`, `package.json`
**Description:** Set up Jest unit testing for data layer functions with mock data fixtures.

**Acceptance Criteria:**
- Tests can import from `src/lib/data.ts`
- Mock data fixtures directory created at `tests/fixtures/`
- `npm run test:unit` runs Jest successfully
- Tests run in CI via GitHub Actions (update `.github/workflows/test.yml`)

**Test:** Run `npm run test:unit` with a placeholder test file

---

### Task 0.2: Define TypeScript Interfaces for Biz Data
**File:** `src/lib/data.ts` (add near other interfaces)
**Description:** Add TypeScript interfaces for all new data function return types.

**Interfaces to add:**
```typescript
export type RecoupmentTrend = "improving" | "steady" | "declining" | "unknown";

export interface SeasonStats {
  season: string;
  capitalAtRisk: number;
  recoupedCount: number;
  totalShows: number;
  recoupedShows: string[];
}

export interface ApproachingRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  estimatedRecoupmentPct: [number, number];
  trend: RecoupmentTrend;
  weeklyGross: number | null;
}

export interface AtRiskShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  weeklyGross: number;
  weeklyRunningCost: number;
  trend: RecoupmentTrend;
}

export interface RecentRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  weeksToRecoup: number;
  capitalization: number;
  recoupDate: string;
}
```

**Acceptance Criteria:**
- All interfaces exported from data.ts
- Consistent with existing patterns in the file
- No TypeScript errors

**Test:** `npm run build` succeeds

---

## Sprint 1: Data Layer Foundation

**Goal:** All data functions working with real data, testable in isolation
**Demo:** Run `npm run test:unit` showing all new data functions pass

### Task 1.1: Add Season Classification Function
**File:** `src/lib/data.ts`
**Description:** Add `getSeason(dateString: string): string` function that returns Broadway season (e.g., "2024-2025"). Broadway seasons run July 1 - June 30.

**Acceptance Criteria:**
- Returns "2024-2025" for dates July 1 2024 - June 30 2025
- Handles shows without opening dates (return null)
- Works with both "YYYY-MM-DD" and other date formats

**Test:** `tests/unit/data-season.test.ts`
```typescript
expect(getSeason("2024-09-15")).toBe("2024-2025")
expect(getSeason("2024-06-15")).toBe("2023-2024")
expect(getSeason("2025-01-15")).toBe("2024-2025")
```

---

### Task 1.2: Add Season Stats Function
**File:** `src/lib/data.ts`
**Description:** Add `getSeasonStats(season: string): SeasonStats` returning capital at risk, recoupment count, recouped shows list for a given season.

**Capital at Risk Calculation:**
Capital at risk includes shows where ALL of these are true:
- `status === "open"` (currently running)
- `designation === "TBD"` (not yet recouped)
- `capitalization !== null` (we have data)
- Excludes Nonprofit or Tour Stop designations
- Show's opening date falls within the specified season

**Acceptance Criteria:**
- Returns `SeasonStats` interface (defined in Task 0.2)
- Only counts commercial shows (has `commercial.json` entry)
- Handles missing capitalization gracefully (exclude from sum, don't error)
- Returns zero values for seasons with no data (not null or error)

**Test:** `tests/unit/data-season-stats.test.ts`
- Mock commercial data with known values
- Verify calculations match expected results
- Test edge cases: empty season, all recouped, missing capitalization

---

### Task 1.3: Add Recoupment Trend Calculator
**File:** `src/lib/data.ts`
**Description:** Add `getRecoupmentTrend(slug: string): RecoupmentTrend` that analyzes grosses-history to determine if a show is trending up, flat, or down.

**Note:** Uses `slug` not `showId` to match `grosses-history.json` key format.

**Algorithm (threshold-based):**
1. Get last 4 weeks of gross data from `grosses-history.json`
2. Calculate week-over-week percentage change for each pair
3. Compute average WoW change
4. Categorize:
   - `"improving"`: average WoW change > +2%
   - `"declining"`: average WoW change < -2%
   - `"steady"`: between -2% and +2%
   - `"unknown"`: fewer than 3 weeks of data

**Acceptance Criteria:**
- Returns `RecoupmentTrend` type (defined in Task 0.2)
- Handles sparse data (gaps in weeks) gracefully
- Returns `"unknown"` for new shows without history
- Does not throw errors, always returns valid trend

**Test:** `tests/unit/data-trend.test.ts`
- Test with mock grosses-history showing upward trend (+5% avg)
- Test with mock showing downward trend (-3% avg)
- Test with mock showing flat trend (+1% avg)
- Test with insufficient data (< 3 weeks)
- Test with gaps in weekly data

---

### Task 1.4: Add Approaching Recoupment Function
**File:** `src/lib/data.ts`
**Description:** Add `getShowsApproachingRecoupment()` returning TBD shows with estimated recoupment 40%+ and positive/steady trend.

**Acceptance Criteria:**
- Returns array of shows with: `{ slug, title, season, capitalization, estimatedRecoupmentPct, trend, weeklyGross }`
- Only includes shows where `estimatedRecoupmentPercentage` exists and lower bound >= 40%
- Excludes shows with "declining" trend
- Sorted by estimated recoupment % descending

**Test:** `tests/unit/data-approaching.test.ts`

---

### Task 1.5: Add At-Risk Shows Function
**File:** `src/lib/data.ts`
**Description:** Add `getShowsAtRisk()` returning shows operating below break-even or with declining trajectory.

**Acceptance Criteria:**
- Returns array of shows with: `{ slug, title, season, capitalization, weeklyGross, weeklyRunningCost, trend }`
- Includes shows where: `weeklyGross < weeklyRunningCost` OR `trend === "declining"`
- Only TBD designation shows
- Sorted by severity (below break-even first, then by how much)

**Test:** `tests/unit/data-at-risk.test.ts`

---

### Task 1.6: Add Recent Recoupments Function
**File:** `src/lib/data.ts`
**Description:** Add `getRecentRecoupments(months: number = 24)` returning shows that recouped within the specified period.

**Acceptance Criteria:**
- Returns array with: `{ slug, title, season, weeksToRecoup, capitalization, recoupDate }`
- Uses `recoupDate` field from commercial.json
- Sorted by recoup date descending (most recent first)
- Limit to shows with actual recoupDate (not just recouped: true)

**Test:** `tests/unit/data-recent-recoupments.test.ts`

---

### Task 1.7: Validate All Sprint 1 Tests Pass
**Description:** Run full unit test suite to validate data layer implementation.

**Acceptance Criteria:**
- All tests from Tasks 1.1-1.6 pass
- No console warnings or errors
- Tests run in under 10 seconds

**Validation:** `npm run test:unit` exits with code 0

---

## Sprint 2: Core Components

**Goal:** Reusable UI components built and visually testable
**Demo:** Components visible in a test page at `/biz-test` (removed after sprint)

### Task 2.1: Create SeasonStatsCard Component
**File:** `src/components/biz/SeasonStatsCard.tsx`
**Description:** Card showing season name, capital at risk, recoupment count, and recouped show names.

**Props:**
```typescript
interface SeasonStatsCardProps {
  season: string           // "2024-2025"
  capitalAtRisk: number    // in dollars
  recoupedCount: number
  totalShows: number
  recoupedShows: string[]  // show titles
}
```

**Acceptance Criteria:**
- Displays capital with ~ prefix (estimate indicator)
- Shows "X of Y" for recoupment count
- Lists recouped show names in smaller text
- Mobile-responsive (full width on small screens)
- Matches mockup styling (dark card, amber accents)

**Test:** Visual inspection + snapshot test

---

### Task 2.2: Create RecentDevelopmentsList Component
**File:** `src/components/biz/RecentDevelopmentsList.tsx`
**Description:** Timeline list of recent commercial events (recoupments, estimates, closings).

**Props:**
```typescript
interface DevelopmentItem {
  date: string           // "Jan 2025"
  type: "recouped" | "estimate" | "closing" | "at-risk"
  showTitle: string
  description: string    // "recouped in ~45 weeks"
}
interface RecentDevelopmentsListProps {
  items: DevelopmentItem[]
  maxItems?: number
}
```

**Acceptance Criteria:**
- Color-coded dots: green (recouped), amber (estimate), red (closing/at-risk)
- Date column left-aligned, fixed width
- Show title in bold white
- "View full changelog" link at bottom
- Matches mockup styling

**Test:** Visual inspection + snapshot test

---

### Task 2.3: Create ApproachingRecoupmentCard Component
**File:** `src/components/biz/ApproachingRecoupmentCard.tsx`
**Description:** Card for a single show approaching recoupment with trend indicator.

**Props:**
```typescript
interface ApproachingRecoupmentCardProps {
  slug: string
  title: string
  season: string
  capitalization: number
  estimatedRecoupmentPct: [number, number]  // [40, 50]
  trend: "improving" | "steady" | "declining" | "unknown"
  weeklyGross?: number
}
```

**Acceptance Criteria:**
- TBD badge in amber
- Investment with ~ prefix
- Est. Recouped as range "~40-50%"
- Trend with arrow icon and color (green up, gray flat, red down)
- Links to show page on click
- Matches mockup styling

**Test:** Visual inspection + snapshot test

---

### Task 2.4: Create AtRiskCard Component
**File:** `src/components/biz/AtRiskCard.tsx`
**Description:** Card for shows at risk, with red accent border.

**Props:**
```typescript
interface AtRiskCardProps {
  slug: string
  title: string
  season: string
  capitalization: number
  weeklyGross: number
  breakEven: number
  trend: "improving" | "steady" | "declining" | "unknown"
}
```

**Acceptance Criteria:**
- "At Risk" badge in red
- Red left border accent
- Shows weekly gross vs break-even comparison
- Trend indicator
- Links to show page on click
- Matches mockup styling

**Test:** Visual inspection + snapshot test

---

### Task 2.5: Create RecoupmentTable Component
**File:** `src/components/biz/RecoupmentTable.tsx`
**Description:** Sortable table for recent recoupments with weeks, capitalization, date.

**IMPORTANT:** Must include `"use client"` directive for client-side sorting state.

**Props:**
```typescript
interface RecoupmentTableProps {
  shows: Array<{
    slug: string
    title: string
    season: string
    weeksToRecoup: number
    capitalization: number
    recoupDate: string  // Format: "MMM YYYY" e.g., "Jan 2025"
  }>
}
```

**Acceptance Criteria:**
- `"use client"` directive at top of file
- Sortable by: weeks, capitalization, date (click header)
- Sort indicators with aria-label for accessibility
- Weeks shown in green
- Capitalization with ~ prefix
- Links to show pages
- Horizontal scroll on mobile
- Empty state: shows "No recent recoupments" message if array is empty
- Matches mockup styling

**Test:** Visual inspection + interaction test (sorting works after page load)

---

### Task 2.6: Create AllShowsTable Component
**File:** `src/components/biz/AllShowsTable.tsx`
**Description:** Full table of all open shows with commercial data.

**IMPORTANT:** Must include `"use client"` directive for client-side sorting and expand state.

**Props:**
```typescript
interface AllShowsTableProps {
  shows: Array<{
    slug: string
    title: string
    designation: string
    capitalization: number
    weeklyGross?: number
    estimatedRecoupmentPct?: [number, number]
    trend?: RecoupmentTrend
  }>
  initialLimit?: number  // default 10
}
```

**Acceptance Criteria:**
- `"use client"` directive at top of file
- Sortable columns with aria-labels
- Designation color-coded with text label (not just color for accessibility)
- Responsive: hide columns on smaller screens (md:hidden classes)
- "View all" expands to show full list (useState for expanded)
- Empty state: shows "No commercial data available" if array is empty
- Matches mockup styling

**Test:** Visual inspection + interaction test (sorting, expand)

---

### Task 2.7: Create DesignationLegend Component
**File:** `src/components/biz/DesignationLegend.tsx`
**Description:** Visual legend explaining Miracle/Windfall/Fizzle/Flop designations.

**Acceptance Criteria:**
- 4-column grid (2x2 on mobile)
- Color-coded designation names
- Brief description for each
- Matches mockup styling

**Test:** Visual inspection + snapshot test

---

### Task 2.8: Create Test Page for Components
**File:** `src/app/biz-test/page.tsx`
**Description:** Temporary page to visually verify all components with mock data.

**Acceptance Criteria:**
- Renders all Sprint 2 components
- Uses realistic mock data
- Visible at `/biz-test` during development
- **Delete after Sprint 2 demo**

**Test:** Visual inspection in browser

---

## Sprint 3: Dashboard Page

**Goal:** `/biz` page fully functional with real data
**Demo:** Visit `/biz` showing all sections with live data

### Task 3.1: Create /biz Route with Layout
**Files:** `src/app/biz/page.tsx`, `src/app/biz/layout.tsx`
**Description:** Create the main dashboard page structure with header, back link, and data download buttons.

**Acceptance Criteria:**
- Title: "Broadway Investment Tracker"
- Subtitle with data sources and last updated date
- "~ indicates estimate" note
- JSON/CSV download buttons (non-functional placeholders)
- Back link to home
- Uses site-wide layout

**Test:** Page loads at `/biz` without errors

---

### Task 3.2: Add Season Stats Section
**File:** `src/app/biz/page.tsx`
**Description:** Add "By Season" row with SeasonStatsCard for 3 most recent seasons.

**Acceptance Criteria:**
- Shows 2024-2025, 2023-2024, 2022-2023 seasons
- Uses getSeasonStats() for each
- 3-column grid (stacks on mobile)
- Real data from commercial.json

**Test:** Verify numbers match manual calculation

---

### Task 3.3: Add Recent Developments Section
**File:** `src/app/biz/page.tsx`
**Description:** Add Recent Developments list from commercial-changelog.json or computed from data.

**Acceptance Criteria:**
- Shows last 5 developments
- Pulls from commercial-changelog.json if exists, else computes from data
- Link to full changelog
- Real data

**Test:** Verify items display correctly

---

### Task 3.4: Add Approaching Recoupment Section
**File:** `src/app/biz/page.tsx`
**Description:** Add grid of ApproachingRecoupmentCards for TBD shows near break-even.

**Acceptance Criteria:**
- Uses getShowsApproachingRecoupment()
- 3-column grid (responsive)
- Heading with description
- Shows up to 6 shows

**Test:** Verify correct shows appear

---

### Task 3.5: Add At-Risk Section
**File:** `src/app/biz/page.tsx`
**Description:** Add grid of AtRiskCards for struggling shows.

**Acceptance Criteria:**
- Uses getShowsAtRisk()
- Red accent styling
- Heading with description
- Only shows if there are at-risk shows

**Test:** Verify correct shows appear (or section hidden if none)

---

### Task 3.6: Add Recent Recoupments Table
**File:** `src/app/biz/page.tsx`
**Description:** Add RecoupmentTable for shows that recouped in last 2 years.

**Acceptance Criteria:**
- Uses getRecentRecoupments(24)
- Sortable table
- Heading with description

**Test:** Verify correct shows and sorting works

---

### Task 3.7: Add All Shows Table
**File:** `src/app/biz/page.tsx`
**Description:** Add AllShowsTable with all open shows having commercial data.

**Acceptance Criteria:**
- Shows all open shows with commercial data
- Initially shows 10, expandable to all
- Sortable columns

**Test:** Verify all open shows appear

---

### Task 3.8: Add Designation Legend and Footer
**File:** `src/app/biz/page.tsx`
**Description:** Add DesignationLegend component and footer with methodology link.

**Acceptance Criteria:**
- Legend displays correctly
- Footer note about estimates vs actuals
- Links to methodology page and old /biz-buzz

**Test:** Visual inspection

---

### Task 3.9: Delete Test Page
**File:** Delete `src/app/biz-test/`
**Description:** Remove the test page now that /biz is complete.

**Acceptance Criteria:**
- `/biz-test` returns 404
- No dead code

---

## Sprint 4: Data Export & Navigation

**Goal:** CSV/JSON export working, navigation integrated
**Demo:** Download buttons work, navigation links in header/footer

**Note:** API routes do NOT work with Next.js static export (`output: 'export'`). All data must be pre-generated at build time as static files.

### Task 4.1: Create Commercial Export Script
**File:** `scripts/generate-commercial-export.js`
**Description:** Build-time script that generates both JSON and CSV exports for download.

**Acceptance Criteria:**
- Creates `public/data/commercial.json` with:
  - All shows with commercial data
  - Merged metadata (title, slug, status, openingDate)
  - Season classification
  - All commercial fields (designation, capitalization, recouped, weeksToRecoup, etc.)
- Creates `public/data/commercial.csv` with headers:
  - Show, Slug, Season, Designation, Capitalization, Recouped, Weeks to Recoup, Est Recoupment %, Weekly Running Cost
- Hook into build process via package.json:
  ```json
  "scripts": {
    "prebuild": "node scripts/generate-commercial-export.js",
    "build": "next build"
  }
  ```

**Test:** Run `npm run prebuild`, verify both files created with correct data

---

### Task 4.2: Wire Up Download Buttons
**File:** `src/app/biz/page.tsx`
**Description:** Make JSON/CSV download buttons functional.

**Acceptance Criteria:**
- JSON button: `<a href="/data/commercial.json" download>↓ JSON</a>`
- CSV button: `<a href="/data/commercial.csv" download>↓ CSV</a>`
- Buttons styled to match mockup (amber accent)

**Test:** Click buttons, verify files download with correct content

---

### Task 4.3: Add /biz Link to Header Navigation
**File:** `src/components/Header.tsx` or `src/app/layout.tsx`
**Description:** Add "Biz" or "Investment Tracker" link in main navigation.

**Acceptance Criteria:**
- Link visible on all pages
- Highlights when on /biz (active state styling)
- Mobile nav includes it
- Positioned appropriately in nav order

**Test:** Visual inspection on desktop and mobile

---

### Task 4.4: Set Up /biz-buzz Redirect
**Files:** `vercel.json`, `src/app/biz-buzz/page.tsx`
**Description:** Redirect /biz-buzz to /biz using Vercel config (static export doesn't support Next.js redirects).

**Implementation:**
1. Add to `vercel.json` (create if doesn't exist):
```json
{
  "redirects": [
    { "source": "/biz-buzz", "destination": "/biz", "permanent": true }
  ]
}
```

2. Keep `/biz-buzz` page but add client-side fallback redirect for non-Vercel environments:
```tsx
"use client"
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
export default function BizBuzzRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/biz') }, [router])
  return <p>Redirecting to /biz...</p>
}
```

**Acceptance Criteria:**
- `/biz-buzz` redirects to `/biz` on Vercel
- Client-side redirect works as fallback
- Old page content removed (just redirect stub)

**Test:** Visit /biz-buzz, verify redirect (both on Vercel and local dev)

---

### Task 4.5: Add E2E Tests for /biz Page
**File:** `tests/e2e/biz-page.spec.ts`
**Description:** Playwright E2E tests for the /biz page.

**Test Cases (split by complexity):**

**Basic (must have):**
- Page loads without console errors
- All main sections render (season stats, recent developments, approaching, at-risk, tables)
- Navigation links to show pages work
- Back link works

**Medium (should have):**
- Table sorting: click header, verify order changes
- Expand "View all" in AllShowsTable

**Complex (nice to have, may skip in CI):**
- Download buttons: intercept download event, verify file content
- Mobile responsive: resize viewport, verify layout

**Acceptance Criteria:**
- Basic tests must pass
- Medium tests should pass
- Complex tests are optional (use `test.skip` if flaky in CI)

**Test:** `npm run test:e2e` passes

---

## Sprint 5: Enhanced Show Pages & Polish

**Goal:** Show pages enhanced with ROI/trend data, mobile polish
**Demo:** Show pages have new commercial section, responsive on mobile

### Task 5.1: Add Recoupment Trend to BizBuzzCard
**File:** `src/components/BizBuzzCard.tsx`
**Description:** Add trend indicator (arrow + label) to the commercial card on show pages.

**Acceptance Criteria:**
- Shows trend arrow for TBD shows
- Green up for improving, red down for declining
- Only shows if trend data available

**Test:** Visual inspection on show pages

---

### Task 5.2: Add ROI Indicator for Recouped Shows
**File:** `src/components/BizBuzzCard.tsx`
**Description:** For recouped shows still running, add estimated ROI indicator.

**Acceptance Criteria:**
- Only shows for recouped shows with grosses data
- Simple format: "Estimated X years of returns"
- Uses weeks since recoup + weekly gross approximation

**Test:** Visual inspection on recouped show pages

---

### Task 5.3: Add Source Attribution to BizBuzzCard
**File:** `src/components/BizBuzzCard.tsx`
**Description:** Show data source (SEC filing, trade press, etc.) for transparency.

**Acceptance Criteria:**
- Small text showing source
- "Source: SEC filing" or "Source: Trade press estimate"
- Uses `source` field from commercial.json if available

**Test:** Visual inspection

---

### Task 5.4: Mobile Responsiveness Audit & Fixes
**Files:** Various components in `src/components/biz/`
**Description:** Test all new components on mobile and fix layout issues.

**Acceptance Criteria:**
- All cards stack vertically on mobile
- Tables scroll horizontally
- Text readable at all sizes
- Touch targets large enough

**Test:** Manual testing on mobile device or Chrome DevTools

---

### Task 5.5: Add Last Updated Timestamp
**File:** `src/app/biz/page.tsx`
**Description:** Show when commercial data was last updated in header.

**Acceptance Criteria:**
- Displays "Updated [date]" in header
- Pulls from commercial.json `_meta.lastUpdated` or similar
- Falls back to build date if not available

**Test:** Verify date displays correctly

---

### Task 5.6: Performance Optimization
**Files:** Various
**Description:** Ensure /biz page loads fast with static generation.

**Acceptance Criteria:**
- Page is statically generated (no runtime data fetching)
- Lighthouse performance score > 90
- No layout shift (CLS < 0.1)

**Test:** Run Lighthouse audit

---

### Task 5.7: Final QA and Bug Fixes
**Description:** End-to-end testing of all features, fix any bugs found.

**Acceptance Criteria:**
- All links work
- All data displays correctly
- No console errors
- Build passes

**Test:** Full manual QA pass

---

## Validation Checklist

Before marking project complete:

- [ ] `npm run build` passes
- [ ] `npm run test:unit` passes
- [ ] `npm run test:e2e` passes
- [ ] `/biz` loads with all sections
- [ ] `/biz-buzz` redirects to `/biz`
- [ ] JSON download works
- [ ] CSV download works
- [ ] All tables sort correctly
- [ ] Mobile layout stacks correctly
- [ ] Show pages display enhanced commercial data
- [ ] No console errors in browser
- [ ] Lighthouse performance > 90

---

## Files Summary

### New Files to Create
```
# Sprint 0 - Infrastructure
tests/unit/setup.ts                         # Jest setup
tests/fixtures/                             # Mock data directory

# Sprint 1 - Data Layer
tests/unit/data-season.test.ts
tests/unit/data-season-stats.test.ts
tests/unit/data-trend.test.ts
tests/unit/data-approaching.test.ts
tests/unit/data-at-risk.test.ts
tests/unit/data-recent-recoupments.test.ts

# Sprint 2 - Components
src/components/biz/SeasonStatsCard.tsx
src/components/biz/RecentDevelopmentsList.tsx
src/components/biz/ApproachingRecoupmentCard.tsx
src/components/biz/AtRiskCard.tsx
src/components/biz/RecoupmentTable.tsx      # "use client"
src/components/biz/AllShowsTable.tsx        # "use client"
src/components/biz/DesignationLegend.tsx

# Sprint 3 - Dashboard
src/app/biz/page.tsx                        # Main dashboard
src/app/biz/layout.tsx                      # Layout wrapper (optional)

# Sprint 4 - Export & Navigation
scripts/generate-commercial-export.js       # Build-time export script
vercel.json                                 # Redirects config
tests/e2e/biz-page.spec.ts

# Generated at build time (gitignored)
public/data/commercial.json
public/data/commercial.csv
```

### Files to Modify
```
src/lib/data.ts                            # Add interfaces + 6 new functions
src/components/BizBuzzCard.tsx             # Add trend, ROI, source (Sprint 5)
src/components/Header.tsx                   # Add /biz nav link
src/app/biz-buzz/page.tsx                  # Replace with redirect
package.json                                # Add test scripts, prebuild hook
jest.config.js                             # Unit test config
.gitignore                                  # Ignore generated export files
```

---

## Dependencies Between Tasks

```
Sprint 0 (Infrastructure)
    ↓
Sprint 1 (Data) → Sprint 2 (Components) → Sprint 3 (Dashboard)
    ↓                                          ↓
    └──→ Sprint 4.1-4.2 (Export Script) ←──────┘
                    ↓
         Sprint 4.3-4.5 (Nav & Tests)
                    ↓
              Sprint 5 (Polish)
```

**Critical Path:** 0 → 1 → 2 → 3 → 4.3+ → 5

**Parallelization:**
- Sprint 4.1-4.2 (Export Script) can run parallel to Sprint 2-3
- Tasks 4.3-4.5 depend on Sprint 3 completion

---

## Risk Assessment

### Hardest Tasks (by difficulty)
1. **Task 1.3 (Recoupment Trend Calculator)** - Most likely to have bugs due to sparse data handling
2. **Task 4.5 (E2E Tests)** - Testing sorting and downloads in Playwright is tricky
3. **Task 2.5/2.6 (Sortable Tables)** - Client-side state + responsive + accessibility

### What Could Go Wrong
1. **Sparse grosses-history data** - New shows may not have 4 weeks of history
2. **commercial.json mismatches** - Shows in commercial.json may not exist in shows.json
3. **Static export caching** - Stale data if rebuild doesn't happen after data updates
4. **Mobile table UX** - Horizontal scroll is poor UX; may need card fallback

### Mitigation
- Add graceful fallbacks in data functions (return `"unknown"` not errors)
- Add data validation in export script
- Document rebuild requirements in README
- Test mobile early in Sprint 2

---

## Review Notes

This plan was reviewed by a subagent that identified:
- 6 critical issues (all addressed in this revision)
- 9 improvements (most addressed)
- 6 nitpicks (documented for implementer awareness)

Key changes from review:
- Added Sprint 0 for infrastructure (was impossible ordering before)
- Removed API route task (doesn't work with static export)
- Fixed redirect to use Vercel config
- Added `"use client"` requirements to table components
- Added empty state handling requirements
- Specified threshold-based trend algorithm

---

Use subagents liberally! For all parts.
