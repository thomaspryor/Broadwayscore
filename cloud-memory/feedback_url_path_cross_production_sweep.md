---
name: url-path-cross-production-sweep-finds-contamination-roundup-audit-misses
description: "roundup-slug audit misses contamination where the review's own url names a different show; url-path sweep catches it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0c8bb0c0-a9f6-4d9a-8394-ec169655091f
---

The weekly `audit-slug-match-routing.js` (slug-misroute alert) only flags a
misrouted review when its **BWW/Playbill roundup-slug** full-matches a different
shows.json show. It MISSES contamination where the roundup-slug doesn't match but
the review's **own url path** clearly names a different production — and since the
file is in reviews.json, it's SCORED, distorting a live score.

**Why:** Triaging the 2026-06-07 slug-misroute alert, a complementary sweep
(compare each 2026 review's url PATH tokens vs shows.json titles; flag when the
path contains none of its own show's title tokens but >=2 distinctive tokens of
another show) found 2 real scored contaminants the roundup audit never flagged:
- `the-p-word-off-west-end-2026` scored a Krapp's Last Tape/Godot's To-Do List
  review (Gary Oldman, score 78) — belonged in `krapps-last-tape-godots-todo-list-west-end-2026`.
- `schmigadoon-2026` scored a w42st triple-bill copy whose text was the ROCKY
  HORROR portion (0 mentions of Schmigadoon, score 72) — a combined-review mis-split.

**How to apply:** When investigating cross-production contamination, run BOTH the
roundup-slug audit AND the url-path sweep (saved: `~/Documents/claude-outputs/cross-production-url-sweep.js`).
Tighten with: require the url path to contain NONE of the current show's tokens
(else it's correctly filed). Verify each candidate by CONTENT — idiomatic phrases
("rabbit hole"), wrong-url-but-right-content (independent Tempest review with a
richard-ii url), and correct per-show combined-review splits (WaPo multi-show
roundups) are false positives. Worth institutionalizing as a weekly CI audit.
Related: [[feedback_same_title_disambiguation]], [[feedback_pending_no_byline_strand_drain]].
