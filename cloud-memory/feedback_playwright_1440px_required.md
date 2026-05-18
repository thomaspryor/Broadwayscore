---
name: feedback_playwright_1440px_required
description: UI screenshots must be taken at 1440px wide before committing — small viewports hide desktop misalignment
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a41695bf-11df-44a9-bb18-74431ce60773
---

Always resize Playwright to 1440×900 before taking the verification screenshot for any UI change.

**Why:** The three-column odds layout (GoldDerby/Polymarket/Kalshi) shipped with columns misaligned at desktop widths because the verification screenshot was taken at the default small viewport (~600px). The flex-1 title area expands at wider widths, shifting column positions — misalignment that's invisible at 600px becomes obvious at 1440px.

**How to apply:** After any `Edit`/`Write` to a `.tsx` file, always call:
1. `mcp__plugin_playwright__browser_resize` → width: 1440, height: 900
2. `mcp__plugin_playwright__browser_navigate` to the relevant page
3. `mcp__plugin_playwright__browser_take_screenshot`
4. `Read` the screenshot and verify before committing

Also test 390px (mobile) for any layout that has responsive breakpoints.
