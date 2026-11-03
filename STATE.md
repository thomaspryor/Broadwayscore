# BRO-6428 state (2026-11-03 ~14:40Z)
## Done
- 2013-14 and 2012-13 are already listed and promoted (completeness 0.85/0.93). Gap is supply only.
- Audit baseline: 2013-14 displayable 0.65 (16 shows below 5 reviews), 2012-13 displayable 0.25 (36 below).
- Dispatched gather-reviews (spend_purpose=historical-backfill, 10 shards x <=2 shows) for the 16 shortfall 2013-14 shows: run 41641643375, all 10 gather shards + aggregator scrape succeeded; its inline rebuild was cancelled. Dispatched rebuild-fast, then gather for the first 20 of the 36 2012-13 shortfall shows.
## Remaining
1. git pull data; `node scripts/audit-we-historical-season.js --season=2013-2014` (collect-review-texts + llm-ensemble-score drain; dispatch if reviews are unscored/unfetched).
2. Gather the other 16 2012-13 shows (list = shows in the audit with displayable=false not in the first 20), then TR (review-refresh.yml tr_show_filter; pre-2015 TR is scanned PDF, OCR path not built), fetch-guardian-reviews.yml shows=..., scrape-whatsonstage.js.
3. Score (llm-ensemble-score.yml sync), rebuild, fact-check sample (fact-check-historical-sample.js --cohort=we-historical --season=S --n=30).
4. Note: acceptance cmd `verify-data-backfill.js --show=2013-2014,2012-2013` checks show IDs and cannot pass (no such ids); the real gate is audit-we-historical-season.js.
5. Record spend vs BRO-6268.
