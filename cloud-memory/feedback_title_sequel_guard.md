---
name: Title sequel/part guard in titlesMatch
description: "titlesMatch() rejects Part N; TR year-guard for null openingDate."
type: feedback
originSessionId: 57b79bab-9e2d-48f1-b26b-c9afb7a4d419
archived: true
---
titlesMatch() in scripts/lib/title-normalization.js has a sequel guard: when the substring match fires and the remainder is "Part N/IV/etc.", it returns false (different plays). Also, hasPartSuffix() checks ensure stripped-suffix equality only matches when both titles had the same part indicator (or neither had one).

**Why:** Theatre Record matched "A Doll's House, Part 2" (2022 Donmar, Lucas Hnath) to "A Doll's House" (2026 Almeida, Ibsen). 14 wrong-production reviews with active scores corrupted the composite.

**How to apply:** When adding new title-matching logic or relaxing existing thresholds, verify that sequel/part variants still return false. Run `node scripts/test-title-normalization.js` — 49 tests including 4 Part-specific regression cases.

Also: isMultiProduction() in scripts/lib/deduplication.js treats "TBA"/"TBD" venues as unknown. And extract-theatre-record.js has a year-guard that compares review year to show ID year when openingDate is null.
