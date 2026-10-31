---
name: ID year suffixes unreliable for dedup
description: "TodayTix suffix is first-performance year; don't dedup on it."
type: feedback
archived: true
---

Never trust show ID year suffixes (e.g., `harry-potter-and-the-cursed-child-2021`) for production dating in deduplication. TodayTix uses the first-performance year, not the production's canonical opening year.

**Why:** A bogus HP duplicate entry bypassed dedup because isMultiProduction() compared ID suffix year (2021) vs existing openingDate year (2018), saw diff=3>2, and treated them as separate productions — even though they were at the same venue. The entry had `openingDate: null`, so the ID suffix was the only year signal.

**How to apply:** In `scripts/lib/deduplication.js`, `isMultiProduction()` only trusts `openingDate` fields for year comparison, never ID suffixes. If adding new dedup logic, follow the same pattern. Also: `new Date(null).getTime()` returns NaN — always guard date sorts with null checks.
