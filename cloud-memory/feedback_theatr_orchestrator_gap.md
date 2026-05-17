---
name: Theatr scraper missing from opening-night orchestrator
description: Opening-night orchestrator + previews→open transition must dispatch update-theatr alongside Mezzanine/ShowScore/Reddit
type: feedback
originSessionId: f92fe8b2-d15d-4d53-9af6-06a1dd9d85c4
archived: true
---
The opening-night-orchestrator originally dispatched Mezzanine, Reddit, ShowScore, and Broadway.com on opening night — but **never Theatr**. Same gap existed in `update-show-status.yml` previews→open transition. Result: Theatr only refreshed on its weekly Sunday cron, so opening-night data was always at least a few days stale.

**Why:** Theatr was added later than the other audience scrapers and the orchestrator wiring was missed. Discovered 2026-04-10 when Death of a Salesman shipped showing "1 vote / 100%" Theatr (a relic from a single voter during early previews that the weekly cron never refreshed because the refresh token had also expired ~Mar 30).

**How to apply:**
- Whenever a new audience scraper is added, wire it into BOTH `opening-night-orchestrator.yml` (audience scrapers section) AND `update-show-status.yml` (previews→open dispatch jobs) — not just the weekly cron.
- Theatr is Broadway/OB only (no WE coverage) — gate dispatch on `MARKET != west-end`.
- When debugging stale audience source data, always check BOTH the source workflow's last successful run AND whether the orchestrator dispatches it on opening night.
