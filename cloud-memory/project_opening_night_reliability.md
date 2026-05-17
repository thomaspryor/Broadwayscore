---
name: Opening Night Reliability Plan
description: SERP deferral, RSS expansion, URL paste mode — shipped 2026-04-02. Sprint 3 (quarantine) cancelled as redundant.
type: project
archived: true
---

Opening night review gathering fixed via 3 changes (2026-04-02):

1. **3 RSS feeds added** (NY Post, IndieWire, Rolling Stone) — 17→20 feeds in rss-discovery.js
2. **SERP deferred for first 4 orchestrator iterations** (~80 min) — opening-night-orchestrator.yml uses iteration count to skip SERP early, then enables it. gather-reviews.yml gets aggregators_only mode for midnight dispatch.
3. **URL paste mode** (ingest-urls.js + ingest-urls.yml) — break-glass fallback: paste URLs into a file, system auto-detects outlets, fetches text, creates review files, triggers scoring/rebuild.

**Why:** SERP on opening night returns wrong URLs (Google hasn't indexed reviews yet). Layers 1-3 (aggregators + RSS + site-search) cover 26/34 T1/T2 outlets and reach BROADCAST READY without SERP (verified on DDA: 56 reviews, EBT: 43 reviews).

**Sprint 3 (quarantine gate) was cancelled** — createReviewFile() in gather-reviews.js already has 12 validation guards. Adding another layer would be redundant.

**How to apply:** On next opening night, verify SERP deferral logs show "SERP deferred (iteration N <= 4)" for early iterations. If reviews are still wrong, the URL paste mode is the manual fallback.

Sprint plan file: `sprint-plan-opening-night-reliability.md`
