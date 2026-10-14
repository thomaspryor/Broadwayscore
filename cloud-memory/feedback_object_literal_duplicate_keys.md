---
name: object-literal-duplicate-keys
description: "When adding a new entry to a registry-shaped object literal (SITE_SEARCH_ENDPOINTS, OUTLET_DOMAINS, MULTI_CRITIC_SERP_OUTLETS, etc.), grep the existing keys first — JS silently lets later-key-wins, so you can ship a registration that silently nukes a working entry."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8f5edbbd-ccdf-43b6-9ad3-670d00d5b22c
---

When adding a new entry to a registry-shaped object literal in JS (e.g. `SITE_SEARCH_ENDPOINTS`, route maps, config dicts), **grep for the key first**. The language has no warning for duplicate keys — the later definition silently overwrites the earlier one. A new entry registered under the same key removes the previous behavior with no error at runtime, no test failure unless the test specifically exercises the overwritten path.

**Why:** Sprint 2 of Opera Auto-Discovery V2 added `'vulture': { … applies: opera }` to `scripts/lib/site-search-discovery.js` at line 761 not realizing the same map already had `'vulture': { … }` for Broadway theater at line 182. JS picked the later entry. Every non-opera Vulture Broadway query stopped firing on the next cron tick. Same bug for `'times-uk'` (lines 221 and 665). Caught by `/ship-check` (Claude codebase-aware + Codex adversarial both flagged independently) — but tests, type-checker, lint, and build all passed.

**How to apply:**
- Before adding any new registry entry, `grep -nE "^  '<key>':" <file>` and confirm no existing definition.
- If the new entry needs the same outlet/feature identity but a different dispatch path (e.g. opera vs Broadway for Vulture), use sibling-key + an explicit override field (we added `outletIdOverride` on `SITE_SEARCH_ENDPOINTS` for this) rather than renaming downstream consumers.
- If a registry has a documented schema, add a runtime warning in the dispatcher when a duplicate-by-canonical-id collision is detected at module load.

**How to detect:** when refactoring a registry, run a unit/integration test that asserts every existing pre-refactor key still resolves to a behaviorally-equivalent entry. The `tier-config-consistency.test.ts` family of tests does this for tier configs — pattern is reusable.
