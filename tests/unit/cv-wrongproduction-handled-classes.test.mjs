// BRO-5437: cv-wrongproduction-unhandled.check.js listed 1153 shipped reviews
// across 586 shows, almost all already handled by a documented pipeline
// decision. handledReason() sets those classes aside; the real bypass shapes
// (high/medium confidence, or low + OVERRIDE with explicit different-show
// evidence, the juan-a-ramirez class) must still be violations.
//
// Synthetic fixtures only: no review text.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/cv-wrongproduction-unhandled.check.js');

const SHOW = {
  id: 'handled-classes-fixture-2026',
  title: 'Fixture Show',
  slug: 'fixture-show',
  category: 'broadway',
  venue: 'Todd Haimes Theatre',
  openingDate: '2026-04-20',
  priorRuns: [{ venue: 'Kennedy Center', openingDate: '2025-01-15', closingDate: '2025-02-20' }],
};

const OVERRIDE = '[OVERRIDE: review within 1d of opening, likely correct production] ';

function file(slug, extra) {
  return {
    showId: SHOW.id,
    outletId: slug,
    criticName: `Critic ${slug}`,
    url: `https://example.com/${slug}/fixture-show-review`,
    publishDate: '2026-04-21',
    contentVerification: { wrongProduction: true, confidence: 'low', reasoning: '', issues: [] },
    ...extra,
  };
}

const FILES = {
  'temporal-low.json': file('temporal-low', {
    contentVerification: { wrongProduction: true, confidence: 'low',
      reasoning: `${OVERRIDE}Review names the American Airlines Theatre, not the Todd Haimes Theatre.`,
      issues: ['Venue mismatch'] },
  }),
  'juan-a-ramirez.json': file('juan-a-ramirez', {
    contentVerification: { wrongProduction: true, confidence: 'low',
      reasoning: `${OVERRIDE}The scraped content reviews the wrong production entirely.`,
      issues: ['reviews a different production'] },
  }),
  'low-no-override.json': file('low-no-override', {
    contentVerification: { wrongProduction: true, confidence: 'low', reasoning: 'Different venue.', issues: [] },
  }),
  'high.json': file('high', {
    contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'Review of the tour.', issues: [] },
  }),
  'prior-run.json': file('prior-run', {
    publishDate: '2025-02-01',
    contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'Kennedy Center production.', issues: [] },
  }),
  'manual-reason.json': file('manual-reason', {
    wrongProductionManualClear: 'Curator: the Royal Court run is this production.',
    contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'Royal Court.', issues: [] },
  }),
  'override-flag.json': file('override-flag', {
    wrongProductionOverride: true,
    contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'x', issues: [] },
  }),
  // Its own top-level flag excludes it; the shipped row with its url is a sibling's.
  // Shares its url with a different critic's shipped row (mis-split byline).
  'sibling.json': file('sibling', { url: 'https://example.com/shared/fixture-show-review',
    contentVerification: { wrongProduction: false, confidence: 'high', reasoning: '', issues: [] } }),
  'not-shipped.json': file('not-shipped', {
    url: 'https://example.com/shared/fixture-show-review',
    wrongProduction: true,
    contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'Tryout review.', issues: [] },
  }),
  // A duplicateOf copy of a sibling that carries its own clean CV verdict: the
  // rebuild drops the copy, so the shipped row is the target's.
  'dup-target.json': file('dup', { contentVerification: { wrongProduction: false, confidence: 'high', reasoning: '', issues: [] } }),
  'dup-copy.json': file('dup', { duplicateOf: 'dup-target.json',
    contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'Tour review.', issues: [] } }),
  // Same shape, but the target was never verified: the copy's CV is the only
  // check on that url, so it stays a violation.
  'dup-unverified-target.json': (() => { const d = file('dupu', {}); delete d.contentVerification; return d; })(),
  'dup-unverified-copy.json': file('dupu', { duplicateOf: 'dup-unverified-target.json',
    contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'Tour review.', issues: [] } }),
};

let tmpRoot;
let result;
let plainResult;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-wp-handled-'));
  const dir = path.join(tmpRoot, SHOW.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  const shipped = Object.values(FILES).filter((d) => d.outletId !== 'not-shipped' && !d.duplicateOf).map((d) => ({ showId: SHOW.id, outletId: d.outletId, criticName: d.criticName, url: d.url }));
  const ctx = { reviewTextsRoot: tmpRoot, reviewsDoc: { [SHOW.id]: shipped } };
  result = check.run(SHOW, { ...ctx, setAsideHandled: true });
  plainResult = check.run(SHOW, ctx);
});

after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('cv-wrongproduction-unhandled handled classes (BRO-5437)', () => {
  it('still reports the real bypass shapes as errors', () => {
    assert.equal(result.severity, 'error');
    const flagged = result.details.violations.map((v) => v.filename).sort();
    assert.deepEqual(flagged, ['dup-unverified-copy.json', 'high.json', 'juan-a-ramirez.json', 'low-no-override.json']);
  });

  it('sets aside each documented handled class, by reason', () => {
    assert.deepEqual(result.details.handledCounts, {
      'temporal-override-low-confidence': 1,
      'prior-run-or-tour-leg': 1,
      'manual-clear-reason': 1,
      'rebuild-skip-audit': 1,
      'not-shipped': 1,
      'duplicate-not-shipped': 1,
    });
  });

  it('the opening-night run (no setAsideHandled) still reports every class', () => {
    assert.equal(plainResult.details.violations.length, 10);
  });

  it('handledReason: an override marker whose current date left the 30-day window is not handled', () => {
    const d = file('x', { publishDate: '2023-01-01', contentVerification: { wrongProduction: true,
      confidence: 'low', reasoning: `${OVERRIDE}venue`, issues: [] } });
    assert.equal(check.handledReason(d, SHOW, '/nonexistent/x.json'), null);
  });

  it('handledReason: an inheritReviews:false prior-run window is not handled', () => {
    const show = { ...SHOW, priorRuns: [{ ...SHOW.priorRuns[0], inheritReviews: false }] };
    const d = file('x', { publishDate: '2025-02-01', contentVerification: { wrongProduction: true,
      confidence: 'high', reasoning: 'x', issues: [] } });
    assert.equal(check.handledReason(d, show, '/nonexistent/x.json'), null);
  });

  it('handledReason: own url+critic shipped means it is not "not-shipped"', () => {
    const d = file('x', { wrongProduction: true, contentVerification: { wrongProduction: true,
      confidence: 'high', reasoning: 'x', issues: [] } });
    assert.equal(check.handledReason(d, SHOW, '/nonexistent/x.json', { exactShipped: true }), null);
  });

  it('handledReason: placeholder manual-clear strings are not a clear', () => {
    for (const mc of ['pending review by curator', 'no', 'NOT cleared yet, check']) {
      const d = file('x', { wrongProductionManualClear: mc,
        contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'x', issues: [] } });
      assert.equal(check.handledReason(d, SHOW, '/nonexistent/x.json'), null, mc);
    }
  });

  it('handledReason: a "false" manual-clear string is not a clear', () => {
    const d = file('x', { wrongProductionManualClear: 'false',
      contentVerification: { wrongProduction: true, confidence: 'high', reasoning: 'x', issues: [] } });
    assert.equal(check.handledReason(d, SHOW, '/nonexistent/x.json'), null);
  });

  it('handledReason: a duplicateOf pointing at a missing file is not handled', () => {
    const d = file('x', { duplicateOf: 'gone.json', contentVerification: { wrongProduction: true,
      confidence: 'high', reasoning: 'x', issues: [] } });
    assert.equal(check.handledReason(d, SHOW, path.join(tmpRoot, SHOW.id, 'x.json')), null);
  });

  it('handledReason: temporal override is only honored at low confidence', () => {
    const d = file('x', { contentVerification: { wrongProduction: true, confidence: 'medium',
      reasoning: `${OVERRIDE}venue`, issues: [] } });
    assert.equal(check.handledReason(d, SHOW, '/nonexistent/x.json'), null);
  });
});
