---
name: ±1 score drift vs reviews.json is almost always deploy lag, not a UI bug
description: Before chasing a "score renders wrong" UI investigation, diff displayed scores against BOTH the last-deployed reviews.json AND local reviews.json. Apparent drift is usually just production pre-dating the latest LLM ensemble rescore.
type: feedback
originSessionId: b2cc6d5f-5eb0-4c16-b1ec-8702cae1481a
archived: true
---
**The rule:** When the live site appears to render per-review scores that differ from the current `data/reviews.json`, the first hypothesis should be **deploy lag**, not a render-time transform bug. Only investigate the render path after confirming a DEPLOYED reviews.json contains the same scores you're expecting.

**Why (actual near-miss, 2026-04-22 session):**
During the Schmigadoon TB rescue I captured Playwright screenshots and saw displayed scores off by ±1 to ±6 points from `data/reviews.json`:

| Critic | reviews.json | Displayed | Δ |
|---|---|---|---|
| Naveen Kumar | 85 | 83 | -2 |
| Jackson McHenry | 60 | 54 | -6 |
| Adam Feldman | 80 | 76 | -4 |
| Christian Lewis | 86 | 85 | -1 |

I nearly opened a Notion card + investigated `src/components/ReviewsList.tsx` and `src/lib/engine.ts` for a bogus transform. The second-opinion reviewer correctly pointed at `DESIGNATION_BUMPS` as a possible render-time bump — but those are `+2` / `+3`, not negative, so that theory failed too.

**The actual cause:** All deltas were ≤ 0 (8 negative, 5 zero, 0 positive). That's the signal: production was showing scores from a pre-ensemble-rescore reviews.json. A recent LLM ensemble pass (commit f95e1560c + b9f0d0bdb6) bumped many scores upward. My local had the new scores; production hadn't redeployed yet.

Engine path (for next-time verification):
- `src/lib/data-reviews.ts:307` — `reviewScore: review.assignedScore` (direct pass-through)
- `src/lib/engine.ts:392-401` — adds `DESIGNATION_BUMPS` (Critics_Pick=+3, Critics_Choice=+2), never subtracts
- `src/components/ReviewsList.tsx:172` — renders `{review.reviewScore}` literally, no transform

There is NO place in the render path that subtracts. Negative drift = stale data, full stop.

**How to apply:**

Before touching any UI file for a "scores render wrong" report:

```bash
# 1. Current local reviews.json (what your rebuild produced)
node -e "const r=require('./data/reviews.json').reviews; const sh=r.filter(x=>x.showId==='SHOW_ID'); sh.forEach(x=>console.log(x.outlet+'/'+x.criticName+': '+x.assignedScore))"

# 2. Last-deployed reviews.json (what prod is actually rendering)
#    — check the most recent successful vercel-deploy.yml run's checkout-core-data SHA,
#      or clone the private broadway-scorecard-data repo at that SHA and diff
gh run list --workflow=vercel-deploy.yml --status=success --limit=1 --json databaseId,conclusion,createdAt

# 3. If they differ: the "bug" is propagation timing. Wait for next deploy or trigger one.
#    gh workflow run "Deploy to Vercel"
```

**Sign a drift is NOT deploy lag:**
- Positive deltas (render HIGHER than JSON) — engine only bumps +2/+3 for designations. Unexplained positive drift is a real bug.
- Same critic on the same show drifts by an EVEN amount (+3 or +2) — designation bump.
- Directional drift that correlates with specific review fields (tier, confidence, bucketScore) — possibly a real transform.

**Related:**
- [feedback_reviews_json_dual_repo_push.md](feedback_reviews_json_dual_repo_push.md) — the deploy-chain that delays score propagation
- [feedback_symlink_aware_writes.md](feedback_symlink_aware_writes.md) — related: why a broken local symlink can make you think reviews.json is out of date when it isn't
