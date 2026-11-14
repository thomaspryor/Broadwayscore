# London census coverage recheck (BRO-6488)

Checked 2026-10-31T00:59:10.902Z. **Partial audit only: BRO-6488 is not complete.**

The spec-existence acceptance command passes on origin/main, but only 13 of the 28 configured London sources have reports. No new outlet enumeration, review ingest, scoring, rebuild, or private-data edit was performed in this recheck. Zero review records changed.

[Machine-readable snapshot](../../data/audit/outlet-census/london/coverage-recheck.json) records the per-outlet and per-season gap counts, source-manifest hashes, recovered URLs, scope inventory and the supplied comment's complete URLs. The original manifests and reports remain the historical enumeration evidence.

## Before/after gap coverage

“Before” is each saved manifest's gap classification from October 29. “Now” is a presence check against the current private review files and published `reviews.json`. The table records progress since those manifests, not ingest performed by this worker. It covers all saved gaps, **not the unavailable full list of 141 vetted URLs**.

A URL must match the same outlet and at least one saved matched show, using the census's existing `urlKey()` and explicit `altUrls` aliases. Held includes flagged, unscored and excluded files. Published is checked independently against `reviews.json`; it is not inferred from file presence. Alternative URLs not explicitly recorded as aliases are not considered recovered. No new matching or vetting is performed, so unresolved rows remain candidates, not approved ingest instructions.

| Outlet | Before: saved gaps | Now held | Now published | Still missing |
|---|---:|---:|---:|---:|
| all-that-dazzles-uk | 137 | 0 | 0 | 137 |
| artsdesk | 51 | 24 | 21 | 27 |
| british-theatre | 530 | 0 | 0 | 530 |
| britishtheatrecom | 204 | 0 | 0 | 204 |
| everything-theatre | 111 | 1 | 1 | 110 |
| london-box-office | 11 | 11 | 11 | 0 |
| london-theatre | 220 | 0 | 0 | 220 |
| theatre-weekly | 112 | 0 | 0 | 112 |
| thereviewshub | 1 | 0 | 0 | 1 |
| thestage | 26 | 1 | 1 | 25 |
| timeout-london | 8 | 6 | 6 | 2 |
| west-end-best-friend | 241 | 0 | 0 | 241 |
| whatsonstage | 76 | 74 | 70 | 2 |
| **Total** | **1728** | **117** | **110** | **1611** |

Examples: London Box Office's Once and Arts Desk's The Philanthropist changed from saved gap to held and published. Arts Desk's Mood Music remains missing. This is a fixed-cohort gap recheck, not a new overall recall estimate: previously held rows are not revalidated.

Per-season counts in the snapshot use the saved publication dates and `seasonOf()` (September through August). Many dates in the original manifests are soft dates; the recheck does not reinterpret them. Only seasons containing saved gaps appear. No empty season is claimed to have zero published reviews. Existing `source.incomplete=false` values are preserved as historical metadata, not treated as proof of complete enumeration from 2012 to now.

## Outlet inventory still outstanding

Configured sources without any report: broadwayworld, daily-mail, express-uk, financialtimes, guardian, i-paper, independent, londontheatre1, mail-on-sunday, observer, standard, sunday-times, telegraph, the-spectator-uk, times-uk.

The current registry/corpus audit finds **216 scope candidates**, including the 28 configured sources and **188 unconfigured outlets**. The latter have `region=london`, tier 1 to 3, and at least one West End/Off-West End row in private or published reviews. Their IDs are recorded in `scope` in the snapshot. This is a registry-based inventory for triage, not an assertion that every regional outlet covers London completely. It also does not discover unknown outlets or reviews absent from the corpus. The card's “every London T1-T3 outlet” scope is broader than the configured 28-source list.

The card comments name BRO-6538 for paywalled and CDX outlets. That does not demonstrate formal transfer of all these missing sources or completion of their census. Missing reports have not been replaced with empty manifests or fabricated zero counts.

## Supplied vetted-gap comment

The supplied 2026-10-29T22:29 comment declares 31 outstanding URLs but contains only **12 complete review URLs**, followed by a truncated Hansard URL. The remaining 19 cannot be reconstructed safely from that text. No claim is made about the complete 141-URL vetted cohort. The Glyndebourne Hamlet URL was explicitly rejected and is excluded.

| Show | Outlet | Current status |
|---|---|---|
| once-west-end-2013 | london-box-office | held and published |
| the-philanthropist-west-end-2017 | artsdesk | held and published |
| network-west-end-2017 | artsdesk | held and published |
| goats-west-end-2017 | artsdesk | held and published |
| pinocchio-west-end-2017 | artsdesk | held and published |
| the-moderate-soprano-west-end-2018 | artsdesk | held and published |
| mood-music-west-end-2018 | artsdesk | missing |
| foxfinder-west-end-2018 | artsdesk | missing |
| true-west-west-end-2018 | artsdesk | missing |
| superhoe-west-end-2019 | artsdesk | missing |
| all-about-eve-west-end-2019 | artsdesk | missing |
| fiddler-on-the-roof-west-end-2019 | artsdesk | missing |

Six complete URLs are still absent and need the existing ingestion path. They have not been marked unfetchable because no fetch was attempted. The full URLs are retained in `suppliedComment.items` in the snapshot.

## Existing callers and remaining actions

The report writer is `runOutlet()` in `scripts/outlet-census.js`: it writes manifests and per-season reports. `LONDON_SOURCES` in `scripts/lib/outlet-census-sources.js` supplies its London enumeration configuration. Existing free enumeration must finish for the missing outlets before full census coverage can be claimed.

The ingest caller is `.github/workflows/ingest-urls.yml`, which invokes `scripts/ingest-urls.js`; that script fetches article content and calls the existing review writer. Repairing missing review files requires this writer, not changing downstream census buckets or inventing fields in a pending-fix plan. This unattended task prohibits scraping and writes through the private review-texts symlink, so ingest, scoring and rebuild remain outstanding. No workflow or production code was changed.

Next work: complete or explicitly transfer the missing enumerations; retrieve the complete vetted list; ingest its remaining approved URLs through the existing path; score and rebuild; then rerun this presence audit. Any misfile repair needs production-level evidence and an allowed fix plan. This snapshot establishes no new misfile diagnosis.

Cost for this recheck: **0 paid fetches, 0 LLM calls, 0 network API calls**. It is an offline manual audit, with no new cron or workflow.

## Validation and limits

- `test -f docs/specs/outlet-census.md`: PASS. `git cat-file -e origin/main:docs/specs/outlet-census.md`: PASS. These prove only that the spec exists.
- `git ls-tree -r --name-only origin/main data/audit/outlet-census/london`: 13 report files. The same 15 configured sources lack reports in this checkout.
- `git log -S 'LONDON_SOURCES' --oneline -5 -- scripts/lib/outlet-census-sources.js`: could not complete because a missing promisor object required fetching into the read-only shared Git directory. No historical fix claim is based on that failed search.
- `node --test --test-timeout 300000 scripts/lib/outlet-census.test.mjs scripts/lib/outlet-census-london.test.mjs scripts/lib/outlet-feed-reconcile.test.mjs`: 84 passed, 0 failed.
- The reproduction command below was rerun: all snapshot fields matched except `checkedAt`. All 13 manifest hashes and every per-season/per-outlet total reconciled.
- Direct file checks confirmed Once as held and published, Mood Music as absent, and Arts Desk's Follies as held but absent from `reviews.json`. No conclusion about why Follies is unpublished is inferred from that check.
- `git diff --check`: PASS. No application, scoring, workflow or test files changed; no TypeScript check or repo-wide test batch was needed.

## Reproduce the snapshot

Run from the checkout root with the private core-data copies and read-only review-texts checkout available. The command reads only identifiers, URLs, dates and manifest classifications into its output; it emits no review text or critic/contact details. It overwrites only `coverage-recheck.json`. Missing or malformed input files fail the run.

```sh
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const census = require('./scripts/lib/outlet-census');
const { LONDON_SOURCES } = require('./scripts/lib/outlet-census-sources');
const base = 'data/audit/outlet-census/london';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const published = read('data/reviews.json').reviews;
const rawShows = read('data/shows.json');
const london = new Set((rawShows.shows || rawShows).filter(s => census.isMarketShow(s, 'london')).map(s => s.id));
const registry = read('data/outlet-registry.json').outlets;
if (!fs.statSync('data/review-texts').isDirectory()) throw new Error('review-texts directory required');
const held = [];
for (const showId of [...london].sort()) {
  const dir = path.join('data/review-texts', showId);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const r = read(path.join(dir, file));
    held.push({ showId, outletId: r.outletId, url: r.url, altUrls: r.altUrls });
  }
}
const index = rows => new Map([...new Set(rows.map(r => r.outletId))].map(id => [id, census.buildCorpusIndex(rows.filter(r => r.outletId === id))]));
const heldIndex = index(held);
const publicIndex = index(published);
const has = (idx, id, item) => (item.matched || []).some(showId => idx.get(id)?.get(census.urlKey(item.url))?.has(showId));
const count = items => ({ savedGaps: items.length, nowHeld: items.filter(i => i.held).length, nowPublished: items.filter(i => i.published).length, stillMissing: items.filter(i => !i.held).length });
const outlets = [];
const checked = [];
for (const file of fs.readdirSync(base).filter(f => f.endsWith('.manifest.json')).sort()) {
  const manifest = read(path.join(base, file));
  const report = read(path.join(base, `${manifest.outletId}.report.json`));
  const gaps = manifest.items.filter(i => i.bucket === 'gap').map(i => ({ outletId: manifest.outletId, url: i.url, matched: i.matched, season: census.seasonOf(i.publishDate), held: has(heldIndex, manifest.outletId, i), published: has(publicIndex, manifest.outletId, i) }));
  checked.push(...gaps);
  outlets.push({ outletId: manifest.outletId, enumerationGeneratedAt: manifest.generatedAt, manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(base, file))).digest('hex'), enumerationIncomplete: report.source.incomplete, enumerationNotes: report.source.notes, ...count(gaps), seasons: Object.fromEntries([...new Set(gaps.map(i => i.season))].sort().map(s => [s, count(gaps.filter(i => i.season === s))])) });
}
const scopeIds = new Set(Object.keys(LONDON_SOURCES));
for (const r of [...held, ...published]) if (london.has(r.showId) && registry[r.outletId]?.region === 'london' && registry[r.outletId]?.tier <= 3) scopeIds.add(r.outletId);
const scope = [...scopeIds].sort().map(outletId => ({ outletId, tier: registry[outletId]?.tier ?? LONDON_SOURCES[outletId]?.tier, configured: !!LONDON_SOURCES[outletId], hasReport: fs.existsSync(path.join(base, `${outletId}.report.json`)) }));
// Show IDs and full URLs transcribed from the supplied 2026-10-29T22:29 card comment.
const listed = [
  ['once-west-end-2013', 'london-box-office', 'https://www.londonboxoffice.co.uk/news/post/once-musical-review'],
  ['the-philanthropist-west-end-2017', 'artsdesk', 'https://theartsdesk.com/theatre/philanthropist-trafalgar-studios-review-simon-callows-direction-underpowered'],
  ['network-west-end-2017', 'artsdesk', 'https://theartsdesk.com/theatre/network-national-theatre-review-bryan-cranstons-searing-london-stage-debut'],
  ['goats-west-end-2017', 'artsdesk', 'https://theartsdesk.com/theatre/goats-royal-court-review-unfocused-and-muddled'],
  ['pinocchio-west-end-2017', 'artsdesk', 'https://theartsdesk.com/theatre/pinocchio-national-theatre-review-boy-puppet-lifts-eventually'],
  ['the-moderate-soprano-west-end-2018', 'artsdesk', 'https://theartsdesk.com/theatre/moderate-soprano-duke-yorks-theatre-review-love-and-opera-flinty-edge'],
  ['mood-music-west-end-2018', 'artsdesk', 'https://theartsdesk.com/theatre/mood-music-old-vic-review-riveting-critique-music-biz'],
  ['foxfinder-west-end-2018', 'artsdesk', 'https://theartsdesk.com/theatre/foxfinder-ambassadors-theatre-review-too-ponderous-half'],
  ['true-west-west-end-2018', 'artsdesk', 'https://theartsdesk.com/theatre/true-west-vaudeville-theatre-review-sizzling-take-seminal-sam-shepard'],
  ['superhoe-west-end-2019', 'artsdesk', 'https://theartsdesk.com/theatre/superhoe-royal-court-review-smart-sassy-and-full-feeling'],
  ['all-about-eve-west-end-2019', 'artsdesk', 'https://theartsdesk.com/theatre/all-about-eve-noel-coward-theatre-review-less-bumpy-night-erratically-arresting-one'],
  ['fiddler-on-the-roof-west-end-2019', 'artsdesk', 'https://theartsdesk.com/theatre/fiddler-roof-playhouse-theatre-review-energetic-production-whips-emotional-storm'],
].map(([showId, outletId, url]) => ({ showId, outletId, url, held: has(heldIndex, outletId, { url, matched: [showId] }), published: has(publicIndex, outletId, { url, matched: [showId] }) }));
const result = {
  issue: 'BRO-6488', checkedAt: new Date().toISOString(), since: '2012-09-01',
  method: 'Offline presence recheck of saved gap classifications. Same outlet and at least one saved matched show must hold the normalized URL or an explicit altUrls alias. Held includes flagged or unscored files; published means present in reviews.json. No new enumeration, metadata extraction, vetting, ingest or scoring.',
  scopeRule: 'Configured London sources plus registry region=london, tier<=3 outlets with a West End/Off-West End row in review-texts or reviews.json. Does not claim to identify unregistered outlets.',
  totals: count(checked), outlets, scope,
  suppliedComment: { declaredRemaining: 31, completeUrlsSupplied: listed.length, omittedOrTruncated: 31 - listed.length, items: listed, excluded: 'Hamlet Glyndebourne was rejected as the wrong production. Hansard URL is truncated in the supplied comment; do not infer it.' },
  recoveredSavedGaps: checked.filter(i => i.held),
};
fs.writeFileSync(path.join(base, 'coverage-recheck.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ totals: result.totals, scope: scope.length, reports: scope.filter(i=>i.hasReport).length, configuredMissing: scope.filter(i=>i.configured&&!i.hasReport).length, unconfigured: scope.filter(i=>!i.configured).length, suppliedUrls: listed.length, suppliedHeld: listed.filter(i=>i.held).length, suppliedPublished: listed.filter(i=>i.published).length }));
NODE
```
