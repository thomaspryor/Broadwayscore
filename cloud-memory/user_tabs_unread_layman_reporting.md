---
name: user-tabs-unread-layman-reporting
description: "Owner 2026-07-25: never looks inside cmux tabs — wants them closed and everything reported in plain layman's terms in the one morning email; tabs are only for work that needs the owner"
metadata: 
  node_type: memory
  type: user
  originSessionId: e90b817f-c373-4276-8942-8d308c3510d4
  modified: 2026-07-25T17:13:37.073Z
---

The owner said plainly (2026-07-25): "I never look inside the tabs anyway. I just
want them closed. I only want to know what happens in layman's terms, simply."

**Why:** Tab-based visibility is push-based clutter for this owner; the morning
email + Notion cards are the only surfaces they actually read.

**How to apply:** Prefer headless/background execution over cmux tabs for any
work that doesn't need the owner's eyes; report outcomes through the morning
email's plain-language path ([[feedback_terse_output_default]]). Don't build
tab-facing status displays. Tab lifecycle: ✅-mark on verified done so
bsc-prune (nightly in autonomous-nightly.sh) closes them; never auto-close
unmarked ([[never-close-unmarked-cmux-workspaces]]).
