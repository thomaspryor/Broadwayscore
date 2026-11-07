---
name: feedback_playwright_1440px_required
description: SUPERSEDED by [[local-preview-before-push]] — scripts/visual-qa.mjs now sweeps 5 widths (360/414/768/1024/1440) with structural overflow probe + per-element full-resolution crops
archived: true
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a41695bf-11df-44a9-bb18-74431ce60773
---

**SUPERSEDED 2026-05-24** — see [[local-preview-before-push]] and `.claude/skills/visual-qa/skill.md`. The runner sweeps a broader set of widths automatically and reads element crops at full resolution to defeat the thumbnail-PASS failure mode.

Original content below for history:

Verify every UI change at **all three viewports**: mobile 390×844, tablet 768×1024, desktop 1440×900. Before AND after.

**Why:** Single-viewport verification has shipped multiple regressions: three-column odds layout misaligned at desktop (only visible at 1440px, screenshot taken at default 600px); mobile row height shrinkage and 3-col mobile layout overflow only visible at 390px; WhereItRanks overflow and footer card fit issues only visible at tablet 768px (Tailwind `md:` boundary, the band most layout transitions break in). 2026-05-23 update from CLAUDE.md §5: tablet was the silent gap — 601–1199px had zero coverage.

**How to apply:** After any `Edit`/`Write` to a `.tsx` file, for EACH of the three viewports:
1. `mcp__plugin_playwright__browser_resize` → 390×844 → 768×1024 → 1440×900
2. `mcp__plugin_playwright__browser_navigate` to the relevant page
3. `mcp__plugin_playwright__browser_take_screenshot`
4. `Read` each screenshot and verify before committing
5. For each viewport, check: layout overflow, text wrap, tap-target heights, score badge size, hover/click affordances.

Skipping any of the three is the regression vector. The tablet check is the newest and most-forgotten.
