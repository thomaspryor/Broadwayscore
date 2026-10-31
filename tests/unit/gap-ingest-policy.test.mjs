/**
 * gap-ingest-policy — production-identity + ingest-eligibility tests.
 *
 * The Broadway discovery path (SERP-found Playbill Verdict / BWW RR articles)
 * had no production-identity check: urlMatchesShow filters wrong SHOWS, not
 * wrong PRODUCTIONS, so a same-title prior production's roundup passed it and
 * its review URLs were ingest-eligible (2026-07-10 incident: 2018 Broadway
 * TKAM RR ingested onto the WE 2026 entry). These tests pin:
 *  - articleRunIdentity dates an article from HTML metadata against the show's
 *    opening window (prior article → priorRun; missing date fails open)
 *  - ingestBlockReason blocks priorRun on EVERY path — including WE shows with
 *    WE_GAP_INGEST on (the auto-enable time bomb) and plain Broadway shows
 *  - parity with the old WE-gate behavior for non-priorRun rows
 *
 * Run: node --test tests/unit/gap-ingest-policy.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { articleRunIdentity, ingestBlockReason, isUrlYearOutOfWindow, orderIngestCandidates } = require('../../scripts/lib/gap-ingest-policy.js');

// TKAM class: WE 2026 entry, 2018 Broadway Review Roundup article.
const TKAM_2026 = { id: 'to-kill-a-mockingbird-west-end-2026', title: 'To Kill a Mockingbird', openingDate: '2026-06-25' };

const htmlWithJsonLdDate = (date) => `<html><head>
<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"${date}T14:00:00-04:00","headline":"Review Roundup: TO KILL A MOCKINGBIRD"}</script>
</head><body><a href="https://www.nytimes.com/2018/12/13/theater/to-kill-a-mockingbird-review.html">NYT</a></body></html>`;

const htmlWithOgDate = (date) => `<html><head>
<meta property="article:published_time" content="${date}T09:00:00+00:00">
</head><body>roundup</body></html>`;

describe('articleRunIdentity', () => {
  test('2018 Broadway TKAM roundup is priorRun for the WE 2026 entry', () => {
    const r = articleRunIdentity(htmlWithJsonLdDate('2018-12-13'), TKAM_2026);
    assert.equal(r.publishDate, '2018-12-13');
    assert.equal(r.priorRun, true);
  });

  test('current-run roundup (published at opening) is not priorRun', () => {
    const r = articleRunIdentity(htmlWithOgDate('2026-06-26'), TKAM_2026);
    assert.equal(r.publishDate, '2026-06-26');
    assert.equal(r.priorRun, false);
  });

  test('window edges match the WE reference: opening-30d ok, +90d ok, beyond is prior', () => {
    assert.equal(articleRunIdentity(htmlWithOgDate('2026-05-27'), TKAM_2026).priorRun, false); // -29d
    assert.equal(articleRunIdentity(htmlWithOgDate('2026-09-20'), TKAM_2026).priorRun, false); // +87d
    assert.equal(articleRunIdentity(htmlWithOgDate('2026-10-15'), TKAM_2026).priorRun, true);  // +112d
    assert.equal(articleRunIdentity(htmlWithOgDate('2026-04-01'), TKAM_2026).priorRun, true);  // -85d
  });

  test('missing publish date fails open (treated as current, WE convention)', () => {
    const r = articleRunIdentity('<html><body>no date metadata here</body></html>', TKAM_2026);
    assert.equal(r.publishDate, null);
    assert.equal(r.priorRun, false);
  });

  test('show without openingDate fails open', () => {
    const r = articleRunIdentity(htmlWithJsonLdDate('2018-12-13'), { id: 'x', title: 'X' });
    assert.equal(r.priorRun, false);
  });
});

describe('ingestBlockReason — priorRun blocks unconditionally', () => {
  test('Broadway show, no WE gate involved: prior-production URL is blocked', () => {
    assert.equal(ingestBlockReason({ priorRun: true }, { showIsWe: false, weGateOn: false }), 'prior-run');
    assert.equal(ingestBlockReason({ priorRun: true }, { showIsWe: false, weGateOn: true }), 'prior-run');
  });

  test('WE show with WE_GAP_INGEST on: Broadway-path prior-run URL STAYS blocked (auto-enable time bomb)', () => {
    assert.equal(
      ingestBlockReason({ priorRun: true, priorRunSource: 'aggregator-article-date' }, { showIsWe: true, weGateOn: true }),
      'prior-run'
    );
  });

  test('weRef prior-run row blocked even with gate on (unchanged WE behavior)', () => {
    assert.equal(ingestBlockReason({ weRef: true, priorRun: true }, { showIsWe: true, weGateOn: true }), 'prior-run');
  });
});

describe('ingestBlockReason — WE gate parity for non-priorRun rows', () => {
  const oldPred = (m, showIsWe, weGateOn) =>
    (showIsWe && !weGateOn) || (m.weRef && (!weGateOn || m.priorRun));

  test('matches the previous inline predicate on every non-priorRun combination', () => {
    for (const weRef of [true, false]) {
      for (const showIsWe of [true, false]) {
        for (const weGateOn of [true, false]) {
          const m = { weRef, knownOutletId: 'nytimes' };
          assert.equal(
            ingestBlockReason(m, { showIsWe, weGateOn }) !== null,
            !!oldPred(m, showIsWe, weGateOn),
            `weRef=${weRef} showIsWe=${showIsWe} weGateOn=${weGateOn}`
          );
        }
      }
    }
  });

  test('plain Broadway current-run URL is ingestable', () => {
    assert.equal(ingestBlockReason({ knownOutletId: 'nytimes' }, { showIsWe: false, weGateOn: false }), null);
  });
});

describe('ingestBlockReason — per-aggregator trust (2026-07-11)', () => {
  const gateOn = { showIsWe: true, weGateOn: true };

  test('URL cited ONLY by low-trust sources stays report-only even with the gate on', () => {
    assert.equal(
      ingestBlockReason(
        { weRef: true, weRefSources: ['theatre-reviews'] },
        { ...gateOn, lowTrustSources: new Set(['theatre-reviews']) }
      ),
      'low-trust-source'
    );
  });

  test('one trusted citing source is enough to ingest', () => {
    assert.equal(
      ingestBlockReason(
        { knownOutletId: 'nytimes', weRef: true, weRefSources: ['theatre-reviews', 'westendtheatre'] },
        { ...gateOn, lowTrustSources: new Set(['theatre-reviews']) }
      ),
      null
    );
  });

  test('fail-open: no trust data / no source attribution / non-weRef rows are never low-trust blocked', () => {
    assert.equal(ingestBlockReason({ knownOutletId: 'nytimes', weRef: true, weRefSources: ['theatre-reviews'] }, { ...gateOn, lowTrustSources: new Set() }), null);
    assert.equal(ingestBlockReason({ knownOutletId: 'nytimes', weRef: true, weRefSources: ['theatre-reviews'] }, gateOn), null);
    assert.equal(ingestBlockReason({ knownOutletId: 'nytimes', weRef: true }, { ...gateOn, lowTrustSources: new Set(['theatre-reviews']) }), null);
    assert.equal(ingestBlockReason({ knownOutletId: 'nytimes' }, { showIsWe: false, weGateOn: false, lowTrustSources: new Set(['theatre-reviews']) }), null);
  });

  test('precedence: prior-run and gate-off outrank low-trust', () => {
    const ctx = { showIsWe: true, weGateOn: false, lowTrustSources: new Set(['theatre-reviews']) };
    assert.equal(ingestBlockReason({ weRef: true, priorRun: true, weRefSources: ['theatre-reviews'] }, { ...ctx, weGateOn: true }), 'prior-run');
    assert.equal(ingestBlockReason({ knownOutletId: 'nytimes', weRef: true, weRefSources: ['theatre-reviews'] }, ctx), 'we-gate-off');
  });
});

describe('isUrlYearOutOfWindow (BRO-1412 — Show Score / other URL-only discovery)', () => {
  // A Broadway revival: current run opens 2026-03-25. Show Score's page for
  // "Cabaret" links straight to each outlet's own review with no roundup
  // article to date via articleRunIdentity — this is the last mile
  // articleRunIdentity (Playbill/BWW) doesn't cover.
  const CABARET_REVIVAL = {
    id: 'cabaret-broadway-2026',
    title: 'Cabaret',
    previewsStartDate: '2026-03-01',
    openingDate: '2026-03-25',
  };

  test('a prior production\'s dated review URL is out of window', () => {
    assert.equal(
      isUrlYearOutOfWindow('https://www.nytimes.com/1998/03/20/theater/cabaret-review.html', CABARET_REVIVAL),
      true
    );
  });

  test('a fresh current-run review URL is in window', () => {
    assert.equal(
      isUrlYearOutOfWindow('https://www.nytimes.com/2026/03/26/theater/cabaret-review.html', CABARET_REVIVAL),
      false
    );
  });

  test('a URL with no embedded year is never flagged (no fetch-free signal available)', () => {
    assert.equal(
      isUrlYearOutOfWindow('https://www.nytimes.com/theater/cabaret-review.html', CABARET_REVIVAL),
      false
    );
  });

  test('a declared priorRuns window re-admits its own dated URL', () => {
    const withPrior = { ...CABARET_REVIVAL, priorRuns: [{ openingDate: '1998-03-19', closingDate: '2004-01-04' }] };
    assert.equal(
      isUrlYearOutOfWindow('https://www.nytimes.com/1998/03/20/theater/cabaret-review.html', withPrior),
      false
    );
  });

  test('dash-form permalink years are read the same as slash-form (parity with acceptSerpCensusResult)', () => {
    assert.equal(isUrlYearOutOfWindow('https://example.com/1998-cabaret-review/', CABARET_REVIVAL), true);
  });

  test('a show with no opening/previews date fails open (no window to compare against)', () => {
    assert.equal(
      isUrlYearOutOfWindow('https://www.nytimes.com/1998/03/20/theater/cabaret-review.html', { id: 'x', title: 'X' }),
      false
    );
  });

  test('a title that IS a year does not self-block its own current-run reviews (codex review)', () => {
    // "1984" the show slugs into review URLs as the literal string "1984" —
    // indistinguishable from a genuine 1984 publish year by the regex alone.
    const orwell1984 = { id: '1984-broadway-2026', title: '1984', openingDate: '2026-05-01' };
    assert.equal(isUrlYearOutOfWindow('https://variety.com/review-1984-broadway/', orwell1984), false);
    // A DIFFERENT number embedded in the same URL is still caught.
    const oldUrl = 'https://variety.com/2010/review-1984-broadway/';
    assert.equal(isUrlYearOutOfWindow(oldUrl, orwell1984), true);
  });
});

describe('ingestBlockReason — SERP census gate (#371, ship-check 2026-07-24)', () => {
  test('Broadway-market serpCensus row is blocked by default (gate off)', () => {
    assert.equal(
      ingestBlockReason({ knownOutletId: 'nytimes', serpCensus: true }, { showIsWe: false, weGateOn: false, serpCensusGateOn: false }),
      'serp-census-gate-off'
    );
  });

  test('serpCensus row ingests once SERP_CENSUS_INGEST is on', () => {
    assert.equal(
      ingestBlockReason({ knownOutletId: 'nytimes', serpCensus: true }, { showIsWe: false, weGateOn: false, serpCensusGateOn: true }),
      null
    );
  });

  test('WE show serpCensus row is blocked by the WE gate first, independent of the SERP census gate', () => {
    assert.equal(
      ingestBlockReason({ knownOutletId: 'nytimes', serpCensus: true }, { showIsWe: true, weGateOn: false, serpCensusGateOn: true }),
      'we-gate-off'
    );
  });

  test('prior-run outranks the SERP census gate', () => {
    assert.equal(
      ingestBlockReason({ serpCensus: true, priorRun: true }, { showIsWe: false, weGateOn: false, serpCensusGateOn: true }),
      'prior-run'
    );
  });

  test('non-serpCensus Broadway rows are unaffected by the new gate', () => {
    assert.equal(ingestBlockReason({ knownOutletId: 'nytimes' }, { showIsWe: false, weGateOn: false, serpCensusGateOn: false }), null);
  });
});

describe('ingestBlockReason — unregistered host (BRO-6685)', () => {
  const ctx = { showIsWe: false, weGateOn: false, serpCensusGateOn: true };

  test('globalnews2.xyz scraper copy (no outlet-registry domain) is refused even with the census gate on', () => {
    const m = {
      url: 'https://globalnews2.xyz/a-few-good-men-broadway-review-bradley-whitford-and-tom-blyth-handle-the-truth/',
      host: 'globalnews2.xyz', knownOutletId: null, serpCensus: true,
    };
    assert.equal(ingestBlockReason(m, ctx), 'unregistered-host');
  });

  test('aggregator-listed (non-census) unregistered host is refused too: no auto-registration', () => {
    assert.equal(ingestBlockReason({ host: 'ctvoice.example', knownOutletId: null }, ctx), 'unregistered-host');
  });

  test('a flaggedMiss with a held file outletId is recovery, not a new registration', () => {
    assert.equal(ingestBlockReason({ knownOutletId: null, recoverableOutletId: 'ctvoice' }, ctx), null);
  });

  test('a registered host still ingests', () => {
    assert.equal(ingestBlockReason({ host: 'nytimes.com', knownOutletId: 'nytimes', serpCensus: true }, ctx), null);
  });

  test('earlier reasons keep precedence over unregistered-host', () => {
    assert.equal(ingestBlockReason({ priorRun: true, knownOutletId: null }, ctx), 'prior-run');
    assert.equal(ingestBlockReason({ serpCensus: true, knownOutletId: null }, { ...ctx, serpCensusGateOn: false }), 'serp-census-gate-off');
  });
});

describe('orderIngestCandidates (BRO-6687 cap starvation)', () => {
  // Martin Guerre 2026 as of 2026-10-31: five census rows ahead of the cited review.
  const census = [
    'https://www.oldvictheatre.com/news/martin-guerre-press-night/',
    'https://theatreboard.co.uk/thread/7596/martin-guerre-2024',
    'https://theatreboard.co.uk/thread/7596/martin-guerre',
    'https://broadwaybaby.com/shows/martin-guerre/839230',
    'https://www.theatremonkey.com/show/martin-guerre/',
  ].map(url => ({ url, serpCensus: true }));
  const cited = { url: 'https://www.london-now.co.uk/news/26665516.martin-guerre-old-vic-theatre-london-review/', weRef: true };
  const prior = [{ url: census[0].url, ok: true }, ...census.slice(1).map(m => ({ url: m.url, ok: false, noop: true, expected: true }))];

  test('the aggregator-cited row moves inside the 5-row cap', () => {
    const out = orderIngestCandidates([...census, cited], prior);
    assert.equal(out[0], cited);
    assert.ok(out.slice(0, 5).includes(cited));
  });
  test('rows tried last run go behind untried rows of the same kind', () => {
    const fresh = { url: 'https://example.com/fresh', serpCensus: true };
    const out = orderIngestCandidates([...census, fresh], prior);
    assert.equal(out[0], fresh);
  });
  test('stable with no prior run, and does not mutate the input', () => {
    const rows = [census[0], cited, census[1]];
    const copy = rows.slice();
    assert.deepEqual(orderIngestCandidates(rows), [cited, census[0], census[1]]);
    assert.deepEqual(rows, copy);
  });
  test('URL matching ignores scheme, www and trailing slash', () => {
    const out = orderIngestCandidates([{ url: 'http://example.com/a/' }, { url: 'https://example.com/b' }], [{ url: 'https://www.example.com/a' }]);
    assert.equal(out[0].url, 'https://example.com/b');
  });
  test('missing input is safe', () => {
    assert.deepEqual(orderIngestCandidates(undefined, undefined), []);
  });
});
