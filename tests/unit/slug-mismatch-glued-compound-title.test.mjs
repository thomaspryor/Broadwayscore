/**
 * Unit test for the glued-compound-title accept-slug in
 * scripts/lib/opening-night-checks/slug-mismatch.check.js.
 *
 * Live incident BRO-3025 (2026-09-08): electra-persona-west-end-2026's
 * checklist gate errored on 5 genuine reviews because several outlets style
 * the review URL slug as the title's words glued together with no separator
 * (e.g. "electrapersona-review"), which the hyphen/space-anchored
 * word-boundary match against "electra-persona" / "electra" / "persona"
 * could never find.
 *
 * Run: node --test tests/unit/slug-mismatch-glued-compound-title.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');
const { run, buildAcceptSlugs } = check;

const show = { id: 'electra-persona-west-end-2026', title: 'Electra / Persona' };

describe('slug-mismatch: glued compound title', () => {
  it('adds the concatenated significant words to acceptSlugs', () => {
    assert.ok(buildAcceptSlugs(show).includes('electrapersona'));
  });

  it('no longer errors on a URL with no separator between title words', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          {
            outletId: 'guardian',
            criticName: 'Arifa Akbar',
            url: 'https://www.theguardian.com/stage/2026/sep/02/electrapersona-review-blanchett-and-hoss-face-off',
          },
        ],
      },
    });
    assert.strictEqual(res.severity, 'ok', res.message);
  });

  it('still errors on a slugged URL naming a different show', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          {
            outletId: 'nytimes',
            criticName: 'B Critic',
            url: 'https://nytimes.com/2026/09/03/theater/every-brilliant-thing-review.html',
          },
        ],
      },
    });
    assert.strictEqual(res.severity, 'error');
    assert.match(res.message, /nytimes/);
  });
});
