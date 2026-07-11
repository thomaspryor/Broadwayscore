---
name: regional-expansion-watchlist
description: "Priority US regional theatres + shows to track for the 'regional' category (Broadway-transfer pipeline), from user's weekly tracker 2026-06-22"
metadata: 
  node_type: memory
  type: project
  originSessionId: da874463-1429-49e2-ac1c-6541d787ab25
---

User's curated priority order for `regional` category coverage (highest % of future Broadway-relevant critical discourse). Track reviews from these theatres first:

1. **American Repertory Theater (A.R.T.)** — Cambridge MA. Strongest pipeline. Recent transfers: Gatsby: An American Myth, Real Women Have Curves, Two Strangers (Carry a Cake Across New York), Black Swan, Wonder. **Current watch: Black Swan (DONE — shipped 2026-06-22), Wonder (Sarah Ruhl adaptation).**
2. **La Jolla Playhouse** — San Diego. Most productive transfer factory: The Outsiders, Redwood, Lempicka, Come From Away, Jersey Boys.
3. **Goodman Theatre** — Chicago. Play-heavy; major playwrights, prestige dramas, star vehicles → Best Play contenders.
4. **Steppenwolf** — Chicago. New plays; Pulitzer contenders, critical darlings.
5. **Arena Stage** — DC. Commercial musicals, politically themed work, adaptations. (e.g. CrazySexyCool – The TLC Musical, summer 2026 world premiere.)
6. **Shakespeare Theatre Company** — DC. Star-driven revivals, prestige.
7. **American Conservatory Theater (ACT)** — San Francisco. Less consistent feeder, but Broadway-aspiring projects: **The Bad News Bears: The Musical** (Paramount + commercial producers attached, explicit Broadway hopes).

**Shows flagged "watching right now" (2026-06-22):** Black Swan (ART, DONE), Wonder (ART), The Bad News Bears (ACT SF). **Shipped 2026-07-08:** CrazySexyCool: The TLC Musical (Arena Stage, 77/100) + Iceboy! (Goodman, 76/100, Mullally/Offerman).

**Selection rule:** only add when a show has a published review roundup / ≥3 pro reviews (the roundup existing = enough critic coverage to score). Build steps: [[regional-show-add-runbook]].

**FULLY AUTOMATED as of 2026-07-08** (user rule: a roundup page IS the go-live signal — CLAUDE.md §3 exception): Playbill "The Verdict" DOES cover regional shows (CrazySexyCool + Iceboy verdicts, 2026-07 — the old "NYC-only" claim is wrong). The chain: PV/BWW scrapers → unmatched audit → extract-aggregator-candidates.js (DAILY in scrape-new-aggregators.yml — the SOLE owner; removed from audit-cross-production-weekly) → feeder venues (REGIONAL_FEEDER_VENUE_RE in scripts/lib/aggregator-candidate-extract.js) classify category 'regional' → promote-ob-venue-candidates.js --regional-only AUTO-ADDS the show to shows.json (buildRegionalShowEntry: -regional- id, market regional, status open, openingDate = roundup date, feeder city from REGIONAL_FEEDER_VENUES table) → validate-data gates the push (sentinel + staging rollback + failure email) → same-run targeted PV+BWW re-scrape ingests reviews → rebuild/deploy. Owner gets a go-live email; IMAGES now auto-source too (2026-07-11: fetch-show-images-auto.js regional branch — venue-domain SERP og:image, BWW-roundup-archive fallback, sharp-cropped locally, Gemini-verified, skip-if-exists unless --force). Still manual: cast/creative, exact dates, audience scrapers (runbook step 5). TRANSFER LINKS live (transferOf/transferredTo reciprocal pair, validate-data enforced, both show pages cross-link with threshold-gated tryout score; first pair little-bear-ridge-road-2025 ↔ Steppenwolf 2024 tryout, 89/100 from 6 reviews incl. WSJ+Jones ingested via --roundup-url). content-filters isNotBroadway has allowRegional (feeder-venue phrases + 'world premiere' + 'in chicago' otherwise blacklist regional articles); collisionSlugSet strips -regional-/-off-broadway- suffixes so promoted shows don't re-stage daily. Once a regional show IS in shows.json, PV/BWW verdict articles match it (high confidence via slug) and reviews auto-ingest; manual entries win over pipeline versions at rebuild. Gotcha fixed 2026-07-08: "iceboy-in-chicago" slug matched musical CHICAGO — location-preposition guard in show-matching.js now rejects single-token matches appearing only after in-/at-.
