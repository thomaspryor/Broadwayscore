# Broadway Scorecard Conventions

This document defines the canonical ID formats, file locations, and data ownership rules.

---

## Canonical ID Formats

### Review ID (most important)
```
Format: {showId}--{outletId}--{criticSlug}
```

**Examples:**
- `two-strangers-bway-2025--NYT--laura-collins-hughes`
- `hamilton-2015--VULT--jesse-green`
- `wicked-2003--THR--unknown`

**Rules:**
- Double-dash `--` as separator (allows single dashes in slugs)
- Use `unknown` for critic slug when name not available
- Use `generateReviewId()` from `src/types/canonical.ts`

### Show ID
```
Format: {title-slug}-{year}
```

**Examples:**
- `two-strangers-bway-2025`
- `hamilton-2015`
- `chicago-revival-2024`

### Outlet ID
```
Format: UPPERCASE abbreviation
```

**Examples:**
- `NYT` - The New York Times
- `VULT` - Vulture
- `THR` - The Hollywood Reporter
- `BWW` - BroadwayWorld

All IDs defined in `src/config/outlets.ts`.

### Review Source ID
```
Format: {source}--{sourceKey}
```

**Examples:**
- `dtli--two-strangers`
- `show-score--two-strangers-carry-a-cake-across-new-york`
- `bww--two-strangers`

### Review Text ID
```
Format: {reviewId}--{textSource}
```

**Examples:**
- `two-strangers-bway-2025--NYT--laura-collins-hughes--scraped`
- `hamilton-2015--VULT--jesse-green--webfetch`

---

## File Locations by Data Type

```
data/
├── shows.json                      # Show metadata (source of truth)
├── reviews.json                    # Legacy reviews (being migrated)
│
├── reviews/
│   └── by-show/
│       └── {showId}.json           # CANONICAL reviews per show
│
├── review-sources/
│   ├── dtli/
│   │   └── {showId}.json           # Did They Like It data
│   ├── show-score/
│   │   └── {showId}.json           # Show Score data
│   └── bww/
│       └── {showId}.json           # BWW roundup data
│
├── review-texts/
│   └── {showId}/
│       └── {outletId}--{critic}.json   # Full text per review
│
├── llm-scores/
│   └── {showId}.json               # LLM sentiment analysis
│
├── aggregator-archive/
│   ├── dtli/                       # Archived DTLI HTML
│   ├── show-score/                 # Archived Show Score HTML
│   └── bww-roundups/               # Archived BWW pages
│
└── audit/
    ├── reconciliation/             # Cross-source reconciliation
    ├── validation/                 # Validation reports
    └── reports/                    # Summary reports
```

---

## Session Ownership (Who Writes Where)

| Directory | Owner Session | Can Read | Can Write |
|-----------|---------------|----------|-----------|
| `data/shows.json` | update-show-status | ALL | update-show-status only |
| `data/reviews/by-show/` | review-reconciliation | ALL | review-reconciliation only |
| `data/review-sources/dtli/` | dtli-scraper | ALL | dtli-scraper only |
| `data/review-sources/show-score/` | show-score-scraper | ALL | show-score-scraper only |
| `data/review-sources/bww/` | bww-scraper | ALL | bww-scraper only |
| `data/review-texts/` | text-scraper | ALL | text-scraper only |
| `data/llm-scores/` | llm-scorer | ALL | llm-scorer only |
| `data/audit/` | reconciliation | ALL | reconciliation only |
| `src/types/canonical.ts` | foundation | ALL | ASK FIRST |
| `src/config/outlets.ts` | foundation | ALL | ASK FIRST |

**Rule:** Sessions can READ from any directory but only WRITE to their assigned directories.

---

## Type Imports

Always import from canonical sources:

```typescript
// ✅ CORRECT
import type { Show, Review, Outlet } from '@/types/canonical';
import { slugify, generateReviewId } from '@/types/canonical';
import { getOutletById, findOutletByName } from '@/config/outlets';
import { getScoreBucket, getScoreLabel } from '@/config/score-buckets';

// ❌ INCORRECT - don't import from engine.ts
import type { RawShow } from '@/lib/engine';  // NO
```

---

## JSON File Format

All data files should include metadata:

```json
{
  "_meta": {
    "description": "Reviews for Two Strangers from all sources",
    "lastUpdated": "2026-01-24T12:00:00Z",
    "source": "review-reconciliation",
    "version": "1.0"
  },
  "showId": "two-strangers-bway-2025",
  "reviewCount": 16,
  "reviews": [
    // ... review objects
  ]
}
```

---

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `review-texts.ts` |
| Directories | kebab-case | `by-show/` |
| Components | PascalCase | `ScoreBadge` |
| Functions | camelCase | `getScoreBucket` |
| Constants | SCREAMING_SNAKE | `MIN_REVIEWS_FOR_SCORE` |
| Interfaces | PascalCase | `Review`, `Show` |

---

## Validation Rules

| Field | Rule |
|-------|------|
| Show ID | Pattern: `^[a-z0-9-]+-\d{4}$` |
| Outlet ID | Uppercase, 2-10 chars |
| Review ID | Exactly two `--` separators |
| Scores | Integer 0-100 or null |
| Timestamps | ISO 8601: `2026-01-24T12:00:00Z` |
| URLs | Must start with `https://` |

---

## Quick Reference

### Generate a Review ID
```typescript
import { generateReviewId } from '@/types/canonical';

const reviewId = generateReviewId(
  'two-strangers-bway-2025',  // showId
  'NYT',                       // outletId
  'Laura Collins-Hughes'       // criticName
);
// → "two-strangers-bway-2025--NYT--laura-collins-hughes"
```

### Find an Outlet
```typescript
import { findOutletByName, getOutletById } from '@/config/outlets';

const outlet = findOutletByName('New York Times');  // → NYT outlet
const outlet2 = getOutletById('VULT');              // → Vulture outlet
```

### Get Score Bucket
```typescript
import { getScoreBucket, getScoreLabel } from '@/config/score-buckets';

const bucket = getScoreBucket(87);   // → { id: 'must-see', label: 'Must See', ... }
const label = getScoreLabel(72);     // → "Good"
```
