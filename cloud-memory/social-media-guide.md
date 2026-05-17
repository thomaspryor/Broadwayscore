---
name: social-media-guide
description: "Brand palette, badge specs, typography, Buffer post templates."
type: reference
originSessionId: 03331355-b799-4a61-9faa-8c76f85a8e6e
archived: true
---
# BWSC Social Media Design Guide

Reference for creating on-brand social media graphics and Buffer posts. All values sourced from the live codebase.

## Brand Palette

### Core Brand
| Color | Hex | RGB | Use |
|-------|-----|-----|-----|
| **Brand Gold** | `#d4a574` | 212, 165, 116 | Primary brand color. Buttons, links, accent text, logo suffix |
| **Brand Gold Hover** | `#c4956a` | 196, 149, 106 | Hover/pressed state of brand gold |
| **Brand Gold Light** | `#e4b584` | 228, 181, 132 | Light emphasis variant |
| **Dark Background** | `#0f0f14` | 15, 15, 20 | Page background. Use for social image backgrounds |
| **Card Background** | `#1a1a24` | 26, 26, 36 | Raised card surface. Use for text boxes on dark bg |
| **White** | `#ffffff` | 255, 255, 255 | Primary text on dark backgrounds |
| **Muted Text** | `#9ca3af` | 156, 163, 175 | Secondary/caption text (gray-400) |

### Per-Market Branding
| Market | Accent Color | Hex | Gradient |
|--------|-------------|-----|----------|
| **Broadway** | Gold | `#d4a574` | Linear gold gradient (brand signature) |
| **West End** | Pink | `#f472b6` | `from #f472b6 to #ec4899` (pink-400 → pink-500) |
| **Off-Broadway** | Gold | `#d4a574` | Same as Broadway |

## Score Tier Colors

These are the 5 tiers that define how shows are rated. Each tier has a distinct color used in badges, text, and backgrounds.

| Tier | Score Range | Color Name | Hex | RGB | Background Hex |
|------|-----------|------------|-----|-----|----------------|
| **Critical Gold** | 83-100 | Amber | `#fbbf24` (amber-400) | 251, 191, 36 | `rgba(251, 191, 36, 0.2)` |
| **Recommended** | 75-82 | Emerald | `#34d399` (emerald-400) | 52, 211, 153 | `rgba(52, 211, 153, 0.2)` |
| **Worth Seeing** | 65-74 | Sky Blue | `#38bdf8` (sky-400) | 56, 189, 248 | `rgba(56, 189, 248, 0.2)` |
| **Skippable** | 55-64 | Orange | `#f97316` (orange-500) | 249, 115, 22 | `rgba(249, 115, 22, 0.2)` |
| **Stay Away** | 0-54 | Red | `#f87171` (red-400) | 248, 113, 113 | `rgba(248, 113, 113, 0.2)` |

### The "Must-See" Gold Badge (Signature Visual)

The most recognizable BWSC visual element. A metallic gold badge with shimmer animation.

**Gradient stops:** `#DAA520` (0%) → `#FFD700` (30%) → `#FFF0A0` (50%) → `#FFD700` (70%) → `#DAA520` (100%)
**Border:** 2px solid `#C8960E`
**Glow:** 24px outer glow at `rgba(218, 165, 32, 0.55)` + 12px inner at `rgba(255, 215, 0, 0.4)`
**Text color:** Dark (`#1a1a1a`) on the gold background
**Shimmer:** A white highlight sweeps left-to-right every 2.5 seconds

For social graphics, replicate this as a gradient rectangle with dark bold text (the score number) centered inside. The gold glow is key to the premium feel.

### Audience A+ Badge

Green gradient badge for top audience scores.

**Gradient:** `#22c55e` (0%) → `#16a34a` (50%) → `#22c55e` (100%)
**Glow:** 24px at `rgba(34, 197, 94, 0.5)`
**Text:** White

## Status Colors

| Status | Color | Hex |
|--------|-------|-----|
| Open / Running | Emerald | `#10b981` |
| Closed | Gray | `#6b7280` |
| Previews | Purple | `#a855f7` |

## Typography

| Element | Font | Weight | Style |
|---------|------|--------|-------|
| **Headlines** | Inter | 800 (ExtraBold) | Normal case |
| **Score numbers** | Inter | 700 (Bold) | Normal |
| **Body text** | Inter | 400 (Regular) | Normal |
| **Labels/chips** | Inter | 600 (SemiBold) | UPPERCASE, wide letter-spacing |
| **Brand name** | Inter | 700+ | "Broadway" in white, "Scorecard" in gold gradient |

**Inter** is a free Google Font: https://fonts.google.com/specimen/Inter

For social graphics where Inter isn't available, use **SF Pro** (Apple) or **Segoe UI** (Windows) as close alternatives.

## Visual Language

### Dark mode is the only mode
BWSC is exclusively dark-themed. All social graphics should use dark backgrounds (`#0f0f14` or `#1a1a24`) with light text. Never use light/white backgrounds.

### Gold is prestige
The gold gradient (`#d4a574` → `#b8956a`) signals quality and premium positioning. Use it for:
- Logo text ("Scorecard" in gold)
- Primary CTAs and highlights
- The Must-See badge

### Score badges are the hero
When sharing a show's score, the badge should be the focal point. Large, centered, with the tier-appropriate color and optional glow effect.

### Borders are subtle
Use `rgba(255, 255, 255, 0.05)` for card borders (barely visible, adds depth). Never use harsh borders.

### Spacing is generous
Cards have 16px internal padding. Sections have 32px vertical spacing. Don't crowd elements.

## Social Post Templates

### Show Score Announcement
**When:** A new show opens and gets scored
**Visual:** Score badge (large) + show title + tier label
**Text template:**
```
[SHOW TITLE] opens to [TIER LABEL] reviews.

Score: [XX]/100 ([TIER])
[Review count] critics weighed in.

broadwayscorecard.com/shows/[slug]
```
**Example:**
```
Proof opens to Critical Gold reviews.

Score: 88/100 (Critical Gold)
12 critics weighed in.

broadwayscorecard.com/shows/proof-2026
```

### Opening Night Roundup
**When:** Morning after opening
**Visual:** Show poster/image + score badge overlay
**Text template:**
```
Opening Night: [SHOW TITLE]

The critics have spoken: [XX]/100
[Rave/Positive/Mixed count breakdown]

Full breakdown: broadwayscorecard.com/shows/[slug]
```

### Weekly Recap
**When:** End of week with multiple openings
**Visual:** Grid of 3-4 show images with score badges
**Text template:**
```
This week on Broadway:

[SHOW 1]: [XX] ([TIER])
[SHOW 2]: [XX] ([TIER])
[SHOW 3]: [XX] ([TIER])

See all scores: broadwayscorecard.com
```

### Tony Predictions
**When:** Awards season
**Visual:** Show images with blended scores
**Text template:**
```
Tony predictions are live.

Critics say [SHOW]. Audiences say [SHOW].
Our blended score picks [SHOW] at [XX]/100.

Full predictions: broadwayscorecard.com/tony-predictions
```

### Fantasy League
**When:** Draft opens, season milestones, Tony night results
**Text template:**
```
Broadway Fantasy League: Draft is open!

$100 budget. 8 shows. Score points from critics, audiences, box office + Tonys.

Free to play: broadwayscorecard.com/fantasy
```

## Hashtags

**Always include:** `#Broadway` `#BroadwayScorecard`

**Show-specific:** `#[ShowName]` `#[ShowNameMusical]` or `#[ShowNamePlay]`

**Seasonal:**
- Tony season: `#TonyAwards` `#Tonys2026`
- Opening nights: `#OpeningNight` `#BroadwayOpeningNight`
- Awards: `#OlivierAwards` (West End)

**Community:** `#BroadwayTwitter` `#TheatreTwitter` `#NYCTheatre`

**West End:** `#WestEnd` `#WestEndScorecard` `#LondonTheatre` `#WestEndTheatre`

## Platform Notes

### Buffer scheduling
- Best times for Broadway content: 10-11 AM ET (pre-matinee), 6-7 PM ET (pre-evening), 9-10 AM ET Sunday (weekend planners)
- Opening night posts: 7-9 AM ET morning after (reviews are in, people are curious)
- Tony predictions: ramp up April-June

### Image specs
- Instagram: 1080x1080 (square) or 1080x1350 (portrait, better engagement)
- Twitter/X: 1200x675 (landscape)
- Facebook: 1200x630
- All: Use dark background, score badge as hero, Inter font, generous padding
