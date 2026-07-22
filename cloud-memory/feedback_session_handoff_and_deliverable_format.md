---
name: feedback-session-handoff-and-deliverable-format
description: "Four rules from the 2026-07-21 iOS-design fiasco (6 rejected deliverables, heavy Fable burn): (1) ask the deliverable-venue question FIRST on design/creative asks (Claude Design vs artifact vs in-app), (2) two rejections of the same deliverable = STOP and ask format, don't produce a third variant, (3) verify a dispatched session's deliverable yourself before pointing the owner at it, (4) refer to other sessions by their VISIBLE cmux title, never workspace/task IDs."
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-07-22T01:10:24.218Z
  originSessionId: 78c06e5a-3954-45b7-ae27-6f6790082fbf
---

2026-07-21: an iOS design session produced SIX rejected versions of "the design recommendation" (text doc → invented HTML mocks → captures+text → mocks again → stripped → composites) before discovering the owner expected it in **Claude Design** (DesignSync tool, deferred toolset) all along. Owner: "This is unfable and is costing you a huge amount of credits for zero gain."

**Why:** Never asked where/how the owner wanted to review the deliverable; each rejection triggered a patch of the previous artifact instead of a step back; DesignSync sat unloaded in the deferred tools list the whole time; dispatched sessions' output (blurry embeds, an empty options column) reached the owner unverified.

**How to apply:**
1. **Venue first.** Any design/creative-deliverable ask: before producing anything, check the toolset for a purpose-built venue (ToolSearch: design/canvas/figma-ish) and if the venue isn't obvious, ask ONE question: "Where do you want to review this — Claude Design, an artifact page, or rendered in the app?" This is a legitimate user-decision question, not a banned can-answer-myself question.
2. **Two-strikes circuit breaker.** If the owner rejects the same deliverable twice, the third response is NOT another variant — it is a restatement of what you think they want + the format question. Six iterations happened because every rejection was answered with more production.
3. **Dispatched work isn't done until YOU verified the deliverable.** Before telling the owner "workspace X delivered," open the actual output (artifact/design project) and check the acceptance bar (images sharp ≥900px from original PNGs, no empty sections, options present). Task #256's output shipped blurry + with an empty column because nobody looked.
4. **Refer to sessions by their VISIBLE title.** The cmux dashboard shows titles like `🤖🧠 Data·iOS: HIGH-FIDELITY proposed designs (images, with ` — "workspace:200" and "task #277" are internal IDs the owner cannot find. Always quote the title prefix from `buildAutoTitle` (bsc-next prints it), e.g. "the workspace named '🤖 Data·iOS: HIGH-FIDELITY proposed designs…'".

Related: [[feedback-ios-design-conservative-real-tokens]] (HTML mockups banned; Claude Design venue also in BroadwayScorecard-app/CLAUDE.md).

**Addendum 2026-07-21 (same night):** API-level verification is NOT owner-level verification. DesignSync listed the project as isOwned:true, but the owner's browser got "no access" (authorization org ≠ browser org), and the design-SYSTEM pane was the wrong venue category for design PROPOSALS anyway. Rule sharpened: before reporting a deliverable ready, exercise the exact link the owner will click, and match the venue's CATEGORY to the content (proposal ≠ design system). Venue still unvalidated — see task #293.

**Addendum 2026-07-22 (task #293):** Venue confirmed with owner — "Design (Labs)" in their claude.ai sidebar. Found a dedicated DesignSync project already existed (`iOS App — Proposed Designs`, `d21b75cc-0388-4721-81f5-d886f744919f`) with all 10 proposal groups, separate from the design-system project — fixes the category mismatch. Deleted the duplicate `ios-design-proposals/` subtree that was still sitting inside `Broadway Scorecard Design System` (`469cbecf-...`) so that project is pure design-system content again. **Could not diagnose or fix the underlying no-permission bug** — no tool in this session's toolset exposes which claude.ai account/org a DesignSync authorization is bound to, and there's no `/design-login` skill/command locally to re-run; this is a claude.ai-side account/org selection that only the owner's own browser can resolve (e.g. their org switcher). Left as an owner-verification gate: both project links are asserted-but-unverified until the owner clicks one and confirms.
