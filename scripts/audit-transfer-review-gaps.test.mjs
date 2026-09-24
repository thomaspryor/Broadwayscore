import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isEligibleCandidate, findSiblingCandidate, buildSuggestedPriorRun, isPerpetualRepertoryVenue, hasSameVenueSibling } = require('./audit-transfer-review-gaps.js');

const NOW = new Date('2026-09-15T00:00:00Z');
const OPTS = { minDaysOpen: 14, windowDays: 240 };

describe('isEligibleCandidate', () => {
  test('flags an off-broadway show open >= minDaysOpen with 0 reviews and no priorRuns', () => {
    const show = { id: 'x', category: 'off-broadway', status: 'open', openingDate: '2026-08-01' };
    const { eligible, daysSinceOpen } = isEligibleCandidate(show, 0, NOW, OPTS);
    assert.strictEqual(eligible, true);
    assert.strictEqual(daysSinceOpen, 45);
  });

  test('does NOT flag a show that already has reviews', () => {
    const show = { id: 'x', category: 'off-broadway', status: 'open', openingDate: '2026-08-01' };
    assert.strictEqual(isEligibleCandidate(show, 3, NOW, OPTS).eligible, false);
  });

  test('does NOT flag a show that already declares priorRuns', () => {
    const show = {
      id: 'x', category: 'off-broadway', status: 'open', openingDate: '2026-08-01',
      priorRuns: [{ venue: 'Some Theater', openingDate: '2026-06-01' }],
    };
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS).eligible, false);
  });

  test('does NOT flag a Broadway show (category gate)', () => {
    const show = { id: 'x', category: 'broadway', status: 'open', openingDate: '2026-08-01' };
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS).eligible, false);
  });

  test('does NOT flag a show opened too recently (still within min-days-open grace period)', () => {
    const show = { id: 'x', category: 'off-broadway', status: 'previews', previewsStartDate: '2026-09-10' };
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS).eligible, false);
  });

  test('does NOT flag a show opened past the window (too old to be a fresh transfer gap)', () => {
    const show = { id: 'x', category: 'off-broadway', status: 'open', openingDate: '2025-01-01' };
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS).eligible, false);
  });

  test('does NOT flag a closed show', () => {
    const show = { id: 'x', category: 'off-broadway', status: 'closed', openingDate: '2026-08-01' };
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS).eligible, false);
  });

  test('does NOT flag a show at a perpetual rotating-repertory venue (no transfer possible — never left the venue)', () => {
    const show = { id: 'x', category: 'off-broadway', status: 'previews', previewsStartDate: '2026-08-01', venue: 'Repertorio Español / Spanish Theatre Repertory' };
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS).eligible, false);
  });

  test('does NOT flag a show with a same-title, same-venue sibling (structural repertory guard — e.g. Met Opera annual re-staging)', () => {
    // La Bohème re-staged annually at the Metropolitan Opera House — same
    // title, same venue every year. Not a transfer: there is no "prior
    // venue" to declare, the show never left.
    const show = { id: 'la-boheme-2026', title: 'La Bohème', category: 'off-broadway', status: 'previews', previewsStartDate: '2026-08-25', venue: 'Metropolitan Opera House' };
    const sameTitleShows = [
      { id: 'la-boheme-2025', title: 'La Bohème', category: 'off-broadway', venue: 'Metropolitan Opera House', openingDate: '2025-09-01', closingDate: '2025-09-20' },
    ];
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS, sameTitleShows).eligible, false);
  });

  test('DOES flag a show with a same-title sibling at a DIFFERENT venue (a real transfer candidate)', () => {
    const show = { id: 'x', category: 'off-broadway', status: 'open', openingDate: '2026-08-01', venue: 'Theatre Row' };
    const sameTitleShows = [
      { id: 'x-original', title: 'Same Title', category: 'off-broadway', venue: 'Gallery Players', openingDate: '2024-05-01', closingDate: '2024-05-20' },
    ];
    assert.strictEqual(isEligibleCandidate(show, 0, NOW, OPTS, sameTitleShows).eligible, true);
  });
});

describe('hasSameVenueSibling', () => {
  test('matches on venue text regardless of case/punctuation differences', () => {
    const show = { id: 'a', venue: 'Metropolitan Opera House' };
    const siblings = [{ id: 'b', venue: 'metropolitan opera house.' }];
    assert.strictEqual(hasSameVenueSibling(show, siblings), true);
  });

  test('does NOT match a different venue', () => {
    const show = { id: 'a', venue: 'Theatre Row' };
    const siblings = [{ id: 'b', venue: 'Gallery Players' }];
    assert.strictEqual(hasSameVenueSibling(show, siblings), false);
  });

  test('does NOT match itself (excludes the show\'s own id)', () => {
    const show = { id: 'a', venue: 'Theatre Row' };
    assert.strictEqual(hasSameVenueSibling(show, [show]), false);
  });

  test('does NOT match when the show has no venue', () => {
    const show = { id: 'a', venue: null };
    const siblings = [{ id: 'b', venue: null }];
    assert.strictEqual(hasSameVenueSibling(show, siblings), false);
  });
});

describe('isPerpetualRepertoryVenue', () => {
  test('matches Repertorio Español regardless of the exact suffix text', () => {
    assert.strictEqual(isPerpetualRepertoryVenue('Repertorio Español / Spanish Theatre Repertory'), true);
  });

  test('does NOT match an unrelated off-broadway venue', () => {
    assert.strictEqual(isPerpetualRepertoryVenue('SoHo Playhouse'), false);
  });

  test('does NOT match a null/missing venue', () => {
    assert.strictEqual(isPerpetualRepertoryVenue(null), false);
    assert.strictEqual(isPerpetualRepertoryVenue(undefined), false);
  });
});

describe('findSiblingCandidate', () => {
  const candidate = { id: 'dad-transfer-2026', title: 'Dad Transfer', openingDate: '2026-06-23' };

  test('picks the same-title sibling with an earlier opening and reviews', () => {
    const siblings = [
      { id: 'dad-transfer-original-2026', title: 'Dad Transfer', openingDate: '2026-05-04' },
    ];
    const counts = new Map([['dad-transfer-original-2026', 6]]);
    const sib = findSiblingCandidate(candidate, siblings, counts);
    assert.strictEqual(sib && sib.id, 'dad-transfer-original-2026');
  });

  test('ignores a same-title sibling with a LATER opening date', () => {
    const siblings = [
      { id: 'dad-transfer-later-2027', title: 'Dad Transfer', openingDate: '2027-01-01' },
    ];
    const counts = new Map([['dad-transfer-later-2027', 6]]);
    assert.strictEqual(findSiblingCandidate(candidate, siblings, counts), null);
  });

  test('ignores an earlier sibling with zero reviews (nothing to inherit)', () => {
    const siblings = [
      { id: 'dad-transfer-original-2026', title: 'Dad Transfer', openingDate: '2026-05-04' },
    ];
    const counts = new Map();
    assert.strictEqual(findSiblingCandidate(candidate, siblings, counts), null);
  });

  test('picks the LATEST-opening eligible sibling when multiple earlier runs exist', () => {
    const siblings = [
      { id: 'run-2024', title: 'Dad Transfer', openingDate: '2024-01-01' },
      { id: 'run-2026-may', title: 'Dad Transfer', openingDate: '2026-05-04' },
    ];
    const counts = new Map([['run-2024', 2], ['run-2026-may', 6]]);
    const sib = findSiblingCandidate(candidate, siblings, counts);
    assert.strictEqual(sib && sib.id, 'run-2026-may');
  });

  test('rejects a same-title sibling from a decade-old unrelated production (title collision, not a transfer)', () => {
    // Matilda the Musical 2013 Broadway (Shubert) vs. a 2026 Off-Broadway
    // "Theatre Row" revival — same title, unrelated productions, 13-year gap.
    const revival = { id: 'matilda-the-musical-theatre-row-off-broadway-2026', title: 'Matilda the Musical', openingDate: '2026-08-04' };
    const siblings = [
      { id: 'matilda-the-musical-2013', title: 'Matilda the Musical', openingDate: '2013-04-11', closingDate: '2017-01-01' },
    ];
    const counts = new Map([['matilda-the-musical-2013', 50]]);
    assert.strictEqual(findSiblingCandidate(revival, siblings, counts), null);
  });

  test('accepts a same-title sibling that closed shortly before the transfer opened, even if it opened long before', () => {
    const candidateLongRun = { id: 'x', title: 'Long Runner', openingDate: '2026-07-01' };
    const siblings = [
      { id: 'long-runner-original', title: 'Long Runner', openingDate: '2024-01-01', closingDate: '2026-05-01' },
    ];
    const counts = new Map([['long-runner-original', 4]]);
    const sib = findSiblingCandidate(candidateLongRun, siblings, counts);
    assert.strictEqual(sib && sib.id, 'long-runner-original');
  });

  test('rejects an overlapping/concurrent sibling that opened earlier but closes AFTER the candidate opens (a different concurrent production, not a completed prior run)', () => {
    // ship-check finding: anchoring the gap only on sibOpen let a sibling
    // that is STILL RUNNING when the candidate opens produce a NEGATIVE gap
    // (candidateOpen - sibEnd < 0), which trivially passed the
    // `gapDays > MAX_SIBLING_GAP_DAYS` rejection. A genuine prior run must
    // have actually ENDED before the candidate's opening.
    const candidateOverlap = { id: 'x', title: 'Concurrent Run', openingDate: '2026-06-01' };
    const siblings = [
      { id: 'concurrent-elsewhere', title: 'Concurrent Run', openingDate: '2026-01-01', closingDate: '2026-12-31' },
    ];
    const counts = new Map([['concurrent-elsewhere', 8]]);
    assert.strictEqual(findSiblingCandidate(candidateOverlap, siblings, counts), null);
  });

  test('rejects a same-title sibling in a different category/market (cross-market title collision, not a transfer)', () => {
    const candidateOB = { id: 'x', title: 'Cross Market Show', category: 'off-broadway', openingDate: '2026-08-01' };
    const siblings = [
      { id: 'we-version', title: 'Cross Market Show', category: 'west-end', openingDate: '2026-06-01', closingDate: '2026-07-01' },
    ];
    const counts = new Map([['we-version', 10]]);
    assert.strictEqual(findSiblingCandidate(candidateOB, siblings, counts), null);
  });
});

describe('buildSuggestedPriorRun', () => {
  test('carries the sibling venue/dates and flags it for human confirmation', () => {
    const sibling = { id: 'sib-1', venue: "St. Luke's Theatre", openingDate: '2026-05-04', closingDate: '2026-06-01' };
    const counts = new Map([['sib-1', 4]]);
    const suggestion = buildSuggestedPriorRun(sibling, counts);
    assert.strictEqual(suggestion.venue, "St. Luke's Theatre");
    assert.strictEqual(suggestion.openingDate, '2026-05-04');
    assert.strictEqual(suggestion.closingDate, '2026-06-01');
    assert.match(suggestion.note, /confirm/i);
  });
});
