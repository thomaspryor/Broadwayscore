---
name: Notion cards need reproduction evidence
description: Bug/issue cards must include specific show IDs, exact log output, and which step failed — not just symptom labels
type: feedback
---

Bug/issue Notion cards must include reproduction evidence, not just symptom labels.

**Why:** The "Fix LBO review extraction (0 reviews parsed)" card didn't specify which show, which log line, or whether extraction returned 0 vs no archive existing. Investigation revealed the function works fine — the real issues were quality bugs (footer junk, missing critics). Ambiguous card descriptions waste session time on diagnosis that should have been captured at discovery time.

**How to apply:** When creating a Notion card for a discovered bug (from daily digests, automated sessions, or wrap-up findings), always include:
1. **Specific show ID(s)** that exhibited the problem
2. **Exact log line or command output** that triggered the card
3. **Which pipeline step failed** — distinguish "fetch failed" from "parse returned 0" from "no archive exists" from "wrong data returned"
4. **How to reproduce** — the command to run to see the problem

Bad: "LBO review extraction returns 0 reviews"
Good: "extractReviewsFromLBO() returns 0 for john-proctor-west-end-2026 — archive file missing at data/aggregator-archive/lbo-roundups/john-proctor-is-the-villain-west-end-2026.html. Sitemap discovery found no roundup URL. SERP returned wrong show (Paddington)."
