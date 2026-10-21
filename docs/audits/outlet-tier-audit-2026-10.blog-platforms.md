# BRO-5801: existing hosted-blog outlet tiers

The 2026-10-20 owner rule assigns small hosted blogs T4 (base weight 0.20).
BRO-5795 already applies this rule to new registrations through
`newOutletTier()` in `scripts/lib/regular-poster.js`. The existing registry
still had exactly 45 T3 entries for which `isBlogPlatformDomain(entry.domain)`
returned true. Their IDs and existing domains are pinned in
`tests/unit/blog-platform-tiers-adopted-2026-10.json`.

BRO-5801's acceptance criteria explicitly include all 45 IDs, including
Medium. This supersedes the earlier audit's Medium T3 exception. The older
audit describes the Medium ID as grouped personal blogs without an editorial
layer. No additional outlet, domain, author, or regional classification is
changed in this migration. Existing T1/T2 outlets and non-platform T3 outlets
retain their tiers. Only Medium has a config override among these 45 IDs;
its override must also become T4 so it cannot mask the registry change.

Despite the card's private-repo description, `git ls-files
data/outlet-registry.json` confirms the registry is tracked in this checkout
and on origin/main. This migration edits that existing file directly.

## Real-data audit

Before the migration, Medium, Theatre's Leiter Side, and Cultural Capital
each resolved to T3 with base weight 0.40. Afterwards, all 45 IDs resolve
to T4 with base weight 0.20 in both NYC and London. No hosted-blog T3 entry
remains. A structural comparison confirms exactly 45 registry records change,
with only their `tier` fields edited; all other records and metadata match.

The BRO-4907 `simulateImpact()` helper proposed T4 in both regions against
the original registry and config. Replaying the actual changed registry and
config through its `loadScorerWithTiers()` canonical scorer matches that
simulation exactly: 250 review rows belong to the cohort and 171 show scores
change (109 Broadway, 17 Off-Broadway, 25 West End, 12 Off-West-End, 6 regional,
2 tour). Zero shows without a cohort review change. Score deltas range from
-0.55 to +2.55 points. Examples:

| Show ID | Before | After |
| --- | ---: | ---: |
| a-dolls-house-part-2-2017 | 83.37 | 83.39 |
| crazy-mama-a-true-story-of-love-and-madness-off-broadway-2026 | 87.42 | 88.00 |
| a-little-life-west-end-2023 | 64.17 | 63.96 |

`node scripts/scoring-delta.js` exits 2 as designed for registry data-input
drift. It reports the 45 tier edits and says the Phase A/B replay cannot
attribute data-input changes, so no inclusion flip count exists. The separate
canonical-score comparison above measures their impact. No scoring algorithm
or inclusion rule changes. `node scripts/test-temporal-override-regression.js`
passes both suites: 31 flagship shows, 1,679 real reviews plus 2 synthetic,
10 eligible flags downgraded, zero surviving at high/medium confidence.

Verify with `node --test scripts/lib/tier-migration-verify.test.mjs`.
The acceptance suite uses the real platform detector and tier lookup, checks
the fixed 45-ID cohort, and rejects any remaining registered T3 platform.
The existing adopted-tier unit suite also pins all 45 moves in both regions.
There are no new fetches, API calls, LLM calls, production scripts, flags, or
cron jobs.

## Validation notes

The acceptance path was absent from origin/main. After adding the suite but
before changing data, it failed both tests: Medium remained T3 and the scan
returned all 45 T3 platform IDs. After the migration it passes both tests.

The edited acceptance and adopted-tier suites plus Cote Notices' registry
suite pass all 9 tests. The related TypeScript suites pass all 31 tests.
The outlet mapper requires the existing `tsx` runner; with that runner all
92 cases pass. The broader related-test scan exposed the Cote Notices test's
stale T3 assertion, which is updated to T4 with this migration.

Two unrelated checks need context. The published-tier probe fails on six
existing 4Columns/Billboard reviews, identically with origin/main's registry
and tier config. The international-trade test's fixture writer initially
failed creating a directory through the private corpus symlink; with an
isolated local fixture directory, all 7 cases pass with both origin/main's
data and the migrated data. The original corpus symlink was restored and
the private review files were not edited.

Commands run (no TypeScript source was edited, so `tsc` was not run):

```sh
node --test scripts/lib/tier-migration-verify.test.mjs
node --test --test-timeout 300000 tests/unit/cote-notices-registry.test.mjs tests/unit/outlet-tiers-adopted-2026-10.test.mjs scripts/lib/tier-migration-verify.test.mjs
node --test --test-timeout 300000 $(rg -l 'outlet-registry\.json|outlet-tiers\.json|blog-platform-tiers|tier-migration-verify' tests scripts --glob '*.test.mjs' --glob '*.test.js') tests/unit/regular-poster.test.mjs
npx --no-install tsx --test --test-timeout 300000 tests/unit/scoring-parity.test.ts tests/unit/critic-score-canonical-parity.test.ts tests/unit/tier-config-consistency.test.ts tests/unit/mobile-feed-website-parity.test.ts
npx --no-install tsx --test --test-timeout 300000 tests/unit/outlet-id-mapper.test.mjs
node --test --test-timeout 300000 scripts/verify-outlet-tiers-published.test.mjs
node --test --test-timeout 300000 scripts/lib/international-trade-cross-market.test.mjs
node scripts/scoring-delta.js
node scripts/test-temporal-override-regression.js
GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet
npx --no-install next lint
git diff --check
git status --short
```

The initial related-test batch reported 1,120 passed, 3 failed, 92 cancelled,
and 1 skipped. The three failures were the stale Cote Notices tier assertion,
the private-directory fixture writer, and the baseline published-tier probe.
The 92 cancelled mapper cases all pass under `tsx`. Focused reruns after
fixing Cote Notices pass as described above; the published-tier failure is
unchanged on main. The lint-workflows gauntlet finishes with `all gates green`
(actionlint is not installed locally). Next lint exits 0 with existing source
warnings. `git diff --check` passes; the final status contains only this card's
registry/config migration, fixture, tests, and audit document.
