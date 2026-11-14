---
name: serp-parity-test-pattern
description: "For SERP/LLM-extraction scrapers, write a parity test that runs known-bad historical URLs through the new defense and asserts each is caught by a named layer (or honestly documents which layer DOES catch it)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ac76a05e-1b22-4ee5-9411-ec675bcd9542
---

When hardening a SERP→LLM scraper after a contamination incident, the right test isn't "the validator returns false for synthetic bad input" — it's a **parity test** that runs each historical bad URL through the production scoring and asserts the named defense layer catches it.

**Why:** Pure-function unit tests prove the validator works on contrived inputs. They don't prove the historical bug class is actually closed. A parity test against real bad URLs forces you to discover gaps — when I added one for cast contamination (commit `0a323c330b`), it immediately caught two real bugs the unit tests missed: (1) `url.includes('cast')` was matching "broad**cast**" in parterre.com URLs (gave +3 spurious), (2) tests using `title: ''` under-approximated production scoring — Codex's ship-check verified Man to Man's URL scores 1 with empty title but 3 with realistic `"Cast Announced"` title.

**How to apply:**
- Each fixture: `{show, url, serpTitle, caughtBy}` where `caughtBy` names ONE of the defense layers (e.g. `serp-scorer`, `validate-extraction`, `opera-source-url`, `llm-prompt`).
- For each `caughtBy: 'serp-scorer'` case: assert `score < SERP_MIN_SCORE`.
- For non-serp-scorer cases: assert `score >= SERP_MIN_SCORE` (boundary documentation) AND add a separate test that calls the named downstream defense and asserts it fires.
- **Always use realistic SERP titles**, never empty — empty masks the title-signal scoring path and lets some real misroutes appear "caught" when they aren't.
- If you tighten the SERP scorer later and a non-serp-scorer case starts passing the assertion, the test breaks loudly — update `caughtBy` to `serp-scorer`.

This converts "we caught the current bugs" into "we have evidence the fix actually closes the historical class". See [[ship-check-finds-real-bugs]] — Codex review catches what unit tests miss.
