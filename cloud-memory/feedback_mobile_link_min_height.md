---
name: feedback_mobile_link_min_height
description: "globals.css forces a{min-height:44px} on mobile for tap-target accessibility. Compact table rows (PerformerRow, CraftRow) opt out via .performer-row/.craft-row CSS exceptions. Tried inverting the global rule on 2026-05-20 — reverted because it shrunk many real tap targets (\"Full Review\" links, breadcrumbs, \"See all\" links)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1a25c184-f59d-4a37-ac18-b9ac849c3edc
---

## Current state (post 2026-05-20)

`globals.css` `@media (max-width: 640px)` rule:
```css
button, a, [role="button"] { min-height: 44px; min-width: 44px; }
p a, span a, li a { min-height: auto; min-width: auto; }
.performer-row a, .craft-row a { min-height: auto; min-width: auto; }
```

The exception list is intentional: compact table rows opt out, everything else (including "See all" links, "Full Review" links per critic review, breadcrumbs, methodology links) gets a 44px tap target.

## Don't invert the global rule

**Lesson learned (2026-05-20):** I tried removing `a` from the rule entirely so all anchors get natural text height, and adding opt-in `.touch-target` for cases that need 44px. Looked clean in theory. In practice it shrunk 18+ real tap targets per show page ("Full Review" links per critic card), 7 on the homepage ("See all" links above show carousels, methodology links), 5 on guides ("Home" breadcrumb, "About"). These are inline-text-styled links that DON'T have explicit `min-h-[44px]` and DID rely on the global rule for iOS accessibility.

The trap is real but the global rule is also actively useful. The right architecture is "sensible default + scoped exceptions" — exactly what the current rule does.

## How to apply

When debugging "rows look too tall on mobile":
1. Run `npx playwright test tests/e2e/tony-nominees-row-height.spec.ts` — does it fail? If yes, you've reintroduced an inflation source.
2. DOM-inspect a single text element inside the row. If it's 44px when font/padding say it should be ~16-20px, look for a `min-height` rule.
3. **Add a new exception class** to globals.css for the affected row type (e.g. `.designer-row a { min-height: auto }`). Apply that class to the row container in JSX.
4. **Do NOT invert the global rule.** It protects accessibility everywhere else.

## Regression guard

`tests/e2e/tony-nominees-row-height.spec.ts` measures actual row heights at 390px width via Playwright. Caps: Major≤110, Performer≤70, Craft≤90. Tests OUTCOME, so it catches any future cause of row inflation — not just min-height regressions, but min-h Tailwind utils, aspect-ratio siblings, padding, etc.
