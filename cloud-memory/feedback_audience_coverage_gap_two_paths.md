---
name: audience-coverage-gap-two-paths
description: "Open-show audience coverage-gap alerts — override vs CONFIRMED_NON_MATCHES; cross-market title collision means non-match, never override"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f9313ab6-66f2-4bde-b22a-9b7914d70935
  modified: 2026-08-01T07:59:17.565Z
---

The "Audience coverage: open-show gaps" health check names only the override knob (THEATR_OVERRIDES / MEZZANINE_OVERRIDES), but there are two resolution paths:

1. **Override** — the source really has data for OUR production and the matcher missed it (title drift). Add the override, re-run the scraper.
2. **Confirmed non-match** — the source entry is a *different production* of the same title. Add `CONFIRMED_NON_MATCHES` entry in `scripts/lib/audience-coverage-gaps.js`, key `source|normalized name|ourShowId` via `nonMatchKey()`. No scraper re-run needed — health-check reads the lib directly.

**Why:** Theatr/Mezzanine are NYC-only sources. If the flagged `ourShowId` is a London-market show (`west-end`/`off-west-end`), the source entry is an NYC staging → always path 2. Overriding would attach wrong-production audience ratings (production-specific data). Precedent: Archduke (`aae247ceaf9`); The Jonathan Larson Project (NYC OB 2025 vs. London Southwark 2026).

**How to apply:** Check the audit entry's `eventCategory` + our show's `category` first. Cross-market collision → non-match entry + test case in `tests/unit/audience-coverage-gaps.test.mjs`. Also: `data/audit/{theatr,mezzanine}-coverage.json` only regenerate on FULL scheduled runs (weekly cron), not `--show` dispatches — a stale `lastUpdated` usually means the weekly run's public-repo commit step failed, not a dead scraper.

Related: [[feedback_returning_production_priorRuns]]
