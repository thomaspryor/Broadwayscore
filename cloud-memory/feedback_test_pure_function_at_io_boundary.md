---
name: test-pure-function-at-io-boundary
description: Tests of pure helpers in scripts/lib/ are necessary but insufficient — also exercise the wrapper that does the I/O against real production data shapes.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 20a2d2fa-ff38-4aa7-bcf7-0f8c4c9f64ff
---

When I extract a pure function to `scripts/lib/X.js` per CLAUDE.md §15, the wrapper in `scripts/Y.js` (which does `fs.readFileSync` + `JSON.parse` + calls X) is where the real bugs live. Unit-testing X with synthetic literals proves the helper is correct against itself, not against production data.

**Rule:** Every new `scripts/lib/X.js` needs at least one test that:
1. Loads `data/shows.json` (or whatever real file the wrapper consumes) from disk
2. Applies the same unwrap/transform the wrapper does
3. Calls X with the real shape
4. Asserts a reasonable contract (no throw, expected ok=true for a known-good sample)

The test can `[skip]` if the data file isn't present in the test context — but it must exist so the contract is locked.

**Why:** 2026-05-16 — Commit 073db6bab0 shipped two P0 bugs that 10 green unit tests + tsc didn't catch:
- `checkShowsJsonMetadata(shows, ids)` worked perfectly with `shows = [{id:'a',...}]`. The wrapper `runShowsJsonPreflight` passed `JSON.parse(fs.readFileSync(SHOWS_JSON))` directly — but `shows.json` is `{_meta, shows: [...]}`, not a bare array. `.map()` on the wrapper → `TypeError`. Crash on first real invocation.
- A workflow jq assertion read `data/historical-shows-pending.json` and selected on `.category` / `.market`. But the pending file writer never persists those fields. The assertion would match every row.

Only the multi-reviewer `/ship-check` skill (Claude + GPT-4o + Codex) caught both — because Codex actually read the real `discover-historical-shows.js:639-644` and noticed the field set, while my tests just sampled the contract I had in my head.

**How to apply:**
- For any new `scripts/lib/X.js`: write `tests/unit/X.test.mjs` that exercises X with both synthetic AND real-data shapes. The integration test can be in the same file under a separate `describe('integration — real shows.json shape', ...)`.
- For any wrapper in `scripts/Y.js` that calls X with file I/O: write a smoke test that runs `node Y.js --dry-run` (or equivalent) against real data before pushing. Same logic as CLAUDE.md rule 12 #4.
- For workflow YAML steps that grep/jq a generated file: paste the real file structure into context FIRST and confirm the fields exist before writing the selector.
- For any commit touching `scripts/lib/` or `.github/workflows/`: the verify-edits hook now requires `/ship-check` (or codex/GPT-4o reviewer Bash) before claiming done. See [[feedback_verification_gate_hook]] for the hook details.

Related: [[feedback_verification_gate_hook]] (the SHIPCHECK gate enforces this), [[feedback_ship_check_finds_real_bugs]] (confirms ship-check value), [[feedback_test_extraction_pattern]] (CLAUDE.md §15 baseline).
