---
name: URL-date wrongProduction backstop
description: "flag-wrong-production-by-url-date.js catches missing publishDate + LLM FN."
type: feedback
originSessionId: bdd2d29e-d732-4d2b-ac96-c553d2de6cbc
archived: true
---
When a review's `publishDate` is missing and the LLM `contentVerification` returns `wrongProduction:false` for what's actually an older production's review, the URL itself often contains a date segment that betrays it (e.g. `nytimes.com/2023/02/28/...`, `vulture.com/2016/05/...`, `washingtonpost.com/2014/01/08/...`).

**Why:** Reddit user feedback on Seagull: True Story (2026) flagged that a Cititour entry was dragging down the score with a 44 (Negative). The review was actually of Bradshaw's "The Seagull/Woodstock, NY" (2023, Pershing Square Signature). LLM saw the article correctly described Bradshaw's production but didn't compare it to the show being scored, so wrongProduction stayed false. Initial sweep also caught 53 contaminated reviews on 58 other shows — pre-Broadway tryouts (Patriots MTC 2024-01, Merrily NYTW 2022, Hells Kitchen Public 2023, etc.) being assigned to the Broadway transfer.

**How to apply:** When investigating low scores or off-tier reviews on shows with revivals/transfers/pre-Bway runs, check `scripts/flag-wrong-production-by-url-date.js` first — it flags any reviewed URL with a `/YYYY/MM/` date segment >30 days outside `[previewStart-21d, close+30d]`. Add to the routine alongside `flag-wrong-production-by-date.js`. Conservative threshold (30 days) avoids false positives from out-of-town tryout reviews that ARE intentionally included via `allowEarlyDate`.
