---
name: competition-rank-for-leaderboards
description: "For user-facing \"#N of M\" leaderboards, use competition rank (1, 1, 3) — NOT dense rank (1, 1, 2). Dense rank silently misleads users into reading \"#34 of 619\" as top 5%."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 86742c7c-b3e2-4ac0-b03b-02cdc7a24ce7
---

When implementing a `#N of M` user-facing rank display, the tie-break algorithm matters more than it looks:

- **Dense rank** (`1, 1, 2, 3, 4`) — ties share rank, next-best moves to the immediately-following rank. Counts *distinct values*. "#34 of 619" means "34th distinct score tier."
- **Competition rank** (`1, 1, 3, 4, 5`) — ties share rank, next-best skips past the tied positions. Counts *shows above this one + 1*. "#34 of 619" means "33 shows scored strictly higher."

**Why this matters:** dense rank makes a Skippable show (CriticScore 56) read as top 5% when most shows in the pool cluster in the 70-95 range. The user expects "rank vs total" to map to "this many shows are better than me." That's competition rank.

**Rule:** for any `displayN/M` UI where users will infer "I'm in the top P%" from `N/M`, use competition rank.

**Why:** real-world UX failure — Dog Day Afternoon (CriticScore 56) showed as #34 of 619 all-time with dense rank; user flagged it as wrong. With competition rank it correctly shows #551 of 619, matching the Skippable verdict. memory:round_once_share_everywhere still applies (rank on the rounded display value, not the raw score) — those two rules compose: round → competition-rank → render.

**How to apply:**
- New leaderboard code: default to competition rank unless explicitly proven dense is what users want.
- Add a unit-test assertion that "the next show after a tie jumps past tied positions" — that's the defining contract.
- See `src/lib/data-show-ranks.ts:computePool` for the pattern.
