---
name: feedback_wrong_show_content_needs_production_match_gate
description: "Synopsis/metadata enrichment writes confident WRONG same-titled-show content that isValidSynopsis can't catch — gate every candidate (TodayTix scrape AND LLM) through verifyProductionMatch before saving"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7973a5df-2045-43b9-b1b6-71f159c8234e
---

When backfilling synopses (2026-06-21), both enrichment sources produced well-formed content about the WRONG show that shared the title, and the existing `isValidSynopsis` (length/refusal/marketing checks) passed all of it:
- **TodayTix scrape**: numeric IDs get recycled, so a stale ID serves a DIFFERENT current show. `rabbit-hole-2006`'s TodayTix ID returned a "Radiolab / Selected Shorts" live-event blurb.
- **LLM generation (Haiku AND Opus)**: confidently writes a same-titled show's plot. `all-about-me-2010` (Dame Edna / Michael Feinstein revue, cast IN the prompt) got the 2024 Laura Winters play "All of Me" (Kyra Sedgwick, disability). Prompt-hardening + a "reply UNKNOWN if unsure" escape hatch did NOT stop it — the model is confidently wrong, not uncertain.

**Why:** content-quality validators check FORM (length, refusals, marketing), not IDENTITY (is this the right production?). For shared titles — common in theatre (revivals, same-name unrelated shows) — form-valid wrong-show text sails through and ships to the public page + SEO meta.

**How to apply:**
- The fix is a production-identity gate, not a better generator prompt. `scripts/lib/synopsis-production-match.js` `verifyProductionMatch(show, text, callLLM)`: asks a STRONG model (Opus — see [[feedback_opus_for_classification.md]]) MATCH/MISMATCH against the record (title/year/venue/cast). Wired as a single CHOKE POINT in `auto-fix-show-data.js` `fixSynopsis` so EVERY candidate (scrape + LLM) passes it before `show.synopsis =`. Any new synopsis source (Wikipedia matcher, etc.) MUST route through the same gate — don't build a second verifier.
- **Reject-on-doubt, fail-closed, and parse strictly.** ship-check (Codex) caught that `MATCH - but the venue doesn't line up` parsed as MATCH off the leading token. Require the verdict ALONE on line 1 (`/^MATCH[.!]?$/`), treat ANY `MISMATCH` mention as reject, everything else (hedged/unparseable/empty/API-error/no-API-key) → reject. No verifier available → persist NOTHING ("never fake data" beats filling).
- **Sparse records → reject.** If cast/venue/year are all unknown and the title is shared, the verifier has no anchor; instruct MISMATCH (verified: "The Wild Party" — two different 2000 musicals — correctly rejected).
- **Verify the verifier at the model level, not just unit tests.** Mock-LLM unit tests cover parsing; they CAN'T prove Opus catches the trap. Run a real-model golden eval (the all-about-me → "All of Me" case + correct cases + a sparse-ambiguous case) before trusting it. This was the de-risk that made me willing to ship.
- Builds on [[feedback_synopsis_quality_gate.md]] (the form-level detector + self-heal). Detector nulls bad synopses → re-enrichment refills → THIS gate stops wrong-show refills.
