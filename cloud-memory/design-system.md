---
name: design-system
description: "Surfaces, score tiers, shared components, CSS classes, banned patterns."
type: reference
originSessionId: 03331355-b799-4a61-9faa-8c76f85a8e6e
modified: 2026-07-21T22:47:46.777Z
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
| `ScoreBadge` | Score display badge with tier colors and crown. Sizes: `xs` (fixed 40px at every breakpoint, for dense list rows such as the Stats drill-down; crown uses the `mini` size), `sm` (44px, 68px at lg), `md` (56px, 68px at lg), `lg` (64/80px). Never hand-roll a `.score-badge` chip; use `xs` |
| `ScoreBreakdownBar` | Horizontal bar showing rave/positive/mixed/negative distribution |
| `ShowListCard` | Primary card for show listings (image + score + metadata) |
| `MiniShowCard` | Compact card for shelves and grids |
| `AddShowCard` | Diary/watchlist add action with shared card styling, icon and label in grid or list layout; opens, reveals and focuses the header search |
| `ScrollRow` (`@/components/ScrollRow`, not in show-cards) | Wrap every horizontal poster shelf in it: adds desktop prev/next arrows because `scrollbar-hide` leaves mouse users no cue. Never hand-roll a bare `overflow-x-auto scrollbar-hide` card row. |
| `StatusBadge` | Open/Closed/Previews pill |
| `FormatPill` | Musical/Play/Revival pill |
| `ProductionPill` | Broadway/WE/OB pill |
| `AudienceChip` | Audience grade display |
| `CategoryBadge` | Category indicator |
| `ToggleBar` | Toggle between view modes |
| `ScoreToggle` | Critics vs. audience score switcher |
| `StatGrid` | Grid layout for statistics |
| `ColumnHeader` | Sortable table header with direction indicators |
| `Modal` / `ModalCloseButton` | Modal dialog container — portals to `<body>` (safe inside `.card`, whose `contain: layout style` would otherwise trap `position:fixed`). `maxWidth`: `sm` \| `md` \| `lg` (520px) \| `xl` (`max-w-3xl`, added 2026-07-21 for the Review Import preview) |
| `ShowSearchDropdown` | Search/autocomplete for shows |
| `MustSeeCrown` | Crown icon for Critical Gold scores |
| `CostStatusPill` | Box-office cost status (Well Above / Above / Near / Below Cost, Too early, No cost, Closing/Closed). Takes `costPill()` from `@/lib/box-office-v2-display`; tones map to `status-open`, `status-closed-bg`, `score-tepid`, dashed pending. BRO-5007, unreleased |
| `DataStalenessBanner` | Amber (`score-tepid`) "data may be out of date" banner for feed-backed pages. Props `lastUpdated`, `kind` (`ticket-policies` 7d / `grosses` 10d), `thresholdDays`, `market`. Not dismissible; decided client-side after mount (static export). On the 11 lottery/rush/SRO/discount/best-value/box-office pages (Broadway + West End), found by scan in the unit test. Ticket pages pass `getLotteryRushLastUpdated()` = lottery-rush.json `lastCheckedAt` (last successful scrape), falling back to `lastUpdated` (BRO-5261). BRO-901 |

**Other shared utilities** (not in show-cards barrel but used by it):
- `ShowImage` from `@/components/ShowImage` — Optimized show image with fallback/loading states
- `getOptimizedImageUrl(url, size)` from `@/lib/images` — CDN-optimized image URL builder
- `RatingEditor` from `@/components/user/RatingEditor` — shared user rating editor (adjustable half-stars, date-seen capped to min(today, closing), 2000-char private notes, failed-save keeps draft + Retry, `'auth-gated'` onSave contract keeps editor open behind sign-in). Bottom-sheet Modal on mobile / inline card on desktop via live matchMedia. The ONLY rating editor — do not resurrect ReviewPanel/ShowPageRating (fixture-only legacy).
- Box office (BRO-5007, behind `commercial && boxOfficeV2`): `BoxOfficeThisWeek` from `@/components/BoxOfficeStats` (the gross/capacity/avg-ticket/attendance tiles, reused by v1 and v2); `BoxOfficeMultipleChart` (SVG bars of gross ÷ weekly cost, dashed 1× line, cream typical-show line; `mode="gross"` for no-cost shows; pass `width={340}` on phones so 12px labels stay legible); `BoxOfficeScorecardV2` (the show-page card; load it with `next/dynamic` only, guarded by `commercial-unreleased.test.mjs`). All copy lives in `@/lib/box-office-v2-display`
- `AdSlot` from `@/components/ads/AdSlot` — the only AdSense unit (BRO-5893). `.card bg-surface-raised` box with a small `text-gray-400` "Advertisement" label (gray-500 fails AA on surface-raised) around a fixed 300×250 `<ins>`; renders nothing unless `decideAdRender()` in `@/lib/ads` passes (flag `ads`, signed out, not automated, `bwsc_ad_region=ads-ok`, IDs set) and hides itself on `data-ad-status="unfilled"`. Never hand-roll an `adsbygoogle` tag; add slots to `AD_SLOTS`
- `StarRating` from `@/components/user/StarRating` — half-star input/display; interactive half derived from pointer-x (keyboard Enter = whole star), `readOnly` renders role="img" display

**Rule:** Before creating any new UI component, check this list. If a shared component exists, use it. If you need a new shared component, add it to `show-cards/` and export from `index.ts`.

## Text Size Floor (owner decision 2026-07-12)

UGC / user-facing surfaces: **12px (`text-xs`) is the minimum text size** — no `text-[10px]`/`text-[11px]` micro-labels (owner: "too small"). 36 instances were bumped across ShowHeroRedesign, RatingEditor, My Shows, ListsTab, MezzanineImport on 2026-07-12.

## Button Hierarchy (owner decision 2026-07-12 — CI-guarded)

One rule, no exceptions: **`.btn-primary` (champagne-gold gradient `#d4a574→#b8956a`, white text — the Get Tickets treatment) = THE single primary action of a screen.** Get Tickets, "+ Add show", "Create a list", Save/Retry in the rating editor. **`.btn-secondary` (neutral fill `bg-white/10 border-white/15 text-white`) = every other tappable action** (Want to See, Rate it, Cancel). **Bright `#FFD700` is reserved for stars and scores ONLY — never a button/border/background fill class** (SVG `fill=` in star/score art is the sanctioned use). Active/selected states use brand tints (`bg-brand/10 border-brand text-brand`), not gold.

Enforced by `tests/unit/button-hierarchy.test.mjs` (registered in test.yml): fails CI on any `bg-[#FFD700]`/`border-[#FFD700]`/`hover:bg-[#e6c200]` class in src. Don't hand-roll gradients or gold pills — use the classes.

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
| `text-gray-500`, `text-gray-600` (text) | `text-fg-muted` (#969da9: 6.3:1 on raised, 4.6:1 on elevated; gray-500 is 3.6:1 and fails AA). Guard: `node scripts/audit-text-contrast.js --strict` (BRO-6553). Empty-star/icon SVGs may keep gray-600 |
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

The `/biz` dashboard, topic pages and season pages share `src/components/biz/BizHeader.tsx`: brand eyebrow pill, responsive title and tagline, share control, and children for statistics and fine print. Keep back links in the page or topic shell above the hero.

Profitability Scorecard show lists use `src/components/biz/ShowLinkListItem.tsx` to widen the mouse target through `openRowLink`. Keep a real show link inside it with `RowLinkArrow label={title}` for keyboard access and a chevron that stays with the final word. Aggregate rows with no single show destination stay plain.

When adding new shared components or tokens, update this file. When a session reads this doc and finds it incomplete, add the missing information before proceeding.
