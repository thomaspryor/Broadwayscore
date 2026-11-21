---
name: feedback-maestro-scroll-to-top-flaky
description: Maestro scrollUntilVisible back to a segmented control near a sticky header taps the wrong element — use fresh openLink per variant instead
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7ba958af-25e1-4cdd-b618-7c1bf5e2a5f0
  modified: 2026-07-27T15:00:07.043Z
---

When a Maestro flow scrolls DOWN to screenshot content, then scrolls UP to tap a segmented-control tab near the top of the screen (to switch variants), the tap frequently lands on the sticky nav/header instead of the control, even though `scrollUntilVisible` reports success. This happened twice during task #595 (iOS show-page below-the-fold design proposals) — the "Option B" tap silently no-opped, and the follow-up scroll-to-top target (`bf-show-tab-hamilton`) sometimes failed to register as visible at all.

**Why:** `scrollUntilVisible` checks accessibility-tree bounds, not visual occlusion by an overlapping sticky header — a control positioned right at the screen top can be inside the visible-bounds check yet its actual tap point/first pixels overlap the real header view.

**How to apply:** for design-proposal capture flows with a segmented control or tab bar near the top of a scrollable screen, don't scroll back up to it mid-flow. Instead, re-issue `openLink` (or relaunch) to reset scroll to zero fresh, then tap the target variant immediately before any scrolling happens. Each variant gets its own clean load. Costs a few extra seconds per screenshot but eliminates the flake entirely — confirmed across ~10 variant captures with zero silent mis-taps once switched to this pattern.

See also [[feedback_worktree_code_changes.md]].
