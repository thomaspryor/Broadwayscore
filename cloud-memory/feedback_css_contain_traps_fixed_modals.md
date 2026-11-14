---
name: css-contain-traps-fixed-modals
description: "Modal gotchas: .card's contain:layout traps position:fixed (must portal to body); module-level singleton state (modal stack, registries) is split-brain across Next.js chunks — coordinate via DOM/globalThis, never module scope"
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

**Second lesson (2026-07-11): module-level singletons are split-brain across Next.js chunks.** The first stacked-modal Escape fix used a module-level `openModalStack` array in `Modal.tsx`. Next's code-splitting compiled Modal into TWO chunks (verified by grepping `.next/static/chunks` for the component markup), so SignInModal and RatingEditor's Modal each had a private copy of the stack — each thought it was topmost, one Escape closed both, and every local spec passed (fixture = one chunk) while the real page failed. Fix: derive topmost-ness from the DOM (`last [role="dialog"][aria-modal] in body order` — all modals portal to body).

**How to apply:** any cross-instance coordination in a shared component (modal stacks, focus-trap registries, toast dedup, scroll-lock refcounts) must NOT live in module scope. Use the DOM as the shared registry, or `globalThis`, and verify with a test that stacks two instances mounted from DIFFERENT routes/chunks — or at minimum live-drive the real page. A green fixture spec proves nothing about chunk-duplicated state.
