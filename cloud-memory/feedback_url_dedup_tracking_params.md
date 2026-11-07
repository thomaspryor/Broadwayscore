---
name: URL dedup tracking-param registry location + known gaps
description: Canonical helper in scripts/lib/review-guards.js with TRACKING_PARAM_NAMES/PREFIXES. Audit real data before adding or removing a param.
type: feedback
originSessionId: 287936bf-b48f-4326-8ddd-6b0da45c4db5
archived: true
---
Single source of truth for URL dedup: `canonicalizeUrlForDedup()` in `scripts/lib/review-guards.js`. Every other URL normalizer delegates to it (multi-critic-serp.js, llm-extractor.js, rebuild-all-reviews.js local normalizeUrlForDedup, etc.).

**TRACKING_PARAM_NAMES (curated allowlist)** — each entry represents "we see this param and it does NOT identify an article, only the click source." Includes: triedredirect, fbclid, gclid, mc_eid, utm_*, smid, _r, pagewanted, wpisrc, searchresultposition, gaa_* etc. Full list in the file.

**NOT on the list (preserved)** — `?p=`, `?article_id=`, `?page=`, `?id=` and similar CMS article-ID params. Removing these would silently collapse two distinct articles into one.

**Verification protocol before adding/removing a param:**
1. Grep live data for `\?<param>=<value>` occurrences across `data/review-texts/`.
2. Group by path — does ANY path carry multiple values? If yes, param is article-context-dependent and MUST NOT be stripped. If every path has one value, the param is tracking and safe to strip.

**Observed gotcha that tripped a ship-check subagent:** Daily Beast `?ref=home|wrap|author` appears to be article-identifying but is actually the section-came-from tracker. Every DB article has exactly one ref value. Same for NYT legacy `?ref=theater|arts`. Confirmed safe to strip.

**Known behaviors:**
- Params sorted by (key, value) in canonical output — `?a=1&b=2` and `?b=2&a=1` collapse to same key.
- Fallback path (URL constructor throws) strips tracking params via regex too — previously was silently preserving them.
- Hostname lowercased; path case preserved; fragment dropped; trailing slash dropped.
