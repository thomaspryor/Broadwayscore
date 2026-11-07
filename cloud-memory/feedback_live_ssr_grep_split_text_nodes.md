---
name: feedback_live_ssr_grep_split_text_nodes
description: "Verifying deployed Next.js content via curl+grep gives false negatives — React splits {expr}/{expr} and interpolated headings across text nodes / HTML comment markers."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d78a4504-6f75-46b9-965d-f62a16cc5887
---

When verifying a deployed change by `curl`-ing the live page and `grep`-ing for a value, **React/Next.js SSR splits JSX expression interpolations into separate text nodes**, so a literal substring grep misses them.

**Why:** This bit me 2026-06-22..25 verifying the Tony retrospective. Three false "it's not live" alarms:
- `{entry.correct}/{entry.attempted}` renders as `17</span>/<span ...>26` — `grep "17/26"` returns 0 even though it IS live. (The standalone graphic uses `17 / 26` with spaces, so the watcher copied from the graphic also missed it.)
- A heading `Who Called the {ceremonyYear} Tonys?` renders as `Who Called the <!-- -->2026<!-- --> Tonys?` — grep for the full phrase fails.
- Combined with Vercel CDN `x-vercel-cache: HIT` serving a stale copy (check `age:` header), and one user-side network outage serving a browser-cached page, it's easy to wrongly conclude a deploy regressed.

**How to apply:** To verify deployed SSR content:
1. Don't grep the joined string. Strip comments first (`re.sub(r'<!--.*?-->','',html)`) and use a split-tolerant regex like `>(\d+)</span>/<span[^>]*>(\d+)<`, or check each number/word independently.
2. For a removed item, grep its **count** (`grep -c "Polymarket"` → expect 0) rather than asserting presence of the replacement string.
3. Always check `x-vercel-cache` + `age:` headers; a HIT with high age is a stale edge copy, not a missing deploy. Cache-bust query params don't change the static cache key — wait for the next deploy/age rollover.
4. Confirm the deployed commit is actually an ancestor of the live build before blaming the page: `git show <deployed-sha>:<file>`.

Related: [[feedback_e2e_runs_against_production]], [[feedback_flag_gated_verify_on_demo]].
