// Unit tests for the lottery/rush show-ID stability guard.
// Per feedback_test_extraction_pattern.md — tests the real module via require().

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { evaluateShowIdStability } = require('../../scripts/lib/lottery-stability-guard');

const showsOf = (...ids) => ({ shows: Object.fromEntries(ids.map(id => [id, {}])) });

describe('lottery-stability-guard', () => {
  it('replays the 2026-06-28 abort: 3 added + 5 closed removals → PASS', () => {
    // Exact IDs from the failing run log.
    const original = showsOf(
      'chess-2025', 'inter-alia-west-end-2026', 'romeo-and-juliet-west-end-2026',
      'end-of-the-rainbow-west-end-2026', 'the-p-word-off-west-end-2026', 'hamilton-2015'
    );
    const updated = showsOf(
      'a-few-good-men-2026', 'awake-and-sing-2026', 'the-sound-of-music-2026', 'hamilton-2015'
    );
    const changes = [
      { showId: 'chess-2025', type: 'removed-closed' },
      { showId: 'inter-alia-west-end-2026', type: 'removed-closed' },
      { showId: 'romeo-and-juliet-west-end-2026', type: 'removed-closed' },
      { showId: 'end-of-the-rainbow-west-end-2026', type: 'removed-closed' },
      { showId: 'the-p-word-off-west-end-2026', type: 'removed-orphan' },
    ];
    const r = evaluateShowIdStability(original, updated, changes);
    assert.equal(r.abort, false, 'closed-show cleanup must not trip the guard');
    assert.equal(r.removed.length, 0, 'all 5 removals were intentional cleanup');
    assert.equal(r.added.length, 3);
  });

  it('still aborts when still-OPEN shows vanish (real scrape garbage)', () => {
    const original = showsOf('a', 'b', 'c', 'd', 'e');
    const updated = showsOf('a'); // b,c,d,e gone, NOT via cleanup
    const r = evaluateShowIdStability(original, updated, []);
    assert.equal(r.abort, true, 'unexplained mass removal must still abort');
    assert.equal(r.removed.length, 4);
  });

  it('aborts on too many additions regardless of removals', () => {
    const original = showsOf('a');
    const updated = showsOf('a', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6');
    const r = evaluateShowIdStability(original, updated, []);
    assert.equal(r.abort, true);
    assert.equal(r.added.length, 6);
  });

  it('passes a quiet run with no changes', () => {
    const ids = showsOf('a', 'b', 'c');
    const r = evaluateShowIdStability(ids, ids, []);
    assert.equal(r.abort, false);
    assert.equal(r.added.length, 0);
    assert.equal(r.removed.length, 0);
  });

  it('counts a non-cleanup removal even when other removals are intentional', () => {
    const original = showsOf('closed1', 'closed2', 'closed3', 'closed4', 'still-open');
    const updated = showsOf(); // everything gone
    const changes = [
      { showId: 'closed1', type: 'removed-closed' },
      { showId: 'closed2', type: 'removed-closed' },
      { showId: 'closed3', type: 'removed-closed' },
      { showId: 'closed4', type: 'removed-orphan' },
      // still-open has NO cleanup change → counts toward threshold
    ];
    const r = evaluateShowIdStability(original, updated, changes);
    assert.deepEqual(r.removed, ['still-open']);
    assert.equal(r.abort, false, '1 unexplained removal is within the limit of 3');
  });
});
