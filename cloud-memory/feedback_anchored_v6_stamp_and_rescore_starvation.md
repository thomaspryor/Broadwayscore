---
name: feedback-anchored-v6-stamp-and-rescore-starvation
description: "Three ways flat star conversions leak past the anchored-v6 sentiment system, and the fixes shipped 2026-07-11"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f0c323f7-b470-4e4a-9094-141d66fa3035
---

Anchored-v6 leak triad (all fixed 2026-07-11, commits 2328738b84 + 829956495f):

1. **Bare-numeric aggregator relays are not published stars.** A review file with `originalScore: 100` (number) and no `originalScoreSource` is Show Score's normalized relay. It used to knock `llm-v6` out of the P0.4 early return and ship the raw 100 via P3b over the LLM's sentiment score. Guard: `lateStarReliable` in rebuild-helpers requires `isUnambiguousRatingString` when the extraction source is absent.

2. **Later star extraction overwrites the v6 scoreSource stamp.** `llmScore.band` is the durable proof a verdict was anchored (only the anchored scorer writes it) — check that, never the stamp. P0.4 honors the band marker; staleness guard: current `originalScore` flat-parse must land inside the band ±2 (star can change after anchoring, e.g. relay 5/5 vs outlet's own 4/5 — equus telegraph).

3. **The needsRescore queue starves.** `llm-ensemble-score.yml` check-needed is a strict priority cascade; the rescore branch only fires at UNSCORED==0 corpus-wide, which near-continuous review inflow makes ~never. Flags sat 4+ days. Fix: unconditional capped drain step (`--needs-rescore --limit=50`) after the scheduled main pass; kill switch `DISABLE_RESCORE_DRAIN=1` repo var.

**Why:** User expected "not many 60s/80s/100s" for London; JCS showed two 100s — one legit (Radio Times anchored top-of-band), one leaked (London Theatre, path 1 + path 3 combined).

**How to apply:**
- When a WE score looks like an exact flat conversion (100/80/60), check the file: `scoreSource` (v6?), `llmScore.band` (anchored?), `originalScore` type (string star vs bare numeric), `needsRescore` (stuck in queue?).
- When re-flagging `needsRescore`, ALWAYS `delete rescoreCompletedAt` (backlog counters skip files carrying both).
- The scorer's `--needs-rescore` filter is the canonical backlog truth (needsRescore===true + isScoreable); never hand-roll a counting predicate — it drifts ([[feedback_includability_predicates_must_be_canonical]]).
- scoring-delta Phase B baseline needs repo `data/` (symlinked into its tmpDir now); without it outlet star scales (NY Post /4) fall back to /5 and it reports phantom flips.
- Historical backfill: `flag-late-star-reanchor.js` extension flags pre-v6/stamp-overwritten files with ensemble verdicts (84 WE found); drains at ≤50/day via the scheduled cron.
