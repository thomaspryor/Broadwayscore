---
name: wrongProductionAutoCleared must be pushed to private data repo
description: Local wrongProduction auto-clears don't propagate to CI unless the private data repo is pushed
type: feedback
originSessionId: ad07f333-0334-4853-a39e-87dfbfc8af47
archived: true
---
After any rebuild that auto-clears wrongProduction (sets wrongProductionAutoCleared), immediately push the changed files to the private data repo (`git -C data/review-texts add ... && git -C data/review-texts push origin main`).

**Why:** CI checks out the private data repo independently. If wrongProductionAutoCleared is set locally but the file isn't pushed, CI sees the stale wrongProduction:true and fails audit B_false_positive_wp. This happened twice with i-was-a-teenage-shedevil-west-end-2026/london-theatre--unknown.json (2026-04-18).

**How to apply:** After any `rebuild-all-reviews.js` or `wrongprod` autoclear run, check `git -C data/review-texts status` and push any changed review-texts files before the next CI run. The symptom is B_false_positive_wp in the audit contamination check.
