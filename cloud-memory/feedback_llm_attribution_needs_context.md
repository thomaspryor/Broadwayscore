---
name: LLM attribution requires production-specific context
description: "Director/playwright prompts MUST include year+venue+synopsis."
type: feedback
originSessionId: bdd2d29e-d732-4d2b-ac96-c553d2de6cbc
archived: true
---
When extracting director/writer/playwright via LLM, the prompt MUST include production-specific context (opening year, venue, synopsis). Title alone is not enough.

**Why:** auto-fix-show-data.js's `generateCreativeTeamWithLLM` asked Claude Haiku "who directs `${show.title}`" with no other context. For shows not in Haiku's training data (post-2024 titles), it confidently returned directors from whichever same-title production was best-represented in training. Concrete contaminations caught:
- Seagull: True Story (Molochnikov, 2026 OB) → got Jamie Lloyd (his 2025 WE Seagull)
- FLYBY (Adam Lenson) → got Racky Plews + Dougal Irvine (different musical)
- Encores! La Cage Aux Folles (Robert O'Hara, 2026) → got Terry Johnson (2010 WE revival)
This is the same lesson as `feedback_structuredtips_hallucinations.md` (LLMs hallucinate factual claims) but specifically for cross-production same-title collisions.

**How to apply:** Two layers, always together:
1. Include year + venue + synopsis (≤500 chars) in the LLM prompt and explicitly say "this specific production, not same-title revivals".
2. Post-validate: if the synopsis literally says "directed by X", the LLM's director name must contain X (last-name overlap is enough). Otherwise reject the entire LLM response — no team is better than a wrong one. Reference: `creativeTeamMatchesSynopsis()` in auto-fix-show-data.js, audit script at `scripts/audit-creative-team-vs-synopsis.js`. Run the audit script proactively whenever new shows are added.
