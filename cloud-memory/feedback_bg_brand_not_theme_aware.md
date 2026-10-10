---
name: bg-brand is static gold, not theme-aware
description: Per-market theming must branch explicitly on market pair — bg-brand is a static hex (#d4a574), not a CSS var that reskins per route.
type: feedback
originSessionId: 15c626a0-aac6-42c9-a19c-d189b765b77b
archived: true
---
`bg-brand` in `tailwind.config.ts:61` resolves to a static gold hex `#d4a574`. It does NOT change color based on the active market route. A component rendered on `/west-end` using `bg-brand` will appear gold, clashing with the pink `WestEndScorecard` logo.

**Why:** MarketFilterBar v1 (2026-04-24) used `bg-brand` for primary-active market pill. Ship-check QA agent caught that the West End pill rendered gold, not pink. Fix: branch on the market pair and apply `bg-gradient-to-r from-pink-400 to-pink-500` for London routes explicitly.

**How to apply:** Any time you add a UI element that should visually match the current market's brand (Broadway gold, West End pink, Off-Broadway purple, Off-West End violet), check `tailwind.config.ts` and `src/config/branding.ts` first. If the token you reach for is a static hex, you must branch on the market pair yourself. Do not assume theme tokens switch automatically. The existing theme tokens are:
- Broadway: `bg-brand` / `text-gradient` / `from-brand` — gold
- West End: `from-pink-400 to-pink-500` gradient (used in logo at `MarketNav.tsx:36`)
- Off-Broadway: `purple-500` / `purple-300` / `purple-400` accents
- Off-West End: `violet-500` / `violet-300` / `violet-400` accents

See `src/components/MarketFilterBar.tsx:55-57` for the canonical pattern: `isNyc ? 'bg-brand …' : 'bg-gradient-to-r from-pink-400 to-pink-500 …'`.
