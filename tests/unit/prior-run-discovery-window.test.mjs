/**
 * Unit tests for the priorRuns-aware SERP discovery window in
 * scripts/lib/url-discovery.js.
 *
 * Historical incident: 2026-08-02 — brainiac-live-west-end-2026 (Garrick,
 * opened 2026-07-29) declared priorRuns for its 2024 Marylebone Theatre run,
 * the run that won the 2025 Olivier for Best Family Show. The rebuild-side
 * guards honoured that window via isWithinPriorRun(), but DISCOVERY did not:
 * calculateDateWindow() started at previewsStart - 7d (2026-07-19), so Google
 * never returned a single 2024 result, and every per-outlet query literally
 * read `"Brainiac Live" West End review 2026`. The Olivier-winning original
 * press corpus was structurally unreachable.
 *
 * Run: node --test tests/unit/prior-run-discovery-window.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  calculateDateWindow,
  earliestPriorRunStart,
  isUrlYearInPriorRun,
} = require('../../scripts/lib/url-discovery.js');
const { isUrlYearOutsideWindow } = require('../../scripts/lib/content-filters.js');

const BRAINIAC = {
  openingDate: '2026-07-29',
  closingDate: '2026-08-30',
  previewsStartDate: '2026-07-26',
  priorRuns: [{
    openingDate: '2024-07-30',
    closingDate: '2024-08-24',
    venue: 'Marylebone Theatre',
  }],
};

describe('earliestPriorRunStart', () => {
  it('returns null when the show declares no priorRuns', () => {
    assert.strictEqual(earliestPriorRunStart({ openingDate: '2026-07-29' }), null);
    assert.strictEqual(earliestPriorRunStart({ priorRuns: [] }), null);
    assert.strictEqual(earliestPriorRunStart(null), null);
  });

  it('picks the EARLIEST openingDate across multiple prior runs', () => {
    const d = earliestPriorRunStart({
      priorRuns: [
        { openingDate: '2023-11-21', venue: 'Barbican Theatre' },
        { openingDate: '2022-10-08', venue: 'Barbican Theatre' },
      ],
    });
    assert.strictEqual(d.toISOString().slice(0, 10), '2022-10-08');
  });

  it('skips entries with a missing or unparseable openingDate', () => {
    const d = earliestPriorRunStart({
      priorRuns: [{ venue: 'No Date' }, { openingDate: 'not-a-date' }, { openingDate: '2024-07-30' }],
    });
    assert.strictEqual(d.toISOString().slice(0, 10), '2024-07-30');
    assert.strictEqual(earliestPriorRunStart({ priorRuns: [{ venue: 'No Date' }] }), null);
  });
});

describe('calculateDateWindow — priorRuns widening', () => {
  it('widens dateMin back to the prior run (Brainiac Live regression)', () => {
    const win = calculateDateWindow(BRAINIAC);
    // 2024-07-30 minus the same 7-day pre-press margin.
    assert.strictEqual(win.dateMin.toISOString().slice(0, 10), '2024-07-23');
    // The Marylebone press window must fall INSIDE the SERP range.
    const maryleboneReview = new Date('2024-08-01').getTime();
    assert.ok(maryleboneReview >= win.dateMin.getTime());
    assert.ok(maryleboneReview <= win.dateMax.getTime());
  });

  it('leaves the window untouched for a show with no priorRuns', () => {
    const { priorRuns, ...noPrior } = BRAINIAC;
    const win = calculateDateWindow(noPrior);
    assert.strictEqual(win.dateMin.toISOString().slice(0, 10), '2026-07-19');
    // The pre-fix behaviour: 2024 press sits outside the window.
    assert.ok(new Date('2024-08-01').getTime() < win.dateMin.getTime());
  });

  it('never NARROWS the window when a prior run is later than previews', () => {
    const win = calculateDateWindow({
      openingDate: '2026-07-29',
      previewsStartDate: '2026-07-26',
      priorRuns: [{ openingDate: '2026-07-28' }],
    });
    assert.strictEqual(win.dateMin.toISOString().slice(0, 10), '2026-07-19');
  });

  it('still returns null when the show has no dates at all', () => {
    assert.strictEqual(calculateDateWindow({ priorRuns: [{ openingDate: '2024-07-30' }] }), null);
  });
});

describe('isUrlYearInPriorRun — exact readmission, no extra grace', () => {
  // ship-check (Codex, 2026-08-02): handing the prior-run year to
  // isUrlYearOutsideWindow as `openingYear` would COMPOUND its own -3y grace,
  // so a 2026 return with a 2022 prior run would start accepting 2019
  // same-title revival URLs — which nothing downstream rejects.
  const TKAM = [{ openingDate: '2022-03-01', closingDate: '2023-05-31' }];

  it('readmits a URL year the prior run actually spans', () => {
    assert.strictEqual(isUrlYearInPriorRun('https://www.thestage.co.uk/reviews/2022/x-review', TKAM), true);
    assert.strictEqual(isUrlYearInPriorRun('https://www.thestage.co.uk/reviews/2023/x-review', TKAM), true);
  });

  it('does NOT readmit years the prior run does not span', () => {
    // The compounded-grace bug would have accepted 2019 (2022 - 3).
    assert.strictEqual(isUrlYearInPriorRun('https://www.thestage.co.uk/reviews/2019/x-review', TKAM), false);
    assert.strictEqual(isUrlYearInPriorRun('https://www.thestage.co.uk/reviews/2021/x-review', TKAM), false);
    assert.strictEqual(isUrlYearOutsideWindow('https://www.thestage.co.uk/reviews/2019/x-review', 2026, 2026), true);
  });

  it('treats a closingDate-less prior run as a single year', () => {
    const oneYear = [{ openingDate: '2024-07-30' }];
    assert.strictEqual(isUrlYearInPriorRun('https://x.co.uk/2024/r', oneYear), true);
    assert.strictEqual(isUrlYearInPriorRun('https://x.co.uk/2025/r', oneYear), false);
  });

  it('returns false with no priorRuns, no year in the URL, or bad dates', () => {
    assert.strictEqual(isUrlYearInPriorRun('https://x.co.uk/2024/r', null), false);
    assert.strictEqual(isUrlYearInPriorRun('https://x.co.uk/2024/r', []), false);
    assert.strictEqual(isUrlYearInPriorRun('https://x.co.uk/some-review', TKAM), false);
    assert.strictEqual(isUrlYearInPriorRun('https://x.co.uk/2024/r', [{ openingDate: 'nope' }]), false);
  });

  it('readmits the Brainiac 2024 Marylebone year', () => {
    assert.strictEqual(
      isUrlYearInPriorRun('https://www.thestage.co.uk/reviews/2024/brainiac-live-review', BRAINIAC.priorRuns),
      true,
    );
  });
});
