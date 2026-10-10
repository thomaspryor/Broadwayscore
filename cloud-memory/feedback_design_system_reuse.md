---
name: feedback_design_system_reuse
description: Never create custom rank badges, score displays, or card layouts — always reuse ShowListCard/ScoreBadge/RankBadge patterns
type: feedback
originSessionId: ecd0b766-e4ad-47a4-a664-923e31dd7991
---
Never create custom rank badges, score displays, or card row layouts. Always reuse the existing design system components from `@/components/show-cards`.

**Why:** TrendingShowCard used custom square rank badges with gold/silver/bronze that looked identical to ScoreBadges — users couldn't tell rank positions from scores. Also used custom tier-colored card borders that no other page had. Fixed in commit ed826c72e6.

**How to apply:**
- Rank positions → `RankBadge` pattern from ShowListCard (round circle, `rounded-full`, gold top-3 via `bg-accent-gold`, neutral 4+ via `bg-surface-overlay`)
- Scores → `ScoreBadge` component (never custom score-looking elements)
- Card rows → `card` or `card-interactive` CSS classes, `hover:bg-surface-raised/80` — never tier-colored borders/backgrounds
- Stats columns → `w-20 sm:w-24` zone matching score badge placement
- Before building any new ranked/scored UI: read ShowListCard.tsx and MiniShowCard.tsx first
- New market-specific pages → separate routes (e.g., /trending + /west-end/trending), never combined columns
