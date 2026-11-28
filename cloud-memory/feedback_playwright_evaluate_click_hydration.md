---
name: page-evaluate-click-races-react-hydration
description: "Synthesized DOM .click() inside page.evaluate fires before React's onClick handler attaches during hydration. Use page.getByRole().click() (or any Playwright locator click) for actionability waiting."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a7719f7a-f7c7-42b3-adb6-b25b8810feeb
---

A button rendered via SSR is present in the DOM long before its React onClick is attached during hydration. Playwright `page.locator().click()` gates on actionability and waits for the handler to be live. A `clearAll.click()` synthesized inside `page.evaluate(() => ...)` does not — it fires the synthetic click and React drops it on the floor.

**Why:** Caught 2026-05-23 in `tests/e2e/filter-panel-sync.spec.ts` clear-all subtest. CI consistently failed for /west-end (3 of 5 runs) with `writes=[]` and the URL unchanged after the "Clear all" click. The chips polled fine (DOM present), but ActiveFilterChips's hydration finished after the synthesized click. Locally the same test passed 80× against production — only CI's slower hydration window exposed the race. The Notion card (369637c5-416f-81c1-9b3d-f778b2d67b92) misattributed it to a per-market config mismatch; all four pages share an identical `handlePanelClearAll` + `PANEL_PARAM_KEYS`.

**How to apply:**
- For any e2e click on a freshly-loaded page, prefer `page.getByRole('button',{name:'…'}).click()` over `(elementHandle).click()` inside `evaluate`.
- If you also need to instrument something on `window` (e.g. wrap `history.replaceState`) install the instrumentation in a prior `evaluate`, then do the Playwright click, then read the captured state in a follow-up `evaluate`.
- "Element renders in DOM" ≠ "React handler attached." Don't rely on polling for DOM presence as a hydration signal.
- Symptom to recognise from a trace artifact: `writes=[]` plus an unchanged `finalUrl` after a click that should have written URL — the click never reached the handler.
