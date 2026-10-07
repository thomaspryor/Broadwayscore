---
name: WE press night vs preview date sourcing
description: "TodayTix startDate is first preview; openingDateSource tracks provenance."
type: feedback
archived: true
---

TodayTix startDate for WE shows is the first preview, NOT press night. These are often weeks apart.

**Why:** 63 WE shows (29%) had openingDate === previewsStartDate because TodayTix dates were stored as opening dates. This caused the orchestrator to fire on preview night instead of press night, missing the 12-24hr review window.

**How to apply:**
- `openingDateSource` field tracks where openingDate came from: ibdb, theatremonkey, playbill, showscore, todaytix, manual, unknown
- Orchestrator only fires for WE (not OWE) shows with trusted sources (theatremonkey, playbill, ibdb, manual)
- OWE shows bypass the source check — they often open cold
- Daily 7 AM UTC enrichment cron runs `--fix-unconfirmed` to correct todaytix/showscore sources from Theatremonkey
- Weekly Thursday 8 AM UTC cron does full enrichment for newly announced shows
- TM and Playbill don't cover OWE venues (Hampstead, Riverside Studios, etc.) — only WE proper
- `enrich-west-end-dates.js` uses bare fetch() which gets TLS-blocked locally; only works in CI
- The `--show` flag on the enrichment script is broken for TM matching (filters weShows before passing to matcher) — use full runs instead
- Not all WE shows have distinct press nights — some open cold. The CONFIRM path upgrades source when TM confirms same date.
