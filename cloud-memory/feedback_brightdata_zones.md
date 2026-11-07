---
name: feedback_brightdata_zones
description: Bright Data zone management — auto-recovery, trial limits, zone creation via API
type: feedback
archived: true
---

Bright Data zone trial limits can't be cleared — create a new zone instead.

**Why:** mcp_unlocker hit its free trial limit. The UI "Recover" button doesn't exist for trial-limited zones (only Statistics and Delete in the menu). The "Disabled" toggle on the zone page is misleading — it shows "Zone is already active" but the zone is still blocked by the trial limit (`plan.disable: "trial limit reached"`).

**How to apply:**
- `check-secrets-health.js` now auto-recovers: detects `data.plan.disable`, creates a new Web Unlocker zone via API, and updates the `BRIGHTDATA_ZONE` GitHub secret. No manual intervention needed.
- Current zone: `web_unlocker2` (created 2026-03-31 after mcp_unlocker trial expired)
- Zone name is read from `BRIGHTDATA_ZONE` env var (default fallback: `mcp_unlocker` in scraper.js)
- To create a zone manually via API: `curl -X POST https://api.brightdata.com/zone -H "Authorization: Bearer $BRIGHTDATA_TOKEN" -H "Content-Type: application/json" -d '{"zone":{"name":"web_unlocker3"},"plan":{"type":"unblocker","product":"unblocker"}}'`
- Detection bug fixed: the disable field is at `data.plan.disable`, NOT `data.disable`
- API token must have **Admin** role to create zones
