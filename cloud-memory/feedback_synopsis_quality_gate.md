---
name: feedback_synopsis_quality_gate
description: "A length-only \"present and >N chars\" check is not a quality gate — production-history placeholders and stale pre-opening copy pass it; detect bad content, self-heal at deploy, re-enrich"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7973a5df-2045-43b9-b1b6-71f159c8234e
---

West End show 1536 displayed a generic placeholder synopsis ("1536 is a stage play written by Ava Pickett. It had its world premiere... It's scheduled to transfer to the West End in 2026.") while already Now Playing. Root cause: the ONLY synopsis quality check anywhere was a 50-char length test (`check-show-freshness.js`, `auto-fix-show-data.js` `fixSynopsis`, `enrich-wikipedia-synopsis.js`). A ~180-char production-history placeholder passed every gate, and enrichment only ever refilled EMPTY synopses — so a placeholder written pre-opening sat live forever. User: "if this one slips through then probably many others have" — corpus scan found ~68 bad-but-present (36 placeholder, 21 refusal, 9 invalid, 2 stale).

**Why:** "present and long enough" ≠ "good." A field can be populated, pass length/type checks, and still be useless (production history with no plot) or stale (future-tense copy that's now wrong). Quality gates that only check presence/length give false confidence and never trigger re-enrichment.

**How to apply:**
- One shared classifier is the fix shape. `scripts/lib/synopsis-validation.js` `classifyBadSynopsis(show)` → {bad, reason: missing|refusal|placeholder|stale|invalid}. Wire the SAME detector into all three layers: detection (`check-show-freshness.js` flags), deploy-time self-heal (`pre-deploy-check.js` strips refusal/placeholder/stale → null so they re-enrich), and remediation (`enrich-wikipedia-synopsis.js` + `auto-fix-show-data.js` target bad synopses, not just empty). Generalizes to any enriched field.
- **Detector precision matters more than recall** when a deploy-time self-heal NULLs the field. "X is a play written by Y about [plot]" is a GOOD synopsis — flag a placeholder only on opener + production-history (premiere/transfer) OR bare attribution with NO plot signal (about/set in/follows/...). Stale future-tense must be anchored to a production context (West End|Broadway|theatre|year) or plot verbs ("they will run away", "will open in Chicago") false-trip. Codex ship-check caught both over-flags.
- **Backfill source ranking for known shows:** Wikipedia enrichment matcher is near-useless here (0/51, even Rabbit Hole "NOT FOUND"). Haiku (the cron's model) refuses on lesser-known plays ("if you don't know, say so"). Opus 4.7 knew ~80% incl. operas/older plays; write a one-off `--show=id1,id2` backfill via Opus and validate each result with `isValidSynopsis`. Genuinely obscure 2026 one-offs / dance / recital / improvised shows (no fixed plot) → leave to the safety net (strip + flag), don't fabricate.
- Related: [[feedback_opus_for_classification.md]] (Haiku/Gemini too weak for content judgment), [[feedback_content_quality_regex_fps.md]] (audit regex against real corpus before edit), [[feedback_includability_predicates_must_be_canonical.md]] (one canonical predicate, many call sites).
