---
name: Ticket CTA placement rules
description: Never render CTAs outside card boundaries; screenshot before shipping; nested-link workaround pattern
type: feedback
archived: true
---

Never render ticket CTAs (or any interactive element) floating below show cards. Cards are self-contained visual units — anything hanging below them looks broken.

**Why:** The "Get Tickets" button was rendered outside the card's `<Link>` wrapper, creating an ugly floating button below each card on browse pages. User called it "HORRIBLE."

**How to apply:**
- When adding CTAs to show cards, put them INSIDE the card (inline with metadata, not below the card boundary)
- Since show cards are wrapped in `<Link>` (the whole card is clickable), you can't nest `<a>` tags. Use `<span role="link" onClick={stopPropagation + window.open}>` pattern instead
- Always take before/after screenshots at both mobile (390px) AND desktop (1440px) before shipping UI changes to cards
- The ShowListCard component has the inline ticket CTA pattern as reference (line ~107)
