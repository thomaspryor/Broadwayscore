---
name: Test pipeline/scraper fixes with dry-run, not just syntax check
description: "After scraper logic edits, --dry-run vs real data; node --check is syntax only."
type: feedback
archived: true
---

When fixing scraper pipeline logic (merge rules, sanitizers, URL normalization), always test with `--dry-run` or a unit test against real data. The user called this out — syntax checks don't prove the fix works.

**Why:** Pipeline fixes that pass `node --check` but aren't tested against real data can silently fail on next scrape run, undoing the fix.

**How to apply:** After any change to `scrape-lottery-rush.js`, `scrape-grosses.ts`, or `scrape-alltime.ts`:
1. Run `node scripts/scrape-lottery-rush.js --dry-run --source=bwayrush` and verify the sanitizer output
2. For scrape-grosses/alltime, write a unit test inline (`node -e "..."`) that exercises the new logic with representative inputs
3. Don't claim "systematic fix" unless you've verified the pipeline will enforce it on next run
