---
name: awards-json-dual-repo
description: awards.json lives in both web repo and private data repo; CI overlays the private copy
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b4e3c2d2-928d-4a65-85d6-a6a6914a9bc6
---

awards.json is tracked in BOTH `/Users/tompryor/Broadwayscore/data/awards.json` (web repo) AND `/Users/tompryor/broadway-scorecard-data/awards.json` (private data repo).

`.github/actions/checkout-core-data/action.yml` copies the private repo's `*.json` files over `data/` in CI. So **public-repo edits to awards.json are silently overwritten** by CI.

**Why:** Discovered 2026-05-22 fixing tony-deny-list.test.mjs. Public-repo awards.json was clean, scrape-tony-awards.js had a deny-list, but the test still failed in CI because the private repo's awards.json still had the misattributed entries.

**How to apply:** When fixing awards.json regressions, you MUST commit the fix to BOTH repos. Use the same pattern as [[dual-repo-data-files]] — except awards.json is the only file tracked in both rather than symlinked. Worktrees don't have access to the private repo's data unless you symlink shows.json/reviews.json manually.
