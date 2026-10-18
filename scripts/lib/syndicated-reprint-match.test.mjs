// BRO-5489: syndication-portal reprints of held reviews are not review gaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { syndicatedReprintOf, slugTokens } = require('./syndicated-reprint-match.js');
const { classifyGapCandidateUrl } = require('./non-review-url-patterns.js');

const GUARDIAN = {
  url: 'https://www.theguardian.com/stage/2026/oct/04/antigone-exits-review-minerva-theatre-chichester-nina-segal-jeff-james',
  fullText: 'Review Antigone Exits review – emotions run high in experimental reworking of Greek tragedy Minerva theatre, Chichester Nina Segal’s revisiting of the Sophoclean story is pleasingly innovative',
};
const STAGE = {
  url: 'https://www.thestage.co.uk/reviews/antigone-exits-review-chichester-festival-theatre-nina-segal',
  fullText: 'Antigone Exits review at Chichester Festival Theatre: Nina Segal reworks Sophocles with a cast that keeps stepping out of the story',
};
const AOL = 'https://www.aol.co.uk/articles/antigone-exits-review-emotions-run-104342000.html';

test('AOL reprint of the held Guardian review is a dup (Antigone Exits, real case)', () => {
  const v = syndicatedReprintOf({ candidateUrl: AOL, heldFiles: [STAGE, GUARDIAN], showTitle: 'Antigone Exits', venue: 'Chichester Festival Theatre, Chichester' });
  assert.equal(v.dup, true);
  assert.equal(v.matchedUrl, GUARDIAN.url);
  assert.equal(v.reason, 'syndicated-reprint');
});

test('reprint of a review we do not hold stays a gap', () => {
  const v = syndicatedReprintOf({ candidateUrl: AOL, heldFiles: [STAGE], showTitle: 'Antigone Exits' });
  assert.equal(v.dup, false);
});

test('a slug of title + venue words never matches, even with no venue given (King Lear, real case)', () => {
  const heads = [
    'Review King Lear review – David Threlfall makes a moving Lear Royal Exchange theatre, Manchester',
    'REVIEW: KING LEAR | ROYAL EXCHANGE THEATRE | 8/10/2026 Sarah Monaghan',
    'King Lear at the Royal Exchange Theatre review: David Threlfall delivers a performance to remember',
    'King Lear at Royal Exchange, Manchester Review Reviews 10 Oct Written By Eleanor Bywater',
  ];
  const held = heads.map((fullText, i) => ({ url: `https://outlet${i}.example/king-lear-review`, fullText }));
  const url = 'https://uk.news.yahoo.com/review-king-lear-royal-exchange-170000344.html';
  assert.equal(syndicatedReprintOf({ candidateUrl: url, heldFiles: held, showTitle: 'King Lear' }).dup, false);
  assert.equal(syndicatedReprintOf({ candidateUrl: url, heldFiles: held, showTitle: 'King Lear', venue: 'Royal Exchange, Manchester' }).dup, false);
});

test('non-syndication URLs and short slugs are never deduped here', () => {
  assert.equal(syndicatedReprintOf({ candidateUrl: GUARDIAN.url, heldFiles: [GUARDIAN], showTitle: 'Antigone Exits' }).dup, false);
  assert.equal(syndicatedReprintOf({ candidateUrl: 'https://www.aol.com/emotions-run-1234.html', heldFiles: [GUARDIAN] }).dup, false);
  assert.equal(syndicatedReprintOf({ candidateUrl: AOL, heldFiles: [], showTitle: 'Antigone Exits' }).dup, false);
});

test('slugTokens drops the numeric portal id and .html', () => {
  assert.deepEqual(slugTokens(AOL), ['antigone', 'exits', 'review', 'emotions', 'run']);
});

test('fullhouse.me show-diary pages are not gap candidates', () => {
  assert.deepEqual(classifyGapCandidateUrl('https://fullhouse.me/dc-production/antigone-exits-2026'), { ok: false, reason: 'census-junk-host' });
});
