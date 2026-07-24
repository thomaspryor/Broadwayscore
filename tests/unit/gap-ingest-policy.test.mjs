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
const { articleRunIdentity, ingestBlockReason } = require('../../scripts/lib/gap-ingest-policy.js');

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
          const m = { weRef };
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
    assert.equal(ingestBlockReason({}, { showIsWe: false, weGateOn: false }), null);
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
        { weRef: true, weRefSources: ['theatre-reviews', 'westendtheatre'] },
        { ...gateOn, lowTrustSources: new Set(['theatre-reviews']) }
      ),
      null
    );
  });

  test('fail-open: no trust data / no source attribution / non-weRef rows are never low-trust blocked', () => {
    assert.equal(ingestBlockReason({ weRef: true, weRefSources: ['theatre-reviews'] }, { ...gateOn, lowTrustSources: new Set() }), null);
    assert.equal(ingestBlockReason({ weRef: true, weRefSources: ['theatre-reviews'] }, gateOn), null);
    assert.equal(ingestBlockReason({ weRef: true }, { ...gateOn, lowTrustSources: new Set(['theatre-reviews']) }), null);
    assert.equal(ingestBlockReason({}, { showIsWe: false, weGateOn: false, lowTrustSources: new Set(['theatre-reviews']) }), null);
  });

  test('precedence: prior-run and gate-off outrank low-trust', () => {
    const ctx = { showIsWe: true, weGateOn: false, lowTrustSources: new Set(['theatre-reviews']) };
    assert.equal(ingestBlockReason({ weRef: true, priorRun: true, weRefSources: ['theatre-reviews'] }, { ...ctx, weGateOn: true }), 'prior-run');
    assert.equal(ingestBlockReason({ weRef: true, weRefSources: ['theatre-reviews'] }, ctx), 'we-gate-off');
  });
});

describe('ingestBlockReason — SERP census gate (#371, ship-check 2026-07-24)', () => {
  test('Broadway-market serpCensus row is blocked by default (gate off)', () => {
    assert.equal(
      ingestBlockReason({ serpCensus: true }, { showIsWe: false, weGateOn: false, serpCensusGateOn: false }),
      'serp-census-gate-off'
    );
  });

  test('serpCensus row ingests once SERP_CENSUS_INGEST is on', () => {
    assert.equal(
      ingestBlockReason({ serpCensus: true }, { showIsWe: false, weGateOn: false, serpCensusGateOn: true }),
      null
    );
  });

  test('WE show serpCensus row is blocked by the WE gate first, independent of the SERP census gate', () => {
    assert.equal(
      ingestBlockReason({ serpCensus: true }, { showIsWe: true, weGateOn: false, serpCensusGateOn: true }),
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
    assert.equal(ingestBlockReason({}, { showIsWe: false, weGateOn: false, serpCensusGateOn: false }), null);
  });
});
