# Flagged Review Recommendations

Analysis of 48 reviews with significant Claude/GPT disagreement.

## Quick Summary

| Action | Count | Details |
|--------|-------|---------|
| ✅ **KEEP (Accept LLM score)** | 35 | Score is reasonable |
| 🔧 **OVERRIDE score** | 6 | LLM confused by truncated text |
| ⚠️ **LOW CONFIDENCE** | 6 | Only fragment available |
| ❌ **REMOVED** | 1 | West End review (not Broadway) |

---

## ❌ REMOVED (Not Broadway)

### stranger-things-2024 / BroadwayWorld (Alexander Cohen)
**DELETED** - Reviewing WEST END production at Phoenix Theatre, London.

---

## 🔧 MANUAL OVERRIDES NEEDED

These have truncated/header-only text where LLMs disagreed significantly:

| Show | Outlet | Current | Override To | Reason |
|------|--------|---------|-------------|--------|
| boop-2025 | Broadway News | 50 | **75** | Only header scraped; "joy bomb" = positive |
| cabaret-2024 | Broadway News | 60 | **80** | Only header; "hotbed of thrills" = positive |
| liberation-2025 | Variety | 56 | **75** | Only headline; "Impressive...Fresh" = positive |
| the-lion-king-1997 | Columbus Dispatch | 65 | **85** | "Triumph of theatrical imagination" = rave |
| the-lion-king-1997 | Milwaukee Journal | 68 | **85** | "Nothing short of miraculous" = rave |
| marjorie-prime-2025 | The Wrap | 55 | **65** | Truncated but headline mixed-positive |

---

## ⚠️ LOW CONFIDENCE (Keep but note)

These have only excerpts/fragments - scores are best guesses:

- `the-lion-king-1997 / NEW YORK MAGAZINE` (54) - John Simon was famously harsh; mixed is fair
- `hadestown-2019 / Broadway & Me` (68) - Fragment only
- `our-town-2024 / The New York Times` (59) - Verify attribution
- `book-of-mormon-2011 / WSJ` (88) - Verify not Chicago review
- `the-lion-king-1997 / other regionals` - Wire service syndication

---

## ✅ KEEP AS-IS (35 reviews)

These have reasonable averaged scores despite model disagreement:

| Delta Range | Count | Examples |
|-------------|-------|----------|
| 20-37 pts | 12 | death-becomes-her NYT, aladdin NBC, marjorie-prime NYPost |
| 10-20 pts | 15 | mamma-mia EW, moulin-rouge NYDN, just-in-time various |
| 2-10 pts | 8 | Various minor disagreements |

The averaging approach works well for genuinely mixed reviews where one model sees positive and other sees negative.

---

## Database Audit Results

### Not Broadway (REMOVED):
- ❌ `stranger-things-2024/broadwayworld--alexander-cohen.json` - West End

### Verified Broadway (KEEP):
- ✅ Lion King 1997 regionals - Published Nov 13-14, 1997 (opening), likely AP syndication
- ✅ Mamma Mia 2025 - Touring production's Broadway engagement at Winter Garden (valid)

### Recommendation for Future:
- Add URL verification for regional outlets
- Flag reviews without URLs as low-confidence
- Cross-check dates against Broadway opening dates
