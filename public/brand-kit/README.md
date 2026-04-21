# Broadway Scorecard — Brand & Social Asset Kit

Complete asset suite for social, marketing, and partner use. All PNGs rendered at 2× DPI using the exact CSS tokens from the production site, so colors, gradients, shadows, and proportions match broadwayscorecard.com pixel-for-pixel.

## Easiest way to use (no setup)

Go to **https://broadwayscorecard.com/brand** → scroll to Downloads.

- **Download Entire Brand Kit** button grabs everything as one zip (52 PNGs + this README).
- Or click any individual tile (logo, badge, social template) to download just that one PNG.
- Transparent variants have an alpha channel — drop them onto any background in Canva, Buffer, PowerPoint, email, etc.

## Drag-and-drop use (this folder)

1. Open the folder you want (e.g. `logos/` or `social/`) in Finder.
2. Drag the PNG into Canva, Buffer, Figma, Keynote, Gmail — wherever.
3. Done.

## Folder map (52 PNGs)

### `logos/` — 8 files
- **Wordmarks** (1200 px wide): `{brand}-wordmark-{variant}.png`
  - brands: `broadway`, `west-end`
  - variants: `dark` (on dark background), `transparent` (alpha for overlay on dark), `light` (for light backgrounds — inverted colors)
- **App icon** (400 px square): `icon-dark.png`, `icon-transparent.png` — the "BS" badge

### `score-badges/` — 10 files
Individual critic-score tier badges (with tier label + description + range), 5 tiers × `dark`/`transparent`:
- `critical-gold-87-{variant}.png` — score 83–100, gold with crown
- `recommended-79-{variant}.png` — score 75–82, green
- `worth-seeing-70-{variant}.png` — score 65–74, teal
- `skippable-60-{variant}.png` — score 55–64, orange
- `stay-away-45-{variant}.png` — score <55, red

### `grade-badges/` — 22 files
Individual audience-grade cards (with "Audience Grade" header + mood label), 11 grades × `dark`/`transparent`:
- `grade-{Aplus|A|Aminus|Bplus|B|Bminus|Cplus|C|Cminus|D|F}-{dark|transparent}.png`
- Grade → mood mapping:
  - A+, A = Loving It · A- = Liking It · B+ = Liking It
  - B = Shrugging · B- = Shrugging
  - C+, C, C- = Disliking It
  - D, F = Loathing It

### `references/` — 4 files
Overview sheets showing all tiers side-by-side with BroadwayScorecard™ branding:
- `score-tiers-{dark|transparent}.png` — all 5 critic tiers horizontal
- `grade-tiers-{dark|transparent}.png` — all 11 audience grades, 3-row grid

### `social/` — 8 files
Brand-only placeholder cards at correct platform aspect ratios. Drop text/images over them, or use as "splash" posts when launching campaigns:
- `{broadway|west-end}-instagram-square-1080x1080.png` — IG feed post
- `{broadway|west-end}-instagram-story-1080x1920.png` — IG/TikTok/Reels story
- `{broadway|west-end}-og-1200x630.png` — Twitter/Facebook/LinkedIn link-preview image
- `{broadway|west-end}-twitter-header-1500x500.png` — profile header banner

## Brand tokens

| Token | Value | Usage |
| ----- | ----- | ----- |
| Background (dark) | `#0f0f14` | Page bg, social card bg |
| Card surface | `#1e1e2a → #16161f` (gradient) | Raised cards |
| Brand gold | `#d4a574 → #b8956a` (gradient) | "Scorecard" wordmark, Broadway accents |
| West End pink | `#f472b6 → #ec4899` (gradient) | "Scorecard" wordmark for West End |
| Critical Gold | `#DAA520 → #FFD700 → #FFF0A0` (gradient) + `#C8960E` border | Score 83–100 |
| Recommended | `#22c55e` | Score 75–82, A grade |
| Worth Seeing | `#14b8a6` | Score 65–74, A- grade |
| Skippable | `#d97706` | Score 55–64 |
| Stay Away | `#ef4444` | Score <55, C+ grade |

Typography: system stack (Inter on web, falls back to `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica`). For exports, any clean sans-serif works. Use weight 700–800 for display, 500–600 for body.

## Regenerating the suite

Anytime the site's design tokens change, update `generate.js` and re-run:

```bash
cd brand-assets
npm install         # one-time, installs playwright
node generate.js    # overwrites all 52 PNGs in ~15 seconds
```

The generator is the single source of truth. To add a new asset variant, add a new block to `generate.js` — don't hand-edit PNGs.

## What's NOT in this kit (and why)

- **SVG wordmark logos** — the production site uses live-rendered HTML, not SVG. Vector export would require hand-authoring and would drift from the live site. PNG at 2× DPI covers 99% of downstream use; ask if you need SVG for a specific print use case.
- **Dynamic show cards** ("{Show Name} just opened with a score of 87!") — templated per-show assets require a separate generator parameterized by show ID. Not included here; request if needed.
- **Video/motion** — not in scope for a static kit.

## Source of truth

All colors, gradients, shadows, and class names in `generate.js` are lifted verbatim from `src/app/globals.css` in the Broadway Scorecard repo. If the site's tokens change, the source of truth is `globals.css`; update this generator to match.

---
_Generated: 2026-04-19 · Broadway Scorecard brand asset suite v2_
