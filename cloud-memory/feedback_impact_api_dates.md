---
name: Impact API date format
description: Impact API rejects ISO dates with milliseconds — must strip .xxxZ to clean Z format
type: feedback
archived: true
---

Impact API returns "Parameter 'StartDate' has invalid value" when ISO dates include milliseconds (e.g. `2026-03-29T19:03:01.337Z`). Must strip to `2026-03-29T19:03:01Z`.

**Why:** Node's `.toISOString()` always includes 3 decimal places. `curl` with manually typed dates doesn't have this issue, so the bug only manifests in scripts.

**How to apply:** In any script calling Impact API, use `.replace(/\.\d{3}Z$/, 'Z')` on ISO date strings. See `scripts/affiliate-report.js` for the pattern.

Also: Partnerize publisher_id (1101l422775) is different from user_id (1101l414795). Reporting endpoints require the publisher_id, found on Partner Details page in the dashboard.
