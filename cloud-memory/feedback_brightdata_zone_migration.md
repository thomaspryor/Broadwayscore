---
name: BD zone migrated to web_unlocker2 — mcp_unlocker is dead trial
description: Zone defaults updated 2026-04-25 after false alarm on the obsolete trial zone
type: feedback
originSessionId: efa2a933-8f2d-45b1-97e1-a6a40e255001
---
# BD zone migration

`mcp_unlocker` is an **obsolete trial zone** (disabled when trial limit reached, before 2026-04-25). The project migrated to **`web_unlocker2`** as the canonical paid zone.

`BRIGHTDATA_ZONE` is set to `web_unlocker2` in:
- Local `.env`
- GitHub Secret `BRIGHTDATA_ZONE`
- Default fallback in `scripts/lib/scraper.js` and `scripts/check-secrets-health.js`

Account has 3 additional paid unblocker zones for backup: `web_unlocker_mnewmsyo`, `web_unlocker_mngwkvlo`, `web_unlocker_mnn80138`. To swap: `printf 'NEW_ZONE_NAME' | gh secret set BRIGHTDATA_ZONE`.

**Why:** A 2026-04-25 session sounded a false "BD disabled" alarm based on stale CLAUDE.md §14.7 instructions. The check was reading `mcp_unlocker` directly instead of `${BRIGHTDATA_ZONE:-web_unlocker2}`.

**How to apply:** Always check via `${BRIGHTDATA_ZONE:-web_unlocker2}`, never hardcode `mcp_unlocker`.

**Files updated:**
- `CLAUDE.md` §14.7 — curl command now uses `${BRIGHTDATA_ZONE:-web_unlocker2}` + explicit note about trial zone false alarm
- `scripts/check-secrets-health.js` line ~214 — fallback changed from `mcp_unlocker` → `web_unlocker2`
- `scripts/lib/scraper.js` line ~16 (docblock) + ~140 (const) — same fallback fix
