---
name: flag-gated-verify-on-demo
description: "For flag-gated features, \"production deploy green\" is NOT the same as \"user-visible.\" Production renders nothing until the flag is flipped in Vercel; demo auto-enables all flags but builds via a separate cron. Verify the SURFACE the user actually visits before claiming live."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 86742c7c-b3e2-4ac0-b03b-02cdc7a24ce7
---

When shipping a feature behind `featureFlags.xxx`, do NOT claim it's "live" or "shipped" based on a green `vercel-deploy.yml` run alone.

**Why:** Production builds with the flag OFF render zero visible change. Demo builds with the flag ON via a separate `vercel-demo.yml` pipeline that:
- Runs on cron every 8 hours (6 AM, 2 PM, 10 PM UTC)
- Does NOT auto-trigger on every push to main (verified via demo workflow file 2026-05-16)
- Source-rewrites `feature-flags.ts` to enable every getter automatically

So even after main is merged + production deploy is green, demo can be hours behind. The user tests on demo and sees old behavior — a repeated, painful confusion.

**How to apply:**
- After merging a flag-gated feature:
  1. Confirm `vercel-deploy.yml` is green (production safe).
  2. Trigger `gh workflow run "Deploy Demo Site"` manually.
  3. Wait for that run to complete green.
  4. Curl/visit `https://demo.broadwayscorecard.com/<relevant-path>` and grep for the feature's known string before declaring it live.
  5. Tell the user the demo URL specifically when asking them to verify, not just `broadwayscorecard.com`.
- Conversely, if the user reports "I don't see it," check `gh run list --workflow=vercel-demo.yml --limit 3` BEFORE assuming a code bug.
- For prod-only verification of a flag-gated feature, the flag must be flipped via Vercel env (`NEXT_PUBLIC_FEATURES=...`) and prod redeployed.
- The hero rank line / WhereItRanks shipped 2026-05-16 hit this exact problem twice in one session.
