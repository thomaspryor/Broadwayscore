---
name: A/B variant strings need a flag-namespace prefix when sent to 3rd-party trackers
description: ab_variant strings echoed through Impact/affiliate networks MUST include a flag:<flag-name> prefix. Without it, future tests reusing the same keys (e.g. buttons:single|multi) silently merge into the previous test's history with no way to demix.
type: feedback
originSessionId: 7627197b-724c-4b8d-b25a-cd9400e698ba
archived: true
---
When sending an A/B variant string through a 3rd-party tracker that becomes append-only history (Impact subIds, GA event params, anything that flows back through a postback), the variant string MUST carry a flag-name namespace.

**Bad:** `platform:todaytix,buttons:multi`
**Good:** `flag:ticket-single-button,platform:todaytix,buttons:multi`

**Why:** Caught 2026-04-27 by Codex during /ship-check on the Impact subId postback. The first version sent the bare `platform:X,buttons:Y` string. If a future A/B test reuses `buttons:` as a key (very plausible), Impact's append-only Action history would interleave conversions from both tests and there's no way to demix retroactively. The analyzer would silently double-count.

**How to apply:**
- Any `ab_variant`-style string that gets forwarded to an external system (subId, query param, header, postback body) needs `flag:<flag-name>,...` as the leading segment.
- The analyzer (e.g. `scripts/analyze-ab-test.js`) gates direct attribution on the matching prefix — strings without it, or with a different flag prefix, fall into the unattributed pool.
- Keep a backward-compat branch in the analyzer for one rollout cycle so in-flight tabs/copied URLs don't suddenly disappear from analysis.
- Internal-only signals (PostHog event properties, console logs) don't need the prefix — only ones that exit the boundary.

Files: `src/components/TicketButtonsAB.tsx` (abVariantStr build), `scripts/analyze-ab-test.js` (VARIANT_RE flag-gated regex).
