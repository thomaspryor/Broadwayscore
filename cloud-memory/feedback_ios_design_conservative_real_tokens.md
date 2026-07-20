---
name: feedback-ios-design-conservative-real-tokens
description: "Owner prefers the EXISTING iOS app layouts — design proposals must be incremental (approve/skip per change), and mockups must use the app's exact tokens (constants/theme.ts) or real simulator screenshots, never hand-approximated colors."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 96f1f818-d58a-4563-b84f-6e1953558609
  modified: 2026-07-20T14:53:49.257Z
---

2026-07-20, iOS redesign session: owner reviewed hand-drawn HTML mockups and said they "don't seem to match our styling at all… don't look great. Currently I prefer the existing iOS layouts to the ones you shared."

**Why:** The mockups used web-design-system colors (amber-400 tiers, bg-surface-overlay #2a2a38) where the app actually uses #FFD700 gold and #252530 overlay (constants/theme.ts) — close-but-wrong colors read as fake and undermined the whole proposal. And the proposals replaced whole layouts when the owner wanted the current structure kept.

**How to apply:** For any BroadwayScorecard-app design work: (1) baseline = current app, presented as real simulator screenshots (build → simctl boot/install → Maestro-driven tour → simctl io screenshot); (2) proposals = one small change each, framed approve/skip, rendered with EXACT values from constants/theme.ts; (3) never propose layout rework unless the owner asks. Simulator tour recipe worked 2026-07-20: Metro bg + dev-client deep link, Maestro taps (JAVA_HOME=/opt/homebrew/opt/openjdk@17; NativeTabs tab labels are NOT tappable by text — use point taps).
