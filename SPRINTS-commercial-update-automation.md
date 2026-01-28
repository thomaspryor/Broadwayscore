# Sprint Plan: Automated Commercial Scorecard Updates

Reference: `PLAN-commercial-update-automation.md`

**Execution guidance:** Each task is an atomic, committable unit of work. Each sprint produces a demoable result. An autonomous agent should be able to execute any task given only its description and validation criteria. When implementing, use subagents liberally for parallel work streams.

---

## Sprint 1: Data Model, Types, UI Config & Data Fixes

**Goal:** Update the TypeScript types, data access layer, all UI designation configs, and commercial.json to support new fields (productionType, estimatedRecoupmentPct, isEstimate, Tour Stop designation). Fix known data issues. Site builds and passes all existing tests with zero regressions.

**Why UI config is here too:** The `designationConfig` in `biz-buzz/page.tsx` is typed as `Record<CommercialDesignation, ...>`. Adding `'Tour Stop'` to the union type without adding it to that Record will break the build. So all designation config locations must be updated atomically with the type change.

**Demo:** `npm run build` succeeds. `npm run test:data` passes. Harry Potter already shows as Miracle (verify only -- change was made prior to this sprint plan). Mamma Mia split into original Miracle entry + Tour Stop entry. Outsiders updated with recoupment data. `/biz-buzz` page renders with Tour Stop in the legend.

**Note:** Harry Potter was already upgraded to Miracle in `data/commercial.json` before this sprint plan was created. No action needed -- just verify during final build.

---

### Task 1.1: Add `Tour Stop` to `CommercialDesignation` type and `ShowCommercial` interface

**File:** `src/lib/data.ts`

**Changes:**

1. Add `| 'Tour Stop'` to the `CommercialDesignation` union type (line ~804):
```typescript
export type CommercialDesignation =
  | 'Miracle' | 'Windfall' | 'Trickle' | 'Easy Winner'
  | 'Fizzle' | 'Flop' | 'Nonprofit' | 'TBD' | 'Tour Stop';
```

2. Add new optional fields to the `ShowCommercial` interface (line ~812):
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

**Validation:** `npx tsc --noEmit` succeeds (type-checks without build). No type errors reported.

---

### Task 1.2: Add Tour Stop to all three UI designation config locations

This task prevents a build break. There are three places that define designation metadata, and all must include `Tour Stop` before the build can succeed after Task 1.1.

**File 1:** `src/components/BizBuzzCard.tsx` -- `getDesignationStyle()` switch statement

Add a new case before the `default`:
```typescript
case 'Tour Stop':
  return {
    bgClass: 'bg-slate-500/15',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-500/25',
    icon: '\uD83D\uDE8C',
    description: 'National tour engagement on Broadway',
  };
```

**File 2:** `src/app/biz-buzz/page.tsx` -- `designationConfig` object (line ~61)

Add entry:
```typescript
'Tour Stop': { emoji: '\uD83D\uDE8C', color: 'text-slate-400', description: 'National tour -- Broadway engagement' },
```

**File 3:** `src/app/biz-buzz/page.tsx` -- `designationOrder` array (line ~116)

Add `'Tour Stop'` between `'Nonprofit'` and `'Fizzle'`:
```typescript
const designationOrder: CommercialDesignation[] = [
  'Miracle', 'Windfall', 'Trickle', 'Easy Winner', 'Nonprofit', 'Tour Stop', 'Fizzle', 'Flop', 'TBD'
];
```

**Validation:** `npm run build` succeeds. No TypeScript errors. The `/biz-buzz` page renders with a Tour Stop section in the legend between Nonprofit and Fizzle.

---

### Task 1.3: Update `_meta.designations` in `commercial.json`

**File:** `data/commercial.json`

**Changes to `_meta.designations`:**
```json
"Miracle": "Long-running mega-hit -- extraordinary returns",
"Windfall": "Solid hit -- recouped and profitable",
"Trickle": "Broke even or modest profit over time",
"Easy Winner": "Limited run that made money, limited downside, limited upside",
"Fizzle": "Closed without recouping (~30%+ recovered)",
"Flop": "Closed without recouping (~<30% recovered)",
"Nonprofit": "Produced by nonprofit theater (LCT, MTC, Second Stage, etc.)",
"TBD": "Too early to tell (still running or recently opened)",
"Tour Stop": "National tour engagement on Broadway -- not rated as original production"
```

Note: Easy Winner description is unchanged (it is not being deprecated).

**Validation:** `npm run test:data` passes. `JSON.parse(fs.readFileSync('data/commercial.json'))._meta.designations['Tour Stop']` returns the expected string.

---

### Task 1.4: Create `mamma-mia-2001` entry in commercial.json

**File:** `data/commercial.json`

**Change:** Add a new key `"mamma-mia-2001"` to `shows`:
```json
"mamma-mia-2001": {
  "designation": "Miracle",
  "productionType": "original",
  "capitalization": 10000000,
  "capitalizationSource": "Playbill (original 2001 production)",
  "weeklyRunningCost": null,
  "recouped": true,
  "recoupedDate": null,
  "recoupedWeeks": null,
  "recoupedSource": "Playbill",
  "notes": "Original production ran 14 years / 5,773 performances. $7B+ grossed across all global productions."
}
```

**Important:** This entry does NOT have a corresponding `shows.json` entry. The `/biz-buzz` page iterates `commercial.json` keys and looks them up in `shows.json` -- if not found, the show should still appear in the Miracle section with its commercial data. See Task 1.8 for the code that handles this.

**Validation:** `npm run test:data` passes. `mamma-mia-2001` appears in `commercial.json` with designation `Miracle`.

---

### Task 1.5: Update `mamma-mia` entry to Tour Stop

**File:** `data/commercial.json`

**Change:** Replace the existing `"mamma-mia"` entry with:
```json
"mamma-mia": {
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

**Validation:** `npm run test:data` passes. `getShowCommercial('mamma-mia')?.designation === 'Tour Stop'`. `getShowCommercial('mamma-mia')?.productionType === 'tour-stop'`.

---

### Task 1.6: Update Outsiders: capitalization, recoupment, and designation

**File:** `data/commercial.json`

**Changes to `"the-outsiders"` entry:**
- `capitalization`: `19000000` -> `22000000`
- `capitalizationSource`: update to `"Press announcement / SEC filing"`
- `recouped`: `false` -> `true`
- `recoupedDate`: set to `"2025-12"` (approximate, based on Reddit Grosses Analysis confirmation)
- `recoupedSource`: `"Reddit Grosses Analysis / Broadway Journal"`
- `designation`: `"TBD"` -> `"Windfall"` (per plan rules: TBD -> Windfall on recoupment)
- `notes`: update to reflect recoupment

**Validation:** `npm run test:data` passes. `getShowCommercial('the-outsiders')?.recouped === true`. `getShowCommercial('the-outsiders')?.designation === 'Windfall'`. `getCapitalization('the-outsiders') === 22000000`.

---

### Task 1.7: Handle orphaned commercial.json entries on /biz-buzz page

**File:** `src/app/biz-buzz/page.tsx`

**Problem:** The `/biz-buzz` page currently loads shows from `shows.json` and looks up their commercial data. But `mamma-mia-2001` exists in `commercial.json` without a matching `shows.json` entry. It would be invisible.

**Change:** Update the data loading logic to also iterate `commercial.json` keys and include any that don't have a `shows.json` match. Display these with their commercial data and use the key as a fallback title (formatted: `mamma-mia-2001` -> `Mamma Mia (2001)`).

Specifically:
- After loading shows from `shows.json` and mapping to commercial data, scan `commercial.json` for keys not found in the shows list
- For each orphaned key, create a minimal display entry with the commercial data
- These entries appear in their designation group (Miracle, etc.) alongside shows with full metadata

**Validation:** `npm run build` succeeds. On `/biz-buzz`, the Miracle section includes `Mamma Mia (2001)` alongside Hamilton, Wicked, etc.

---

### Task 1.8: Update `validate-data.js` with new commercial field validation

**File:** `scripts/validate-data.js`

**Add these validations to the commercial.json section:**

1. `productionType` must be one of `"original"`, `"tour-stop"`, `"return-engagement"` (if present)
2. `estimatedRecoupmentPct` must be a 2-element array `[low, high]` where `0 <= low <= high <= 100` (if present)
3. `originalProductionId` must reference an existing key in `commercial.json` (if present)
4. `isEstimate` values must be booleans (if present)
5. Shows with `designation: "Tour Stop"` must have `productionType` set to `"tour-stop"` or `"return-engagement"`
6. Shows with `productionType: "tour-stop"` must have `designation: "Tour Stop"`
7. `estimatedRecoupmentDate` must be a valid date string YYYY-MM-DD (if present)

**Validation:** `npm run test:data` passes with all new rules. Deliberately break one rule (e.g., set `estimatedRecoupmentPct: [80, 50]`) and verify it fails with a clear error message, then revert.

---

### Task 1.9: Full build + test verification

**Commands:**
```bash
npm run test:data   # Data validation passes (including new rules)
npm run build       # Site builds without errors
```

**Validation:** Both commands exit 0. No TypeScript errors. No validation warnings. `/biz-buzz` renders Tour Stop in the legend. HP is Miracle. Mamma Mia is Tour Stop. Mamma Mia (2001) appears in Miracle. Outsiders is Windfall.

---

## Sprint 2: Designation Descriptions, ~ Prefix & Estimate Display

**Goal:** Updated designation descriptions visible on the site (remove "Profit > Nx" language). Estimated values render with `~` prefix. Source attribution displayed for estimates.

**Demo:** Visit `/biz-buzz` -- descriptions say "Long-running mega-hit" instead of "Profit > 3x investment". Visit a show page with estimated weekly running cost -- shows `~$1.0M` with "Source: Reddit Grosses Analysis" underneath.

---

### Task 2.1: Update designation descriptions in BizBuzzCard

**File:** `src/components/BizBuzzCard.tsx` -- `getDesignationStyle()` switch statement

**Changes to `description` field only (styling unchanged):**

| Case | Old `description` | New `description` |
|---|---|---|
| `'Miracle'` | `'Legendary hit - 3x+ return'` | `'Long-running mega-hit -- extraordinary returns'` |
| `'Windfall'` | `'Solid hit - profitable'` | `'Solid hit -- recouped and profitable'` |
| `'Trickle'` | `'Broke even'` | `'Broke even or modest profit'` |
| `'Fizzle'` | `'Lost some money'` | `'Closed without recouping (~30%+ recovered)'` |
| `'Flop'` | `'Lost most investment'` | `'Closed without recouping (~<30% recovered)'` |
| `'TBD'` | `'Too early to tell'` | `'Too early to determine'` |

Do NOT change Easy Winner (`'Limited run that made money, limited downside, limited upside'`) or Nonprofit descriptions.

**Validation:** `npm run build` succeeds. Grep for old strings ("Legendary hit", "Solid hit - profitable", "Lost some money", "Lost most investment") in `BizBuzzCard.tsx` returns zero matches.

---

### Task 2.2: Update designation descriptions in biz-buzz page

**File:** `src/app/biz-buzz/page.tsx` -- `designationConfig` object (line ~61)

**Changes to `description` field:**

| Key | Old `description` | New `description` |
|---|---|---|
| `'Miracle'` | `'Profit > 3x investment (mega-hits)'` | `'Long-running mega-hit -- extraordinary returns'` |
| `'Windfall'` | `'Profit > 1.5x investment (solid hits)'` | `'Solid hit -- recouped and profitable'` |
| `'Trickle'` | `'Broke even or modest profit'` | `'Broke even or modest profit'` (unchanged) |
| `'Fizzle'` | `'Lost money but not all'` | `'Closed without recouping (~30%+ recovered)'` |
| `'Flop'` | `'Lost most/all investment'` | `'Closed without recouping (~<30% recovered)'` |

Do NOT change Easy Winner, Nonprofit, or TBD descriptions.

**Validation:** `npm run build` succeeds. Grep for "Profit > 3x" and "Profit > 1.5x" in `biz-buzz/page.tsx` returns zero matches.

---

### Task 2.3: Add `~` prefix helper and integrate into BizBuzzCard

**File:** `src/components/BizBuzzCard.tsx`

**Changes:**

1. Add helper function after the existing `formatCurrency()`:
```typescript
function formatWithEstimate(formatted: string, isEstimate: boolean): string {
  return isEstimate ? `~${formatted}` : formatted;
}
```

2. Update the Capitalization stat card to use the estimate flag:
```typescript
<div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
  {formatWithEstimate(formatCurrency(commercial.capitalization), commercial.isEstimate?.capitalization ?? false)}
</div>
```

3. Update the Weekly Cost stat card similarly:
```typescript
{formatWithEstimate(formatCurrency(commercial.weeklyRunningCost), commercial.isEstimate?.weeklyRunningCost ?? false)}
```

**Defensive behavior:** If `commercial.isEstimate` is undefined (most existing entries), `?? false` ensures no `~` prefix. Only shows that explicitly set `isEstimate.weeklyRunningCost: true` will show the tilde.

**Validation:** `npm run build` succeeds. Shows without `isEstimate` render identically to before (no visual regression). Manually add `"isEstimate": { "weeklyRunningCost": true }` to one show in `commercial.json`, rebuild, and verify `~` appears on that show's Weekly Cost. Then revert the test change.

---

### Task 2.4: Add source attribution display to BizBuzzCard expandable section

**File:** `src/components/BizBuzzCard.tsx`

**Change:** In the expandable details section (inside the `isExpanded` conditional), add display for `weeklyRunningCostSource` and `estimatedRecoupmentSource`:

```typescript
{commercial.weeklyRunningCostSource && (
  <p className="text-xs text-gray-600 mt-1">
    Weekly cost source: {commercial.weeklyRunningCostSource}
  </p>
)}
{commercial.estimatedRecoupmentSource && (
  <p className="text-xs text-gray-600 mt-1">
    Recoupment estimate source: {commercial.estimatedRecoupmentSource}
  </p>
)}
```

**Validation:** `npm run build` succeeds. Shows without these fields render identically (no change). Shows with these fields display the source text.

---

### Task 2.5: Add E2E test for updated descriptions

**File:** `tests/e2e/biz-buzz.spec.ts` (new file)

```typescript
import { test, expect } from '@playwright/test';

test.describe('Biz Buzz Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/biz-buzz');
  });

  test('designation legend shows updated descriptions (no Profit > Nx language)', async ({ page }) => {
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('Profit > 3x');
    expect(bodyText).not.toContain('Profit > 1.5x');
    expect(bodyText).toContain('Long-running mega-hit');
    expect(bodyText).toContain('Solid hit');
  });

  test('Tour Stop designation appears in legend', async ({ page }) => {
    const bodyText = await page.textContent('body');
    expect(bodyText).toContain('Tour Stop');
    expect(bodyText).toContain('National tour');
  });

  test('Mamma Mia appears as Tour Stop', async ({ page }) => {
    // Mamma Mia should be in the Tour Stop section, not Miracle or Windfall
    const tourStopSection = page.locator('text=Tour Stop').first();
    await expect(tourStopSection).toBeVisible();
  });
});
```

**Validation:** `npx playwright test tests/e2e/biz-buzz.spec.ts` passes all 3 tests (requires dev server running or build output).

---

### Task 2.6: Build + test verification

**Commands:**
```bash
npm run test:data
npm run build
```

**Validation:** Both exit 0. No regressions.

---

## Sprint 3: Recoupment Progress Bar & Estimated Recoupment Display

**Goal:** Show pages display estimated recoupment percentage with a visual progress bar for TBD shows. The `/biz-buzz` page TBD section shows recoupment estimates. Seed data populated for demo.

**Demo:** Visit `/show/death-becomes-her` -- see progress bar showing `~60-80% recouped` with source attribution. Visit `/biz-buzz` -- TBD section shows recoupment percentage for each show with estimates.

---

### Task 3.1: Seed `estimatedRecoupmentPct` data for 5 shows

**File:** `data/commercial.json`

**Why first:** The progress bar component and its integration need real data to test against. Seeding data first allows visual verification during development.

**Changes:** Add fields to these existing entries based on the Jan 25 Reddit Grosses Analysis post:

| Show slug | `estimatedRecoupmentPct` | `estimatedRecoupmentSource` | `estimatedRecoupmentDate` | `isEstimate` |
|---|---|---|---|---|
| `death-becomes-her` | `[60, 80]` | `"Reddit Grosses Analysis (u/Boring_Waltz_9545)"` | `"2026-01-25"` | `{ "weeklyRunningCost": true }` |
| `stranger-things` | `[30, 50]` | `"Reddit Grosses Analysis (u/Boring_Waltz_9545)"` | `"2026-01-25"` | `{ "weeklyRunningCost": true }` |
| `maybe-happy-ending` | `[10, 30]` | `"Reddit Grosses Analysis (u/Boring_Waltz_9545)"` | `"2026-01-25"` | `{}` |
| `just-in-time` | `[80, 100]` | `"Reddit Grosses Analysis (u/Boring_Waltz_9545)"` | `"2026-01-25"` | `{ "weeklyRunningCost": true }` |
| `oh-mary` | `[80, 100]` | `"Reddit Grosses Analysis (u/Boring_Waltz_9545)"` | `"2026-01-25"` | `{}` |

**Validation:** `npm run test:data` passes (validation from Task 1.8 verifies format). All 5 entries have valid `estimatedRecoupmentPct` arrays.

---

### Task 3.2: Create `RecoupmentProgressBar` component

**File:** `src/components/RecoupmentProgressBar.tsx` (new file)

**Props:**
```typescript
interface RecoupmentProgressBarProps {
  estimatedPct: [number, number];  // [low, high]
  source?: string | null;
}
```

**Renders:**
- A horizontal bar container (full width, rounded, gray background)
- A filled gradient section from `low%` to `high%` width
- Color: green gradient for high ranges (midpoint > 70%), yellow for mid (40-70%), orange-red for low (<40%)
- Text label above bar: `~${low}-${high}% recouped` (or `~${low}% recouped` if low === high)
- If `source` provided, small gray text below: `Source: ${source}`
- `data-testid="recoupment-progress"` on the container div for E2E testing

**Accessibility:**
- `role="progressbar"` on the bar element
- `aria-valuenow={Math.round((low + high) / 2)}`
- `aria-valuemin={0}`
- `aria-valuemax={100}`
- `aria-label={`Estimated ${low} to ${high} percent recouped`}`

**Edge cases:**
- `[0, 0]`: render empty bar with "~0% recouped" text
- `[100, 100]`: render full bar with "~100% recouped" text (green)
- If `low > high` (shouldn't happen after validation): swap them silently

**Validation:** `npm run build` succeeds. Component exports correctly.

---

### Task 3.3: Integrate progress bar into BizBuzzCard

**File:** `src/components/BizBuzzCard.tsx`

**Change:** After the Stats Row `</div>` and before the Expandable Details section, add:

```typescript
{/* Recoupment Progress (for shows with estimates) */}
{commercial.estimatedRecoupmentPct && (
  <RecoupmentProgressBar
    estimatedPct={commercial.estimatedRecoupmentPct}
    source={commercial.estimatedRecoupmentSource}
  />
)}
```

Import `RecoupmentProgressBar` at the top of the file.

**Validation:** `npm run build` succeeds. Visit `/show/death-becomes-her` -- progress bar visible showing `~60-80% recouped`. Visit `/show/hamilton` -- no progress bar (no `estimatedRecoupmentPct` data). Visit `/show/mamma-mia` -- no progress bar (Tour Stop, no estimate data).

---

### Task 3.4: Add recoupment estimate to biz-buzz TBD section

**File:** `src/app/biz-buzz/page.tsx`

**Change:** In the section that renders TBD shows (wherever the TBD group is displayed in the page), add an estimated recoupment display next to each show name.

Find the section where shows are listed per designation. For TBD shows, after the show title, add:
```typescript
{commercial.estimatedRecoupmentPct && (
  <span className="text-xs text-gray-500 ml-2">
    ~{commercial.estimatedRecoupmentPct[0]}-{commercial.estimatedRecoupmentPct[1]}% recouped
  </span>
)}
```

This appears inline with the show name in the TBD section, giving a quick overview of how each TBD show is progressing.

**Validation:** `npm run build` succeeds. On `/biz-buzz`, the TBD section shows "Death Becomes Her ~60-80% recouped" etc.

---

### Task 3.5: E2E test for recoupment progress bar

**File:** `tests/e2e/biz-buzz.spec.ts` (append to existing file from Task 2.5)

```typescript
test('recoupment progress bar displays on show pages with estimates', async ({ page }) => {
  await page.goto('/show/death-becomes-her');
  await page.waitForLoadState('networkidle');
  const progressBar = page.locator('[data-testid="recoupment-progress"]');
  await expect(progressBar).toBeVisible({ timeout: 10000 });
  const text = await progressBar.textContent();
  expect(text).toContain('recouped');
  expect(text).toContain('60');
});

test('recoupment progress bar does NOT display on shows without estimates', async ({ page }) => {
  await page.goto('/show/hamilton');
  await page.waitForLoadState('networkidle');
  const progressBar = page.locator('[data-testid="recoupment-progress"]');
  await expect(progressBar).toHaveCount(0);
});
```

**Validation:** Both tests pass with `npx playwright test tests/e2e/biz-buzz.spec.ts`.

---

### Task 3.6: Build + test verification

**Commands:**
```bash
npm run test:data
npm run build
```

**Validation:** Both exit 0.

---

## Sprint 4: Reddit Grosses Analysis Scraper

**Goal:** A standalone script that fetches the latest weekly Grosses Analysis post from r/Broadway, parses per-show financial data, and outputs structured JSON. Can be run with `--dry-run` to preview output without modifying files.

**Demo:** Run `SCRAPINGBEE_API_KEY=xxx node scripts/update-commercial-data.js --gather-reddit --dry-run` and see structured JSON output for every currently running show.

---

### Task 4.0: Set up unit test infrastructure

**File:** `package.json`

**Change:** Add a `test:unit` script:
```json
"test:unit": "node --test tests/unit/"
```

This uses Node.js built-in test runner (available in Node 20+, which the project uses). No additional dependencies needed.

**File:** `tests/unit/` (create directory)

**Validation:** `mkdir -p tests/unit && echo "import { test } from 'node:test'; import assert from 'node:assert'; test('sanity', () => { assert.ok(true); });" > tests/unit/sanity.test.mjs && npm run test:unit` passes.

---

### Task 4.1: Create script skeleton with CLI arg parsing

**File:** `scripts/update-commercial-data.js` (new file)

**Structure:**
```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

// CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const GATHER_REDDIT = args.includes('--gather-reddit');
const GATHER_TRADE = args.includes('--gather-trade');
const GATHER_ONLY = args.includes('--gather-only');
const GATHER_ALL = args.includes('--gather-all') || (!GATHER_REDDIT && !GATHER_TRADE);

// API keys
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Data paths
const COMMERCIAL_PATH = path.join(__dirname, '..', 'data', 'commercial.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const GROSSES_PATH = path.join(__dirname, '..', 'data', 'grosses.json');
const CHANGELOG_PATH = path.join(__dirname, '..', 'data', 'commercial-changelog.json');

async function main() {
  console.log('Commercial Data Update Script');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Gather: ${GATHER_ALL ? 'ALL' : GATHER_REDDIT ? 'Reddit only' : 'Trade press only'}`);

  if (!SCRAPINGBEE_KEY) {
    console.error('ERROR: SCRAPINGBEE_API_KEY is required');
    process.exit(1);
  }

  // Steps will be added in subsequent tasks
  console.log('No gather functions implemented yet.');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
```

**Validation:** `node scripts/update-commercial-data.js --dry-run` runs and exits with error about missing SCRAPINGBEE_API_KEY. `SCRAPINGBEE_API_KEY=test node scripts/update-commercial-data.js --dry-run` runs and prints "No gather functions implemented yet." then exits 0.

---

### Task 4.2: Implement `fetchViaScrapingBee()` utility

**File:** `scripts/update-commercial-data.js`

**Function:** Reusable HTTP fetcher using ScrapingBee API (modeled on the pattern in `scripts/scrape-reddit-sentiment.js` lines 49-78).

```javascript
function fetchViaScrapingBee(url, { renderJs = false, premiumProxy = true } = {}) {
  // Returns Promise<string> (raw response body)
  // Uses SCRAPINGBEE_KEY
  // API URL: https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=${renderJs}&premium_proxy=${premiumProxy}
  // Timeout: 30 seconds
  // Returns parsed JSON if response is JSON, raw string otherwise
}
```

**Validation:** Call with a known public URL (e.g., `https://httpbin.org/json`). Returns valid response. Call with invalid URL returns error (caught, not crashed).

---

### Task 4.3: Implement `fetchGrossesAnalysisPost()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Fetches Reddit JSON API via ScrapingBee: `https://www.reddit.com/r/Broadway/search.json?q=author:Boring_Waltz_9545+Grosses+Analysis&sort=new&restrict_sr=1&limit=1&t=month`
- Extracts from response: `data.children[0].data.selftext`, `.title`, `.created_utc`, `.permalink`
- Parses week-ending date from title using regex: `/Week Ending (\d{1,2}\/\d{1,2}\/\d{4})/i`
- Fallback if search returns empty: try `https://www.reddit.com/user/Boring_Waltz_9545/submitted.json?limit=5` and find latest Grosses Analysis post
- If both fail, log error and return null (script continues with other sources)

**Returns:** `{ selftext, title, weekEnding, permalink, createdUtc }` or `null`

**Validation:** Run `SCRAPINGBEE_API_KEY=xxx node scripts/update-commercial-data.js --gather-reddit --dry-run`. Console logs the post title and week-ending date. Selftext is non-empty string (>1000 chars).

---

### Task 4.4: Implement `parseGrossesAnalysisPost()`

**File:** `scripts/update-commercial-data.js`

**Function:** Takes raw post selftext and extracts per-show financial data.

**Parsing strategy (two-tier):**
1. **Regex extraction:** Try to parse the structured format using patterns for show name, gross, capacity, ATP, operating cost, profit/loss, recoupment %
2. **Claude fallback:** If regex extracts data for fewer than 10 shows (indicating format change), send the full text to Claude Sonnet with instructions to extract the same fields as structured JSON

**Regex patterns for the known format:**
```
Show Name - $X.XM gross, XX% capacity, $XXX atp
Gross Less-Fees: $X.XXXM; Estimated Weekly Operating Cost: $XXXk/week
Estimated Profit (Loss): $XXXk+
Estimated percentage recouped: XX%-XX%
```

**Returns:** Array of objects:
```javascript
{
  showName: string,
  weeklyGross: number | null,       // in dollars
  capacity: number | null,           // percentage
  atp: number | null,                // in dollars
  grossLessFees: number | null,      // in dollars
  estimatedWeeklyCost: number | null, // in dollars
  estimatedProfitLoss: number | null, // in dollars (negative = loss)
  estimatedRecoupmentPct: [number, number] | null,  // [low, high]
  commentary: string                 // any additional text for this show
}
```

**Number parsing rules:**
- `$1.3M` or `$1.300M` -> `1300000`
- `$600k` or `$600K` -> `600000`
- `$248` -> `248`
- `102%` -> `102`
- `80%-100%` -> `[80, 100]`
- `N/A` or missing -> `null`
- `($150k)` or `-$150k` -> `-150000`

**Validation:** Unit test (see Task 4.5).

---

### Task 4.5: Unit tests for `parseGrossesAnalysisPost()`

**File:** `tests/unit/parse-grosses-analysis.test.mjs` (new file)

Export the parsing function from the script (or extract into a shared module `scripts/lib/parse-grosses.js`).

**Tests:**
1. Standard show block with all fields -> all values correctly parsed
2. Show block with "N/A" recoupment -> `estimatedRecoupmentPct: null`
3. `$600k` cost -> `600000`
4. `$1.3M` cost -> `1300000`
5. Multiple shows in combined text -> correct array length (test with 3-show sample)
6. Negative profit/loss `($150k)` -> `-150000`
7. `102%` capacity -> `102`
8. Empty input -> empty array
9. Show with only gross and capacity (missing other fields) -> partial data with nulls
10. Percentage range `80%-100%` -> `[80, 100]`

**Validation:** `npm run test:unit` passes all 10 tests. Exit code 0.

---

### Task 4.6: Implement `fetchPostComments()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes Reddit permalink (e.g., `/r/Broadway/comments/abc123/grosses_analysis/`)
- Fetches `https://www.reddit.com${permalink}.json` via ScrapingBee
- Reddit returns a 2-element array: `[post, comments]`
- Extracts top-level comments from `[1].data.children`: author, body, score, created_utc
- Sorts by score descending
- Returns top 20 comments
- If fetch fails, returns empty array (non-fatal)

**Returns:** `Array<{ author, body, score, createdUtc }>`

**Validation:** Run with `--gather-reddit --dry-run`. Console logs: "Fetched N comments from Grosses Analysis post". N > 0.

---

### Task 4.7: Implement `matchShowToSlug()`

**File:** `scripts/update-commercial-data.js`

**Function:** Maps a show name from the Reddit post to a slug in commercial.json or shows.json.

**Matching strategy (in order):**
1. **Exact slug match**: lowercase, replace spaces with hyphens, strip special chars
2. **Known aliases**: hardcoded map (same pattern as `scripts/lib/deduplication.js` KNOWN_DUPLICATES):
   - `"Harry Potter and the Cursed Child"` -> `"harry-potter"`
   - `"The Lion King"` -> `"the-lion-king"`
   - etc.
3. **Normalized match**: strip "The", "A", "An" from start; strip ": The Musical", "on Broadway", "- The Musical" from end; compare slugified result
4. **Title containment**: if a shows.json title contains the Reddit name or vice versa
5. **No fuzzy matching**: if none of the above match, return `null` with a log warning. Fuzzy matching risks false positives.

**Returns:** `{ slug: string, confidence: 'high' | 'medium' } | null`

High confidence = exact or alias match. Medium confidence = normalized or containment match.

**Validation:** Unit test with at least 10 show names from a real Grosses Analysis post -> all correctly matched. "Unknown Fake Show" -> null.

---

### Task 4.8: Integration test: Reddit gather pipeline

**Process:**
```bash
SCRAPINGBEE_API_KEY=xxx node scripts/update-commercial-data.js --gather-reddit --dry-run
```

**Validation:** Script completes in < 60 seconds. Output includes:
- Post title and week-ending date
- Parsed data for at least 15 shows (there are ~27 currently running)
- Comment count
- No crashes. Exit code 0.

---

## Sprint 5: Broader Data Gathering (Reddit Search + Trade Press)

**Goal:** Script searches r/Broadway for standalone financial discussions and trade press for Broadway financial news. All gathered data combined into a structured context document for AI analysis.

**Demo:** Run `SCRAPINGBEE_API_KEY=xxx node scripts/update-commercial-data.js --gather-all --gather-only` and see a context document written to `data/debug/commercial-analysis-context.txt` with: Grosses Analysis data, N additional Reddit threads, M trade press articles.

---

### Task 5.1: Implement `searchRedditFinancial()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Searches r/Broadway via Reddit JSON API (through ScrapingBee) for the past 7 days
- Four search queries (run sequentially to avoid rate limits, 2s delay between):
  1. `https://www.reddit.com/r/Broadway/search.json?q=recouped+OR+recoupment&sort=new&restrict_sr=1&t=week&limit=10`
  2. `...q=capitalization+OR+investment+OR+SEC+filing&...`
  3. `...q=closing+OR+final+performance&...`
  4. `...q=running+costs+OR+weekly+nut+OR+break+even&...`
- Deduplicates results by post `id` (Reddit unique post ID)
- For each unique post: fetch top 5 comments via `fetchPostComments()`
- Excludes the Grosses Analysis post itself (already fetched in Sprint 4)

**Returns:** `Array<{ title, selftext, comments[], score, url, createdUtc }>`

**Fallback:** If Reddit JSON API returns 403/429:
1. Log the error with full status code and response body
2. Return empty array (non-fatal -- script continues with trade press)
3. Include "Reddit search failed: HTTP {code}" in the context document

**Validation:** Run with `--gather-all --gather-only`. Console logs: "Reddit financial search: found N threads (M unique after dedup)".

---

### Task 5.2: Implement `searchTradePress()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Uses ScrapingBee Google search API endpoint to search trade press sites
- ScrapingBee Google search URL: `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=QUERY`
- Search queries (run sequentially, 2s delay):
  1. `Broadway recoup OR recoupment site:deadline.com OR site:variety.com` (past 7 days -- add `&search_type=news` or `tbs=qdr:w` param)
  2. `Broadway capitalization OR investment site:broadwayjournal.com OR site:playbill.com`
  3. `Broadway closing OR recoup site:broadwaynews.com OR site:broadwayworld.com`
  4. `Broadway show financial site:nytimes.com OR site:forbes.com`
- Extracts from each result: title, url, snippet

**Returns:** `Array<{ title, url, snippet, source }>`

**Fallback:** If Google search API is unavailable (ScrapingBee has a dedicated Google search endpoint -- check their docs), fall back to regular `fetchViaScrapingBee()` on `https://www.google.com/search?q=QUERY` and parse the HTML. If that also fails, return empty array with error log.

**Validation:** Run with `--gather-all --gather-only`. Console logs: "Trade press search: found M articles across N sources". M may be 0 in quiet news weeks -- that's OK.

---

### Task 5.3: Implement `scrapeArticle()` with fallback chain

**File:** `scripts/update-commercial-data.js`

**Function:** Takes a URL and attempts to retrieve article text.

**Fallback chain:**
1. **Archive.org Wayback Machine**: Fetch `https://web.archive.org/web/2025/${url}` via ScrapingBee. If 200, extract article text.
2. **ScrapingBee direct**: Fetch `url` via ScrapingBee with `render_js=true`. Extract article text.
3. **Snippet only**: Return the search result snippet as the article text (always available from Task 5.2).

**Article text extraction:** Strip HTML tags, extract `<article>` or `<main>` content if available, otherwise use full body text. Truncate to 3000 chars.

**Rate limiting:** Max 1 request per second. Max 10 articles total per run (to control API costs).

**Returns:** `{ text: string, source: 'archive.org' | 'scrapingbee' | 'snippet-only' }`

**Validation:** Test with a known Deadline Broadway article URL (from a recent trade press search). Returns text from at least one source.

---

### Task 5.4: Implement `buildAnalysisContext()`

**File:** `scripts/update-commercial-data.js`

**Function:** Assembles all gathered data into a structured text document for Claude analysis.

**Sections:**
```
## SECTION A: Current Commercial Data
[For each show in commercial.json: slug, designation, capitalization, recouped, weeklyRunningCost, productionType, notes]

## SECTION B: Box Office Math
[For each show: all-time gross from grosses.json, cap from commercial.json, gross/cap ratio]

## SECTION C: Grosses Analysis Post Data
[Parsed per-show data from Sprint 4: showName, weeklyGross, capacity, atp, estimatedWeeklyCost, estimatedRecoupmentPct, commentary]

## SECTION D: Grosses Analysis Comments
[Top 20 comments: author, score, body text]

## SECTION E: Reddit Financial Threads
[For each thread from Task 5.1: title, body excerpt (500 chars), top 3 comments]

## SECTION F: Trade Press Articles
[For each article from Tasks 5.2-5.3: title, source, text excerpt (500 chars)]

## SECTION G: Shows Without Commercial Data
[Shows in shows.json that have no commercial.json entry, with their show metadata]
```

**Returns:** String (the full context document)

**Validation:** Run with `--gather-all --gather-only`. Context document written to `data/debug/commercial-analysis-context.txt`. File contains all 7 section headers. Character count logged. Section A has 47+ shows. Section C has 15+ shows (or fewer if Grosses Analysis post wasn't found).

---

### Task 5.5: Implement `--gather-only` mode

**File:** `scripts/update-commercial-data.js`

**Change:** In the `main()` function, after gathering all data and building the context:
- If `GATHER_ONLY` flag is set, write context to `data/debug/commercial-analysis-context.txt`, log character count, and exit
- Create `data/debug/` directory if it doesn't exist
- Add `data/debug/` to `.gitignore` (if not already there)

**Validation:** `SCRAPINGBEE_API_KEY=xxx node scripts/update-commercial-data.js --gather-all --gather-only`. File exists at expected path. Contains all sections. Script exits 0.

---

### Task 5.6: Error isolation and rate limiting

**File:** `scripts/update-commercial-data.js`

**Changes:**
- Wrap each gather step (Reddit Grosses Analysis, Reddit search, trade press) in try/catch. If one fails, log the error and continue with the others.
- Add rate limiter: async `sleep(ms)` function, 2s between Reddit requests, 1s between trade press requests
- Add total timeout: 5 minutes for all gathering combined. If exceeded, proceed with whatever data was gathered.
- Log a summary at the end of gathering: "Sources gathered: Grosses Analysis [yes/no], Reddit threads [N], Trade press articles [M]"

**Validation:** Simulate a failure (e.g., invalid ScrapingBee key for one step). Script logs the error and continues. Script completes with partial data. Exit code 0.

---

## Sprint 6: AI Analysis Engine & Change Application

**Goal:** Claude Sonnet analyzes the gathered context and proposes changes to commercial.json. Changes filtered by confidence and applied. Shadow classifier runs in background. Changelog updated.

**Demo:** Run `SCRAPINGBEE_API_KEY=xxx ANTHROPIC_API_KEY=xxx node scripts/update-commercial-data.js --gather-all --dry-run` and see: proposed changes table, shadow classifier disagreements, and what would be applied vs flagged. Run without `--dry-run` to see changes written to `commercial.json` and `commercial-changelog.json`.

---

### Task 6.1: Implement `analyzeWithClaude()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes the context document from `buildAnalysisContext()`
- Calls Claude Sonnet API (use `claude-sonnet-4-20250514` or latest available sonnet model)
- API endpoint: `https://api.anthropic.com/v1/messages`
- Headers: `x-api-key: ${ANTHROPIC_KEY}`, `anthropic-version: 2023-06-01`, `content-type: application/json`

**System prompt:**
```
You are a Broadway financial data analyst. You are given the current commercial database for Broadway shows and multiple data sources from the past week. Your job is to propose updates to the database.

For each proposed change, provide:
- slug: the show's slug in commercial.json
- field: the field to update (e.g., "estimatedRecoupmentPct", "weeklyRunningCost", "recouped", "designation", "capitalization", "notes")
- oldValue: current value
- newValue: proposed new value
- isEstimate: boolean - is this an estimate or confirmed fact?
- confidence: "high" (official source, SEC filing, press announcement), "medium" (consistent Reddit estimates, multiple sources agree), "low" (single comment, speculation, uncertain)
- source: where you found this information
- reasoning: 1-2 sentence explanation

RULES:
- NEVER propose changing Miracle, Nonprofit, or Tour Stop designations
- NEVER propose designation upgrades (Windfall→Miracle) -- flag these as low confidence suggestions only
- TBD→Windfall is OK if recoupment is officially announced
- TBD→Fizzle/Flop is OK if show is closed/closing and recoupment < 30%
- estimatedRecoupmentPct should be [low, high] array from Reddit ranges
- For new shows (in Section G), propose a full initial entry

Return your response as a JSON object:
{
  "proposedChanges": [...],
  "newShowEntries": [...],
  "shadowClassifierNotes": "any observations about designation accuracy"
}
```

**Returns:** Parsed JSON object from Claude's response.

**Error handling:** If Claude returns invalid JSON, attempt to extract JSON from markdown code blocks. If still invalid, log error and return empty proposals.

**Validation:** Run with `--gather-all --dry-run`. Claude returns valid JSON with `proposedChanges` array. Each change has all required fields.

---

### Task 6.2: Implement `filterByConfidence()`

**File:** `scripts/update-commercial-data.js`

**Function:** Takes array of proposed changes, applies confidence and safety filters.

**Rules:**
- `confidence: "high"` -> apply
- `confidence: "medium"` -> apply
- `confidence: "low"` -> skip (flag in notification)
- Designation changes to/from `Miracle` -> skip (flag)
- Designation changes to/from `Nonprofit` -> skip (flag)
- Designation changes to/from `Tour Stop` -> skip (flag)
- Designation upgrade (e.g., Windfall -> Miracle) -> skip (flag)
- Designation `TBD -> Windfall` (recoupment confirmed) -> apply if high/medium
- Designation `TBD -> Fizzle/Flop` (show closed) -> apply if high/medium
- Changes to `productionType` -> skip (flag, requires manual review)

**Returns:** `{ applied: Change[], flagged: Change[], skipped: Change[] }`

**Validation:** Unit test (see Task 6.5).

---

### Task 6.3: Implement `applyChanges()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Takes the `applied` array from `filterByConfidence()`
- For each change: updates the corresponding field in the commercial data object
- Updates `_meta.lastUpdated` to today's date (YYYY-MM-DD)
- If `DRY_RUN`, prints changes but does NOT write to disk
- If not dry run, writes to `data/commercial.json` with 2-space indentation

**Validation:** Run without `--dry-run` (on a git branch). `data/commercial.json` is modified. `JSON.parse()` succeeds. `lastUpdated` is today. `git diff` shows expected changes.

---

### Task 6.4: Implement `shadowClassifier()`

**File:** `scripts/update-commercial-data.js`

**Function:** Computes heuristic designations for comparison with live designations.

**For each show in commercial.json (skip Nonprofit, Tour Stop):**
1. Calculate gross/cap ratio from `grosses.json` allTime gross and `commercial.json` capitalization
2. Look up `estimatedRecoupmentPct` if available
3. Apply heuristic rules:
   - `recouped == true` AND `gross/cap > 20x` -> Shadow: Miracle
   - `recouped == true` AND `gross/cap > 5x` -> Shadow: Windfall
   - `recouped == true` AND `gross/cap <= 5x` -> Shadow: Trickle
   - Show closed AND `estimatedRecoupmentPct` midpoint < 30% -> Shadow: Flop
   - Show closed AND `estimatedRecoupmentPct` midpoint >= 30% -> Shadow: Fizzle
   - Otherwise -> Shadow: TBD
4. Compare shadow vs live designation
5. Return disagreements only

**Returns:** `Array<{ slug, liveDesignation, shadowDesignation, grossCapRatio, estimatedRecoupmentPct }>`

**Validation:** Run on current data. Known disagreements:
- Hadestown: live=Windfall, shadow=Miracle (gross/cap ~22x, recouped)
- Oh Mary: live=Windfall, shadow=Miracle (gross/cap ~20x, recouped)
These should appear in the output.

---

### Task 6.5: Unit tests for `filterByConfidence()` and `shadowClassifier()`

**File:** `tests/unit/commercial-changes.test.mjs` (new file)

Export `filterByConfidence` from the script (or extract to `scripts/lib/commercial-rules.js`).

**Tests for filterByConfidence:**
1. High confidence weeklyRunningCost update -> in `applied`
2. Medium confidence estimatedRecoupmentPct update -> in `applied`
3. Low confidence capitalization update -> in `skipped`
4. Medium confidence Windfall->Miracle designation -> in `flagged` (never auto-upgrade)
5. High confidence TBD->Windfall (recouped) -> in `applied`
6. High confidence TBD->Fizzle (closed, <30%) -> in `applied`
7. Any confidence change to Miracle designation -> in `skipped`
8. Any confidence change to Nonprofit designation -> in `skipped`
9. Any confidence change to Tour Stop designation -> in `skipped`
10. Change to productionType -> in `flagged`

**Tests for shadowClassifier (mock data):**
- Show with 100x gross/cap and recouped -> shadow Miracle
- Show with 8x gross/cap and recouped -> shadow Windfall
- Show with 3x gross/cap and recouped -> shadow Trickle
- Closed show with 20% estimated recoupment -> shadow Flop
- Closed show with 50% estimated recoupment -> shadow Fizzle

**Validation:** `npm run test:unit` passes all tests.

---

### Task 6.6: Implement `writeChangelog()`

**File:** `scripts/update-commercial-data.js`

**Creates/updates:** `data/commercial-changelog.json`

**Logic:**
- Load existing changelog (or create new one if file doesn't exist)
- Append new entry to `entries` array:
```json
{
  "date": "2026-01-29",
  "weekEnding": "1/25/2026",
  "sourcesConsulted": [
    "Reddit Grosses Analysis (u/Boring_Waltz_9545)",
    "r/Broadway search (3 threads)",
    "Deadline (1 article)"
  ],
  "changesApplied": [
    { "slug": "death-becomes-her", "field": "estimatedRecoupmentPct", "oldValue": null, "newValue": [60, 80], "confidence": "medium" }
  ],
  "changesFlagged": [],
  "changesSkipped": [],
  "shadowDisagreements": [
    { "slug": "hadestown", "live": "Windfall", "shadow": "Miracle", "grossCapRatio": 22.1 }
  ]
}
```
- Update `_meta.lastUpdated`
- Write to disk (unless `DRY_RUN`)

**Validation:** Run full pipeline (not dry run). `commercial-changelog.json` exists. Contains a valid entry. `JSON.parse()` succeeds. Entry has all required fields.

---

### Task 6.7: Create initial `commercial-changelog.json`

**File:** `data/commercial-changelog.json` (new file)

```json
{
  "_meta": {
    "description": "Automated commercial data update log",
    "lastUpdated": null
  },
  "entries": []
}
```

**Validation:** `npm run test:data` passes. File is valid JSON.

---

### Task 6.8: Full pipeline integration test (dry run)

**Commands:**
```bash
SCRAPINGBEE_API_KEY=xxx ANTHROPIC_API_KEY=xxx node scripts/update-commercial-data.js --gather-all --dry-run
```

**Validation:** Script completes without error. Output includes:
- Sources gathered count
- Proposed changes table (or "no changes proposed")
- Shadow classifier disagreements
- Dry run confirmation (no files modified)
- `git diff` shows no changes to data files
- Exit code 0

---

## Sprint 7: GitHub Actions, Notifications & Tip Submission

**Goal:** Fully automated weekly workflow. GitHub issue created with change summary on every run. Insider tip submission system via GitHub issue template with automated processing.

**Demo:** Trigger `update-commercial.yml` manually via GitHub Actions UI. Workflow runs, creates GitHub issue with change summary, commits any changes. Submit a commercial tip via GitHub issue template -> automated processing posts a comment.

---

### Task 7.1: Implement `createGitHubIssue()`

**File:** `scripts/update-commercial-data.js`

**Function:**
- Uses GitHub REST API: `POST https://api.github.com/repos/{owner}/{repo}/issues`
- Auth: `Authorization: Bearer ${GITHUB_TOKEN}`
- Repo: parsed from git remote or hardcoded `thomaspryor/Broadwayscore`

**Issue title:** `Commercial Update: Week ending {weekEnding}` (or `Commercial Update: No changes - Week ending {weekEnding}`)

**Issue body (markdown):**
```markdown
## Changes Applied

| Show | Field | Old Value | New Value | Confidence | Source |
|------|-------|-----------|-----------|------------|--------|
| ... | ... | ... | ... | ... | ... |

## Suggestions Not Applied (Low Confidence / Designation Upgrades)

| Show | Field | Suggested Value | Confidence | Reason Not Applied |
|------|-------|----------------|------------|-------------------|
| ... | ... | ... | ... | ... |

## Shadow Classifier Disagreements

| Show | Live | Shadow | Gross/Cap Ratio |
|------|------|--------|----------------|
| ... | ... | ... | ... |

## Sources Consulted
- [Grosses Analysis: Week ending 1/25/2026](https://reddit.com/r/Broadway/...)
- [Reddit: Show X recoupment discussion](https://reddit.com/...)
- [Deadline: Broadway Show Y Recoups](https://deadline.com/...)

## Summary
- Shows updated: N
- Suggestions flagged: M
- Shadow disagreements: K
- Total shows tracked: 47

---
*Automated by [update-commercial-data.js](https://github.com/thomaspryor/Broadwayscore/blob/main/scripts/update-commercial-data.js)*
```

**Labels:** `["commercial-update", "automated"]`

**Skip condition:** If no changes applied AND no suggestions AND no shadow disagreements, log "No changes this week, skipping issue creation" and don't create an issue.

**Validation:** Run full pipeline (not dry run, with GITHUB_TOKEN). Issue created in the repo. Has correct title, labels, and formatted tables. Issue URL logged to console.

---

### Task 7.2: Create `update-commercial.yml` workflow

**File:** `.github/workflows/update-commercial.yml` (new file)

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
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Run commercial data update
        env:
          SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          ARGS="--gather-all"
          if [ "${{ github.event.inputs.dry_run }}" = "true" ]; then
            ARGS="$ARGS --dry-run"
          fi
          if [ "${{ github.event.inputs.gather_only }}" = "true" ]; then
            ARGS="$ARGS --gather-only"
          fi
          node scripts/update-commercial-data.js $ARGS

      - name: Validate data
        if: always()
        run: npm run test:data

      - name: Build site
        if: always()
        run: npm run build
        env:
          NODE_ENV: production
        continue-on-error: true

      - name: Commit and push changes
        if: always()
        run: |
          git add data/commercial.json data/commercial-changelog.json

          if git diff --staged --quiet; then
            echo "No changes to commit"
          else
            WEEK_ENDING=$(node -e "const d=require('./data/commercial-changelog.json');const e=d.entries;console.log(e.length?e[e.length-1].weekEnding:'unknown')")
            git commit -m "data: Update commercial data for week ending $WEEK_ENDING

          Automated weekly update of commercial scorecard data.

          Co-Authored-By: github-actions[bot] <github-actions[bot]@users.noreply.github.com>"

            for i in 1 2 3 4 5; do
              if git push origin main; then
                echo "Push succeeded on attempt $i"
                break
              fi
              echo "Push failed (attempt $i), pulling and rebasing..."
              git pull --rebase origin main
              sleep $((RANDOM % 5 + 2))
            done
            echo "Changes committed and pushed"
          fi

      - name: Summary
        if: always()
        run: |
          echo "## Commercial Data Update" >> $GITHUB_STEP_SUMMARY
          if [ -f data/commercial-changelog.json ]; then
            ENTRIES=$(node -e "const d=require('./data/commercial-changelog.json');console.log(d.entries.length)")
            echo "Total changelog entries: $ENTRIES" >> $GITHUB_STEP_SUMMARY
          fi
```

**Validation:** `gh workflow view update-commercial.yml` shows no errors. Workflow appears in Actions tab.

---

### Task 7.3: Create `commercial-tip.yml` issue template

**File:** `.github/ISSUE_TEMPLATE/commercial-tip.yml` (new file)

```yaml
name: Commercial Tip
description: Share insider info about a Broadway show's commercial performance
title: "[Commercial Tip] "
labels: ["commercial-tip", "needs-processing"]
body:
  - type: markdown
    attributes:
      value: |
        ## Share Commercial Information

        Help us keep the Commercial Scorecard accurate by sharing financial information about Broadway shows.

  - type: input
    id: show_name
    attributes:
      label: Show Name
      description: Name of the Broadway show
      placeholder: Hamilton, Wicked, Death Becomes Her, etc.
    validations:
      required: true

  - type: dropdown
    id: tip_type
    attributes:
      label: Type of Information
      description: What kind of financial info are you sharing?
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
      description: What did you learn? Include specific numbers if possible.
      placeholder: "E.g., 'Death Becomes Her announced recoupment on Feb 1 per Deadline article'"
    validations:
      required: true

  - type: input
    id: source
    attributes:
      label: Source (optional)
      description: Where did you find this info?
      placeholder: "URL, publication name, or 'personal knowledge'"
    validations:
      required: false

  - type: markdown
    attributes:
      value: |
        ---
        **What happens next:**
        1. Our system validates the tip and matches it to a show
        2. If valid, the commercial data is updated automatically
        3. You'll get a comment on this issue with the result
```

**Validation:** Template appears in GitHub "New Issue" dropdown under "Commercial Tip". All fields render correctly.

---

### Task 7.4: Create `scripts/process-commercial-tip.js`

**File:** `scripts/process-commercial-tip.js` (new file)

**Function:**
- Parses issue body to extract: show_name, tip_type, details, source
- Matches show_name to a slug in commercial.json (using `matchShowToSlug()` or similar logic)
- Calls Claude Sonnet to validate the tip:
  - Is this credible? (check source, specificity)
  - What field(s) should be updated?
  - What confidence level?
  - Proposed changes as structured JSON
- If valid and high/medium confidence:
  - Apply changes to commercial.json
  - Append to commercial-changelog.json (source: "User tip via GitHub issue")
  - Post comment on issue: "Tip processed. Updated {field} for {show}. Changes: ..."
  - Close issue
- If low confidence or invalid:
  - Post comment: "Tip received but needs manual review. Reason: ..."
  - Add label: `needs-manual-review`

**Validation:** Create a test issue with a known-good tip (e.g., "Hamilton recouped in 2015"). Script processes it, posts a comment, and closes the issue.

---

### Task 7.5: Create `process-commercial-tip.yml` workflow

**File:** `.github/workflows/process-commercial-tip.yml` (new file)

```yaml
name: Process Commercial Tip

on:
  issues:
    types: [opened, edited]

jobs:
  process-tip:
    if: contains(github.event.issue.labels.*.name, 'commercial-tip')
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Process tip
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          ISSUE_BODY: ${{ github.event.issue.body }}
        run: node scripts/process-commercial-tip.js

      - name: Commit and push (if changes made)
        if: always()
        run: |
          git add data/commercial.json data/commercial-changelog.json
          if git diff --staged --quiet; then
            echo "No changes"
          else
            git commit -m "data: Process commercial tip from issue #${{ github.event.issue.number }}

            Co-Authored-By: github-actions[bot] <github-actions[bot]@users.noreply.github.com>"

            for i in 1 2 3; do
              if git push origin main; then break; fi
              git pull --rebase origin main
              sleep 2
            done
          fi
```

**Validation:** Workflow file is valid YAML. Create a test issue with `commercial-tip` label. Workflow triggers and runs.

---

### Task 7.6: Update CLAUDE.md with commercial automation documentation

**File:** `CLAUDE.md`

**Change:** Add a new section under "Automation (GitHub Actions)":

```markdown
### `.github/workflows/update-commercial.yml`
- **Runs:** Weekly (Wednesday 4pm UTC / 11am ET)
- **Does:**
  - Scrapes r/Broadway Grosses Analysis post for financial data
  - Searches r/Broadway for recoupment/capitalization discussions
  - Searches trade press (Deadline, Variety, etc.) for Broadway financial news
  - AI analysis (Claude Sonnet) proposes updates to commercial.json
  - Auto-applies high/medium confidence changes
  - Creates GitHub issue with change summary
  - Runs shadow classifier for designation validation
- **Secrets required:** SCRAPINGBEE_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN
- **Manual trigger:** `gh workflow run "Update Commercial Data"`
  - `--dry_run`: Preview changes without committing
  - `--gather_only`: Gather data without AI analysis
- **Script:** `scripts/update-commercial-data.js`

### `.github/workflows/process-commercial-tip.yml`
- **Runs:** When issue created/edited with `commercial-tip` label
- **Does:** Validates and applies user-submitted commercial tips
- **Issue template:** `.github/ISSUE_TEMPLATE/commercial-tip.yml`
- **Script:** `scripts/process-commercial-tip.js`
```

**Validation:** Section present in CLAUDE.md. Accurate reflection of the workflows.

---

### Task 7.7: End-to-end workflow test

**Process:**
1. Ensure all Sprint 7 code is pushed to `main`
2. Trigger workflow: `gh workflow run "Update Commercial Data" --field dry_run=true`
3. Wait for completion: `gh run watch`
4. Verify:
   - Workflow completed successfully (exit code 0)
   - GitHub step summary shows results
   - No data files modified (dry run mode)
5. Trigger again without dry run: `gh workflow run "Update Commercial Data"`
6. Verify:
   - `data/commercial.json` has updated `_meta.lastUpdated`
   - `data/commercial-changelog.json` has new entry
   - GitHub issue created with `commercial-update` label
   - Vercel build succeeds

**Validation:** All verification points pass.

---

### Task 7.8: Test tip submission end-to-end

**Process:**
1. Navigate to GitHub Issues -> New Issue -> "Commercial Tip"
2. Fill in: Show Name = "Test Show", Type = "Other financial info", Details = "This is a test tip, please ignore"
3. Submit
4. Verify `process-commercial-tip.yml` triggers
5. Verify workflow posts a comment (likely "needs manual review" for a fake tip)
6. Close the test issue manually

**Validation:** Workflow triggered. Comment posted on issue. No data corruption.

---

## Summary

| Sprint | Tasks | Goal |
|--------|-------|------|
| 1 | 9 | Data model, types, UI config, data fixes (foundation) |
| 2 | 6 | Designation descriptions, ~ prefix, estimate display |
| 3 | 6 | Recoupment progress bar + seeded data |
| 4 | 9 | Reddit Grosses Analysis scraper + unit tests |
| 5 | 6 | Reddit search + trade press + context builder |
| 6 | 8 | AI analysis + change engine + shadow classifier + changelog |
| 7 | 8 | GitHub Actions + notifications + tip submission |
| **Total** | **52** | **Fully automated weekly commercial updates** |

Each sprint builds on the previous one. Sprints 1-3 are UI/data work (no external API calls needed). Sprints 4-5 are data gathering (requires SCRAPINGBEE_API_KEY). Sprint 6 is the AI brain (requires ANTHROPIC_API_KEY). Sprint 7 ties it all together with automation (requires GITHUB_TOKEN).

Use subagents liberally!
