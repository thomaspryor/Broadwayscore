---
name: feedback_dedup_genre_suffix
description: "TodayTix appends \"a comedy by <author>\" title tails that defeat normalizeTitle dedup; strip trailing \"a/an [new] <genre>[ by X]\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f59b0c83-792f-4571-ac93-95f59e04b229
---

A West End duplicate shipped (2026-06-15): the same Apollo Theatre 2026 revival of Florian Zeller's *The Truth* existed as two `shows.json` entries — a clean catalog entry "The Truth" (`the-truth-west-end-2026`, from TheatreMonkey) and a TodayTix listing "THE TRUTH a comedy by Florian Zeller" (`the-truth-a-comedy-by-florian-zeller-west-end-2026`). It slipped BOTH dedup layers: the `discover-new-shows.js` creation guard AND `validate-data.js`'s catalog-wide `checkForDuplicate` scan — because both call `scripts/lib/deduplication.js` `normalizeTitle`, and that didn't strip the descriptive tail. `normalizeTitle("THE TRUTH a comedy by Florian Zeller")` → `"truth a comedy by florian zeller"` ≠ `"truth"`, so none of the 9 checks fired (title-containment's 50%-length floor also rejected the short "truth" base).

**Why:** Listing sources (esp. TodayTix) append marketing tails: "a comedy by <author>", "a new play", "a play by <author>". `normalizeTitle` only stripped colon/dash subtitles, "the musical", "a (new) musical", and possessive prefixes — not bare genre tails. One root-cause fix to `normalizeTitle` closes both the discovery guard and the CI gate at once because both call it.

**How to apply:**
- Fix added to `normalizeTitle`: `.replace(/\s+an?\s+(?:new\s+)?(?:comedy|play|musical|drama|opera|operetta|thriller|farce|tragedy)(?:\s+by\s+.+)?$/i, '')`. Anchored on "a/an [new] <genre>" at END so it never eats integral genre words ("Slave Play", "The Play That Goes Wrong", "An Octoroon" all preserved).
- Before changing `normalizeTitle`, ALWAYS run the parity scan: `checkForDuplicate` across the full catalog (`broadway-scorecard-data/shows.json`, 2668 shows) with old vs new module, diff the dup-collapses. The risk is FALSE POSITIVES (merging distinct shows) — verify zero new collapses are legitimate separate productions. Here it was 0/0.
- Tests live in `scripts/test-deduplication.js` (custom runner, not node:test). Now wired into `test.yml` (step + push-path allow-list entries for `deduplication.js` + `test-deduplication.js`) — it was NOT in CI before.
- `validate-data.js` runs a hard-error catalog dup scan (line ~234) in many workflows; it's only as good as `normalizeTitle`. When a dup still ships, the normalizer is usually the gap, not the scan.
- Related: this is a sibling of the possessive-prefix dedup gap ([[feedback_dual_repo_data_files]] for the dual-repo write; [[feedback_manual_stub_bypasses_validation]] for stub provenance). Dedup edits are discovery logic, NOT scoring — `scoring-delta.js` is not required.
