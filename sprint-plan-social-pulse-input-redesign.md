# Sprint Plan: Social Pulse Input Redesign (Replace Apify)

**Status:** Design — not yet implemented
**Date:** 2026-07-14
**Owner card:** Notion `39d637c5-416f-81f1-89a4-dd21d33ab243`

## Why

Three problems with the current Apify-based Socials Scorecard, all confirmed against live data (2026-07-13 run):

1. **Cost.** Apify usage is pacing ~$60/mo (last full weekly run: $13.88) on top of the Creator plan fee (~$39/mo) → **~$80–100/mo all-in** for a feature with low user engagement.
2. **Fake volume.** "Volume" = count of relevant mentions in a *capped sample* (X ≤150, TikTok ≤20, IG ≤15). Across 119 shows: volume p50=154, max=193 — everything is squashed against the ~185 combined ceiling. **TikTok is saturated at its 20-item cap for 118/119 shows** while being the single most expensive actor (~$0.065/show/wk). The number on the card measures our caps, not the world.
3. **Low usage.** The card + /trending see little traffic. The feature shouldn't cost more than the signal it produces.

## Core design insight

The current pipeline conflates **two jobs that need different data shapes**:

| Job | What it needs | What we buy today |
|---|---|---|
| **A. Volume / trend** ("how much buzz?") | Uncapped **counters** | Expensive capped *samples* → fake numbers |
| **B. Sentiment + quotes** ("what are they saying?") | A modest **sample of texts** (~50–150/show is statistically plenty) | Same expensive samples — the only job they actually do |

Redesign: source each job separately. Counters are free. Text samples are free from Reddit + Bluesky.

## New input architecture

### Job A — volume counters (all true, uncapped)

| Signal | Source | Cost | Status |
|---|---|---|---|
| Bluesky mention count | `public.api.bsky.app` `searchPosts` → `hitsTotal` | **$0**, unauthenticated | ✅ verified live 2026-07-14 (`"maybe happy ending" broadway` → hitsTotal 1015) |
| Reddit post count | Reddit JSON search (existing `brand-mention-sources.js`) | $0 | ✅ already integrated |
| X weekly tweet count | X `tweets/counts/recent` (existing `fetchXTweetCount`) | $0 **while grandfathered** | ⚠️ X killed the free tier Feb 2026; pay-per-use migration in progress. Treat as optional signal, degrade to null. **Action: check the X dev portal for a migration banner.** |
| Wikipedia article pageviews (weekly) | Wikimedia AQS REST API | $0, no key (descriptive User-Agent required per 2026 rate-limit policy) | ✅ verified live (Hamilton ~4–8k views/day). Needs one-time article mapping — reuse title-resolution from `enrich-wikipedia-synopsis.js` |
| YouTube top-video weekly view delta (optional, phase 2) | YouTube Data API (`search.list` now has its own 100 calls/day bucket → spread 120 shows over 2 days; `videos.list` for views) | $0 | Needs a `YOUTUBE_API_KEY` secret |
| Google Trends (optional, phase 2) | DataForSEO Trends API, $0.00225/query ≈ $1.20/mo ($50 deposit rolls over) | ~$1–2/mo | Only if we want a general-public interest axis |

**Volume score:** raw counts across platforms aren't comparable (4k Wikipedia views ≠ 4k tweets). Normalize each signal to a per-market percentile, then weighted-average into a **Buzz Index (0–100)**. Peer-relative tiering (`derivePeerTier`, already the primary path) works unchanged on the index. Because counters are uncapped, WoW% and baselines become *real* for the first time.

### Job B — sentiment + quote texts

| Source | Sample size | Cost |
|---|---|---|
| Reddit posts (existing fetcher, title+excerpt) | up to 100/show | $0 |
| Bluesky posts (same `searchPosts` call as the counter — texts come free with it) | up to 100/show | $0 |

Classification stays GPT-4o-mini (`social-pulse-llm.js`) — already negligible (~$0.007/show).

Quote quality note: Reddit + Bluesky text quality is *better* than what we lose — TikTok text was hashtag spam (we already filter it via `meaningfulContentLength`), IG captions were mostly promo, and current top quotes already skew Reddit/X.

### What gets dropped

- **Apify entirely** — all three actors. Cancel the Creator plan (~$39/mo) and delete the `_budget.json` cap machinery.
- **TikTok + Instagram per-post scraping.** Their capped counts carried no information (20/15 flat for every show). The platform icons row loses TikTok/IG and gains Bluesky/Wikipedia.
- Optional keep (Option 2 below): TikTok/IG via **Bright Data** (existing vendor) if platform breadth matters more than cost.

## Options

### Option 1 — free-only (recommended)

Reddit + Bluesky (texts + counts), X counts while they last, Wikipedia pageviews.
**Marginal cost: $0/mo. Savings: full ~$80–100/mo.**
Trade-off: no TikTok/IG presence on the card. Given 118/119 TikTok counts were the identical capped value, nothing real is lost — but the card shows fewer brand icons.

### Option 2 — Option 1 + Bright Data for TikTok/IG

- BD TikTok Posts scraper (keyword discovery): $1.50/1k records; at top-100 videos/show/wk ≈ $8–15/mo, partially covered by BD's 5k free monthly credits. A 100 cap actually differentiates shows (vs 20 today).
- BD Instagram scraper: ~$6–8/mo, or just the hashtag-page "N posts" total via one Web Unlocker fetch/show/wk (<$2/mo) as a counter with no post scraping.
**Marginal cost: ~$10–17/mo (existing vendor, no new account). Savings: ~$65–85/mo.**

Recommendation: **ship Option 1**; add Option 2's BD TikTok counter later only if the feature earns usage. Dead-ends checked and rejected: TikTok Research API (commercial use ineligible), IG Graph hashtag API (media_count no longer exposed, 30-hashtag/week cap), social-listening SaaS (all cheap tiers cap at 3–10 keywords; we need 120).

## Cadence & scope (further cost/runtime cut)

- Weekly (Mon 06:00 UTC, unchanged) for: shows opened <8 weeks ago, top-40 by last Buzz Index, and anything Buzzing/Rising/Troubled.
- Biweekly for the steady tail. With free sources this saves runtime/rate-limit headroom rather than dollars; the current 300-min workflow timeout should drop to ~60 min without three Apify sync-runs per show.

## Schema / UI impact (kept minimal)

- Sibling-file contract unchanged (`public/data/shows/{id}.social.json`, `data/social-pulse/{id}.json`). Bump `_v: 3`.
- `pl` gains `bs` (Bluesky) and `wv` (Wikipedia weekly views); `tt`/`ig` become optional (Option 1 omits them). Card already defaults missing platforms to 0 and filters zero-count entries — back-compat is free.
- New `bi` (Buzz Index 0–100) alongside `v`; card's "N mentions" line switches to Reddit+Bluesky+X-count total.
- `SocialPulseCard.tsx`: add Bluesky/Wikipedia icons, drop (or conditionally render) TikTok/IG. `/trending` ranks by Buzz Index instead of raw volume — ranking becomes meaningful because the input has dynamic range.
- **Baselines reset** (volume semantics change). Peer-relative tiers work day 1; self-baseline WoW returns after 2 weeks.

## Implementation sketch

1. `scripts/lib/buzz-sources/bluesky.js` — searchPosts fetcher (counter + texts), paced ~1 req/s.
2. `scripts/lib/buzz-sources/wikipedia-views.js` + one-time `scripts/map-show-wikipedia-articles.js` (reuse `enrich-wikipedia-synopsis.js` title logic; store `wikipediaTitle` on running shows only, validate with `validate-show-venue.js` rules for revivals).
3. Rework `fetch-social-pulse.js`: drop Apify orchestration + budget gate; compose counters + text sample; keep LLM classify + scorer.
4. `social-pulse-scorer.js`: add per-market percentile normalization → Buzz Index; keep `derivePeerTier` on the index.
5. Card + trending updates; visual QA per §5.
6. Secrets: none required for Option 1 (X_BEARER_TOKEN already optional). Remove `APIFY_TOKEN` from `update-social-pulse.yml`; add `YOUTUBE_API_KEY` only in phase 2.
7. After 2 green weekly runs: cancel Apify subscription.

Estimated effort: one focused session for 1–4, a second for 5–7 including visual QA.

## Risks

| Risk | Mitigation |
|---|---|
| X counts token stops working mid-migration | Signal already optional/nullable; Buzz Index weights renormalize over remaining signals |
| Bluesky volume is a fraction of X's | It's one input, not the sole one; hitsTotal still differentiates shows (verified: 1015 for MHE) |
| Bluesky search throttling (anecdotal ~10 rapid calls) | Sequential fetch with 1–2s spacing; 120 queries/wk is trivial |
| Wikipedia mapping errors (wrong-year revivals) | Same class of bug as show-venue validation — validate mapping against opening year; log shows with no article (small OB shows) and omit the signal |
| Quote pool shrinks (no TikTok/IG) | Reddit+Bluesky sample ≈ 130+ texts/show for hot shows; current quotes already skew Reddit/X |
