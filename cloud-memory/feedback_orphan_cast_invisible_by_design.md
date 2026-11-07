---
name: orphan-cast-invisible-by-design
description: "Cast members without ibdbPersonId are intentionally skipped at manifest build — they don't render on /show/[slug]. Don't \"fix\" by surfacing them without first cleaning upstream contamination."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ac76a05e-1b22-4ee5-9411-ec675bcd9542
---

Cast members in `data/cast/*.json` that lack `ibdbPersonId` are skipped at `scripts/build-cast-manifest.js:50` (`if (!member.ibdbPersonId) continue`) and at `scripts/build-actor-slugs-manifest.js:48`. Effect: they're invisible on `/show/[slug]` Cast sections — NOT non-clickable, not displayed at all. The fallback `<span>` branch in `src/components/CastSection.tsx` for "has IBDB but no slug" is dead code in the current pipeline (40,688 / 40,688 manifest entries have clickable profiles).

**Why:** West End and Off-Broadway scrapers often write cast rows without IBDB IDs because the actors have no Broadway history (IBDB only tracks Broadway). The skip is a quality gate — better to hide a row than display a non-clickable name without provenance. Also: a non-trivial subset of orphan files contain **contamination** (wrong show entirely, or wrong field — e.g. kavalier-and-clay-off-broadway-2025 has Met Opera singers; much-ado-globe-west-end-2026 has TV-show titles in the role field). Surfacing orphans without cleanup would ship that contamination.

**How to apply:**
- If asked to "make cast member X clickable" or "fix invisible cast", first check whether the row has `ibdbPersonId`. If not, the row is correctly hidden — explain the design rather than removing the gate.
- Don't add a synthetic-ID scheme or surface-orphans change without first cleaning the contamination cases. Survey of 8 high-orphan shows (2026-05-23) found ~5-10% of orphans are bad data (wrong cast, wrong role field, name-swap typos).
- Of the legitimately-missing orphans (~80% of the 359 surveyed), ~15% are IBDB-back-fillable (actor IS in IBDB, scraper missed match — Samuel Barnett, Caroline Sheen examples). Back-fill is the right next step, NOT synthetic IDs.
- See [[notion-brain-workflow]] cards `369637c5-416f-8103-ba73-f958627f3a5e` (parent, Done) and follow-ups `…810b…` (kavalier-clay), `…8118…` (much-ado), `…81ce…` (pride), `…812f…` (back-fill).
