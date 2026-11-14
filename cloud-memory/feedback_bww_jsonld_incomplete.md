---
name: BWW JSON-LD is incomplete — always supplement with text scan
description: BWW LiveBlogPosting JSON-LD omits ~45% of roundup entries; text-based articleBody parsing catches them
type: feedback
archived: true
---

BWW roundup pages have incomplete JSON-LD structured data. On the Becky Shaw roundup, only 18 of 33 reviews were in LiveBlogPosting entries — the other 15 (including Guardian, NYTG) were only in the articleBody text.

**Why:** BWW progressively builds roundup pages. Entries added later (especially those without hyperlinks) may not get JSON-LD representation. The entries without hyperlinks were the Mixed reviews — their absence made the show look unanimously positive.

**How to apply:** Always run articleBody text parsing as a supplement after JSON-LD extraction, not as a fallback. Dedup by outlet+critic between methods. This pattern applies to both gather-reviews.js (fixed) and scrape-bww-reviews.js (P2 card created).
