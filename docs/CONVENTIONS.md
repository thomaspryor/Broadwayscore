# Broadway Scorecard Conventions

This document defines the canonical ID formats, file locations, and data ownership rules for the Broadway Scorecard project.

## Canonical ID Formats

### Show IDs
Format: `{title-slug}-{year}`

Examples:
- `two-strangers-bway-2025`
- `wicked-2003`
- `hamilton-2015`

Rules:
- Use `slugify()` from `src/types/canonical.ts` to generate title slugs
- Year is the opening year
- Add suffixes for revivals: `chicago-revival-2024`

### Outlet IDs
Format: Uppercase abbreviation

Examples:
- `NYT` - The New York Times
- `VULT` - Vulture
- `THR` - The Hollywood Reporter
- `BWW` - BroadwayWorld

Rules:
- All IDs defined in `src/config/outlets.ts`
- Use `normalizeOutletId()` to convert names to IDs
- Unknown outlets get ID `UNKNOWN` and tier 3

### Review IDs
Format: `{showId}--{outletId}--{criticSlug}`

Examples:
- `two-strangers-bway-2025--NYT--laura-collins-hughes`
- `hamilton-2015--VULT--jesse-green`
- `wicked-2003--THR--unknown`

Rules:
- Use double-dash `--` as separator (allows single dashes in slugs)
- Use `unknown` for critic slug when name not available
- Use `generateReviewId()` from `src/types/canonical.ts`

### Review Source IDs
Format: `{source}--{sourceKey}`

Examples:
- `dtli--two-strangers`
- `show-score--two-strangers-carry-a-cake-across-new-york`
- `bww--two-strangers-carry-a-cake-across-new-york`

Rules:
- Source is one of: `dtli`, `show-score`, `bww`, `manual`
- Source key is the aggregator's own identifier for the show

### Review Text IDs
Format: `{reviewId}--{textSource}`

Examples:
- `two-strangers-bway-2025--NYT--laura-collins-hughes--scraped`
- `hamilton-2015--VULT--jesse-green--webfetch`

Rules:
- Text source is one of: `scraped`, `webfetch`, `manual`, `excerpt-only`

## Directory Structure

```
data/
├── shows.json                    # Show metadata (source of truth)
├── reviews.json                  # Legacy reviews (being migrated)
│
├── reviews/
│   └── by-show/
│       └── {showId}.json         # Canonical reviews per show
│
├── review-sources/
│   ├── dtli/
│   │   └── {showId}.json         # Did They Like It data
│   ├── show-score/
│   │   └── {showId}.json         # Show Score data
│   └── bww/
│       └── {showId}.json         # BroadwayWorld roundup data
│
├── review-texts/
│   └── {showId}/
│       └── {outletId}--{critic}.json   # Full text per review
│
├── llm-scores/
│   └── {showId}.json             # LLM sentiment analysis
│
├── aggregator-archive/
│   ├── dtli/                     # Archived DTLI HTML pages
│   ├── show-score/               # Archived Show Score HTML pages
│   └── bww-roundups/             # Archived BWW roundup pages
│
└── audit/
    ├── reconciliation/           # Cross-source reconciliation reports
    ├── validation/               # Data validation reports
    └── reports/                  # Summary reports
```

## File Ownership by Session

Different automation sessions own different data directories:

| Directory | Owner Session | Description |
|-----------|--------------|-------------|
| `data/shows.json` | update-show-status | Show metadata |
| `data/reviews/by-show/` | review-reconciliation | Canonical reviews |
| `data/review-sources/dtli/` | dtli-scraper | DTLI aggregator data |
| `data/review-sources/show-score/` | show-score-scraper | Show Score data |
| `data/review-sources/bww/` | bww-scraper | BWW roundup data |
| `data/review-texts/` | text-scraper | Full review text |
| `data/llm-scores/` | llm-scorer | Sentiment analysis |
| `data/audit/` | reconciliation | Audit reports |

## Type Imports

Always import types from the canonical source:

```typescript
// CORRECT
import type { Show, Review, Outlet } from '@/types/canonical';
import { slugify, generateReviewId } from '@/types/canonical';
import { getOutletById, findOutletByName } from '@/config/outlets';
import { getScoreBucket, getScoreLabel } from '@/config/score-buckets';

// INCORRECT - don't import from engine.ts or other files
import type { RawShow } from '@/lib/engine';  // NO
```

## JSON File Format

All JSON data files should include metadata:

```json
{
  "_meta": {
    "description": "Brief description of this file's contents",
    "lastUpdated": "2026-01-24T12:00:00Z",
    "source": "script-name or session-name",
    "version": "1.0"
  },
  "data": {
    // Actual data here
  }
}
```

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `review-texts.ts` |
| Directories | kebab-case | `by-show/` |
| Components | PascalCase | `ScoreBadge` |
| Functions | camelCase | `getScoreBucket` |
| Constants | SCREAMING_SNAKE | `MIN_REVIEWS_FOR_SCORE` |
| Interfaces | PascalCase | `Review`, `Show` |
| Type aliases | PascalCase | `ScoreBucket` |

## Validation Rules

1. **Show IDs**: Must match pattern `^[a-z0-9-]+-\d{4}$`
2. **Outlet IDs**: Must be uppercase, 2-10 characters
3. **Review IDs**: Must contain exactly two `--` separators
4. **Scores**: Must be integers 0-100 or null
5. **Dates**: ISO 8601 format for timestamps, descriptive for publish dates
6. **URLs**: Must be valid, start with `https://`

## Migration Notes

The project is migrating from:
- `data/reviews.json` → `data/reviews/by-show/{showId}.json`
- `data/review-texts/{showId}/` → same location, new schema
- Old interfaces in `engine.ts` → canonical types in `src/types/canonical.ts`

During migration, both old and new formats may coexist. The scoring engine reads from both.
