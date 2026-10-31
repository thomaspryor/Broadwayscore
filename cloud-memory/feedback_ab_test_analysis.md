---
name: A/B test analysis methodology
description: How to correctly analyze ticket A/B test results in PostHog — filtering, statistical significance, what to exclude
type: feedback
originSessionId: 2b6dce24-d199-4c32-be96-75b023a9c0d6
archived: true
---
A/B tests on ticket buttons are tracked via PostHog `ticket_click` events with `ab_variant` property. To analyze correctly, future sessions MUST apply these filters or results will be wrong.

## Active flags
- `ticket-primary-platform` — locked 100% to `todaytix` (challenger killed Apr 10)
- `ticket-single-button` — 50/50 `multi` vs `single` (active)

## Correct filter for analysis
```
event = ticket_click
AND properties.page_type = 'show'
AND properties.ab_variant LIKE 'platform:%,buttons:%'
AND properties.ab_variant NOT LIKE '%buttons:fallback%'
AND properties.ab_variant NOT LIKE '%platform:fallback%'
```

## What to exclude (and why)
- **page_type != 'show'**: ShowtimesCard, compare page, guides all fire `ticket_click` events but DON'T go through TicketButtonsAB. They have no ab_variant. Including them inflates "no variant" noise.
- **ab_variant = null**: Pre-deploy events from before the test was wired up (Apr 5-10).
- **ab_variant LIKE '%fallback%'**: Users with ad blockers or PostHog opt-out. The component falls back to default render after 5s and tags the variant as "fallback" so we can exclude.
- **Old format ab_variants** (`"todaytix"`, `"stubhub"` alone, no `platform:` prefix): Pre-Apr 10 events from the original platform-only test.

## How to compute the metric
For each variant (`buttons:single` vs `buttons:multi`):
1. Count unique users in variant: `COUNT DISTINCT distinct_id`
2. Count clicks per user: `COUNT(*) / unique_users`
3. Count conversions from Impact API (TodayTix sales) and join by date
4. CTR = clicks / unique_users
5. Conversion rate per click = conversions / clicks (must come from Impact API)
6. Revenue per user = (clicks/user) × (conv rate) × ($1.72 avg commission)

## Statistical significance
At ~30 ticket clicks/day, 50/50 split = 15 per variant per day.
- 50% relative lift detection: ~100 clicks per variant → **8 days minimum**
- 30% relative lift: ~200 → **15 days**
- 20% relative lift: ~400 → **30 days**

Use Fisher's exact test or two-proportion z-test on conversions, NOT just clicks.

## Scripts for analysis
- `scripts/analyze-ab-test.js` — pulls PostHog events + applies correct filters + computes per-variant metrics
- `scripts/affiliate-report.js` — weekly digest, includes A/B test breakdown with correct filters
- Both run in CI via `.github/workflows/weekly-affiliate-report.yml`

## Decision criteria
- **Kill a variant** if: 0 conversions over 50+ clicks while control has ≥3 conversions
- **Declare winner** if: p < 0.05 on conversions OR ≥30% lift in clicks-to-conversion with ≥100 clicks per variant
- **Continue running** if: <100 clicks per variant OR no clear directional signal

## Past results
- **Test 1 (Apr 5-10): TodayTix vs StubHub primary** — TodayTix won 5-0 in conversions over 8 days. Locked to 100% TodayTix. StubHub resale prices killed conversion.
