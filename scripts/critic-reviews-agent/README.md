# Broadway Critic Reviews Agent

A data agent for fetching, normalizing, and managing critic reviews for Broadway shows.

## ⚠️ Important: Use Claude Code Integration

**Direct web scraping gets 403 blocked by most review sites.**

The recommended workflow is to use **Claude Code's WebSearch capability** to find and verify reviews. See [WORKFLOW.md](./WORKFLOW.md) for the step-by-step process.

## Features

- **Rating Normalization**: Converts various rating formats (stars, letters, buckets) to 0-100 scale
- **Validation**: Ensures bucket/thumb consistency with scores
- **Deduplication**: Identifies and merges duplicate reviews from different sources
- **Consistency**: Running twice produces identical results (idempotent)
- **Manual Entry Support**: Add reviews that can't be automatically fetched
- **DTLI Cross-Check**: Validate review counts against Did They Like It

## Quick Start

### Recommended: Claude Code Integration

Ask Claude Code to collect reviews:
```
"Collect reviews for [Show Name]. Cross-check against Did They Like It for accuracy."
```

Claude Code will:
1. Search for the show's review roundup
2. Find each outlet's review with actual star/letter ratings
3. Convert to 0-100 scores
4. Validate against DTLI's counts
5. Add to reviews.json

### Validate Existing Data

```bash
# Validate a show's reviews
npx ts-node scripts/critic-reviews-agent/validate.ts bug-2025

# Generate coverage report
npm run reviews:report
```

## Command Reference

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
| `--search` | **Use search API** instead of direct scraping (recommended) |
| `--search-provider` | Search provider: `serpapi` (default) or `brave` |
| `--comprehensive, -c` | Search all configured outlets + web search |
| `--sources <list>` | Comma-separated sources: `broadwayworld,didtheylikeit,showscore` |
| `--manual <file>` | JSON file with manual review entries |
| `--verbose, -v` | Enable detailed logging |
| `--dry-run, -n` | Preview changes without writing files |
| `--help, -h` | Show help message |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SERPAPI_KEY` | API key for [SerpAPI](https://serpapi.com) - Google search results |
| `BRAVE_API_KEY` | API key for [Brave Search API](https://brave.com/search/api) |

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
├── index.ts          # CLI entry point
├── types.ts          # TypeScript type definitions
├── config.ts         # Outlets, tiers, normalization rules
├── normalizer.ts     # Rating conversion logic
├── deduper.ts        # Deduplication & merging
├── fetchers.ts       # Direct web scraping utilities
├── search-fetcher.ts # Search API integration (SerpAPI, Brave)
└── README.md         # This file
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
