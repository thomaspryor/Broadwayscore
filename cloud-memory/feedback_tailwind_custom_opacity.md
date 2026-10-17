---
name: Tailwind opacity modifier works on custom hex tokens
description: bg-surface-overlay/30 and similar compile to rgba() correctly — don't second-guess this during design-system cleanups
type: feedback
originSessionId: c0e956d5-f072-4b5a-b5dd-0be98dada9fb
archived: true
---
Tailwind v3's `/opacity` modifier works on custom hex color tokens defined in `tailwind.config.ts`, not just default palette colors. Classes like `bg-surface-overlay/30`, `bg-surface-raised/60`, and `border-white/[0.06]` compile to proper `rgba()` output.

**Why:** A ship-check subagent flagged `bg-surface-overlay/30` as a P1 "might silently fail" on 2026-04-13. Verification via `npx tailwindcss --content '...' --minify | grep surface-overlay` showed it produces `#2a2a384d` (the hex + 30% alpha) correctly. The concern was unfounded but cost a round-trip.

**How to apply:** When migrating `bg-gray-700/30` → `bg-surface-overlay/30` or similar, the opacity modifier carries over cleanly. No need to restructure as `bg-[rgba(42,42,56,0.30)]` or use `/[0.30]` arbitrary syntax. Trust the standard `/XX` modifier on any color in `theme.extend.colors`.

If a reviewer flags this pattern as risky, verify once with `npx tailwindcss --content ... --minify` and move on — don't let it block a PR.
