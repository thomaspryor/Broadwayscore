/**
 * Unit tests for getWrongProductionReasonFromUrl in scripts/lib/review-guards.js
 *
 * Fixtures based on the 7 files manually deleted from
 * data/review-texts/_pending/fallen-angels-2026/ on opening night (2026-04-19).
 * These were Unknown-byline SERP hits with URL paths pointing to prior years.
 *
 * Run: node --test tests/unit/url-date-wrongproduction.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  getWrongProductionReasonFromUrl,
  getWrongProductionReasonForUnknownCritic,
} = require('../../scripts/lib/review-guards.js');

const fallenAngels = {
  id: 'fallen-angels-2026',
  category: 'broadway',
  previewsStartDate: '2026-03-19',
  openingDate: '2026-04-19',
};

const fallenAngelsWithCloseDate = {
  ...fallenAngels,
  closingDate: '2026-08-30',
};

const priorFallenAngels = {
  id: 'fallen-angels',
  category: 'broadway',
  previewsStartDate: '2022-09-01',
  openingDate: '2022-10-15',
  closingDate: '2022-12-18',
};

describe('getWrongProductionReasonFromUrl — flags wrong-year URLs', () => {
  it('flags NYT /2024/ article for 2026 show', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2024/03/14/theater/smash-broadway-musical.html',
      fallenAngels
    );
    assert.ok(reason, 'should return a reason string');
    assert.match(reason, /prior production|before show earliest/i);
    assert.match(reason, /2024-03-14/);
  });

  it('flags NYT /2025/ article when previews start 2026-03', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2025/06/22/theater/korean-theater-ai.html',
      fallenAngels
    );
    assert.ok(reason, 'should flag — 2025-06 is > 30 days before 2026-03');
  });

  it('flags Guardian /2025/ article for 2026 show', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.theguardian.com/stage/2025/jun/30/fallen-angels-menier-chocolate-factory-review',
      fallenAngels
    );
    assert.ok(reason, 'should flag — prior London production');
  });

  it('keeps Variety /YYYY/legit/ year-only URL (no month — fail-safe KEEP)', () => {
    // Variety theater URLs sometimes lack month in path: /2024/legit/reviews/...
    // Year-only is intentionally NOT flagged — too imprecise, risk of false positive.
    const reason = getWrongProductionReasonFromUrl(
      'https://variety.com/2024/legit/reviews/full-monty-review-1235890123/',
      fallenAngels
    );
    assert.strictEqual(reason, null);
  });

  it('flags Playbill /2024/MM/DD/ article for 2026 show', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.playbill.com/2024/10/07/some-coverage-article',
      fallenAngels
    );
    assert.ok(reason);
  });
});

describe('getWrongProductionReasonFromUrl — keeps in-window URLs', () => {
  it('keeps /2026/04/ article for 2026-04 opening', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2026/04/19/theater/fallen-angels-review.html',
      fallenAngels
    );
    assert.strictEqual(reason, null);
  });

  it('keeps /2026/03/ article published during previews', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2026/03/22/theater/fallen-angels-first-look.html',
      fallenAngels
    );
    assert.strictEqual(reason, null);
  });

  it('keeps /2026/02/ article within the 30-day lead window', () => {
    // previewsStart 2026-03-19, so 2026-02-20 is ~27 days before → within window
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2026/02/20/theater/fallen-angels-preview.html',
      fallenAngels
    );
    assert.strictEqual(reason, null);
  });
});

describe('getWrongProductionReasonFromUrl — post-closing (revival/tour)', () => {
  it('flags article published >30 days after show closed', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2024/06/15/theater/fallen-angels-revival-review.html',
      priorFallenAngels
    );
    assert.ok(reason);
    assert.match(reason, /after show closed|later production/i);
  });

  it('keeps articles within the 30-day trailing window', () => {
    // Closed 2022-12-18, so 2023-01-10 is ~23 days after → within window
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2023/01/10/theater/fallen-angels-wrap-review.html',
      priorFallenAngels
    );
    assert.strictEqual(reason, null);
  });
});

describe('getWrongProductionReasonFromUrl — fail-safe edge cases', () => {
  it('returns null for null url', () => {
    assert.strictEqual(getWrongProductionReasonFromUrl(null, fallenAngels), null);
  });

  it('returns null for non-string url', () => {
    assert.strictEqual(getWrongProductionReasonFromUrl(123, fallenAngels), null);
    assert.strictEqual(getWrongProductionReasonFromUrl({}, fallenAngels), null);
  });

  it('returns null for empty url', () => {
    assert.strictEqual(getWrongProductionReasonFromUrl('', fallenAngels), null);
  });

  it('returns null for url without /YYYY/MM/ path segment', () => {
    assert.strictEqual(
      getWrongProductionReasonFromUrl(
        'https://www.nytimes.com/theater/fallen-angels.html',
        fallenAngels
      ),
      null
    );
  });

  it('returns null for url with year-like query param (not path)', () => {
    assert.strictEqual(
      getWrongProductionReasonFromUrl(
        'https://example.com/theater/review?year=2024&month=03',
        fallenAngels
      ),
      null
    );
  });

  it('returns null when show is null', () => {
    assert.strictEqual(
      getWrongProductionReasonFromUrl('https://nytimes.com/2024/03/14/theater/x.html', null),
      null
    );
  });

  it('returns null when show has no earliest date', () => {
    const showNoDate = { id: 'x', category: 'broadway' };
    assert.strictEqual(
      getWrongProductionReasonFromUrl('https://nytimes.com/2024/03/14/theater/x.html', showNoDate),
      null
    );
  });

  // NOTE: off-broadway was blanket-exempt here until 2026-06-05. It is no longer —
  // see the dedicated "off-broadway lead window + prior-run exemption" block below.

  it('returns null for invalid month in URL (e.g. /YYYY/14/)', () => {
    assert.strictEqual(
      getWrongProductionReasonFromUrl(
        'https://example.com/2024/14/99/x.html',
        fallenAngels
      ),
      null
    );
  });

  it('falls back to openingDate when previewsStartDate missing', () => {
    const showNoPreview = {
      id: 'x',
      category: 'broadway',
      openingDate: '2026-04-19',
    };
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2024/03/14/theater/x.html',
      showNoPreview
    );
    assert.ok(reason);
  });

  it('uses /YYYY/MM/ (no day) with default day 15', () => {
    // When day is missing, fn uses 15. /2024/03/ → 2024-03-15 → flagged for 2026 show
    const reason = getWrongProductionReasonFromUrl(
      'https://www.playbill.com/2024/03/some-article/',
      fallenAngels
    );
    assert.ok(reason);
    assert.match(reason, /2024-03-15/);
  });
});

describe('getWrongProductionReasonFromUrl — off-broadway lead window + prior-run exemption', () => {
  // OB shows legitimately carry same-season pre-transfer coverage, so they use a
  // wider 180-day lead window than Broadway (30d) instead of the old blanket exempt.
  const obShow = {
    id: 'girl-interrupted-off-broadway-2026',
    category: 'off-broadway',
    previewsStartDate: '2026-05-13',
    openingDate: '2026-06-04',
  };

  it('flags the Our New Girl cross-attribution (2025 article on 2026 OB show)', () => {
    // The girl-interrupted 2026-06-05 incident: a 2025 Guardian review of a DIFFERENT
    // show ("Our New Girl") attached via the shared "girl" title token.
    const reason = getWrongProductionReasonFromUrl(
      'https://www.theguardian.com/stage/2025/apr/14/our-new-girl-review-lyric-belfast',
      obShow
    );
    assert.ok(reason, 'should flag — 13 months before previews, no prior run');
    assert.match(reason, /prior\/different production/i);
  });

  it('flags an OB article >180 days before previews (no prior run)', () => {
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2025/01/20/theater/x-review.html',
      obShow
    );
    assert.ok(reason);
  });

  it('KEEPS an OB same-season pre-transfer article within the 180-day window', () => {
    // 2026-01-20 is ~113 days before 2026-05-13 previews → within OB window.
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2026/01/20/theater/some-ob-show-first-look.html',
      obShow
    );
    assert.strictEqual(reason, null);
  });

  it('KEEPS an OB review dated within a declared prior-run window', () => {
    // Sexual Misconduct of the Middle Classes 2026 — Audible Minetta Lane 2025 run.
    const priorRunShow = {
      id: 'sexual-misconduct-of-the-middle-classes-off-broadway-2026',
      category: 'off-broadway',
      previewsStartDate: '2026-03-17',
      openingDate: '2026-03-17',
      priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }],
    };
    const reason = getWrongProductionReasonFromUrl(
      'https://www.nytimes.com/2025/05/08/theater/sexual-misconduct-review.html',
      priorRunShow
    );
    assert.strictEqual(reason, null, 'prior-run coverage is legit, must not flag');
  });

  it('Broadway lead window stays tight at 30 days (unchanged)', () => {
    // 60 days before previews on Broadway → still flagged (no widening for BW).
    const bw = { id: 'x', category: 'broadway', previewsStartDate: '2026-05-01', openingDate: '2026-05-15' };
    assert.ok(getWrongProductionReasonFromUrl('https://www.nytimes.com/2026/03/01/theater/x-review.html', bw));
  });
});

describe('getWrongProductionReasonForUnknownCritic — criticName gate', () => {
  const badUrl = 'https://www.theguardian.com/stage/2015/feb/18/hamilton-review-public-theater';
  const hamilton2015 = {
    id: 'hamilton-2015',
    category: 'broadway',
    previewsStartDate: '2015-07-13',
    openingDate: '2015-08-06',
  };

  it('flags Unknown byline with prior-year Guardian URL', () => {
    const reason = getWrongProductionReasonForUnknownCritic(
      { url: badUrl, criticName: 'Unknown' },
      hamilton2015
    );
    assert.ok(reason, 'should flag when byline is Unknown');
  });

  it('flags empty/missing criticName', () => {
    assert.ok(getWrongProductionReasonForUnknownCritic({ url: badUrl, criticName: '' }, hamilton2015));
    assert.ok(getWrongProductionReasonForUnknownCritic({ url: badUrl, criticName: null }, hamilton2015));
    assert.ok(getWrongProductionReasonForUnknownCritic({ url: badUrl }, hamilton2015));
  });

  it('flags "Staff" byline (generic)', () => {
    assert.ok(
      getWrongProductionReasonForUnknownCritic({ url: badUrl, criticName: 'Staff' }, hamilton2015)
    );
  });

  it('KEEPS named critic even with prior-year URL (FP protection)', () => {
    // The core FP class this gate is designed to prevent: Jesse Green / Ben Brantley /
    // Michael Billington reviewing a legitimate pre-transfer UK or OB run before the
    // Broadway window. URL date alone can't tell "different show" from "same show,
    // earlier venue" — named critics get the benefit of the doubt at ingest time.
    assert.strictEqual(
      getWrongProductionReasonForUnknownCritic(
        { url: badUrl, criticName: 'Jesse Green' },
        hamilton2015
      ),
      null
    );
  });

  it('case-insensitive on "unknown"', () => {
    assert.ok(
      getWrongProductionReasonForUnknownCritic({ url: badUrl, criticName: 'UNKNOWN' }, hamilton2015)
    );
    assert.ok(
      getWrongProductionReasonForUnknownCritic({ url: badUrl, criticName: '  unknown  ' }, hamilton2015)
    );
  });

  it('returns null for null review', () => {
    assert.strictEqual(getWrongProductionReasonForUnknownCritic(null, hamilton2015), null);
  });

  it('returns null when URL is in-window (Unknown byline, good URL)', () => {
    assert.strictEqual(
      getWrongProductionReasonForUnknownCritic(
        { url: 'https://www.nytimes.com/2015/08/06/theater/hamilton-review.html', criticName: 'Unknown' },
        hamilton2015
      ),
      null
    );
  });
});
