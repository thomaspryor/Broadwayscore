---
name: feedback_satori_display_flex
description: "Every div with >1 child needs display:'flex' or HTTP 500 at render."
type: feedback
originSessionId: 03331355-b799-4a61-9faa-8c76f85a8e6e
archived: true
---
Satori (the rendering engine behind Next.js `ImageResponse` / `next/og`) requires **every `<div>` with more than one child node** to have explicit `display: 'flex'` (or `display: 'none'`) in its inline `style` object. Missing this returns HTTP 500 with `Error: Expected <div> to have explicit "display: flex" or "display: none" if it has more than one child node.`

**Why:** Satori doesn't support block-level layout. Flex is the default.

**How to apply:**
- When writing `opengraph-image.tsx` or any `ImageResponse` route, add `display: 'flex'` to every `<div>` defensively, even divs with a single child — it's cheap and prevents a class of bug that only shows at render time.
- Conditional children (e.g., `{count > 0 && <div />}`) can flip a single-child div into multi-child — belt-and-suspenders the parent.
- Testing via dev server catches this immediately; static build alone may not.

**Reference:** Fixed 2026-04-13 in `src/app/show/[slug]/opengraph-image.tsx` during dynamic OG image implementation. Added `display: 'flex'` to all divs in the render tree.
