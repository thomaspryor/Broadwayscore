---
name: stats global vs filtered
description: "UI counts from getDataStats() (Broadway-filtered); round down to nearest 50."
type: feedback
originSessionId: 96154346-df8a-4247-9303-ff1a49c01f18
archived: true
---
When a UI element shows a count of critics, outlets, reviews, or shows on a Broadway-context page, source it from `getDataStats()` in `src/lib/data-core.ts`, not from the registry files.

**Why:** `critic-registry.json` (514 entries) and `outlet-registry.json` (938 entries) are GLOBAL across all markets. But `getDataStats()` filters to reviews of Broadway shows only and counts unique critic-NAME strings (942) and outlet IDs (396). The two are not interchangeable — and counterintuitively, the Broadway-filtered critic count is *higher* than the registry, because review records contain spelling variations and historical writers across an outlet's full history. The Broadway-filtered outlet count is *lower* because many registry outlets only cover WE/OB.

**How to apply:** If a copy line says "X critics" or "Y outlets" or similar, pass `stats.totalCritics` / `stats.totalOutlets` from page.tsx through HomePageClient → component props. Round down to the nearest 50 (`Math.floor(n / 50) * 50`) so the displayed copy degrades gracefully as the data grows. Never hardcode the number; never read the registry directly. Discovered 2026-04-15 during /ship-check on the homepage explainer shelf — would have shipped "420+ critics" (registry-based estimate) when actual is "900+ critics across 350+ outlets" (Broadway-filtered).
