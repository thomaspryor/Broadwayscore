---
name: Demo feature flags must be checked in client components only
description: "isDemo()/window checks must run in 'use client' only; CI lint enforces."
type: feedback
---

Demo feature flags (theaterScorecard, showPageRedesign, userAccounts, showtimes) use `isDemo()` which checks `window.location.hostname`. During static generation `window` is undefined, so these flags always evaluate to `false` in server-rendered HTML.

**Why:** Theater scorecard was invisible on demo.broadwayscorecard.com because the flag was checked in the server-rendered page.tsx (fix: 7770e1b567, 2026-04-02).

**How to apply:** When adding a new demo-gated feature:
1. Never check `featureFlags.{demoFlag}` in server components or page.tsx files
2. Always move the check inside a `'use client'` component (e.g., the feature's own component)
3. CI lint in test.yml (`lint-feature-flags`) catches violations
4. If adding a new flag to DEMO_FEATURES in feature-flags.ts, add it to the CI grep pattern too
