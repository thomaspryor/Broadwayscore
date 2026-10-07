---
name: feedback_duplicate_named_normalizeurl_functions
description: "Two files export a same-named normalizeUrl() with different logic; only review-normalization.js's version is actually imported by the dedup pipeline"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 413529d6-e804-4b4d-8a2e-6d1908bf3297
  modified: 2026-07-31T15:54:22.747Z
---

`scripts/lib/url-utils.js` and `scripts/lib/review-normalization.js` both export a function named `normalizeUrl`, with different implementations. Only the `review-normalization.js` one is wired into anything that matters: `gather-reviews.js`, `review-write-guard.js`, `url-ownership.js`, `cleanup-phantom-outlets.js`, `dedupe-same-url-bylines.js`, `opening-night-poller.js`, `rebuild-all-reviews.js`, and 7 more — the whole dedup/duplicate-detection pipeline. `url-utils.js`'s `normalizeUrl` has zero production callers (confirmed 2026-07-31: no file destructures it from `url-utils.js` besides its own test).

**Why:** Task #704 fixed url-utils.js's `normalizeUrl` for the invisible-Unicode bug class (cousin of #702), based on a card citing "28 call sites" from `grep -rl "normalizeUrl\b"`. That grep matched the bare identifier across both files without checking which file each caller's `require()` actually points to — so the fix landed on the dead function. Codex's ship-check adversarial review caught it by tracing real import sites; the bug would otherwise have shipped as "fixed" while the actual dedup pipeline stayed vulnerable. See fix commit 993a20aa9ed for the real patch.

**How to apply:** Before touching *any* `normalizeUrl`-adjacent logic (or any other identically-named helper that might be duplicated), grep for `require(.*<file>)` at each claimed call site and confirm the destructured name actually resolves to the file you're editing — don't trust a bare-identifier grep as proof of call sites. If you're editing `url-utils.js`'s `normalizeUrl`, you're very likely editing the wrong one; the real dedup logic lives in `review-normalization.js`.
