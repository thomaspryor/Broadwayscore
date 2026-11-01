# BRO-6710 state
Done: scripts/uk-serp-sweep.js (+lib, test). Pass 1 (98 URLs/48 shows) ingested+scored+rebuilt: UK scoreable 229->252 (77%), reviews 1315->1370.
Pass 2 (--deep, 56 URLs/28 shows, plan data/audit/bro-6710-plan-b.json) ingested, scoring dispatched 09:00 EST; rebuild follows.
Next: node scripts/uk-regional-coverage.js (after rebuild lands); rerun node scripts/uk-serp-sweep.js --deep --plan=... for shows still below.
Acceptance cmd verify-data-backfill.js --show=329 is invalid (329 is a count, not a show id).
