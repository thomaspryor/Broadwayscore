# Sprint Plan: Automated Commercial Scorecard Updates

Reference: `PLAN-commercial-update-automation.md`

---

## Sprint 1: Data Model & Type System Foundation

**Goal:** Update the data model, TypeScript types, data access layer, and commercial.json to support all new fields (productionType, estimatedRecoupmentPct, isEstimate, Tour Stop designation). Site builds and passes all existing tests with zero regressions.

**Demo:** `npm run build` succeeds. `npm run test:data` passes. All existing show pages render. New fields are accessible via data access functions. Harry Potter shows as Miracle. Mamma Mia split into original (Miracle) + tour stop.

---

### Task 1.1: Add `Tour Stop` to `CommercialDesignation` type

**File:** `src/lib/data.ts` (line ~804)

**Change:** Add `| 'Tour Stop'` to the `CommercialDesignation` union type.

**Before:**
```typescript
export type CommercialDesignation =
  | 'Miracle' | 'Windfall' | 'Trickle' | 'Easy Winner'
  | 'Fizzle' | 'Flop' | 'Nonprofit' | 'TBD';
```

**After:**
```typescript
export type CommercialDesignation =
  | 'Miracle' | 'Windfall' | 'Trickle' | 'Easy Winner'
  | 'Fizzle' | 'Flop' | 'Nonprofit' | 'TBD' | 'Tour Stop';
```

**Validation:** `npm run build` succeeds (no type errors).

---

### Task 1.2: Add new fields to `ShowCommercial` interface

**File:** `src/lib/data.ts` (line ~812)

**Change:** Add these fields to the `ShowCommercial` interface:

```typescript
estimatedRecoupmentPct?: [number, number] | null;
estimatedRecoupmentSource?: string | null;
estimatedRecoupmentDate?: string | null;
weeklyRunningCostSource?: string | null;
isEstimate?: {
  capitalization?: boolean;
  weeklyRunningCost?: boolean;
  recouped?: boolean;
};
productionType?: 'original' | 'tour-stop' | 'return-engagement';
originalProductionId?: string;
```

**Validation:** `npm run build` succeeds (new optional fields don't break existing code).

---

### Task 1.3: Add `Tour Stop` to `_meta.designations` in `commercial.json`

**File:** `data/commercial.json`

**Change:** Add to the `_meta.designations` object:

```json
"Tour Stop": "National tour engagement on Broadway -- not rated as original production"
```

**Validation:** `npm run test:data` passes. `getDesignationDescription('Tour Stop')` returns the new description.

---

### Task 1.4: Split Mamma Mia into original production + tour stop

**File:** `data/commercial.json`

**Change:**
- Rename existing `"mamma-mia"` key to keep it as the tour stop entry
- Update its designation to `"Tour Stop"`, add `productionType: "tour-stop"`, add `originalProductionId: "mamma-mia-2001"`
- Set capitalization to `null` (we don't know the tour stop's Broadway engagement cost)
- Create new `"mamma-mia-2001"` entry with designation `"Miracle"`, the original $10M capitalization, recouped=true

**Tour stop entry (`mamma-mia`):**
```json
{
  "designation": "Tour Stop",
  "productionType": "tour-stop",
  "originalProductionId": "mamma-mia-2001",
  "capitalization": null,
  "capitalizationSource": null,
  "weeklyRunningCost": null,
  "recouped": null,
  "recoupedDate": null,
  "recoupedWeeks": null,
  "notes": "25th Anniversary Tour Broadway engagement (Aug 2025 - Feb 2026). See mamma-mia-2001 for original production."
}
```

**Original entry (`mamma-mia-2001`):**
```json
{
  "designation": "Miracle",
  "productionType": "original",
  "capitalization": 10000000,
  "capitalizationSource": "Playbill (original 2001 production)",
  "weeklyRunningCost": null,
  "recouped": true,
  "recoupedDate": null,
  "recoupedWeeks": null,
  "recoupedSource": "Playbill",
  "notes": "Original production ran 14 years / 5,773 performances. $7B+ grossed across all global productions. Tour recouped in just 13 weeks."
}
```

**Validation:** `npm run test:data` passes. `getShowCommercial('mamma-mia')?.designation === 'Tour Stop'`. `getShowCommercial('mamma-mia-2001')?.designation === 'Miracle'`.

---

### Task 1.5: Fix Outsiders capitalization

**File:** `data/commercial.json`

**Change:** Update `the-outsiders` capitalization from `19000000` to `22000000` per official announcement.

**Validation:** `getCapitalization('the-outsiders') === 22000000`.

---

### Task 1.6: Update `validate-data.js` to validate new commercial fields

**File:** `scripts/validate-data.js`

**Changes:**
- Validate `productionType` is one of `"original"`, `"tour-stop"`, `"return-engagement"` (if present)
- Validate `estimatedRecoupmentPct` is a 2-element array of numbers `[low, high]` where `0 <= low <= high <= 100` (if present)
- Validate `originalProductionId` references an existing key in `commercial.json` (if present)
- Validate `isEstimate` fields are booleans (if present)
- Validate `Tour Stop` designation requires `productionType: "tour-stop"` or `"return-engagement"`
- Validate that shows with `productionType: "tour-stop"` have designation `"Tour Stop"`

**Validation:** `npm run test:data` passes with new validation rules. Deliberately malformed data triggers errors.

---

### Task 1.7: Full build + test verification

**Commands:**
```bash
npm run test:data   # Data validation passes
npm run build       # Site builds without errors
```

**Validation:** Both commands exit 0. No TypeScript errors. No validation errors.

---

## Sprint 2: Designation System & UI Updates

**Goal:** Updated designation descriptions on the site (remove "Profit > Nx" language). Tour Stop badge renders with neutral styling. Estimated values show `~` prefix. All UI changes are visible on the live site.

**Demo:** Visit `/biz-buzz` -- Tour Stop appears in legend with correct description. Visit `/show/mamma-mia` -- shows "Tour Stop" badge. Visit a show with estimated weekly running cost -- shows `~$1.0M` instead of `$1.0M`.

---

### Task 2.1: Add Tour Stop to `getDesignationStyle()` in BizBuzzCard

**File:** `src/components/BizBuzzCard.tsx` (line ~32, in the switch statement)

**Change:** Add a new case for `'Tour Stop'`:

```typescript
case 'Tour Stop':
  return {
    bgClass: 'bg-slate-500/15',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-500/25',
    icon: '🚌',
    description: 'National tour engagement on Broadway',
  };
```

**Validation:** `npm run build` succeeds. No unhandled switch case warnings.

---

### Task 2.2: Update designation descriptions in BizBuzzCard

**File:** `src/components/BizBuzzCard.tsx`

**Change:** Update the `description` field in each case of `getDesignationStyle()`:

| Designation | Old | New |
|---|---|---|
| Miracle | `'Legendary hit - 3x+ return'` | `'Long-running mega-hit -- extraordinary returns'` |
| Windfall | `'Solid hit - profitable'` | `'Solid hit -- recouped and profitable'` |
| Trickle | `'Broke even'` | `'Broke even or modest profit'` |
| Fizzle | `'Lost some money'` | `'Closed without recouping (~30%+ recovered)'` |
| Flop | `'Lost most investment'` | `'Closed without recouping (~<30% recovered)'` |
| TBD | `'Too early to tell'` | `'Too early to determine'` |

**Validation:** `npm run build` succeeds.

---

### Task 2.3: Update `designationConfig` on biz-buzz page

**File:** `src/app/biz-buzz/page.tsx` (line ~61)

**Change:**
- Update descriptions to match plan (remove "Profit > Nx" language)
- Add `'Tour Stop'` entry:
  ```typescript
  'Tour Stop': { emoji: '🚌', color: 'text-slate-400', description: 'National tour -- Broadway engagement' },
  ```

**Validation:** `npm run build` succeeds.

---

### Task 2.4: Add Tour Stop to `designationOrder`

**File:** `src/app/biz-buzz/page.tsx` (line ~116)

**Change:** Add `'Tour Stop'` to the `designationOrder` array (after Nonprofit, before Fizzle):

```typescript
const designationOrder: CommercialDesignation[] = [
  'Miracle', 'Windfall', 'Trickle', 'Easy Winner', 'Nonprofit', 'Tour Stop', 'Fizzle', 'Flop', 'TBD'
];
```

**Validation:** `npm run build` succeeds. Tour Stop section appears on `/biz-buzz` between Nonprofit and Fizzle.

---

### Task 2.5: Update `_meta.designations` descriptions in commercial.json

**File:** `data/commercial.json`

**Change:** Update designation descriptions in the `_meta` section to match the plan:

```json
"Miracle": "Long-running mega-hit -- extraordinary returns",
"Windfall": "Solid hit -- recouped and profitable",
"Trickle": "Broke even or modest profit over time",
"Fizzle": "Closed without recouping (~30%+ recovered)",
"Flop": "Closed without recouping (~<30% recovered)"
```

**Validation:** `npm run test:data` passes.

---

### Task 2.6: Add `~` prefix helper and integrate into BizBuzzCard

**File:** `src/components/BizBuzzCard.tsx`

**Change:**
- Add a helper function:
  ```typescript
  function formatCurrencyWithEstimate(value: number | null, isEstimate: boolean): string {
    if (value === null) return '—';
    const formatted = formatCurrency(value);
    return isEstimate ? `~${formatted.replace('$', '')}` : formatted.replace('$', '');
  }
  ```
  Wait -- actually the `~` should come before the `$`. Per the plan: `~$1.0M`. Let me reconsider:
  ```typescript
  function formatWithEstimate(formatted: string, isEstimate: boolean): string {
    return isEstimate ? `~${formatted}` : formatted;
  }
  ```
- Update the Capitalization and Weekly Cost stat cards to use `isEstimate` flags from the commercial data:
  - `formatWithEstimate(formatCurrency(commercial.capitalization), commercial.isEstimate?.capitalization ?? false)`
  - `formatWithEstimate(formatCurrency(commercial.weeklyRunningCost), commercial.isEstimate?.weeklyRunningCost ?? false)`

**Validation:** `npm run build` succeeds. Shows without `isEstimate` render unchanged (no `~`). Shows with `isEstimate.weeklyRunningCost: true` render `~$1.0M`.

---

### Task 2.7: Add E2E test for Tour Stop designation

**File:** `tests/e2e/biz-buzz.spec.ts` (new file)

**Test:**
```typescript
test('Tour Stop designation appears in legend', async ({ page }) => {
  await page.goto('/biz-buzz');
  const tourStopSection = page.locator('text=Tour Stop');
  await expect(tourStopSection.first()).toBeVisible();
});

test('Tour Stop shows appear in the correct section', async ({ page }) => {
  await page.goto('/biz-buzz');
  // Mamma Mia should appear under Tour Stop
  const pageContent = await page.textContent('body');
  expect(pageContent).toContain('Mamma Mia');
});
```

**Validation:** `npx playwright test tests/e2e/biz-buzz.spec.ts` passes.

---

### Task 2.8: Build + deploy verification

**Commands:**
```bash
npm run test:data
npm run build
npm run test:e2e  # If local server available
```

**Validation:** All pass. Push to main triggers Vercel deploy. Visual check: `/biz-buzz` shows updated descriptions + Tour Stop section.

---

## Sprint 3: Recoupment Progress Bar & Estimated Recoupment Display

**Goal:** Show pages display estimated recoupment percentage with a visual progress bar for TBD shows. The `/biz-buzz` page shows recoupment estimates in the TBD section. Seed data for demo.

**Demo:** Visit `/show/death-becomes-her` -- see progress bar showing `~60-80% recouped` with source attribution. Visit `/biz-buzz` -- TBD section shows recoupment estimates for each show.

---

### Task 3.1: Create `RecoupmentProgressBar` component

**File:** `src/components/RecoupmentProgressBar.tsx` (new file)

**Component props:**
```typescript
interface RecoupmentProgressBarProps {
  estimatedPct: [number, number];  // [low, high]
  source?: string | null;
}
```

**Renders:**
- A horizontal bar with gradient fill from `low%` to `high%`
- Text label: `~${low}-${high}% recouped`
- If `source` is provided, small gray text below: `Source: ${source}`
- Green gradient for high percentages (>80%), yellow for mid (40-80%), red for low (<40%)

**Validation:** `npm run build` succeeds. Component renders with test data.

---

### Task 3.2: Integrate progress bar into BizBuzzCard

**File:** `src/components/BizBuzzCard.tsx`

**Change:** After the Stats Row section, add:

```typescript
{/* Recoupment Progress (for TBD shows with estimates) */}
{commercial.estimatedRecoupmentPct && (
  <RecoupmentProgressBar
    estimatedPct={commercial.estimatedRecoupmentPct}
    source={commercial.estimatedRecoupmentSource}
  />
)}
```

**Validation:** `npm run build` succeeds. Shows with `estimatedRecoupmentPct` display the bar. Shows without it are unchanged.

---

### Task 3.3: Add recoupment estimate column to biz-buzz TBD section

**File:** `src/app/biz-buzz/page.tsx`

**Change:** In the section that lists TBD shows, add an estimated recoupment column/display that shows the `estimatedRecoupmentPct` range when available. Format: `~60-80%` or `—` if unknown.

**Validation:** `npm run build` succeeds. TBD shows with estimates display the range.

---

### Task 3.4: Seed 3-5 shows with `estimatedRecoupmentPct` data

**File:** `data/commercial.json`

**Change:** Add `estimatedRecoupmentPct`, `estimatedRecoupmentSource`, `estimatedRecoupmentDate`, and `isEstimate` to these TBD shows based on the Jan 25 Reddit Grosses Analysis post:

| Show | estimatedRecoupmentPct | Source |
|------|----------------------|--------|
| death-becomes-her | [60, 80] | Reddit Grosses Analysis (u/Boring_Waltz_9545) |
| stranger-things | [30, 50] | Reddit Grosses Analysis (u/Boring_Waltz_9545) |
| the-outsiders | [80, 100] | Reddit Grosses Analysis (u/Boring_Waltz_9545) |
| maybe-happy-ending | [10, 30] | Reddit Grosses Analysis (u/Boring_Waltz_9545) |
| just-in-time | [80, 100] | Reddit Grosses Analysis (u/Boring_Waltz_9545) |

Also add `isEstimate: { weeklyRunningCost: true }` to shows where `weeklyRunningCost` comes from Reddit estimates.

**Validation:** `npm run test:data` passes (new validation from Task 1.6 validates the format). Progress bars render on these show pages.

---

### Task 3.5: E2E test for recoupment progress bar

**File:** `tests/e2e/biz-buzz.spec.ts` (append)

**Test:**
```typescript
test('recoupment progress bar displays for TBD shows with estimates', async ({ page }) => {
  await page.goto('/show/death-becomes-her');
  const progressBar = page.locator('[data-testid="recoupment-progress"]');
  await expect(progressBar).toBeVisible();
  const text = await progressBar.textContent();
  expect(text).toContain('recouped');
});
```

**Validation:** Test passes.

---

### Task 3.6: Build + deploy verification

**Commands:**
```bash
npm run test:data
npm run build
```

**Validation:** All pass. Visual check: progress bars render correctly.

---

## Sprint 4: Reddit Grosses Analysis Scraper

**Goal:** A standalone script that fetches the latest weekly Grosses Analysis post from r/Broadway, parses per-show financial data, and outputs structured JSON. Can be run with `--dry-run` to preview output without modifying files.

**Demo:** Run `node scripts/update-commercial-data.js --gather-reddit --dry-run` and see structured JSON output for every currently running show with: gross, capacity, ATP, estimated operating cost, estimated recoupment %, estimated profit/loss.

---

### Task 4.1: Create script skeleton with CLI arg parsing

**File:** `scripts/update-commercial-data.js` (new file)

**Structure:**
```javascript
const fs = require('fs');
const path = require('path');
const https = require('https');

// CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const GATHER_REDDIT = args.includes('--gather-reddit');
const GATHER_TRADE = args.includes('--gather-trade');
const GATHER_ALL = args.includes('--gather-all') || (!GATHER_REDDIT && !GATHER_TRADE);

// API keys
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Data files
const COMMERCIAL_PATH = path.join(__dirname, '..', 'data', 'commercial.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const GROSSES_PATH = path.join(__dirname, '..', 'data', 'grosses.json');
const CHANGELOG_PATH = path.join(__dirname, '..', 'data', 'commercial-changelog.json');

async function main() { /* orchestrator */ }
main().catch(err => { console.error(err); process.exit(1); });
```

**Validation:** `node scripts/update-commercial-data.js --dry-run` runs without error (exits cleanly with "no data sources gathered" message).

---

### Task 4.2: Implement `fetchGrossesAnalysisPost()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Uses ScrapingBee (premium proxy) to fetch Reddit JSON API
- URL: `https://www.reddit.com/r/Broadway/search.json?q=author:Boring_Waltz_9545+flair:Grosses+Analysis&sort=new&restrict_sr=1&limit=1`
- Extracts: post body (selftext), title, created_utc, permalink, url
- Parses week-ending date from title (e.g., "Grosses Analysis - Week Ending 1/25/2026")
- Falls back to `https://www.reddit.com/user/Boring_Waltz_9545/submitted.json` if search returns empty

**Validation:** Run with `--gather-reddit --dry-run`. Console logs the post title and week-ending date. Post body is non-empty.

---

### Task 4.3: Implement `parseGrossesAnalysisPost()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes raw post selftext as input
- Parses per-show blocks using the consistent format:
  ```
  **Show Name** - $X.XM gross, XX% capacity, $XXX atp
  Gross Less-Fees: $X.XXXM; Estimated Weekly Operating Cost: $XXXk/week
  Estimated Profit (Loss): $XXXk+
  Estimated percentage recouped: XX%-XX%
  ```
- Returns array of objects:
  ```javascript
  {
    showName: string,
    weeklyGross: number | null,
    capacity: number | null,
    atp: number | null,
    grossLessFees: number | null,
    estimatedWeeklyCost: number | null,
    estimatedProfitLoss: number | null,
    estimatedRecoupmentPct: [number, number] | null,
    commentary: string
  }
  ```
- Handles variations: "N/A", missing fields, different formatting

**Validation:** Unit test with sample post text → expected parsed output. At least 20 shows parsed from a real post.

---

### Task 4.4: Implement `fetchPostComments()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes Reddit permalink (e.g., `/r/Broadway/comments/abc123/...`)
- Fetches `https://www.reddit.com${permalink}.json` via ScrapingBee
- Extracts top-level comments: author, body, score, created_utc
- Returns top 20 comments sorted by score

**Validation:** Run with `--gather-reddit --dry-run`. Console logs the number of comments fetched and top 3 comment previews.

---

### Task 4.5: Add unit tests for `parseGrossesAnalysisPost()`

**File:** `tests/unit/parse-grosses-analysis.test.js` (new file)

**Tests:**
1. Parses a standard show block with all fields present → all values correct
2. Parses a show block with "N/A" recoupment → `estimatedRecoupmentPct: null`
3. Parses a show block with "$XXXk" cost → correct number conversion
4. Parses a show block with "$X.XM" cost → correct number conversion
5. Parses multiple shows from a combined post → correct array length
6. Handles a show with negative profit/loss → negative number
7. Handles "100%+" capacity → 100 (or actual number)
8. Empty input → empty array

**Validation:** `node --test tests/unit/parse-grosses-analysis.test.js` (Node.js built-in test runner) passes all 8 tests.

---

### Task 4.6: Implement show name → slug matching

**File:** `scripts/update-commercial-data.js`

**Function: `matchShowToSlug(showName, commercialData, showsData)`**
- Takes a show name from the Reddit post (e.g., "Harry Potter and the Cursed Child")
- Matches to a slug in commercial.json or shows.json
- Uses normalization: lowercase, strip "the", "a", "an", articles, punctuation
- Falls back to fuzzy matching (Levenshtein distance)
- Returns `{ slug, confidence: 'high' | 'medium' | 'low' }` or null

**Validation:** Test cases:
- `"Hamilton"` → `{ slug: "hamilton", confidence: "high" }`
- `"Harry Potter and the Cursed Child"` → `{ slug: "harry-potter", confidence: "high" }`
- `"Death Becomes Her"` → `{ slug: "death-becomes-her", confidence: "high" }`
- `"Unknown Show Title"` → `null`

---

### Task 4.7: Integration test: full Reddit gather pipeline

**Commands:**
```bash
SCRAPINGBEE_API_KEY=xxx node scripts/update-commercial-data.js --gather-reddit --dry-run
```

**Validation:** Script outputs structured JSON for 20+ shows. Each show has at least `showName` and `weeklyGross`. No crashes. Exit code 0.

---

## Sprint 5: Broader Data Gathering (Reddit Search + Trade Press)

**Goal:** Script searches r/Broadway for standalone financial discussions and trade press for Broadway financial news. Combined with Grosses Analysis data into a structured context document ready for AI analysis.

**Demo:** Run `node scripts/update-commercial-data.js --gather-all --dry-run` and see: Grosses Analysis data + N additional Reddit threads + M trade press articles, all combined into a context document.

---

### Task 5.1: Implement `searchRedditFinancial()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Searches r/Broadway via Reddit JSON API (through ScrapingBee) for financial discussions from the past 7 days
- Search queries (executed in parallel):
  - `recouped OR recoupment`
  - `capitalization OR investment OR "SEC filing"`
  - `closing OR "final performance"`
  - `"running costs" OR "weekly nut" OR "break even"`
- Deduplicates results by post ID
- Fetches post body + top 5 comments for each match
- Returns array of `{ title, selftext, comments[], score, url, created_utc }`

**Validation:** Run with `--gather-all --dry-run`. Logs N Reddit threads found. Output includes post titles and comment counts.

---

### Task 5.2: Implement `searchTradePress()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Performs Google searches scoped to trade press sites (past 7 days):
  - `site:deadline.com OR site:variety.com Broadway recoup OR capitalization OR closing`
  - `site:broadwayjournal.com OR site:playbill.com Broadway financial`
  - `site:broadwaynews.com OR site:broadwayworld.com Broadway recoup OR investment`
  - `site:nytimes.com OR site:forbes.com Broadway show investment OR recoup`
- Uses ScrapingBee Google search endpoint OR mcp__scrapingbee__get_google_search_results pattern adapted for Node.js
- Returns array of `{ title, url, snippet, source }` for each result

**Validation:** Run with `--gather-all --dry-run`. Logs M trade press articles found. Each has title + URL + snippet.

---

### Task 5.3: Implement `scrapeArticle()` with fallback chain

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes a URL and attempts to retrieve article text
- Fallback chain:
  1. **Archive.org Wayback Machine**: `https://web.archive.org/web/2024*/${url}` → fetch archived version
  2. **ScrapingBee**: `https://app.scrapingbee.com/api/v1/?url=${url}&render_js=true`
  3. **At minimum**: Use the title + snippet from search results (always available)
- Returns `{ fullText: string | null, source: 'archive.org' | 'scrapingbee' | 'snippet-only' }`
- Rate-limited: max 2 requests/second to any single domain

**Validation:** Test with a known Deadline article URL. Returns article text from at least one source.

---

### Task 5.4: Implement `buildAnalysisContext()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes all gathered data and assembles a structured context for Claude:
  - **Section A:** Current `commercial.json` state per show (designation, cap, recouped, weeklyRunningCost, notes)
  - **Section B:** Box office math from `grosses.json` (all-time gross vs cap for each show)
  - **Section C:** Grosses Analysis post data (per-show parsed data from Task 4.3)
  - **Section D:** Grosses Analysis comments (from Task 4.4)
  - **Section E:** Other Reddit threads (from Task 5.1)
  - **Section F:** Trade press articles (from Task 5.2 + 5.3)
  - **Section G:** Shows in `shows.json` that have no `commercial.json` entry (potential new entries)
- Returns a single string, formatted for Claude's structured prompt
- Includes character count in output (for cost estimation)

**Validation:** Run with `--gather-all --dry-run`. Outputs the context document to stdout. All 7 sections present. Character count logged.

---

### Task 5.5: Add `--gather-only` flag

**File:** `scripts/update-commercial-data.js`

**Change:** When `--gather-only` is passed, the script gathers all data, builds the context document, writes it to `data/debug/commercial-analysis-context.txt`, and exits without running AI analysis.

**Validation:** Run with `--gather-all --gather-only`. File written. Contents match expected structure.

---

### Task 5.6: Rate limiting and error handling

**File:** `scripts/update-commercial-data.js`

**Change:**
- Add rate limiter: max 2 concurrent requests, 500ms between requests to same domain
- Add timeout: 30s per request, 5 minute total for all gathering
- Add error isolation: if one search fails, others continue
- Log all errors but don't crash

**Validation:** Simulate a timeout (invalid URL). Script logs the error and continues. Exit code 0.

---

## Sprint 6: AI Analysis Engine & Change Application

**Goal:** Claude Sonnet analyzes the gathered context and proposes changes to commercial.json. Changes are filtered by confidence and applied. Shadow classifier runs in background. Changelog updated.

**Demo:** Run `node scripts/update-commercial-data.js --gather-all --dry-run` and see: proposed changes table (show, field, old→new, confidence, source), shadow classifier disagreements, new show suggestions. With `--apply`, changes written to commercial.json and changelog appended.

---

### Task 6.1: Implement `analyzeWithClaude()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes the context document from `buildAnalysisContext()`
- Calls Claude Sonnet API (`claude-sonnet-4-20250514`) with a structured system prompt
- System prompt instructs Claude to:
  - Compare current commercial.json data against all gathered sources
  - Propose changes as structured JSON
  - Assign confidence: `"high"` (official announcement, SEC filing), `"medium"` (consistent Reddit estimates), `"low"` (single comment, speculation)
  - Include reasoning for each proposed change
  - Suggest new show entries for shows in shows.json without commercial.json entries
  - Flag designation upgrade possibilities (never auto-apply)
- Returns parsed JSON array of proposed changes:
  ```javascript
  {
    slug: string,
    field: string,
    oldValue: any,
    newValue: any,
    isEstimate: boolean,
    confidence: 'high' | 'medium' | 'low',
    source: string,
    reasoning: string
  }
  ```

**Validation:** Run with `--dry-run`. Claude returns valid JSON. At least 1 proposed change. All required fields present.

---

### Task 6.2: Implement `filterAndApplyChanges()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes array of proposed changes
- Filters by confidence:
  - `"high"` → auto-apply
  - `"medium"` → auto-apply
  - `"low"` → do NOT apply, include in notification only
- Additional filters:
  - Designation changes from Windfall→Miracle, Windfall→Tour Stop etc. → **never auto-apply**, flag only
  - Designation changes from TBD→Windfall (on recoupment announcement) → auto-apply
  - Designation changes from TBD→Fizzle/Flop (on closing) → auto-apply if confidence high/medium
  - Never change Miracle, Nonprofit, Tour Stop designations
- For applied changes: updates the in-memory commercial.json object
- Returns `{ applied: Change[], flagged: Change[], skipped: Change[] }`

**Validation:** Unit test with mock changes:
- High confidence weeklyRunningCost update → applied
- Low confidence capitalization update → skipped
- Medium confidence Windfall→Miracle upgrade → flagged (not applied)
- High confidence TBD→Windfall on recoupment → applied
- Attempt to change Miracle → skipped

---

### Task 6.3: Implement `shadowClassifier()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- For each show in commercial.json, computes a heuristic designation based on:
  - Gross/cap ratio (from grosses.json)
  - Recoupment status
  - Running time (performances)
  - estimatedRecoupmentPct
- Heuristic rules (experimental, not live):
  - gross/cap > 20x AND recouped → Shadow: Miracle
  - gross/cap > 5x AND recouped → Shadow: Windfall
  - gross/cap > 2x AND recouped → Shadow: Trickle
  - closed AND estimatedRecoupmentPct < 30% → Shadow: Flop
  - closed AND estimatedRecoupmentPct >= 30% → Shadow: Fizzle
- Compares shadow designation vs live designation
- Returns array of disagreements: `{ slug, liveDesignation, shadowDesignation, metrics }`

**Validation:** Run shadow classifier on current data. Hamilton: shadow=Miracle, live=Miracle (agree). Hadestown: shadow=Miracle, live=Windfall (disagree, logged).

---

### Task 6.4: Implement `writeChangelog()`

**File:** `scripts/update-commercial-data.js`

**Creates/updates:** `data/commercial-changelog.json`

**Schema:**
```json
{
  "_meta": { "description": "Automated commercial data update log" },
  "entries": [
    {
      "date": "2026-01-29",
      "weekEnding": "1/25/2026",
      "sourcesConsulted": ["Reddit Grosses Analysis", "r/Broadway search (3 threads)", "Deadline (1 article)"],
      "changesApplied": [{ "slug": "...", "field": "...", "oldValue": "...", "newValue": "...", "confidence": "high" }],
      "changesFlagged": [],
      "shadowDisagreements": [{ "slug": "hadestown", "live": "Windfall", "shadow": "Miracle" }]
    }
  ]
}
```

**Validation:** Run full pipeline. `commercial-changelog.json` exists and contains a valid entry with all required fields.

---

### Task 6.5: Implement `writeCommercialJson()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Writes the updated commercial data object to `data/commercial.json`
- Pretty-prints with 2-space indentation
- Updates `_meta.lastUpdated` to today's date
- Only writes if `DRY_RUN` is false

**Validation:** Run without `--dry-run` (on test data). File written. `JSON.parse()` succeeds. `lastUpdated` is today.

---

### Task 6.6: Unit tests for confidence filtering

**File:** `tests/unit/commercial-changes.test.js` (new file)

**Tests:**
1. High confidence change → applied
2. Medium confidence change → applied
3. Low confidence change → skipped (not applied, flagged)
4. Designation upgrade (Windfall→Miracle) → flagged regardless of confidence
5. Designation downgrade (TBD→Fizzle, high confidence, show closed) → applied
6. Change to Miracle show → skipped (never change Miracle)
7. Change to Nonprofit show → skipped (never change Nonprofit)
8. Change to Tour Stop show designation → skipped
9. New estimatedRecoupmentPct update → applied if medium+ confidence
10. Multiple changes to same show → all processed independently

**Validation:** All 10 tests pass.

---

### Task 6.7: Full pipeline integration test (dry run)

**Commands:**
```bash
SCRAPINGBEE_API_KEY=xxx ANTHROPIC_API_KEY=xxx node scripts/update-commercial-data.js --gather-all --dry-run
```

**Validation:** Script completes without error. Output includes:
- Sources gathered (count of Reddit posts, trade articles)
- Proposed changes table
- Shadow classifier disagreements
- New show suggestions (if any)
- No files modified (dry run)

---

## Sprint 7: GitHub Actions, Notifications & Tip Submission

**Goal:** Fully automated weekly workflow that runs the commercial update script, creates a GitHub issue with change summary, and commits changes. Insider tip submission system via GitHub issue template with automated processing.

**Demo:** Trigger `update-commercial.yml` manually via GitHub Actions UI. Workflow runs, updates data, creates GitHub issue with change summary, commits and pushes. Submit a commercial tip via GitHub issue template → automated processing creates a comment.

---

### Task 7.1: Create `update-commercial.yml` workflow

**File:** `.github/workflows/update-commercial.yml` (new file)

**Structure:**
```yaml
name: Update Commercial Data
on:
  schedule:
    - cron: '0 16 * * 3'  # Wednesday 4pm UTC / 11am ET
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run (no changes committed)'
        required: false
        type: boolean
        default: false
      gather_only:
        description: 'Gather data only (no AI analysis)'
        required: false
        type: boolean
        default: false

jobs:
  update-commercial:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - Checkout
      - Setup Node.js 20
      - npm ci
      - Configure git
      - Run update-commercial-data.js (with SCRAPINGBEE_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN)
      - Validate data (npm run test:data)
      - Build site (npm run build)
      - Commit and push (with retry logic)
```

**Validation:** Workflow file is valid YAML. `gh workflow view update-commercial.yml` shows no errors.

---

### Task 7.2: Implement `createGitHubIssue()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Uses GitHub REST API (via `GITHUB_TOKEN`) to create an issue
- Title: `Commercial Update: Week ending {date}` (or `Commercial Update: No changes - Week ending {date}`)
- Body includes:
  - **Changes Applied** table: show, field, old→new, confidence, source
  - **Suggestions Not Applied** table: low-confidence changes, designation upgrades
  - **Shadow Classifier Disagreements** table: show, live designation, shadow designation
  - **Sources Consulted**: links to Reddit posts, trade articles
  - **Shows Unchanged**: count of shows not modified
- Labels: `commercial-update`, `automated`
- Only creates issue if there are changes or suggestions to report

**Validation:** Run full pipeline (not dry run) on GitHub Actions. Issue created with correct title, labels, and tables.

---

### Task 7.3: Create `commercial-tip.yml` issue template

**File:** `.github/ISSUE_TEMPLATE/commercial-tip.yml` (new file)

**Structure:**
```yaml
name: Commercial Tip
description: Share insider info about a Broadway show's commercial performance
title: "[Commercial Tip] "
labels: ["commercial-tip", "needs-processing"]
body:
  - type: input
    id: show_name
    attributes:
      label: Show Name
      placeholder: Hamilton, Wicked, etc.
    validations:
      required: true
  - type: dropdown
    id: tip_type
    attributes:
      label: Type of Information
      options:
        - Recoupment announcement
        - Capitalization / investment amount
        - Weekly running cost
        - Closing announcement
        - Other financial info
    validations:
      required: true
  - type: textarea
    id: details
    attributes:
      label: Details
      placeholder: "E.g., 'Show X announced recoupment on Jan 15 per Deadline article'"
    validations:
      required: true
  - type: input
    id: source
    attributes:
      label: Source
      placeholder: "URL, publication name, or 'personal knowledge'"
    validations:
      required: false
```

**Validation:** Template appears in GitHub "New Issue" dropdown. All fields render correctly.

---

### Task 7.4: Create `process-commercial-tip.yml` workflow

**File:** `.github/workflows/process-commercial-tip.yml` (new file)

**Structure:**
```yaml
name: Process Commercial Tip
on:
  issues:
    types: [opened, edited]

jobs:
  process-tip:
    if: contains(github.event.issue.labels.*.name, 'commercial-tip')
    runs-on: ubuntu-latest
    steps:
      - Checkout
      - Setup Node.js
      - npm ci
      - Parse issue body for show name, tip type, details, source
      - Call Claude Sonnet to validate tip and propose changes
      - If valid: apply change to commercial.json, commit, push
      - Post comment on issue with result
      - Close issue if processed successfully
```

**Validation:** Create a test issue with `commercial-tip` label. Workflow triggers. Comment posted on issue.

---

### Task 7.5: Add commit + push logic to main workflow

**File:** `.github/workflows/update-commercial.yml`

**Change:** Add commit step (follows existing pattern from `update-reddit-sentiment.yml`):
- `git add data/commercial.json data/commercial-changelog.json`
- Commit message: `data: Update commercial data for week ending {date}`
- Retry push with rebase (5 attempts)
- `if: always()` to commit even on partial failure

**Validation:** Workflow pushes successfully. Commit appears in git log.

---

### Task 7.6: Add `commercial-changelog.json` to git tracking

**File:** `data/commercial-changelog.json` (new file, initial state)

```json
{
  "_meta": {
    "description": "Automated commercial data update log",
    "lastUpdated": null
  },
  "entries": []
}
```

**File:** `.github/workflows/update-commercial.yml`

**Change:** Ensure `data/commercial-changelog.json` is included in `git add`.

**Validation:** File exists in repo. `git log -- data/commercial-changelog.json` shows initial commit.

---

### Task 7.7: End-to-end workflow test

**Process:**
1. Push all Sprint 7 changes to `main`
2. Trigger `update-commercial.yml` manually via `gh workflow run "Update Commercial Data"`
3. Wait for workflow to complete
4. Verify:
   - Workflow exit code 0
   - `data/commercial.json` has updated `lastUpdated`
   - `data/commercial-changelog.json` has new entry
   - GitHub issue created with `commercial-update` label
   - Site builds successfully on Vercel

**Validation:** All 5 verification points pass.

---

### Task 7.8: Documentation update

**File:** `CLAUDE.md`

**Change:** Add section for the new commercial update automation:
- Workflow name, schedule, secrets
- How to trigger manually
- How to submit a commercial tip
- Link to plan document

**Validation:** Section present in CLAUDE.md. No broken links.

---

## Summary

| Sprint | Tasks | Goal |
|--------|-------|------|
| 1 | 7 | Data model + types + data fixes (foundation) |
| 2 | 8 | Designation UI + Tour Stop + ~ prefix |
| 3 | 6 | Recoupment progress bar + seeded data |
| 4 | 7 | Reddit Grosses Analysis scraper |
| 5 | 6 | Reddit search + trade press + context builder |
| 6 | 7 | AI analysis + change engine + shadow classifier |
| 7 | 8 | GitHub Actions + notifications + tips |
| **Total** | **49** | **Fully automated weekly commercial updates** |

Each sprint builds on the previous one. Sprints 1-3 are UI/data work (no external API calls). Sprints 4-5 are data gathering. Sprint 6 is the AI brain. Sprint 7 ties it all together with automation.

Use subagents liberally!
