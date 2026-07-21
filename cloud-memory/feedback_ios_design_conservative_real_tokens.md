---
name: feedback-ios-design-conservative-real-tokens
description: "iOS design proposals: fidelity honesty — anything shown as THE design must be a real product render or real-capture composite (sketches labeled, exploration-only); confirm review venue (Claude Design pref, unvalidated); 2-3 rendered options when direction contested. Authoritative: app CLAUDE.md Design Proposals."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 96f1f818-d58a-4563-b84f-6e1953558609
  modified: 2026-07-21T02:43:03.678Z
---

Two escalations, same day (2026-07-20/21):
1. First session: hand-drawn HTML mockups with web-palette colors → "don't seem to match our styling at all."
2. Second session (same day!) read this memory, then STILL shipped HTML mockups — twice — first with invented grays, then "token-accurate" ones. Owner: "random mocks in a design language that doesn't exist when we have our own design system? What the heck is going on… so lazy and weird and frustrating."

**Why:** The design system is not a hex list — it IS the code (constants/theme.ts + components/ rendered by RN). Any HTML re-creation, however token-accurate, differs in font rendering, spacing, radii, shadows, and real content, and reads as fake. The "exact tokens" allowance in the previous version of this rule was the loophole that let it happen again.

**How to apply:**
1. **Fidelity honesty (supersedes the earlier blanket ban):** nothing lower-fidelity than a real product render or real-capture composite may be PRESENTED as "the proposed design." Rough sketches are for private exploration only and must be labeled as sketches if shown at all. If you catch yourself writing `<div>` to depict a finished app screen for the owner, stop.
2. **Design proposal = code + screenshot.** Implement the variant in a worktree of BroadwayScorecard-app, render it in the simulator, `simctl io screenshot`, and present REAL captures (before/after side by side). JS-only changes: dev-client + Metro (`npx expo start` from the WORKTREE, deep link `broadwayscorecard://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081`) — verify the installed sim app is actually a dev client first (production builds silently ignore the dev-client URL and just foreground). If no dev client installed: `eas build --profile development` (or sim-prod) → simctl install.
3. **Options, not one-shots:** when direction isn't obvious, implement 2-3 variants (they're usually a few lines apart) and screenshot each. The owner explicitly asked for options: "it's fine to have a couple of options, not just try and one-shot it."
4. Baseline stays: current app is the reference; proposals incremental, approve/skip each.
5. Maestro gotchas: JAVA_HOME=/opt/homebrew/opt/openjdk@17; add `launchApp` first (taps land on whatever's foregrounded otherwise, e.g. Safari); NativeTabs labels not tappable by text — point taps (tab bar Y≈94%).

Authoritative version: BroadwayScorecard-app/CLAUDE.md "Design Proposals (principles)" — 4 principles incl. venue-confirmation with a validation checkpoint (Claude Design preference recorded 2026-07-21, unvalidated until first delivery). This file adds the pipeline gotchas.
