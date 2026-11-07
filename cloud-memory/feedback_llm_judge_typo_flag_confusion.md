---
name: LLM judges confuse "stale flag" semantics on typo-pair flags
description: When asking an LLM "is this flag correctly applied?" on a Levenshtein-typo flag, the LLM often returns STALE because it sees the canonical critic's text and forgets the FILE's claimed critic is the typo. Re-prompt instead of trusting binary verdict.
type: feedback
originSessionId: e4d59407-536a-4598-aee1-8bbcf8fea358
archived: true
---
**Rule:** Don't trust an LLM's binary "stale_flag vs correct_flag" verdict on Levenshtein-typo flags without manual sanity check. Re-prompt with the actual question instead.

**Why:** Audit on 2026-04-26 spot-checked 20 wrongAttribution=true files via Sonnet 4.5. Of 12 "explicit-reason" files (most with `Typo of X (Levenshtein 1)`), the LLM marked 6 as STALE. Manual verification: ALL 6 were actually CORRECT flags — every one had `wrongAttributionReason` explicitly identifying the typo AND a sibling file with the canonical name existed on disk.

The semantic trap: the LLM reads the fullText, recognizes the writing as belonging to the real critic (e.g., "Sara Holdren writes for Vulture"), and labels the flag STALE. But the FILE's `criticName` is the typo (e.g., "Sara Holden" — missing 'r'); the canonical sibling is the one with the correct spelling and the actual scored copy. The flag is doing exactly the right thing.

**How to apply:**
- For typo-pair flag audits: ask the LLM "does the criticName field on this file (`X`) match the writer of this text?" — NOT "is the flag stale?". Binary stale/correct framing collapses two different relationships and the LLM gets them backwards.
- Always cross-check LLM verdicts against deterministic signals: `wrongAttributionReason: Typo of X` + presence of canonical sibling on disk = correct flag, regardless of LLM verdict.
- For the wrongAttribution audit specifically: 0/20 sampled files were genuinely stale once LLM confusion was filtered out. Audit conclusion was bulletproof.

See: Notion 34e637c5-416f-81eb (audit card with outcome), tmp/spot-check-wrong-attribution.js, tmp/spot-check-results.json (raw LLM output).
