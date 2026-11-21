---
name: Inventory what is already built before proposing product or growth ideas
description: Before recommending new features, growth moves or strategy for the site or app, list what already ships (routes, account features, games, embeds) so no proposal duplicates a live feature
type: feedback
---
**Rule:** before proposing any product, growth or strategy idea to the owner, spend ten minutes listing what already exists, and state for each idea what it builds on.

**What happened (2026-11-10, BRO-7305):** a strategy session worked from traffic numbers and the data files and proposed four "moves". Three overlapped things that were already live: critic alignment for signed-in users, a quotable score badge and embed, and a pick-the-winners game for the Tonys. The owner's response: the ideas were "kind of interesting, but nothing really mind-blowing", and he was "a bit skeptical about some of these recommendations when it seems like you didn't even know that we had a accounts and rating system". Trust in the remaining ideas dropped with it.

**Why:** the data and analytics say what visitors do. They do not say what the product offers. A proposal that duplicates a shipped feature reads as not having looked.

**How to apply (my interpretation, the owner did not prescribe steps):**
- List routes: `ls src/app` and `ls src/app/api`. Read the tab list in `src/app/my-shows`.
- Check feature flags (`NEXT_PUBLIC_FEATURES`, grep `src/` for the flag names) for what is on, off or parked.
- Grep `src/lib/stats` and `src/components` for the noun in the idea (alignment, badge, embed, predict, forecast, game, list, follow).
- Known as of 2026-11-10: accounts, ratings, seen list, watchlist, lists, diary and feed under `/my-shows`; critic alignment in `src/lib/stats/align-critics.ts`; score badge at `src/app/api/badge` and `src/app/embed`; Tony picks game at `src/app/beat-the-critics`; Tony predictions; review count prediction in `scripts/predict-review-count.js`; review score forecast backtest in `scripts/lib/review-forecast.js` (BRO-7314). Fantasy is flagged off.
- In the write-up, each idea carries one line: "builds on: X (exists)" or "new".

**Also from the same feedback (owner preferences, 2026-11-10):** no monetization while the audience is small, because it adds pressure to keep everything current and accurate. Ideas that need market dominance or a paid partnership to work (score quoting, a seal for top-rated shows) are not wanted. Live "watch the reviews arrive" is seen as niche (10 to 20 people). Predicting a show's reviews is the idea he liked, by analogy with the Tony predictions.
