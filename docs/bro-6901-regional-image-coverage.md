# BRO-6901 regional image coverage

The queue repair is already present on main (`37faa316`): batch 30,
never-attempted rows first, oldest waiting rows first, a stalled-backlog alert,
and regional venue sources. This follow-up supplies the four remaining unmarked
regional productions with verified artwork and adds a failing coverage command.

## Verification

After applying `data/pending-fixes/bro-6901.json` to the private core data:

```sh
node scripts/audit-imageless-scored-shows.js --check-regional
node scripts/validate-data.js --strict
```

The first command is read-only even without `--dry-run`. It exits 1 if any scored
UK regional, Chicago or DC production lacks a real image and an active
`noReliableArt` marker. It includes closed, newly discovered and undated shows.
Missing or malformed input fails instead of reporting empty coverage. The normal
self-heal audit retains its 24-hour dispatch grace period and tour-parent routing.

Regression tests exercise the same input normalization and coverage predicate
that the audit calls:

```sh
node --test --test-timeout 300000 scripts/lib/imageless-audit-input.test.mjs scripts/lib/no-reliable-art.test.mjs scripts/lib/image-trigger-guard.test.mjs scripts/lib/regional-image-venues.test.mjs
node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-6901.json
```

## Evidence collected on 2026-11-12

At HEAD `890c4e91800` (also origin/main), `validate-data.js --strict` passed with
1932 warnings. The image audit still reported seven scored gaps, three regional.
The new regional check exited 1 and named Contact (3 reviews), Little Shop of
Horrors (8), and The Play That Goes Wrong (4). Dial M for Mayhem had no reviews
and was the only other unmarked, imageless regional row.

Replaying the four plan actions in memory with the executor's `applyDataEdit`
changes exactly four shows, only their `images` fields. Scored regional gaps go
from 3 to 0; all unmarked regional gaps go from 4 to 0. The same audit caller
then exits 0. No markers, scores, dates, statuses or unrelated records change.
Strict validation after that replay passes with 1930 warnings. The 169 related
unit tests pass, including the existing queue, venue and marker regressions.
The general dry-run audit goes from 7 to 4, retaining only the existing tour
and West End gaps outside this card's regional scope. Private data files are
not edited by this change; the runner must apply the pending plan after landing.

## Artwork provenance

The sources below were opened, downloaded and visually inspected. Production
identity comes from the linked page content and cast, not image URL fragments.
Assets use the existing compression helper and pass `check-image-aspect.js`.
The Little Shop thumbnail uses the right-hand square of its banner so the
production artwork and title remain intact.

| Show ID | Production evidence | Downloaded source |
| --- | --- | --- |
| `contact-oran-mor-regional-2026` | [Official production page](https://playpiepint.com/whats-on/event/contact/): Jonny Donahoe, Ben Standish, Blythe Duff and Mark Barrett; 5 to 10 October 2026. Production photo credited to Tommy Ga-Ken Wan. | [Photo](https://playpiepint.com/app/uploads/2026/07/Blythe-Duff-Mark-Barrett-in-Contact-Tommy-Ga-Ken-Wan-2.jpg) |
| `little-shop-of-horrors-hope-mill-regional-2026` | [Hope Mill page](https://hopemilltheatre.co.uk/event/little-shop-of-horrors/): Manchester run from 25 September 2026, Maisie Smith, Jed Berry, Michael Starke and Carrie-Anne Ingrouille. | [Manchester banner](https://hopemilltheatre.co.uk/app/uploads/2025/05/LSOH-USE-BANNER.png) |
| `the-play-that-goes-wrong-regional-2026` | [Keegan production page](https://keegantheatre.com/portfolio/the-play-that-goes-wrong/): Michael Innocenti's production, extended through 19 July 2026. Poster explicitly names Keegan and the extension. | [Poster](https://keegantheatre.com/wp-content/uploads/2025/07/TPTGW-Key-Art-2-EXTENDED.jpg) |
| `dial-m-for-mayhem-dundee-rep-regional-2025` | [Dundee's brochure](https://dundee-rep.files.svdcdn.com/production/2024/Digital-Brochure-Dundee-Rep-2024.pdf?dm=1719305337) identifies Middle Ground's touring production and its 25 February to 1 March 2025 stop. The [Royal & Derngate page](https://royalandderngate.co.uk/whats-on/dial-m-for-mayhem/) supplies the same production's tour artwork. | [Tour artwork](https://royalandderngate.co.uk/wp-content/uploads/2024/07/Northampton-web.jpg) |

The coverage command adds zero network requests, paid fetches or LLM calls.
Existing scheduled self-heal dispatches and their batch limit are unchanged.

## Local check results

The complete related-test command executed successfully (169 passed, 0 failed):

```sh
node --test --test-timeout 300000 \
  scripts/lib/imageless-audit-input.test.mjs \
  scripts/lib/image-trigger-guard.test.mjs \
  scripts/lib/regional-image-venues.test.mjs \
  scripts/lib/no-reliable-art.test.mjs \
  tests/unit/audit-push-retry-budgets.test.mjs \
  scripts/lib/autonomous-triage-core.test.mjs \
  tests/unit/image-presence.test.mjs \
  scripts/lib/ux-walkthrough-filing.test.mjs \
  tests/unit/audit-imageless-scored-shows-push.test.mjs \
  tests/unit/audit-imageless-scored-shows-push-timeout.test.mjs \
  tests/unit/collect-outlet-reviews-time-budget.test.mjs
```

`GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`
completed. Its log reported missing `actionlint` and a venue-write false
positive on the read-only audit projection. After documenting that projection
with the guard's supported annotation, `node scripts/audit-venue-write-guard.js
--strict` passed with zero new sites. All other workflow gates passed.
`audit-toplevel-script-test-yml-coverage.js`, `audit-test-yml-lib-deps.js` and
`audit-orphan-tests.js` also passed independently.

`git log -S 'orderFlaggedForSelfHeal' --oneline -5` could not complete because
the partial clone lacks historical objects and Git's object store is read-only.
`git show --no-patch 37faa316` confirms the original BRO-6901 repair commit;
HEAD and origin/main both resolve to `890c4e91800`.

The plan generator wrote and preflighted all four actions, then its automatic
`git add -f` failed because the worktree index is read-only. The explicit
`.gitignore` exceptions keep the plan and this evidence visible to the runner's
normal `git add -A`. No private data was changed and nothing was deployed here.
