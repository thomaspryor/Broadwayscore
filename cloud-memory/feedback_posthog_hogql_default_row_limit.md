---
name: posthog-hogql-default-row-limit
description: "PostHog's HogQL query API silently caps GROUP BY result rows at ~100 with no LIMIT clause — always add an explicit high LIMIT to any multi-row hogql() query on a high-cardinality column"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5696472e-8025-4b07-b4e0-65d26daa8c01
  modified: 2026-08-26T19:36:14.079Z
---

Any HogQL query sent via `POST /api/projects/{id}/query/` that returns multiple rows (i.e. anything with `GROUP BY`) gets silently capped at ~100 rows if the query has no explicit `LIMIT`. `count(DISTINCT ...)` scalar-aggregate queries (a single row) are NOT affected — only row-returning queries.

**Why this matters:** `scripts/analyze-gate-cold-start.js` reported 0.00% captures/exposed in both arms of a live A/B experiment for 5+ weeks. The real cause: its `GROUP BY person_id` exposure query and `GROUP BY person_id, event` modal-events query were both silently truncated to ~100 rows against a true population of ~21,000+ people. Confirmed by re-running the identical query with an explicit `LIMIT 100000`: row count jumped from 100 to 21,234. Took 6 rounds of live diagnostics to isolate (2026-08-26) — ruled out REAL_USERS filtering, person_profiles:'identified_only' person-merge issues, and distinct_id-vs-person_id grouping before finding the actual cause, because every hypothesis kept "confirming" against the same silently-capped ~100-row ceiling.

**How to apply:** any `hogql()`/HogQL query with `GROUP BY` on a column whose true cardinality could plausibly exceed 100 (person_id, distinct_id, any per-user dimension) MUST have an explicit `LIMIT` well above the realistic ceiling (e.g. `LIMIT 1000000`). `GROUP BY` on genuinely low-cardinality columns (event name, trigger type, a small enum) is safe without one, since the true result count is already well under 100 — don't add noise there. When debugging a HogQL query that returns a suspiciously round/small/stable row count regardless of the WHERE clause, suspect this cap FIRST before chasing attribution/join logic.

Fixed in: `scripts/analyze-gate-cold-start.js`, `scripts/analyze-email-gate-funnel.js` (2026-08-26). Checked all other hogql()-pattern scripts same day — only 3 total in the codebase, the other 2 (`scripts/diagnose-gate-cold-start-join.js`'s remaining ungrouped queries) already safe (low-cardinality GROUP BY columns).
