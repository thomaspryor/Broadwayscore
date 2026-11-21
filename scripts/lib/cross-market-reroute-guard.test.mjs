/**
 * scripts/lib/cross-market-reroute-guard.js — BRO-4204 audit S6-T2.
 *
 * Exercises the REAL decideCrossMarketReroute (CLAUDE.md §15) with the real
 * Romeo and Juliet shape: Theatre Record relayed the London reviews of Robert
 * Icke's Harold Pinter Theatre production with no outlet URL; the date guard
 * filed them under romeo-and-juliet-1977 and --cross-market then moved them
 * onto the 2026 Delacorte production on year proximity alone.
 *
 * Run: node --test scripts/lib/cross-market-reroute-guard.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideCrossMarketReroute,
  productionMarkers,
  venueMarkers,
  dualMarketOutletForHost,
} = require('./cross-market-reroute-guard.js');

// Real shows.json records (2026-09-28) — fields the guard reads.
const NYC_2026 = {
  id: 'romeo-and-juliet-off-broadway-2026', title: 'Romeo and Juliet', category: 'off-broadway',
  venue: 'Public Theater/Delacorte Theater', openingDate: '2026-06-11',
  creativeTeam: [{ name: 'Saheem Ali', role: 'Director' }, { name: 'William Shakespeare', role: 'Playwright' }],
};
const WE_2026 = {
  id: 'romeo-and-juliet-west-end-2026', title: 'Romeo and Juliet', category: 'west-end',
  venue: 'Harold Pinter Theatre', openingDate: '2026-03-31',
  creativeTeam: [{ name: 'Robert Icke', role: 'Director' }, { name: 'William Shakespeare', role: 'Book Writer' }],
};
const BWAY_1977 = {
  id: 'romeo-and-juliet-1977', title: 'Romeo and Juliet', category: 'broadway',
  venue: 'Circle in the Square Theatre', openingDate: '1977-03-17',
  creativeTeam: [{ name: 'Theodore Mann', role: 'Director' }, { name: 'Ming Cho Lee', role: 'Scenic Design' }],
};

// Registry slice — real isDualMarket / domain values.
const REGISTRY = {
  outlets: {
    variety: { tier: 1, isDualMarket: true, domain: 'variety.com' },
    'times-uk': { tier: 1, isDualMarket: true, domain: 'thetimes.co.uk', region: 'london' },
    thestage: { tier: 2, isDualMarket: true, domain: 'thestage.co.uk', region: 'london' },
    'london-theatre': { tier: 3, domain: 'londontheatre.co.uk', region: 'london' }, // NOT dual-market
  },
};

// Real times-uk--clive-davis.json shape (text abridged to the identifying sentences).
const TIMES_TR_RELAY = {
  source: 'theatre-record',
  url: null,
  theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/3/37873-romeo-and-juliet',
  outletId: 'times-uk',
  criticName: 'Clive Davis',
  publishDate: '2026-04-01',
  wrongProduction: true,
  wrongProductionNote: 'cross-market: London outlet reviewing Broadway show',
  fullText: 'Time presses on Sadie Sink and Noah Jupe in this modern-dress version of the tale of lovers. '
    + 'As in his recent reworking of Oedipus, the director Robert Icke confronts us with a digital clock. '
    + 'What is clear from this evening at an uncomfortably warm Harold Pinter Theatre is that Sink is a star.',
};

describe('decideCrossMarketReroute — the real R&J case', () => {
  test('theatre-record relay, no URL, text names Icke / Harold Pinter, target Delacorte → skip', () => {
    const verdict = decideCrossMarketReroute({
      file: TIMES_TR_RELAY, candidateShow: NYC_2026, sourceShow: BWAY_1977,
      outletRegistry: REGISTRY, siblings: [NYC_2026, WE_2026, BWAY_1977],
    });
    assert.equal(verdict.allow, false);
    assert.ok(verdict.reasons.includes('no-url'), verdict.reason);
    assert.ok(verdict.reasons.includes('target-venue-or-director-not-named'), verdict.reason);
    assert.ok(verdict.reasons.includes('names-other-production:romeo-and-juliet-west-end-2026'), verdict.reason);
    assert.equal(verdict.stampOverride, false);
    assert.deepEqual(verdict.evidence.matched, []);
  });

  test('same relay even WITH a dual-market URL still skips: the text names the wrong production', () => {
    const verdict = decideCrossMarketReroute({
      file: { ...TIMES_TR_RELAY, url: 'https://www.thetimes.co.uk/article/romeo-and-juliet-review-x' },
      candidateShow: NYC_2026, sourceShow: BWAY_1977, outletRegistry: REGISTRY, siblings: [WE_2026],
    });
    assert.equal(verdict.allow, false);
    assert.ok(!verdict.reasons.includes('no-url'));
    assert.ok(verdict.reasons.includes('target-venue-or-director-not-named'), verdict.reason);
    assert.equal(verdict.evidence.dualMarketOutletId, 'times-uk');
  });

  test('Variety review with a variety.com URL whose text names the Delacorte → allowed, no override stamp', () => {
    const file = {
      source: 'serp-discovery',
      url: 'https://variety.com/2026/legit/reviews/romeo-and-juliet-review-1236000000/',
      outletId: 'variety',
      criticName: 'Ellise Shafer',
      publishDate: '2026-06-12',
      wrongProduction: true,
      wrongProductionNote: 'cross-market: London outlet reviewing Broadway show',
      fullText: 'Under the stars at the Delacorte, Shakespeare in the Park returns with a Romeo and Juliet '
        + 'that runs against the clock. The lovers are played with real heat.',
    };
    const verdict = decideCrossMarketReroute({
      file, candidateShow: NYC_2026, sourceShow: BWAY_1977, outletRegistry: REGISTRY, siblings: [WE_2026],
    });
    assert.equal(verdict.allow, true, verdict.reason);
    assert.equal(verdict.stampOverride, false);
    assert.equal(verdict.evidence.dualMarketOutletId, 'variety');
    assert.deepEqual(verdict.evidence.matched, [{ kind: 'venue', marker: 'delacorte' }]);
    assert.ok(!('wrongProductionOverride' in verdict), 'decision never carries an override stamp');
  });

  test('director named (Saheem Ali) is sufficient evidence when the venue is not', () => {
    const file = {
      url: 'https://variety.com/2026/legit/reviews/rj/',
      fullText: 'Saheem Ali directs a fleet, sun-dappled Romeo and Juliet in Central Park.',
    };
    const verdict = decideCrossMarketReroute({ file, candidateShow: NYC_2026, outletRegistry: REGISTRY });
    assert.equal(verdict.allow, true, verdict.reason);
    assert.deepEqual(verdict.evidence.matched, [{ kind: 'director', marker: 'saheem ali' }]);
  });

  test('contentVerification naming the target venue counts as evidence', () => {
    const file = {
      url: 'https://www.thestage.co.uk/reviews/romeo-and-juliet-review',
      fullText: 'A brisk, bloody staging of the lovers\' tragedy.',
      contentVerification: { isValid: true, reasoning: 'Review of the Public Theater production at the Delacorte Theater, June 2026.' },
    };
    const verdict = decideCrossMarketReroute({ file, candidateShow: NYC_2026, outletRegistry: REGISTRY });
    assert.equal(verdict.allow, true, verdict.reason);
    assert.ok(verdict.evidence.matched.some(m => m.kind === 'venue'));
  });

  test('dual-market host is required: a London-only outlet URL skips even when the target is named', () => {
    const file = {
      url: 'https://www.londontheatre.co.uk/reviews/romeo-and-juliet',
      fullText: 'The Delacorte production directed by Saheem Ali is a triumph.',
    };
    const verdict = decideCrossMarketReroute({ file, candidateShow: NYC_2026, outletRegistry: REGISTRY });
    assert.equal(verdict.allow, false);
    assert.ok(verdict.reasons.includes('host-not-dual-market-outlet:londontheatre.co.uk'), verdict.reason);
  });

  test('human breadcrumb crossMarketRerouteApproved: true bypasses both checks, still no override', () => {
    const verdict = decideCrossMarketReroute({
      file: { ...TIMES_TR_RELAY, crossMarketRerouteApproved: true },
      candidateShow: NYC_2026, sourceShow: BWAY_1977, outletRegistry: REGISTRY,
    });
    assert.equal(verdict.allow, true);
    assert.deepEqual(verdict.reasons, ['human-approved']);
    assert.equal(verdict.stampOverride, false);
  });

  test('unparseable URL and missing candidate are refusals, not crashes', () => {
    assert.equal(decideCrossMarketReroute({ file: { url: 'not a url', fullText: 'Delacorte' }, candidateShow: NYC_2026, outletRegistry: REGISTRY }).allow, false);
    assert.equal(decideCrossMarketReroute({ file: { url: 'https://variety.com/x' } }).allow, false);
    assert.equal(decideCrossMarketReroute({}).allow, false);
  });
});

describe('production markers', () => {
  test('venue variants: full name + distinctive stem; generic stems dropped', () => {
    assert.deepEqual(venueMarkers('Public Theater/Delacorte Theater'), ['public theater', 'delacorte theater', 'delacorte']);
    assert.deepEqual(venueMarkers('Harold Pinter Theatre'), ['harold pinter theater', 'harold pinter']);
    assert.deepEqual(venueMarkers('The Old Vic'), ['old vic']);
    assert.deepEqual(venueMarkers('Metropolitan Opera House'), ['metropolitan opera house', 'metropolitan opera']);
    assert.deepEqual(venueMarkers('Perelman Performing Arts Center (PAC NYC)'), ['perelman performing arts center', 'perelman', 'pac nyc']);
    assert.deepEqual(venueMarkers(null), []);
  });

  test('director: stage director only, not musical/associate/casting roles', () => {
    const m = productionMarkers({
      venue: 'Winter Garden Theatre',
      creativeTeam: [
        { name: 'Jamie Lloyd', role: 'Director' },
        { name: 'Fabian Aloise', role: 'Choreographer' },
        { name: 'Someone Else', role: 'Associate Director' },
        { name: 'A Musician', role: 'Music Director' },
      ],
    });
    assert.deepEqual(m.director, ['jamie lloyd']);
    assert.deepEqual(m.venue, ['winter garden theater', 'winter garden']);
  });

  test('dualMarketOutletForHost: subdomain-aware, dual-market only', () => {
    assert.equal(dualMarketOutletForHost('www.variety.com', REGISTRY), 'variety');
    assert.equal(dualMarketOutletForHost('amp.thetimes.co.uk', REGISTRY), 'times-uk');
    assert.equal(dualMarketOutletForHost('londontheatre.co.uk', REGISTRY), null);
    assert.equal(dualMarketOutletForHost('notvariety.com', REGISTRY), null);
  });
});
