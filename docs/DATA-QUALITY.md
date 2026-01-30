# Data Quality System

This document describes the data quality infrastructure for Broadway Scorecard.

## Overview

The data quality system ensures:
- **No duplicate reviews** (same critic+outlet for same show)
- **No unknown outlets** (all outlets in registry)
- **Proper display names** (not raw IDs shown to users)
- **Consistent critic names** (typos and variations normalized)
- **Accurate scoring** (correct tier weights applied)

## Architecture

```
                    ┌─────────────────────┐
                    │  Extraction Scripts │
                    │  (gather-reviews,   │
                    │   extract-*, etc.)  │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ review-normalization│
                    │  - normalizeOutlet  │
                    │  - normalizeCritic  │
                    │  - deduplication    │
                    └──────────┬──────────┘
                               │
                               ▼
              ┌────────────────────────────────┐
              │      data/review-texts/        │
              │  {showId}/{outlet}--{critic}.json │
              └────────────────┬───────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ validate-review │  │ rebuild-all-    │  │ generate-       │
│ -texts.js       │  │ reviews.js      │  │ integrity-      │
│ (CI validation) │  │ (reviews.json)  │  │ report.js       │
└─────────────────┘  └────────┬────────┘  └────────┬────────┘
                              │                    │
                              ▼                    ▼
                    ┌─────────────────┐  ┌─────────────────┐
                    │ outlet-id-mapper│  │ Weekly Discord  │
                    │ (tier scoring)  │  │ Notifications   │
                    └─────────────────┘  └─────────────────┘
```

## Key Components

### 1. Outlet Registry (`data/outlet-registry.json`)

Single source of truth for all outlets. Contains:
- **outletId**: Canonical lowercase ID (e.g., `nytimes`)
- **displayName**: Human-readable name (e.g., "The New York Times")
- **tier**: 1 (major), 2 (regional/trade), or 3 (blogs/niche)
- **aliases**: All known variations of the outlet name

```json
{
  "nytimes": {
    "displayName": "The New York Times",
    "tier": 1,
    "aliases": ["nytimes", "new york times", "the new york times", "ny times", "nyt"]
  }
}
```

### 2. Review Normalization (`scripts/lib/review-normalization.js`)

Core module that normalizes all review data:

#### `normalizeOutlet(name)`
Maps any outlet name variation to canonical ID:
```javascript
normalizeOutlet("The New York Times") // → "nytimes"
normalizeOutlet("NY Times")           // → "nytimes"
normalizeOutlet("nyt")                // → "nytimes"
```

#### `normalizeCritic(name)`
Normalizes critic names and handles typos:
```javascript
normalizeCritic("Jesse Green")        // → "jesse-green"
normalizeCritic("Elisabeth Vincentelli") // → "elisabeth-vincentelli"
normalizeCritic("Elizabeth Vincentelli") // → "elisabeth-vincentelli" (typo handled)
```

#### Critic Aliases
Explicit mappings for known name variations:
```javascript
const CRITIC_ALIASES = {
  'jesse-green': ['jesse green', 'jesse', 'j green'],
  'elisabeth-vincentelli': ['elisabeth vincentelli', 'elizabeth vincentelli'], // typo
  'johnny-oleksinski': ['johnny oleksinski', 'johnny oleksinki'], // typo
  // ...
};
```

**Important**: We do NOT use fuzzy matching (Levenshtein distance) for critics. This caused false positives like "Helen Smith" matching "Helen Smyth" (different people). Only explicit aliases are used.

### 3. Outlet ID Mapper (`src/lib/outlet-id-mapper.ts`)

Maps between registry format (lowercase) and scoring format (uppercase):

```typescript
// Registry uses lowercase: "nytimes", "vulture"
// Scoring engine uses uppercase: "NYT", "VULT"

toScoringId("nytimes")     // → "NYT"
toScoringId("vulture")     // → "VULT"
toRegistryId("NYT")        // → "nytimes"
```

This ensures reviews get correct tier weights regardless of which ID format is stored.

### 4. Validation Script (`scripts/validate-review-texts.js`)

Validates all review-text files with 4 checks:

| Check | Description | Severity |
|-------|-------------|----------|
| Unknown outlets | outletId not in registry | ERROR |
| Garbage critic names | "Photo Credit", "Staff", etc. | ERROR |
| Duplicates | Same outlet+critic in same show | ERROR |
| Required fields | Missing showId, outletId, or outlet | ERROR |

Run manually:
```bash
node scripts/validate-review-texts.js
node scripts/validate-review-texts.js --show=hamilton-2015
node scripts/validate-review-texts.js --json
```

Runs in CI on every push to `main`.

### 5. Integrity Report (`scripts/generate-integrity-report.js`)

Weekly health check tracking 4 metrics:

| Metric | Description | Target |
|--------|-------------|--------|
| Total Reviews | Count of review-text files | Tracked |
| Unknown Outlets | Files with unregistered outlets | 0 |
| Duplicates | Same outlet+critic per show | 0 |
| Sync Delta | Difference between review-texts and reviews.json | Expected* |

*Sync delta is expected when reviews lack score sources (no LLM score, no thumb, no original rating). These are excluded from `reviews.json` until scored.

Outputs:
- `data/integrity-report.md` - Human-readable report
- `data/integrity-report.json` - Machine-readable data
- `data/integrity-history.json` - 12-week history

### 6. Registry Audit (`scripts/audit-outlet-registry.js`)

Audits registry coverage:
- Missing outlets (in reviews but not registry)
- Unused outlets (in registry but no reviews)
- Display name mismatches
- Normalization needed (e.g., "USATODAY" → "usatoday")

Output: `data/audit/outlet-registry-gaps.json`

## CI Integration

### On Every Push (`test.yml`)

```yaml
- name: Validate review-text files
  run: node scripts/validate-review-texts.js
```

Fails the build if ANY validation error is found.

### Weekly Monitoring (`weekly-integrity.yml`)

Runs Sundays at 3 AM UTC:
1. Generates integrity report
2. Posts to Discord `#weekly-reports` channel
3. Creates GitHub issue if critical issues found

## Discord Notifications

| Channel | Notifications |
|---------|---------------|
| `#alerts` | CI failures, critical data issues |
| `#weekly-reports` | Integrity report, review counts |
| `#new-shows` | New shows discovered |

Secrets required:
- `DISCORD_WEBHOOK_ALERTS`
- `DISCORD_WEBHOOK_REPORTS`
- `DISCORD_WEBHOOK_NEWSHOWS`

## Adding New Outlets

1. Add to `data/outlet-registry.json`:
```json
{
  "new-outlet": {
    "displayName": "New Outlet Name",
    "tier": 2,
    "aliases": ["new outlet", "new-outlet", "newoutlet"]
  }
}
```

2. Add to `scripts/lib/review-normalization.js` OUTLET_ALIASES:
```javascript
'new-outlet': ['new outlet', 'new-outlet', 'newoutlet'],
```

3. Add to `src/lib/outlet-id-mapper.ts`:
```typescript
'new-outlet': 'NEWOUTLET',
```

4. Add to `src/config/scoring.ts` OUTLET_TIERS:
```typescript
'NEWOUTLET': { tier: 2, name: 'New Outlet Name', scoreFormat: 'text_bucket' },
```

5. Run validation:
```bash
node scripts/validate-review-texts.js
node scripts/audit-outlet-registry.js
```

## Adding Critic Aliases

For typos or name variations, add to `scripts/lib/review-normalization.js`:

```javascript
const CRITIC_ALIASES = {
  // Existing entry - add new variation
  'existing-critic': ['existing critic', 'new variation here'],

  // New entry
  'new-critic': ['new critic', 'n. critic', 'n critic'],
};
```

## Troubleshooting

### "Unknown outlet" validation error

1. Check if outlet is in `data/outlet-registry.json`
2. If not, add it with appropriate tier
3. Add aliases to normalization module
4. Add to outlet ID mapper and scoring config

### "Duplicate review" validation error

1. Check `data/review-texts/{showId}/` for duplicate files
2. Run `node scripts/cleanup-duplicate-reviews.js --dry-run`
3. If safe, run without `--dry-run` to merge duplicates

### Reviews missing from reviews.json (sync delta)

This is expected for reviews without score sources. Options:
1. Run LLM scoring: `gh workflow run "LLM Ensemble Score Reviews"`
2. Manually add scores if original rating is known
3. Wait for aggregator thumbs to be collected

### Wrong tier applied to reviews

1. Check `src/lib/outlet-id-mapper.ts` has the mapping
2. Check `src/config/scoring.ts` has the outlet tier
3. Rebuild: `node scripts/rebuild-all-reviews.js`

## Scripts Reference

| Script | Purpose | Run Frequency |
|--------|---------|---------------|
| `validate-review-texts.js` | Validate all review files | Every CI push |
| `generate-integrity-report.js` | Weekly health metrics | Weekly (Sunday) |
| `audit-outlet-registry.js` | Registry coverage audit | As needed |
| `cleanup-duplicate-reviews.js` | Merge duplicate files | As needed |
| `rebuild-all-reviews.js` | Rebuild reviews.json | After data changes |

## Metrics History

The system maintains 12 weeks of history in `data/integrity-history.json`:

```json
{
  "weeks": [
    {
      "date": "2026-01-30",
      "totalReviews": 2111,
      "unknownOutlets": 0,
      "duplicates": 0,
      "syncDelta": 13
    }
  ]
}
```

This allows tracking trends and detecting regressions.
