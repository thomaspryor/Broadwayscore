---
name: verify-scores
version: "1.0.0"
description: "TRIGGER when: user has edited scoring logic (review-guards.js, rebuild-all-reviews.js, scoring.ts, engine.ts, data-core.ts), user wants to verify scoring changes, or CLAUDE.md rule 12 section on scoring-logic edits applies. Runs scoring-delta.js to surface T1 flips and total flip count before any push. MANDATORY for all scoring-logic edits — unit tests alone are not sufficient."
argument-hint: "[--base=<ref>] [--limit=<n>]"
allowed-tools: Bash, Read
user-invocable: true
---

# Verify Scores — Scoring Delta Check

This skill is MANDATORY before pushing any edit to scoring logic. Run it now.

## Background

On 2026-04-14, a "fix" to `applyTemporalOverrides` would have newly excluded 183 T1 reviews across 46 flagship shows (Hamilton, Giant, Hadestown, Phantom, Lion King, Book of Mormon). 276 unit tests passed. The counterfactual was only discovered post-merge by running `scoring-delta.js`.

Unit tests verify logic; this script verifies real-world impact.

## What It Does

`scoring-delta.js` replays the core inclusion decision against every review-text file under **both** HEAD's logic and the working-tree logic, then reports which reviews would flip inclusion. Exit code 2 = T1 flips or >5 total flips.

## Run It

```bash
cd /Users/tompryor/Broadwayscore

# Standard run (working tree vs HEAD):
node scripts/scoring-delta.js

# Faster — sample first 100 shows:
node scripts/scoring-delta.js --limit=100

# Against a specific base ref:
node scripts/scoring-delta.js --base=main

# Machine-readable output:
node scripts/scoring-delta.js --json
```

Also run the temporal override regression fixture test:
```bash
node scripts/test-temporal-override-regression.js
```

## Interpreting Results

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 0 | No T1 flips AND ≤5 total flips | Safe to push |
| 2 | Any T1 flip OR >5 total flips | STOP — paste summary to user before pushing |
| 1 | Script error | Fix the script error first |

## T1 Flips Are Serious

T1 outlets (NYT, Vulture, Variety, Guardian, Times, Telegraph, FT, New Yorker, Timeout, Hollywood Reporter, NPR, Chicago Tribune, LA Times, Observer, Independent) carry outsized weight in the composite score. Even a single T1 flip on a flagship show materially changes the site.

**If any T1 flips:** show the user the full flip list before asking if they want to proceed. Do not push without explicit confirmation.

## What to Report to the User

Paste:
1. Total flips (inclusions gained / lost)
2. T1 flips specifically (list show + outlet + direction)
3. Exit code
4. Whether the temporal fixture test passed

Example summary:
```
Scoring delta: 3 total flips (2 gained, 1 lost)
T1 flips: NONE
Temporal fixture: PASS
Exit code: 0 — safe to push
```

Or if failing:
```
Scoring delta: 12 total flips (5 gained, 7 lost)
T1 flips: 2
  - Hamilton (hamilton-2015): NYT review newly EXCLUDED
  - Giant (giant-2026): Variety review newly EXCLUDED
Temporal fixture: PASS
Exit code: 2 — DO NOT PUSH without user confirmation
```

## Files That Trigger This Skill

- `scripts/lib/review-guards.js`
- `scripts/rebuild-all-reviews.js`
- `src/lib/scoring.ts`
- `src/lib/engine.ts`
- `src/lib/data-core.ts`

The stop hook in `.claude/settings.local.json` enforces this — it will block a session-end without a qualifying scoring-delta run if any of the above files were edited.
