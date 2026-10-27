# BRO-5189: Affluenza button investigation

Checked 2026-10-27. The historical rage-click target remains unidentified.
Current production controls respond correctly, so this change adds the missing
acceptance test without changing production behavior or private data.

## Reproduction and current behavior

Before changes, `node --test tests/unit/affluenza-show-page-button.test.mjs`
failed with `Could not find 'tests/unit/affluenza-show-page-button.test.mjs'`.
`git log -S 'affluenza-show-page-button' --oneline -5 -- tests/unit/affluenza-show-page-button.test.mjs`
returned no commits. `git log -S 'Want to See' --oneline -5 -- src/components/show-page/ShowHeroRedesign.tsx`
returned the existing baseline commit `603826cf`. The existing handlers are on main.

Playwright checked the live `/show/affluenza-off-west-end` before and after adding
the test. The initial mobile check and subsequent checks at 360, 390, 768, 1024
and 1440 pixels found:

| Control | Observed response |
| --- | --- |
| Want to See | Saves locally, changes to On your list and opens the sign-in offer |
| Rate it | Opens the rating editor; Cancel closes it |
| Cite this score | Displays Citation copied |
| Show more reviews | Expands from 5 to 31 review cards |
| By Date | Reorders reviews by date |
| Tickets | Shows Get Tickets from £25 with the London TodayTix destination |

The five-width pass repeated rating open/close and review expansion, with zero
page errors and no document overflow. This is evidence of current behavior,
not proof of what the two original visitors experienced.

## Real callers and data

The show page renders `ShowHeroRedesign`, which binds Want to See and Rate it
to `handleWantToSee` and `handleRateIt`. The same hero renders
`ShowPageTicketCTA`. `src/app/show/[slug]/page.tsx` passes five inline rows plus
the `/show/<slug>/reviews.json` endpoint to `ReviewsList`. The new test imports
these actual components and `AuthProvider`, dispatches DOM clicks, and exercises
the deferred review request with a deterministic response. It copies no handlers.

Zero real records changed before/after. The production files and private data
were left unchanged. Rendering the actual ticket CTA against three real records
also produced the expected results:

| Record | Result |
| --- | --- |
| affluenza-off-west-end-2026 | Two stored/eligible links; Get Tickets from £25 |
| the-lost-boys-2026 | Two stored links, one eligible; Get Tickets from $58 |
| the-disappear-off-broadway-2026 | No links; closed-show explanation |

## Verification and wiring

`node --test tests/unit/affluenza-show-page-button.test.mjs` passes four tests.
The combined command below passes 22 tests:

```sh
node --test --test-timeout 300000 tests/unit/affluenza-show-page-button.test.mjs tests/unit/show-page-ticket-cta.test.mjs tests/unit/show-page-rage-clicks.test.mjs tests/unit/show-proof-rage-clicks.test.mjs
```

`node scripts/lib/unit-test-collection.js | rg affluenza-show-page-button`
prints the new test path. `node scripts/audit-orphan-tests.js` passes. There are
no new production scripts, functions, flags, cron jobs, paid fetches, LLM calls
or API calls per run. jsdom tests do not fetch external resources.

`GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`
passes with `lint-workflows: all gates green` and gate exit 0. The first run
flagged explicit TypeScript require extensions in the new test; the corrected
test uses the registered ts-node hook and the final audit passes. Actionlint
is not installed here and was skipped by the harness. `git diff --check` passes.

## Limits and follow-up

The localhost route returned HTTP 500 because `data/cast-manifest.json` is
missing. No bootstrap or fabricated manifest was added; browser checks used
production. The environment lacks `POSTHOG_PERSONAL_API_KEY`, so the original
event's selector or replay could not be inspected. The card supplies only a
button near `#main-content`. There is no verified product defect to patch.

Remaining: identify the original clicked element from historical telemetry and
check the seven-day rage-click window after this change is deployed. Neither
is established by a passing unit test.
