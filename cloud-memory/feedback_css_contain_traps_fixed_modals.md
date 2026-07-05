---
name: css-contain-traps-fixed-modals
description: ".card's contain:layout makes it the containing block for position:fixed — modals rendered inside cards get trapped; QA fixtures that force a different presentation hide this class of bug"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6687e1e0-8979-43b9-9502-a7b861e34e1b
---

The design-system `.card` class sets `contain: layout style` (globals.css:30). CSS containment (like transform/filter/backdrop-filter) makes the element the **containing block for `position:fixed` descendants**. A Modal rendered inside a `.card` is therefore positioned relative to the card, not the viewport — on 2026-07-05 the RatingEditor bottom-sheet's Save button landed below the fold on phones with body scroll locked (unsavable), live on demo.

**Why it escaped QA:** the Playwright fixture pinned `presentation="inline"` for determinism, and visual-QA screenshots cropped the fixture card — the Modal path was never exercised in its real mount context (inside the show-hero `.card`). All 44 specs were green while the shipped flow was broken.

**How to apply:**
1. `Modal.tsx` now portals to `document.body` (`createPortal`) — keep it that way; any new overlay component must either portal or never render inside `.card`/transformed ancestors.
2. Regression spec: `tests/e2e/rating-editor.spec.ts` "modal presentation escapes .card containment" + fixture `?presentation=modal` renders the modal inside a `.card` deliberately.
3. When a component has presentation variants, the fixture must exercise **every** variant in a realistic ancestor context — never force one variant "for determinism" and call the component verified.
4. Live-drive the deployed page (not just the fixture) for at least one happy path per viewport before calling a UGC flow shipped. [[feedback_ugc_test_patterns.md]]
