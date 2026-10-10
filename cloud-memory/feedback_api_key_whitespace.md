---
name: api-key-whitespace
description: "External API JSON often has trailing/leading whitespace in object keys; normalize at load, not at lookup"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ed01c2ad-8952-416f-be83-ac5b273583e7
---

When ingesting JSON from external APIs into a `Record<string, T>` lookup table, **normalize key whitespace at load time** — not at lookup. Trailing spaces in keys are common (the GoldDerby Tony API returned all 41 `persons` object keys as `"Nathan Lane "` with trailing space) and `obj[key]` lookups silently miss without erroring.

**Why:** GoldDerby's `tony-win-probabilities.json` `persons` map had trailing-space keys for ~6 weeks before discovery. Every per-person GD odds lookup fell back to show-level pWin, so two nominees from the same show always displayed identical odds (Uranowitz showed 94% instead of his real ~0.4%). The fallback "worked" in 39/41 cases (one nominee per show), masking the bug.

**How to apply:**
- At load (not lookup): `Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim(), v]))` — fixes all consumers at once
- Add a contract test on the loaded data: assert `Object.keys(obj).every(k => k === k.trim())`
- Avoid the "trim at lookup site" anti-pattern — easy to forget at one of N sites; also doesn't fix the inverse case where keys are clean but the lookup arg has whitespace

**Related:** [[live-api-contract-test]] — unit tests against fixtures can't catch this; the bug only surfaces when the real API returns malformed keys.
