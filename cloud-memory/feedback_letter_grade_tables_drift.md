---
name: feedback_letter_grade_tables_drift
description: Letter-grade→score is duplicated in 5 files; two drifted to A=95 (incl the live admin-ingest path). Single-source onto the canonical map + a cross-file parity test.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 16d96be1-473b-4d44-b95b-e6ffb581510d
---

The letter-grade→0-100 conversion was hand-copied into FIVE files and split into
two value-camps (found 2026-06-29 while debugging star-audit false positives):
- **Canonical (A=90):** `src/config/scoring.ts` `LETTER_GRADE_MAP`,
  `scripts/lib/score-extractors.js` `LETTER_GRADES`, `scripts/lib/score-conversion-rules.js`.
- **Drifted (A=95, far worse at the low end — D=65, F=50 vs 35/20):**
  `scripts/lib/star-parse.js` (audit-only — tripped ~16 false HARD flags in
  audit-star-accuracy.js, mostly the D/D+ cluster) and **`src/lib/admin-ingest-score.ts`**
  — the LIVE manual-ingest API path (`/api/admin/ingest-review`), which scored
  every manually-ingested letter grade far too high at ingest time.

**Why:** a hardcoded copy "to avoid an import" silently rots. The audit one
inflated its own yardstick (false positives); the admin-ingest one inflated real
provisional scores (the next rebuild re-derived from `originalScore` via the
canonical map, so existing data mostly self-corrected — only 3 reviews affected,
already canonical — but the ingest-time score shown before rebuild was wrong).

**How to apply:** never hand-copy a conversion table. JS consumers
`require('./score-extractors').LETTER_GRADES` (the labeled-canonical CJS file,
12+ existing call sites); client-safe TS imports `LETTER_GRADE_MAP` from
`@/config/scoring`. Enforce with a cross-file parity test
(`tests/unit/letter-grade-parity.test.ts`, modeled on
`tier-config-consistency.test.ts`) asserting all tables `deepEqual` — runs in the
tsx lane (reads the .ts canonical; the plain `node --test` `scripts/lib` lane
can't import .ts). Same SET-without-CLEAR / copy-without-import smell as
[[feedback_stale_wrongproduction_flag_never_recleared]]. The star audit
(audit-star-accuracy.js) reads reviews.json, so it also surfaces transient
reviews.json-vs-review-text staleness as HARD — those clear on the next rebuild,
not a code bug; only treat audit HARD as a bug once reviews.json is fresh.
