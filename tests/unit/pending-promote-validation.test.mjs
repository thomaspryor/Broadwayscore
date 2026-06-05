/**
 * replay-pending-bylines: validate before promoting a stranded _pending review.
 *
 * Incident 2026-06-04 (Beetlejuice WE): the _pending drain promoted junk it found
 * stranded — three WestEndTheatre-roundup URLs filed under telegraph/thestage/times
 * (fabricating fake outlet reviews with the roundup author's byline), a Justin Theroux
 * FILM article, and a Tim Burton interview — all because they mention "Beetlejuice".
 * pendingPromoteRejectReason gates promotion on: aggregator/listing URL, non-theatre
 * news section (wrong production, same title), and verifyAggregatorUrl show-match.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { pendingPromoteRejectReason } = require('../../scripts/replay-pending-bylines.js');

const SHOW = { id: 'beetlejuice-west-end-2026', title: 'Beetlejuice', venue: 'Shaftesbury Theatre', openingDate: '2026-05-28' };
const titled = (t) => `<html><head><title>${t}</title></head><body>${t}</body></html>`;

describe('pendingPromoteRejectReason', () => {
  test('REJECTS a WestEndTheatre roundup URL filed under an outlet', () => {
    const r = pendingPromoteRejectReason(
      'https://www.westendtheatre.com/356598/news/reviews/beetlejuice-the-musical-reviews/',
      titled('Beetlejuice the Musical reviews roundup'), SHOW);
    assert.ok(r && /aggregator/.test(r), `expected aggregator reject, got ${r}`);
  });

  test('REJECTS a same-title FILM article (wrong production)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/film/article/justin-theroux-jennifer-aniston-beetlejuice',
      titled('Justin Theroux on Beetlejuice'), SHOW);
    assert.ok(r && /non-theatre section \(film\)/.test(r), `expected film reject, got ${r}`);
  });

  // Narrowed 2026-06-05 (ship-check): outlets file REAL theatre reviews under
  // tv/music/lifestyle sections (Daily Mail /tv/, USA Today /entertainment/music/,
  // WashPost /lifestyle/), so those sections must NOT auto-reject — that was destroying
  // real reviews. A genuine theatre review under a /tv/ section is promoted; a same-title
  // interview is left to the downstream LLM non-review classifier, not this URL gate.
  test('does NOT reject a real theatre review filed under /tv/ (false-positive guard)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.dailymail.co.uk/tv/article-15559075/review-Shadowlands-London-Aldwych-Theatre.html',
      titled('Beetlejuice review — Aldwych Theatre'), SHOW);
    assert.equal(r, null, `a real review under /tv/ must not be section-rejected, got ${r}`);
  });

  test('REJECTS a different show entirely (show-match)', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/war-horse-review',
      titled('War Horse review'), SHOW);
    assert.ok(r && /not this show/.test(r), `expected show-match reject, got ${r}`);
  });

  test('ALLOWS a genuine theatre review of the right show', () => {
    const r = pendingPromoteRejectReason(
      'https://www.thetimes.com/culture/theatre-dance/article/beetlejuice-review-shaftesbury',
      titled('Beetlejuice review — Shaftesbury Theatre'), SHOW);
    assert.equal(r, null, `expected promote-OK, got reject: ${r}`);
  });
});
