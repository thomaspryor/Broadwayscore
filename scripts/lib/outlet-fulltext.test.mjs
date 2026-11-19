// BRO-7702: major-outlet full-text metric, floor verdict, queue priority.
// Run: node --test scripts/lib/outlet-fulltext.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('./outlet-fulltext.js');
const T = require('./gap-strategy-table.js');
const UF = require('./gap-url-find.js');
const N = require('./gap-recovery-nightly.js');

const LONG = 'The production is a triumph of design and nerve. '.repeat(40);

test('isFull: a short review the classifier proved complete counts; a long truncated one does not', () => {
  assert.equal(F.isFull({ fullText: 'A tight 200-word capsule review that ends properly.' }, 'complete'), true);
  assert.equal(F.isFull({ fullText: '' }, 'complete'), false);
  assert.equal(F.isFull({ fullText: LONG }, 'truncated'), false);
  assert.equal(F.isFull({ fullText: LONG }, undefined), true);
  assert.equal(F.isFull({ fullText: 'short' }, 'excerpt'), false);
});

test('excerptQuotedIn: an aggregator excerpt quoted (curly quotes, ellipsis) in a full sibling', () => {
  const full = 'Opening paragraph. It’s in the use of shock tactics that the drama falters, leaving the cast stranded on a bare stage. Closing.';
  assert.equal(F.excerptQuotedIn({ dtliExcerpt: "...It's in the use of shock tactics that the drama falters, leaving the cast stranded..." }, full), true);
  assert.equal(F.excerptQuotedIn({ dtliExcerpt: 'A different critic entirely praised the lighting and the score to the rafters.' }, full), false);
  assert.equal(F.excerptQuotedIn({ dtliExcerpt: 'too short' }, full), false, 'passages under 40 chars never match');
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofx-'));
  const w = (show, file, obj) => { fs.mkdirSync(path.join(dir, show), { recursive: true }); fs.writeFileSync(path.join(dir, show, file), JSON.stringify(obj)); };
  w('play-2026', 'wsj--a.json', { outletId: 'wsj', criticName: 'A', url: 'u1', contentTier: 'complete', fullText: LONG });
  w('play-2026', 'wsj--b.json', { outletId: 'wsj', criticName: 'B', url: 'u2', contentTier: 'complete', fullText: 'A short complete capsule review.' });
  // quoted excerpt of wsj--a in an excerpt-only row: a duplicate, not a gap
  w('play-2026', 'wsj--dup.json', { outletId: 'wsj', criticName: 'A', contentTier: 'excerpt', fullText: '', dtliExcerpt: 'The production is a triumph of design and nerve. The production is' });
  w('play-2026', 'wsj--gap.json', { outletId: 'wsj', criticName: 'C', url: 'u3', contentTier: 'stub', fullText: '', firstSeenAt: '2026-01-01T00:00:00Z' });
  w('play-2026', 'wsj--news.json', { outletId: 'wsj', criticName: 'D', url: 'u4', contentTier: 'stub', fullText: '', isNonReview: true });
  w('play-2026', 'guardian--x.json', { outletId: 'guardian', criticName: 'X', url: 'g', contentTier: 'complete', fullText: LONG });
  w('play-1999', 'wsj--old.json', { outletId: 'wsj', contentTier: 'stub', fullText: '' });
  return dir;
}

test('sameCritic: two named critics are two reviews; an unnamed placeholder may match either', () => {
  assert.equal(F.sameCritic({ criticName: 'Clive Davis' }, { criticName: 'Dominic Maxwell' }), false);
  assert.equal(F.sameCritic({ criticName: "Holly O'Mahony" }, { criticName: 'Holly OMahony' }), true);
  assert.equal(F.sameCritic({ criticName: 'Unknown' }, { criticName: 'Dominic Maxwell' }), true);
});

test('computeOutletFulltext: complete capsule full, quoted excerpt duplicate, scanner exclusion skipped, old shows ignored', () => {
  const base = fixture();
  const { rates, gaps } = F.computeOutletFulltext({ base, tierOf: (r) => r.contentTier, excludedKeys: new Map([['play-2026/wsj--news.json', 'nonReview']]) });
  assert.deepEqual({ n: rates.wsj.n, full: rates.wsj.full, dup: rates.wsj.dupCovered, notReview: rates.wsj.notReview }, { n: 4, full: 2, dup: 1, notReview: 1 });
  assert.equal(rates.wsj.floor, 98);
  assert.equal(rates.guardian.floor, 95);
  assert.deepEqual(gaps.map((g) => g.reviewKey), ['play-2026/wsj--gap.json']);
  fs.rmSync(base, { recursive: true, force: true });
});

test('evaluateFloors: below floor + never attempted fails; attempted gaps pass; stale unattempted gap fails on its own', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const rates = { wsj: { n: 10, pct: 90, floor: 98 }, guardian: { n: 100, pct: 99, floor: 95 } };
  const gaps = [{ outlet: 'wsj', reviewKey: 's/wsj--a.json', firstSeenAt: '2026-11-15T00:00:00Z' }];
  let v = F.evaluateFloors({ rates, gaps, attemptedKeys: new Set(), nowMs: now });
  assert.equal(v.ok, false);
  assert.deepEqual(v.failingOutlets, ['wsj']);
  assert.equal(v.staleUnattempted.length, 0, '2 days old is not stale');
  v = F.evaluateFloors({ rates, gaps, attemptedKeys: new Set(['s/wsj--a.json']), nowMs: now });
  assert.equal(v.ok, true, 'below floor but every gap is being worked');
  assert.deepEqual(v.belowFloor, ['wsj']);
  const stale = [{ outlet: 'guardian', reviewKey: 's/guardian--z.json', firstSeenAt: '2026-10-01T00:00:00Z' }];
  v = F.evaluateFloors({ rates: { guardian: rates.guardian }, gaps: stale, attemptedKeys: new Set(), nowMs: now });
  assert.equal(v.ok, false);
  assert.equal(v.staleUnattempted[0].ageDays, 47);
});

test('nightly queue: a major-outlet gap sorts ahead of a newer minor-outlet gap (recent first still wins)', () => {
  const c = [
    { reviewKey: 'minor-new', showId: 'a-2026', outletId: 'some-blog', recency: 'recent', showDate: '2026-11-01', strategy: 'REFETCH_FREE' },
    { reviewKey: 'major-old', showId: 'b-2025', outletId: 'times-uk', recency: 'recent', showDate: '2025-03-01', strategy: 'REFETCH_FREE' },
    { reviewKey: 'major-2024', showId: 'c-2024', outletId: 'wsj', recency: 'recent', showDate: '2024-12-01', strategy: 'REFETCH_FREE' },
    { reviewKey: 'major-historic', showId: 'd-2019', outletId: 'wsj', recency: 'historic', showDate: '2019-01-01', strategy: 'REFETCH_FREE' },
  ].sort(T.compareCandidates).map((x) => x.reviewKey);
  // a 2024 show is outside the floor, so it gets no boost
  assert.deepEqual(c, ['major-old', 'minor-new', 'major-2024', 'major-historic']);
  const u = [
    { reviewKey: 'x-2026/some-t1--a.json', outletId: 'some-t1', recency: 'recent', showDate: '2026-11-01' },
    { reviewKey: 'y-2025/standard--b.json', outletId: 'standard', recency: 'recent', showDate: '2025-01-01' },
  ].sort(UF.urlFindPriority(() => 1)).map((x) => x.reviewKey);
  assert.deepEqual(u, ['y-2025/standard--b.json', 'x-2026/some-t1--a.json']);
});

test('digest line: names outlets below target and stale unattempted gaps; silent when all at floor', () => {
  assert.equal(N.outletFloorLine({ ok: true, below: [], staleUnattempted: 0 }), null);
  assert.equal(N.outletFloorLine(null), null);
  const s = N.outletFloorSummary({ ok: false, outlets: [{ outlet: 'times-uk', pct: 92.3, floor: 98, below: true, unattempted: 3 }, { outlet: 'guardian', pct: 99, floor: 95, below: false }], failingOutlets: ['times-uk'], staleUnattempted: [{}, {}] });
  assert.equal(N.outletFloorLine(s), 'Major outlets below the full-text target: times-uk 92.3% (target 98%); 2 major-outlet reviews missing text for over a week with no recovery attempt yet.');
});

// Accents fold before comparing (diacritics guard, 2026-11-19).
test('critic names with accents match their unaccented spelling, not each other', () => {
  assert.equal(F.sameCritic({ criticName: 'Aleks Sierz' }, { criticName: 'Aleks Siérz' }), true);
  assert.equal(F.sameCritic({ criticName: 'Amélie Roy' }, { criticName: 'Amlie Roy' }), false);
});

// Review 2026-11-19: the window rolls with the calendar (was hardcoded 2025/2026).
test('recent productions = this year and last, by the clock', () => {
  const at = (iso) => Date.parse(iso);
  const nov26 = at('2026-11-19T00:00:00Z');
  assert.deepEqual(F.recentYears(nov26), [2025, 2026]);
  assert.equal(F.isRecentProductionShow('play-2026', nov26), true);
  assert.equal(F.isRecentProductionShow('hamlet-2025-london', nov26), true);
  assert.equal(F.isRecentProductionShow('play-2024', nov26), false);
  assert.equal(F.isRecentProductionShow('cats', nov26), false);
  assert.equal(F.isRecentProductionShow('play-2025', at('2027-03-01T00:00:00Z')), false, 'rolls forward in 2027');
  assert.equal(F.isRecentProductionShow('play-2027', at('2027-03-01T00:00:00Z')), true);
});
