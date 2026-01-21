# Broadway Critic Reviews Agent

A data agent for fetching, normalizing, and managing critic reviews for Broadway shows.

## Features

- **Multi-Source Fetching**: Pulls reviews from BroadwayWorld, DidTheyLikeIt, Show-Score
- **Rating Normalization**: Converts various rating formats (stars, letters, buckets) to 0-100 scale
- **Deduplication**: Identifies and merges duplicate reviews from different sources
- **Consistency**: Running twice produces identical results (idempotent)
- **Manual Entry Support**: Add reviews that can't be automatically fetched

## Quick Start

```bash
# Generate a report of current data
npm run reviews:report

# Fetch reviews for a specific show
npm run reviews:fetch -- --show two-strangers-bway-2025

# Fetch for all open shows
npm run reviews:all

# Dry run (preview changes without writing)
npm run reviews:fetch -- --show cabaret-2024 --dry-run --verbose
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run reviews:report` | Generate a data coverage report |
| `npm run reviews:fetch -- --show <id>` | Fetch reviews for one show |
| `npm run reviews:all` | Fetch reviews for all open shows |
| `npm run reviews:fetch -- --manual <file>` | Import manual review entries |

## Options

| Flag | Description |
|------|-------------|
| `--show, -s <id>` | Process a specific show by ID or slug |
| `--all, -a` | Process all shows with status "open" |
| `--report, -r` | Generate report only, no fetching |
| `--sources <list>` | Comma-separated sources: `broadwayworld,didtheylikeit,showscore` |
| `--manual <file>` | JSON file with manual review entries |
| `--verbose, -v` | Enable detailed logging |
| `--dry-run, -n` | Preview changes without writing files |
| `--help, -h` | Show help message |

## Rating Normalization

The agent converts various rating formats to a 0-100 scale:

### Star Ratings
- `5/5` → 100
- `4/5` → 80
- `3.5/5` → 70
- `3/4` → 75

### Letter Grades
- `A+` → 98, `A` → 95, `A-` → 91
- `B+` → 87, `B` → 83, `B-` → 79
- `C+` → 75, `C` → 71, `C-` → 67
- `D` → 59, `F` → 40

### Text Buckets
- `Rave` → 92
- `Positive` → 80
- `Mixed` → 60
- `Pan` → 25

### Score → Bucket/Thumb Derivation
| Score Range | Bucket | Thumb |
|-------------|--------|-------|
| 85-100 | Rave | Up |
| 70-84 | Positive | Up |
| 50-69 | Mixed | Flat |
| 0-49 | Pan | Down |

## Manual Data Entry

For reviews that can't be automatically fetched, create a JSON file:

```json
{
  "reviews": [
    {
      "showId": "two-strangers-bway-2025",
      "outlet": "Variety",
      "criticName": "Frank Rizzo",
      "url": "https://variety.com/...",
      "publishDate": "2025-11-20",
      "rating": "Positive",
      "pullQuote": "A delightful evening of theater."
    },
    {
      "showId": "cabaret-2024",
      "outlet": "The Guardian",
      "criticName": "Alexis Soloski",
      "url": "https://theguardian.com/...",
      "publishDate": "2024-04-21",
      "rating": "5/5",
      "assignedScore": 95
    }
  ]
}
```

Then import:
```bash
npm run reviews:fetch -- --manual data/manual-reviews.json
```

### Manual Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `showId` | Yes | ID from shows.json |
| `outlet` | Yes | Outlet name (matched to config) |
| `criticName` | No | Critic's name |
| `url` | No | Review URL |
| `publishDate` | No | YYYY-MM-DD format |
| `rating` | No | Original rating (stars, letter, bucket) |
| `assignedScore` | No | Override: explicit 0-100 score |
| `pullQuote` | No | Key quote from review |
| `designation` | No | `Critics_Pick`, `Critics_Choice`, `Recommended` |

## Outlet Configuration

Outlets are organized into three tiers based on influence:

### Tier 1 (Weight: 1.0)
Major national publications:
- NYT, WASHPOST, LATIMES, WSJ
- VARIETY, THR, VULT
- GUARDIAN, TIMEOUTNY
- BWAYNEWS

### Tier 2 (Weight: 0.85)
Regional/trade publications:
- NYP, NYDN, WRAP, EW
- TMAN, THLY, NYTG, NYSR
- TDB, DEADLINE, INDIEWIRE

### Tier 3 (Weight: 0.70)
Smaller outlets:
- BWW, CITI, CSCE, OMC
- FRONTMEZZ, THERECS, TALKIN
- PLAYBILL

## Architecture

```
scripts/critic-reviews-agent/
├── index.ts        # CLI entry point
├── types.ts        # TypeScript type definitions
├── config.ts       # Outlets, tiers, normalization rules
├── normalizer.ts   # Rating conversion logic
├── deduper.ts      # Deduplication & merging
├── fetchers.ts     # Web scraping utilities
└── README.md       # This file
```

## Output

The agent writes to:
- `data/reviews.json` - Updated reviews data
- `data/agent-output/run-<timestamp>.json` - Run logs for auditing

## Consistency Guarantees

1. **Deterministic**: Same inputs always produce same outputs
2. **Sorted Output**: Reviews sorted by showId, outletId, criticName
3. **Deduplication**: Based on URL match > outlet+critic > outlet-only
4. **Merge Strategy**: Prefers reviews with URLs, critic names, and pull quotes
5. **Validation**: Checks bucket/thumb consistency with scores

## Troubleshooting

### "Unknown outlet" warning
Add the outlet to `config.ts` with appropriate tier and format.

### Validation errors
Check that bucket/thumb match the score using the derivation table above.

### Fetch failures
Web scraping may fail if:
- Site structure changed (update parsers in `fetchers.ts`)
- Rate limiting (retry with delays)
- Network issues (retry automatically)

Use `--manual` for reliable data entry when scraping fails.
