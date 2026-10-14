/**
 * Unit tests for the opaque-URL carve-out in
 * scripts/lib/opening-night-checks/slug-mismatch.check.js.
 *
 * Live incident 2026-09-05 (BRO-2828 follow-on): the opening-night broadcast
 * checklist gate blocked on the-story-west-end-2026 because a genuine
 * Financial Times review by Sarah Hemming — right show, right date, complete
 * tier, assignedScore 60 — lives at ft.com/content/<uuid>. The check demands
 * the show slug appear in the URL, an FT URL never contains one, and the
 * result was a hard error no operator could ever resolve.
 *
 * The carve-out must NOT weaken the signal the check exists for: a URL naming
 * a DIFFERENT show still errors, because it carries real word tokens.
 *
 * Run: node --test tests/unit/slug-mismatch-opaque-urls.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');
const { isOpaqueUrlSlug, urlSearchSlug, run } = check;

const opaque = (url) => isOpaqueUrlSlug(urlSearchSlug(url));

describe('isOpaqueUrlSlug', () => {
  it('treats the live FT /content/<uuid> URL as opaque', () => {
    assert.strictEqual(
      opaque('https://www.ft.com/content/ce137235-1a5a-4eef-b82a-d6f9e7f6a244?syn-25a6b1a6=1'),
      true,
    );
  });

  it('treats a bare numeric id path as opaque', () => {
    assert.strictEqual(opaque('https://example.com/p/123456'), true);
  });

  it('treats an empty path as opaque', () => {
    assert.strictEqual(opaque('https://example.com/'), true);
  });

  it('does NOT treat a slugged URL as opaque, even for the wrong show', () => {
    assert.strictEqual(
      opaque('https://www.thetimes.com/culture/theatre-dance/article/the-story-review-06fjp2xcd'),
      false,
    );
    assert.strictEqual(
      opaque('https://nytimes.com/2026/09/03/theater/some-other-show-review.html'),
      false,
    );
  });
});

describe('slug-mismatch run() with an opaque-URL review', () => {
  const show = { id: 'the-story-west-end-2026', title: 'The Story', slug: 'the-story' };
  const FT = 'https://www.ft.com/content/ce137235-1a5a-4eef-b82a-d6f9e7f6a244?syn-25a6b1a6=1';

  it('no longer errors on an FT review of the right show', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          { outletId: 'financialtimes', criticName: 'Sarah Hemming', url: FT },
          {
            outletId: 'guardian',
            criticName: 'A Critic',
            url: 'https://www.theguardian.com/stage/2026/sep/03/the-story-review-national-theatre',
          },
        ],
      },
    });
    assert.strictEqual(res.severity, 'ok', res.message);
    assert.match(res.message, /opaque-id URL\(s\) skipped: financialtimes/);
  });

  it('still errors on a slugged URL naming a different show', () => {
    const res = run(show, {
      reviewsDoc: {
        [show.id]: [
          { outletId: 'financialtimes', criticName: 'Sarah Hemming', url: FT },
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
    assert.ok(
      !/financialtimes/.test(res.message),
      'the opaque FT URL must not be reported as a mismatch',
    );
  });
});
