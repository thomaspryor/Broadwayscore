# BRO-5603 outlet name review

Reviewed 2026-10-30 against the registry at `27ad1a4a860`.

The original detector returned zero candidates despite 24 entries having a
lowercase displayName equal to their ID with at least 11 letters. Making the
initial capital optional finds exactly those 24. Short names, existing
capitalized-name boundaries, and explicitly reviewed names remain unchanged.

Ran `node scripts/audit-registry-slug-displaynames.js --fetch --apply` through
the existing fetchPage Playwright fallback. It applied 18 proposals and left
six unresolved. Manual source review completed those six and corrected one
automatic proposal: the old resolver picked `London` instead of `Muddy
Stilettos`. On the same fetched homepage metadata, the corrected resolver picks
`Muddy Stilettos` by preferring the outlet ID over its regional subdomain.
Two About pages also established that existing display names were taglines.

Final result: 26 changed records, restricted to displayName and provenance;
zero unresolved detector matches. No outlet IDs, tiers, domains, aliases, or
outlet-tiers.json names changed. The registry is tracked public data, so these
changes do not require a private-data fix action.

## Source review

Names below come from page content or metadata, never from splitting URLs.
`audit` means the existing fetch/apply command supplied the final value;
`manual` means the source needed review beyond the resolver's conservative
ID/domain spelling rule, was blocked in Playwright, or corrected a tagline.

| Outlet ID | Final displayName | Method and source |
| --- | --- | --- |
| readaboutstuff | Read About Stuff | audit: [homepage title](https://readaboutstuff.com/) |
| primarytimes | Primary Times | audit: [homepage](https://primarytimes.co.uk/) |
| timesofsandiego | Times of San Diego | audit: [homepage heading](https://timesofsandiego.com/) |
| theunforgettableline | The Unforgettable Line | audit: [homepage heading](https://theunforgettableline.com/) |
| openairtheatreheritage | Open Air Theatre | manual: [homepage title, Our Heritage section](https://openairtheatreheritage.com/) |
| chicagoconcertreviews | Chicago Concert Reviews | audit: [homepage](https://chicagoconcertreviews.com/) |
| chicagocultureauthority | Chicago Culture Authority | audit: [homepage title](https://chicagocultureauthority.com/) |
| chelmsfordtheatre | Chelmsford Theatre | audit: [homepage](https://www.chelmsfordtheatre.co.uk/) |
| dayoutwiththekids | Day Out With The Kids | manual: [official About page](https://www.dayoutwiththekids.co.uk/about-us) |
| boxofficeticketsales | Box Office Ticket Sales | audit: [homepage](https://boxofficeticketsales.com/), corroborated by [About page](https://www.boxofficeticketsales.com/user-Information/about_us.aspx) |
| muddystilettos | Muddy Stilettos | manual: [homepage title and navigation](https://london.muddystilettos.co.uk/); corrected regional label |
| westwaleschronicle | West Wales Chronicle | manual: [homepage title](https://westwaleschronicle.co.uk/) |
| cherylmarkosky | Cheryl Markosky | audit: [homepage heading](https://cherylmarkosky.com/) |
| melissamaney | Melissa Maney | audit: [homepage heading](https://www.melissamaney.com/) |
| sohoplayhouse | SoHo Playhouse | audit: [homepage title](https://www.sohoplayhouse.com/) |
| theatlantic | The Atlantic | audit: [homepage](https://www.theatlantic.com/) |
| theatreboard | TheatreBoard | manual: [founding member's launch announcement](https://www.theatremonkey.com/2016/02/theatreboard-co-uk-the-new-home-of-independent-theatre-discussion/); current masthead unavailable |
| bestoftheatre | Best Of Theatre | audit: [homepage title](https://www.bestoftheatre.co.uk/) |
| soundsandstage | Sounds & Stage | manual: [homepage heading and metadata](https://soundsandstage.com/); ampersand differs from ID spelling |
| myshrewsbury | My Shrewsbury | audit: [homepage title](https://www.myshrewsbury.co.uk/) |
| eventticketscenter | Event Tickets Center | audit: [homepage heading](https://www.eventticketscenter.com/) |
| politeonsociety | Polite On Society | audit: [homepage heading](https://politeonsociety.com/) |
| redbulltheater | Red Bull Theater | audit: [homepage title](https://www.redbulltheater.com/) |
| singleticket | singleticket’s Substack | manual: [official About heading](https://singleticket.substack.com/about) |
| onceaweektheatre | Once A Week Theatre | manual: [About heading](https://onceaweektheatre.com/once-a-week-theatre/); replaces descriptive tagline |
| artsreviewhub | Arts Review Hub | manual: [About text](https://artsreviewhub.com/home/); replaces descriptive tagline |

`funfandomblog` stays **A Blog of Books and Musicals**: the [homepage](https://funfandomblog.wordpress.com/)
uses that as its title and separately shows its actual tagline below it.

## Verification and limits

- Before patch: real-data assertion failed, `0 !== 24`.
- After patch on the same original registry: 24 candidates. After backfill: 0.
- `node scripts/validate-data.js --strict`: exit 0 before and after, both
  printing `PASSED WITH 2185 WARNING(S)`. No new validation warnings.
- Relevant tests: 81 passed, 0 failed across seven test files.
  Exact command:

  ```sh
  node --test --test-timeout 300000 tests/unit/outlet-registry-display-names.test.mjs scripts/outlet-staged-grace.test.mjs scripts/outlet-registry.test.mjs tests/unit/show-score-outlet-identity.test.mjs tests/unit/push-core-data-outlet-staging.test.mjs scripts/lib/outlet-registry-field-shape.test.mjs tests/unit/outlet-registry-live-data.test.mjs
  ```

- All 26 new display names still resolve to their original IDs through the
  real `normalizeOutlet()` function. The registry's aliases remain intact.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`:
  only failing gate was missing `actionlint` (exit 127); remaining audits passed.
- HEAD equals origin/main at the baseline commit.
  `git log -S 'findRunTogetherSlugDisplayNames' --oneline -5 -- scripts/lib/outlet-auto-register.js`
  and `git log -S 'theatlantic' --oneline -5 -- data/outlet-registry.json` could not
  finish because older objects require a lazy fetch into the read-only shared
  `.git` directory. The actual real-data reproduction proves the bug exists
  in the starting main checkout despite its passing strict validator.
- Existing callers: `audit-registry-slug-displaynames.js` calls
  `findRunTogetherSlugDisplayNames` and writes accepted names;
  `check-corpus-drift.yml` runs it daily at 08:20 UTC. Rebuild and the outlet
  audit already call `deriveOutletDisplayName`. No new script or flag.
- Cost: no paid scraper or LLM calls in this run. The audit attempted 24
  target homepages plus three already-staged outlets through free Playwright.
  The widened detector adds one fetchPage request per newly detected record
  on the existing daily cron; after this backfill it adds zero requests for
  these records. Provider fallback may bill future unresolved records under
  existing scraper budgets. No new cron or API integration.
- Remaining: verify TheatreBoard's current masthead when accessible. The
  registered `.com` host and the `.co.uk` host named in the launch announcement
  were inaccessible. Its display name is independently supported by the
  founding member's announcement; its domain was deliberately not changed.
