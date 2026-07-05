---
name: feedback_discovery_pipeline_silent_gates
description: "Review discovery has independent silent gates keyed off openingDate/title/byline; a show \"with no reviews\" usually means a gate dropped them, not that scrapers failed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dab9e266-2c1f-4178-9dc7-ce1d9fd541d8
---

When a show has missing reviews that are trivially Googleable, the scrapers are almost never the cause — a **gate** silently dropped the show or its reviews. 2026-06-15: "A Life in Four Seasons" (2/7) and "Are You Now Or Have You Ever Been?" (0/3) exposed three distinct gates, all now fixed.

**Why:** the pipeline is discover → collect text → score → rebuild, and EACH stage has filters that fail independently and silently. Diagnose by walking the stages, not by re-running scrapers.

**How to apply — check these gates in order when reviews are missing:**
1. **Did the dedicated poller even run?** `opening-night-orchestrator.yml` selection excluded WE shows with untrusted `openingDateSource` (todaytix) and ANY show with null `openingDate` (`if(!s.openingDate) return false`). OB/OWE open "cold" with null openingDate → invisible. Fix shipped: WE untrusted-source polls once `status==='open'`; OB/OWE fall back to `previewsStartDate`. If a show isn't in the orchestrator's poll list, the 5-aggregator + SERP + site-search breadth never ran.
2. **SERP outlet gate** (`gather-reviews.js` ~L4605): for WE shows only `region==='london'`/dual outlets are searched. A UK outlet missing `region` in `outlet-registry.json` is silently skipped (plays-to-see/theatre-vibe). Dual-repo: fix public + `~/broadway-scorecard-data`.
3. **url_content_mismatch FP on long titles** (`content-quality.js validateContentMentionsShow`): required title ≥3× in body; a 7-word title never repeats and a trailing "?" breaks matching. Fix: guarded headline-lead `<title>` signal + body long-phrase threshold-lowering. Long titles live in the headline, not body prose.
4. **The scorer reads reviews.json, not review-texts.** A new prose review with no aggregator star/percent score must be put into reviews.json by a **rebuild first** (shows as "awaiting"), THEN the LLM scorer finds it. Sequence to surface a recovered prose review: rebuild → score → rebuild → deploy. Skipping the first rebuild = scorer scores 0.
5. **Multi-critic outlet + unknown byline** → `_pending` no-byline strand, excluded. Set the outlet as criticName (e.g. "The Stage") like thereviewshub does, or find the byline.

**More gates/classes (2026-06-22):**
6. **Outlet domain coverage** — per-outlet SERP builds `site:<domain>`; an outlet with `domain:null` (372/968 in registry, incl. Bachtrack) or the WRONG primary domain (theatreandtonic.com vs live .co.uk) is never searched. `buildSiteClause()` now searches domainAliases too. Dance shows hit hardest: WE aggregators don't cover dance AND dance outlets (Bachtrack/Seeing Dance/DanceTabs/Gramilano) were unregistered.
7. **Generic 1-word titles** ("Sting","Pride","Mass") over-match in SERP (`'sting'` substring → "The Last Ship review sting musical"). `isGenericShowTitle`+`hasDisambiguator` gate (url-discovery.js) now requires a venue/cast/creative-surname corroborator — but ONLY enforced when cast/creative present (else under-collection risk). Gate covers per-outlet SERP, NOT the aggregator path.
8. **Content-swap** — collection occasionally stores outlet A's text under outlet B (same fingerprint, different host). Rebuild's `skippedDuplicateText` dedup then drops the AUTHENTIC copy. Detect: same-text-different-host scan (computeContentFingerprint). Rare (~95% of collisions are legit syndication: AP wire, about.com/NYT, vulture/nymag aliases). Fix = re-capture the contaminated file from its real URL.

**Operational gotchas:** `discoverCorrectUrl(review, scrapingBeeKey, options)` — the SB key is the **2nd positional arg**; passing options there sends an empty key → SERP 400 (looks like "SERP down" but isn't). `gather-reviews` RE-PROCESSING resets `wrongShow` flags → never auto-re-gather an ultra-generic title (re-pulls contamination). `aggregator-coverage.json` `trulyMissing` is NOISY (over-counts via aggregator thumb counts) — don't treat as ground truth. When excluding a roundup/dup, check siblings don't `duplicateOf`→it (would drop the real review); clear with `duplicateClearReason`. Links: [[feedback_off_broadway_opening_date_gap]], [[feedback_previews_open_flip_needs_review_signal]], [[feedback_content_quality_regex_fps]], [[feedback_pending_no_byline_strand_drain]], [[feedback_paywalled_star_outlets_not_gaps]], [[feedback_review_recovery_pipeline_gaps]].
