---
name: Integration tests on real HTML are mandatory for extraction fixes
description: Rule — synthetic unit tests alone can't prove an extraction fix works; always re-exercise the full decision path with real HTML from the failing source before claiming done
type: feedback
originSessionId: 34b8dffe-1d8d-436f-bf1e-24ef1fa9d128
archived: true
---
Extraction fixes must be verified against real HTML from the specific outlet that failed, not just synthetic unit tests that cover the isolated helper.

**Why:** 2026-04-20, the NYTG byline fix (`collect-review-texts.js` HC author override) shipped with 12/12 synthetic unit tests passing. The override block itself worked correctly in isolation. But in production the override never fired, because it was gated inside the byline cross-check branch — which only enters when `extractByline(cleanedText)` returns `{found: true}`. NYTG formats its byline in HTML markup that doesn't survive the strip-to-plain-text pass, so `extractByline` returns `{found: false}` on real NYTG HTML, and the override was dead code for the exact production failure it was meant to fix.

The synthetic tests passed because they fed in handcrafted HTML with a "By X" byline pattern AND the article:author meta tag — conditions the test author controlled. Real NYTG HTML has only the meta tag, not a parseable byline.

**How to apply:**
1. For any extractor/scraper/parser change, capture a real-HTML fixture from the outlet that triggered the bug — save it to `tests/fixtures/` (gitignored if copyrighted).
2. Before committing the fix, run the ENTIRE production decision path against the real fixture — not just the helper function. Specifically, trace:
   - Does the full guard chain enter the branch containing your fix?
   - Does each precondition hold on real HTML?
3. If you can't run the full pipeline, at least shell-evaluate the guard chain in order (e.g. `extractByline()` → does it return `{found:true}`? If no, the fix never runs).
4. Write a regression test that exercises the FULL decision logic, not just the leaf function. Port the production guard chain into a `applyX()` helper in the test file and unit-test that — so changes to the guard chain fail the test.
5. Never claim "fix works" when the only verification is "helper function returns X given synthetic input Y."

**Red flag:** unit tests pass, but the bug still reproduces in production. The tests are testing something different from the production code path.

**Established pattern (this session):**
- `tests/unit/hc-author-override.test.mjs` — exercises the EXACT 1A-bis override block logic (guard-by-guard port), with a fixture derived from real NYTG HTML shape. Catches the "extractByline returns false" case as `fired: false`, forcing the fix to be an unconditional override block rather than a nested one.
