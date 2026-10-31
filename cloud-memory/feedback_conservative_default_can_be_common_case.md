---
name: conservative-default-can-be-common-case
description: "Helpers that default to 'unknown → assume X' can silently misbehave when unknown is the COMMON case. Derive from adjacent data instead."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 95a5d861-cfa7-43b7-91fb-711151fb4018
---

When writing a helper that handles missing data, the "safe / conservative" default can BECOME the bug if the missing case is more common than the populated case.

**Example (2026-05-17, Awards Scorecard v2):**
```ts
// First attempt — looked safe, defaulted to common case:
export function tonyCeremonyIsFuture(season): boolean {
  const record = BY_LABEL.get(season);
  if (!record?.ceremonyDate) return true;  // "if we don't know, assume future"
  return new Date(record.ceremonyDate).getTime() > Date.now();
}
```

I'd populated `ceremonyDate` for 2024-25 and 2025-26 only. ALL prior seasons (2013-14 through 2023-24) returned `true` from the conservative default → 733 historical Tony nominees rendered as "in progress" with breathing pulse animation. Caught only by ship-check.

**Fix derives from adjacent data:**
```ts
export function tonyCeremonyIsFuture(season): boolean {
  if (!season) return false;
  const record = BY_LABEL.get(season);
  if (!record) return false;
  if (record.ceremonyDate) {
    return new Date(record.ceremonyDate).getTime() > Date.now();
  }
  // Fall back to record.end + 90-day window
  // (Tony ceremony historically lands 5-7 weeks after eligibility cutoff)
  const endMs = new Date(record.end).getTime();
  return (endMs + 90 * 24*60*60*1000) > Date.now();
}
```

**How to avoid this pattern:**
1. Count the missing cases before defaulting. If unknown is >50% of inputs, your "default" IS the behavior — design for it deliberately.
2. Prefer "derive from adjacent data" over "assume X". `season.end` was right there; using it gives a deterministic answer.
3. Test the helper against the common case, not just the case you're implementing for. I only tested 2025-26 before shipping; testing 2013-14 would have caught it.

Origin commits: 9b57087a7f (introduced bug), 918b4175d0 (fixed via ship-check P0).
