---
name: feedback-report-cmux-tab-titles-not-numbers
description: "Never reference dispatched sessions as \"workspace:<N>\" in owner-facing text — use the cmux TAB TITLE (e.g. \"Data·LIVE TEST of evidence-anchored…\"); numbers are invisible in the owner's sidebar"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0bb4f0cb-c00e-4d66-a31b-8aef1dea1697
  modified: 2026-07-30T17:04:32.200Z
---

When reporting a dispatched session to the owner (DISPATCHED/CONTINUING lines, status blocks, Notion outcomes), identify it by its cmux **tab title** — the `🤖<glyph> <Project>·<Card subject>` string the sidebar displays — never by `workspace:<N>`.

**Why:** The owner's cmux sidebar shows titles only. "workspace:165" is unfindable for them. They corrected multiple sessions on this before it was fixed (escalation 2026-07-30).

**How to apply:** `bsc-next.js` now prints the tab title in its launch line (fix shipped 2026-07-30) — quote that line's title verbatim. If you only have a `workspace:<N>` ref, resolve the title via `buildAutoTitle` in [[scripts/lib/workspace-naming.js]] or `cmux` listing before reporting. Related: [[feedback_never_close_unmarked_cmux_workspaces]].
