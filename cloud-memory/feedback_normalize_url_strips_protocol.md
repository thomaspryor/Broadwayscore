---
name: review-normalization normalizeUrl strips the protocol — not safe for fetchable URLs
description: scripts/lib/review-normalization.js#normalizeUrl returns scheme-less canonical strings (`example.com/path/`) for dedup comparison. `new URL(x)` on the result throws. Don't use it where downstream needs to fetch the URL.
type: feedback
originSessionId: daa181c6-4a0a-48e5-b11b-3b74229ebe61
archived: true
---
`normalizeUrlCanonical` from `scripts/lib/review-normalization.js` (re-exported as `normalizeUrl` in some places) is designed for **canonical comparison in dedup** — it strips the protocol, www., trailing slash, fragment, tracking params, and lower-cases the host. The output looks like `1minutecritic.com/lost-boys-broadway-review/` (no `https://`).

This means `new URL(normalizedResult)` throws "Invalid URL". Any downstream code that needs to fetch, parse hostname, or extract pathname will fail.

**Why:** Caught by ship-check round 2 of Parallel Session 3 (2026-04-29). I had OMC discovery routing item.link through `normalizeUrlCanonical` to canonicalize utm-stripped URLs. The OMC parser then called `new URL(item.link).pathname` for the URL-pattern guard → `URL parse err` for every item → 0 hits.

**How to apply:**
- Discovery libs and any code that emits URLs intended to be fetched/parsed downstream must NOT pre-canonicalize via review-normalization. Strip only what you need (utm_*, fbclid, gclid, mc_cid, mc_eid) and keep the protocol.
- Canonicalization for dedup happens DOWNSTREAM in the rebuild pipeline (`processDiscoveredReviews`, `safeWriteReview`, etc.) — let those layers do it.
- If you need a canonical key for in-memory comparison, store the result of normalizeUrlCanonical separately. Don't overwrite the fetchable URL.
- Reference: `scripts/lib/omc-discovery.js`'s `cleanUrl` (utm + ad-tracker strip only, keeps protocol).
