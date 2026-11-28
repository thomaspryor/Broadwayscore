---
name: Multi-critic URL dedup
description: "URL dedup must allow different named critics at same outlet."
type: feedback
originSessionId: 67341499-ffb2-476f-89bc-45ed085486f8
archived: true
---
Multi-critic outlets (NYT, Variety, Vulture, Guardian, TimeOut, Daily Mail, Theater Life, Talkin' Broadway) have multiple critics reviewing the same show. These reviews sometimes share a URL (multi-critic pages).

**Why:** URL dedup in rebuild-all-reviews.js and duplicateOf flagging in cleanup-dedup-comprehensive.js were silently dropping ~1144 reviews from different critics. Fixed 2026-04-12: +369 reviews restored site-wide.

**How to apply:**
- rebuild-all-reviews.js: URL dedup now checks both critics are named and different before allowing through; fingerprint dedup catches identical text downstream
- cleanup-dedup-comprehensive.js: same-show-url-dedup section skips when both files have different named critics
- When writing new dedup logic, always check critic names before flagging same-URL files as duplicates
- Print-only reviews (Mail on Sunday/Gore-Langton) have URL=null; their text comes from Theatre Record
