/**
 * Unit tests for previewsStartDate + priorRuns support in
 * scripts/lib/opening-night-checks/publish-date-pre-opening.check.js.
 *
 * Live incident BRO-3025 (2026-09-08): the opening-night broadcast checklist
 * gate blocked electra-persona-west-end-2026 and abigails-party-west-end-2026,
 * contributing to those shows' subscriber emails never being sent.
 *   - electra-persona-west-end-2026: 3 genuine reviews of preview performances
 *     (published during previewsStartDate..openingDate) were flagged as
 *     "anticipatory posts" — the check only knew about openingDate.
 *   - abigails-party-west-end-2026: 6 genuine reviews of the show's declared
 *     priorRuns entry (Theatre Royal Stratford East, 2024) were flagged as
 *     pre-opening, because the check never looked at priorRuns at all.
 *
 * Run: node --test tests/unit/publish-date-pre-opening-previews-priorruns.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/publish-date-pre-opening.check.js');
const { run } = check;

describe('publish-date-pre-opening: previewsStartDate', () => {
  const show = {
    id: 'electra-persona-west-end-2026',
    title: 'Electra / Persona',
    openingDate: '2026-09-01',
    previewsStartDate: '2026-08-19',
  };

  it('accepts a review published during previews, well before openingDate', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          { outletId: 'cultural-capital', criticName: 'Unknown', publishDate: '2026-08-24', url: 'https://x.com/a' },
        ],
      },
      reviewTextsRoot: '/nonexistent',
    });
    assert.strictEqual(res.severity, 'ok', res.message);
  });

  it('still flags a review published before previews even started', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          { outletId: 'anticipation-blog', criticName: 'Unknown', publishDate: '2026-08-01', url: 'https://x.com/b' },
        ],
      },
      reviewTextsRoot: '/nonexistent',
    });
    assert.strictEqual(res.severity, 'error');
    assert.match(res.message, /anticipation-blog/);
  });
});

describe('publish-date-pre-opening: priorRuns', () => {
  const show = {
    id: 'abigails-party-west-end-2026',
    title: 'Abigail’s Party',
    openingDate: '2026-08-19',
    previewsStartDate: '2026-08-12',
    priorRuns: [
      { venue: 'Theatre Royal Stratford East', openingDate: '2024-09-06', closingDate: '2024-10-05' },
    ],
  };

  it('accepts a review published during the priorRun window', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          { outletId: 'thestage', criticName: 'Paul Vale', publishDate: '2024-09-13', url: 'https://x.com/c' },
        ],
      },
      reviewTextsRoot: '/nonexistent',
    });
    assert.strictEqual(res.severity, 'ok', res.message);
  });

  it('still flags a review published between the priorRun and the current run', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          { outletId: 'curtain-call-reviews', criticName: 'Unknown', publishDate: '2026-07-20', url: 'https://x.com/d' },
        ],
      },
      reviewTextsRoot: '/nonexistent',
    });
    assert.strictEqual(res.severity, 'error');
    assert.match(res.message, /curtain-call-reviews/);
  });
});
