---
name: design-system
description: "Surfaces, score tiers, shared components, CSS classes, banned patterns."
type: reference
originSessionId: 03331355-b799-4a61-9faa-8c76f85a8e6e
---
# BWSC Design System Reference

Read this before writing any UI code. Use existing tokens and components — never invent custom styling.

## Surface Colors (Dark Mode Palette)

| Token | Hex | Use for |
|-------|-----|---------|
| `bg-surface` | #0f0f14 | Page background, full-width sections |
| `bg-surface-raised` | #1a1a24 | Cards, panels, input backgrounds |
| `bg-surface-overlay` | #2a2a38 | Hover states, popovers, active items |
| `bg-surface-elevated` | #32323f | Modals, dropdowns, floating UI |

**BANNED — never use these:** `bg-zinc-*`, `bg-slate-*`, `bg-gray-900`, `bg-gray-800`, `bg-gray-700`, or any hardcoded dark hex in `style={{}}`. Always use the surface tokens above.

**Borders:** `border-white/5` (subtle), `border-white/10` (visible), `border-white/20` (hover emphasis). Never `border-zinc-*` or `border-gray-*`.

## Score System (5 Tiers)

Always use `getScoreBucket()` from `src/config/score-buckets.ts` or `getScoreTier()` from `@/components/show-cards`. Never hardcode score colors.

| Tier | Range | Text Class | Bg Class | CSS Badge Class |
|------|-------|-----------|----------|-----------------|
| Critical Gold | 83-100 | `text-amber-400` | `bg-amber-400/20` | `.score-must-see` |
| Recommended | 75-82 | `text-emerald-400` | `bg-emerald-400/20` | `.score-great` |
| Worth Seeing | 65-74 | `text-sky-400` | `bg-sky-400/20` | `.score-good` |
| Skippable | 55-64 | `text-orange-500` | `bg-orange-500/20` | `.score-tepid` |
| Stay Away | 0-54 | `text-red-400` | `bg-red-400/20` | `.score-skip` |
| Pending | null | `text-gray-400` | `bg-gray-400/20` | `.score-none` |

**Gold threshold is market-aware:** Broadway 83+, West End/Off-WE 85+. Always pass `category` to score functions.

**Helper functions:**
- `getScoreBucket(score, category?)` → full config (label, color, bgColor, description)
- `getScoreColor(score, category?)` → Tailwind text class
- `getScoreBgColor(score, category?)` → Tailwind bg class
- `getScoreTier(score, category?)` → tier object (from show-cards)
- `getScoreColorClass(score, category?)` → CSS class string (from show-cards)

## Status Colors (Use Domain Tokens)

Don't invent red/yellow/green combos. Use these existing domain tokens:

| Meaning | Token | Hex |
|---------|-------|-----|
| Success / Open | `text-status-open`, `bg-status-open-bg` | #10b981 |
| Warning / Tepid | `text-score-tepid`, `bg-score-tepid-bg` | #d97706 |
| Danger / Skip | `text-score-skip`, `bg-score-skip-bg` | #ef4444 |
| Info / Previews | `text-status-previews`, `bg-status-previews-bg` | #a855f7 |
| Neutral / Closed | `text-status-closed`, `bg-status-closed-bg` | #6b7280 |

## Brand Colors

| Token | Hex | Use for |
|-------|-----|---------|
| `bg-brand` / `text-brand` | #d4a574 | Primary actions, links, active states |
| `bg-brand-hover` | #c4956a | Hover on brand elements |
| `text-brand-light` | #e4b584 | Light variant for emphasis |
| `bg-brand-muted` | rgba(212,165,116,0.2) | Subtle brand backgrounds |
| `text-accent-gold` | #d4a574 | Decorative gold accents |
| `text-accent-cream` | #f5e6d3 | Light warm accent |
| `text-accent-purple` | #a855f7 | Purple accent (previews, special) |

**Per-market branding:** Use `getMarketBrand(market)` from `src/config/branding.ts`. Broadway = gold gradient, West End = pink gradient. Never hardcode brand colors.

## Shared Components (from `@/components/show-cards`)

Import: `import { ComponentName } from '@/components/show-cards'`

| Component | Use for |
|-----------|---------|
| `ScoreBadge` | Score display badge with tier colors and crown |
| `ScoreBreakdownBar` | Horizontal bar showing rave/positive/mixed/negative distribution |
| `ShowListCard` | Primary card for show listings (image + score + metadata) |
| `MiniShowCard` | Compact card for shelves and grids |
| `StatusBadge` | Open/Closed/Previews pill |
| `FormatPill` | Musical/Play/Revival pill |
| `ProductionPill` | Broadway/WE/OB pill |
| `AudienceChip` | Audience grade display |
| `CategoryBadge` | Category indicator |
| `ToggleBar` | Toggle between view modes |
| `ScoreToggle` | Critics vs. audience score switcher |
| `StatGrid` | Grid layout for statistics |
| `ColumnHeader` | Sortable table header with direction indicators |
| `Modal` / `ModalCloseButton` | Modal dialog container |
| `ShowSearchDropdown` | Search/autocomplete for shows |
| `MustSeeCrown` | Crown icon for Critical Gold scores |

**Other shared utilities** (not in show-cards barrel but used by it):
- `ShowImage` from `@/components/ShowImage` — Optimized show image with fallback/loading states
- `getOptimizedImageUrl(url, size)` from `@/lib/images` — CDN-optimized image URL builder

**Rule:** Before creating any new UI component, check this list. If a shared component exists, use it. If you need a new shared component, add it to `show-cards/` and export from `index.ts`.

## CSS Component Classes (from `globals.css`)

Use these classes directly in `className`. Don't recreate their styling.

**Cards:**
- `.card` — Standard card (raised surface, rounded, border, shadow)
- `.card-interactive` — Card with hover elevation + transform
- `.card-premium` — Card with subtle brand gradient overlay
- `.show-card` — Full clickable show card (extends card-interactive)

**Score Badges:**
- `.score-badge` — Base badge styling
- `.score-badge-sm` / `-md` / `-lg` / `-xl` — Size variants (w-10 to w-20)
- `.score-must-see` — Metallic gold gradient with shimmer
- `.gold-badge` / `.gold-badge-xs` / `-sm` / `-md` / `-lg` — Square gold list badges

**Status Chips:**
- `.chip` — Base chip (pill-shaped, uppercase, small)
- `.chip-open` / `.chip-closed` / `.chip-previews` — Status variants

**Buttons:**
- `.btn` — Base button
- `.btn-primary` — Gold gradient, white text, hover glow
- `.btn-ghost` — Transparent, gray text, hover white
- `.btn-active` — Brand background, white text

**Inputs & Filters:**
- `.search-input` — Full-width search field with brand focus ring
- `.filter-pills` — Horizontal scrollable filter container
- `.filter-pill-active` / `.filter-pill-inactive` — Filter pill states

**Tables:**
- `.data-table` — Full table styling (thead sticky, hover rows, dividers)

**Navigation:**
- `.nav-link` / `.nav-link-active` — Header nav links with underline animation

**Tier Badges:**
- `.tier-badge` + `.tier-1` / `.tier-2` / `.tier-3` — Outlet tier indicators

**Utilities:**
- `.text-gradient` — Gold gradient text (brand signature)
- `.divider` — Subtle white/5 border-top
- `.glass` — Glassmorphism (blurred raised surface)
- `.shine` — Hover shine sweep effect
- `.scrollbar-hide` — Hide scrollbars
- `.focus-ring` — Accessible focus ring with brand color

## Spacing & Radius Tokens

| Token | Value | Use for |
|-------|-------|---------|
| `p-card` / `gap-card` | 1rem | Card internal padding |
| `p-card-lg` | 1.5rem | Larger card padding |
| `py-section` | 2rem | Section vertical spacing |
| `rounded-card` | 1rem | Card border radius |
| `rounded-badge` | 0.625rem | Badge/button radius |
| `rounded-pill` | 9999px | Pill/chip radius |

## Typography

- **Font:** Inter (loaded via `next/font`, available as `font-sans`)
- **Score sizes:** `text-score-sm` (0.875rem) → `text-score-md` (1.125rem) → `text-score-lg` (1.5rem) → `text-score-xl` (2rem), all bold
- **Labels:** `text-xs font-semibold uppercase tracking-wide` (used in chips, column headers)
- **Headings:** `font-bold` or `font-extrabold`, standard Tailwind text sizes

## Animations

| Class | Effect | Duration |
|-------|--------|----------|
| `animate-fade-in` | Opacity 0→1 | 0.3s |
| `animate-fade-up` | Opacity + translateY 16px→0 | 0.7s |
| `animate-slide-up` | Opacity + translateY 10px→0 | 0.3s |
| `animate-slide-in` | Opacity + translateX -10px→0 | 0.4s |
| `animate-scale-in` | Opacity + scale 0.5→1 | 0.3s (spring) |
| `animate-pulse-subtle` | Opacity 1→0.8→1 | 2s infinite |

## Shadows

- `shadow-card` — Default card shadow
- `shadow-card-hover` — Elevated hover shadow
- `shadow-glow` — Brand gold glow (20px)
- `shadow-glow-sm` — Subtle brand glow (10px)

## Banned Patterns → Correct Replacement

| DON'T use | DO use instead |
|-----------|---------------|
| `bg-zinc-950` | `bg-surface` |
| `bg-zinc-900` | `bg-surface` |
| `bg-zinc-800`, `bg-zinc-800/*` | `bg-surface-raised` |
| `bg-zinc-700` | `bg-surface-overlay` |
| `border-zinc-*` | `border-white/5` or `border-white/10` |
| `text-zinc-400` | `text-gray-400` |
| `text-zinc-300` | `text-gray-300` |
| `text-zinc-500` | `text-gray-500` |
| `bg-slate-*` | Use `bg-surface-*` tokens |
| `bg-gray-900/800/700` | Use `bg-surface-*` tokens |
| Custom card borders | `.card` or `.card-interactive` class |
| Hardcoded hex in `style={{}}` | Tailwind classes from this guide |
| Custom red/yellow/green | Domain tokens (score-skip, score-tepid, status-open) |

## Enforcement

**CI guard:** `scripts/lint-design-tokens.js` (job: `design-tokens-lint` in `.github/workflows/test.yml`) blocks merges that introduce:
- `border-neutral` — `border-(gray|slate|zinc)-N` on any line
- `bg-slate-zinc` — `bg-(slate|zinc)-N` (all shades, all alpha variants)
- `bg-gray-dark` — `bg-gray-(700|800|900|950)` (dark solids and alphas — use `bg-surface*`)
- `text-slate-zinc` — `text-(slate|zinc)-N`
- `other-slate-zinc` — `(ring|divide|outline|from|to|via|decoration|caret|accent|shadow|fill|stroke|placeholder)-(slate|zinc)-N`

Run locally: `npm run lint:design`.

**Exemption format:** `// design-lint-ok[<rule-id>,<rule-id>]: <reason>` on the offending line.
- Rule ids in brackets are required (empty `design-lint-ok:` is ignored).
- Reason after the colon must be non-empty.
- Only the listed rules are skipped; other violations on the same line still fire.
- Multiple rules: `// design-lint-ok[border-neutral,text-slate-zinc]: reason`.

Example: `const x = 'border-gray-500'; // design-lint-ok[border-neutral]: legacy third-party widget, tracked in issue #xyz`

Use sparingly — drift is the default failure mode (129 zinc refs cleaned 2026-04-12, 44 gray/slate refs cleaned 2026-04-13 before the guard shipped).

## Visual regression baselines (test-ugc)

Playwright snapshot baselines live in `tests/e2e/__screenshots__/chromium/`. They are **linux-rendered** — you cannot regenerate them on a Mac (fonts/anti-aliasing differ, every snapshot would diff). Regenerate ONLY in CI:

```bash
gh workflow run test-ugc.yml -f update_snapshots=true   # writes + commits new baselines [skip ci]
gh workflow run test-ugc.yml                            # normal run to confirm the comparison passes
```

The `update_snapshots` run only *writes* baselines (it doesn't compare), so always follow it with a plain run to prove green.

**Scope snapshots to a component region, never `fullPage: true`.** Full-page snapshots capture the shared header/footer, so any unrelated chrome change (e.g. a new footer nav item) shifts everything and reds every feature baseline — this caused test-ugc to be red 2026-06-04..06 (+28px footer growth broke all My Shows snapshots). Clip to a stable container instead: `await expect(page.getByTestId('my-shows-content')).toHaveScreenshot(...)`. Add a `data-testid` to the feature wrapper if one doesn't exist.

## Maintenance

When adding new shared components or tokens, update this file. When a session reads this doc and finds it incomplete, add the missing information before proceeding.
