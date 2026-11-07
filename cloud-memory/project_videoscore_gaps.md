---
name: VideoScore coverage gaps
description: Missing video reviews identified 2026-04-13 — 17-23 reviews not captured, especially Mickey-Jo YouTube and Cabaret
type: project
archived: true
---

## VideoScore Coverage Gaps (2026-04-13)

Current: 36 reviews across 15 shows. Estimated true total: 53-59. Gap: ~32-39%.

### Biggest Creator Gaps

**Mickey-Jo Theatre (+5-7)** — YouTube reviews with star ratings in titles:
- Chess: "Broadway's new CHESS is a mess | 2-star review" (34min, 79K views)
- Great Gatsby: "THE GREAT GATSBY musical is just okay | 3-star" (41min, 43K)
- Two Strangers: "TWO STRANGERS is best on Broadway | 5-star" (28min, 12.8K)
- CATS Jellicle Ball: "I saw the circus CATS revival | 4-star" (32min, 11.5K)
- Cabaret with Orville Peck (27min, 57K)

**Why missed:** YouTube pre-classification was skipped ("title heuristics sufficient for YouTube"). But many Mickey-Jo videos are vlogs that contain reviews, not standalone review videos.

**Tyler Nabinger (+5-6):** CATS, Beaches, Proof, Schmigadoon, Titanique, Cabaret
**Ash Hufford (+4-6):** Becky Shaw, Mexodus, Operation Mincemeat, Beaches, Titanique
**Broadway Ben (+2-4):** Burnout Paradise, Cabaret, mystery review

### Missing Shows (zero coverage but reviews exist)
- **Cabaret** — 4 reviews exist (Tyler, Ben, Oracle, Mickey-Jo) — ZERO captured
- **Titanique** — 3 reviews (Tyler, Ash, Mickey-Jo)
- **Beaches** — 2 reviews (Tyler, Ash)
- **Sunset Blvd** — closed, but 2 reviews (Oracle, Kate)

### How to apply
1. Run Mickey-Jo through the full classify pipeline (not just title heuristics)
2. Add Cabaret, Titanique, Beaches to sources and process
3. Re-check Tyler's feed for CATS, Beaches, Proof
4. Re-check Ash's feed for Becky Shaw, Mexodus, Operation Mincemeat
