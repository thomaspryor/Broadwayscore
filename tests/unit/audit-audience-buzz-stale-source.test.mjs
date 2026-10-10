import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { audit } = require('../../scripts/audit-audience-buzz-contamination.js');

// Fixed today=2026-05-24 so the test doesn't rot as time advances.
// STALE_YEARS_AGO=8 → cutoff year is 2018 (closed shows that opened ≤2018 are stale).
const TODAY = '2026-05-24';

const shows = [
  { id: 'pal-joey-2008', title: 'Pal Joey', category: 'broadway', openingDate: '2008-12-18', status: 'closed' },
  { id: 'merrily-2026', title: 'Merrily We Roll Along', category: 'broadway', openingDate: '2026-01-15', status: 'closed' },
  { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06', status: 'open' },
  { id: 'old-no-modern-source', title: 'Old', category: 'broadway', openingDate: '1985-01-01', status: 'closed' },
];

const buzz = {
  shows: {
    'pal-joey-2008': {
      sources: {
        theatr: { score: 8, reviewCount: 12 },
        mezzanine: { score: 52, reviewCount: 107 },
      },
    },
    'merrily-2026': {
      sources: {
        theatr: { score: 80, reviewCount: 50 },
      },
    },
    'hamilton-2015': {
      sources: {
        theatr: { score: 90, reviewCount: 500 },
      },
    },
    'old-no-modern-source': {
      sources: {
        showScore: { score: 70, reviewCount: 100 },
        mezzanine: { score: 65, reviewCount: 50 },
      },
    },
  },
};

describe('OTHER_SOURCE_STALE flag', () => {
  test('fires on closed pre-2018 show with theatr reviewCount > 0', () => {
    const issues = audit({ shows, buzz, today: TODAY });
    const palJoey = issues.find(i => i.id === 'pal-joey-2008');
    assert.ok(palJoey, 'expected pal-joey-2008 flagged');
    const stale = palJoey.flags.find(f => f.startsWith('OTHER_SOURCE_STALE'));
    assert.ok(stale, `expected OTHER_SOURCE_STALE on pal-joey-2008, got: ${palJoey.flags.join(',')}`);
    assert.ok(stale.includes('src=theatr'));
    assert.ok(stale.includes('rc=12'));
    assert.ok(stale.includes('openYear=2008'));
  });

  test('does NOT fire on recent (post-2018) closure', () => {
    const issues = audit({ shows, buzz, today: TODAY });
    const merrily = issues.find(i => i.id === 'merrily-2026');
    if (merrily) {
      const stale = merrily.flags.find(f => f.startsWith('OTHER_SOURCE_STALE'));
      assert.strictEqual(stale, undefined, `merrily-2026 (closed 2026) should NOT be STALE, got: ${merrily.flags.join(',')}`);
    }
  });

  test('does NOT fire on open shows even if old', () => {
    const issues = audit({ shows, buzz, today: TODAY });
    const hamilton = issues.find(i => i.id === 'hamilton-2015');
    if (hamilton) {
      const stale = hamilton.flags.find(f => f.startsWith('OTHER_SOURCE_STALE'));
      assert.strictEqual(stale, undefined, `hamilton-2015 (open) should NOT be STALE, got: ${hamilton.flags.join(',')}`);
    }
  });

  test('does NOT fire when no modern app source is present', () => {
    const issues = audit({ shows, buzz, today: TODAY });
    const old = issues.find(i => i.id === 'old-no-modern-source');
    if (old) {
      const stale = old.flags.find(f => f.startsWith('OTHER_SOURCE_STALE'));
      assert.strictEqual(stale, undefined, `old-no-modern-source has only showScore/mezzanine — should NOT be STALE`);
    }
  });
});

describe('REDDIT_SCORE_DIVERGENCE honors suppressed', () => {
  // A divergent Reddit source (Glengarry Glen Ross West End 2026 case, 2026-06-26):
  // reddit.score=48 vs 7-source consensus ~88, almost certainly wrong-production
  // contamination from a same-titled production. Once suppressed (acknowledged +
  // dropped from weighting), it must not keep failing the audit.
  const divShows = [
    { id: 'glengarry-glen-ross-west-end-2026', title: 'Glengarry Glen Ross', category: 'west-end', openingDate: '2026-06-10', status: 'open' },
  ];
  // Consensus ~88 from sources the audit actually considers (SOURCE_NAMES:
  // showScore/mezzanine/reddit/theatr/broadwayCom), all rc>=10 so they count as
  // credibleOthers; reddit=48 → diff>=40.
  const baseSources = {
    showScore: { score: 90, reviewCount: 30 },
    mezzanine: { score: 88, reviewCount: 87 },
    broadwayCom: { score: 88, reviewCount: 71 },
  };

  test('fires when divergent reddit is NOT suppressed', () => {
    const buzz = { shows: { 'glengarry-glen-ross-west-end-2026': {
      sources: { ...baseSources, reddit: { score: 48, reviewCount: 16 } },
    } } };
    const issues = audit({ shows: divShows, buzz, today: TODAY });
    const g = issues.find(i => i.id === 'glengarry-glen-ross-west-end-2026');
    assert.ok(g && g.flags.some(f => f.startsWith('REDDIT_SCORE_DIVERGENCE')),
      `expected REDDIT_SCORE_DIVERGENCE, got: ${g ? g.flags.join(',') : 'no issue'}`);
  });

  test('does NOT fire once divergent reddit is suppressed', () => {
    const buzz = { shows: { 'glengarry-glen-ross-west-end-2026': {
      sources: { ...baseSources, reddit: { score: 48, reviewCount: 16, suppressed: true } },
    } } };
    const issues = audit({ shows: divShows, buzz, today: TODAY });
    const g = issues.find(i => i.id === 'glengarry-glen-ross-west-end-2026');
    const div = g && g.flags.find(f => f.startsWith('REDDIT_SCORE_DIVERGENCE'));
    assert.strictEqual(div, undefined, `suppressed reddit must not fire divergence, got: ${g ? g.flags.join(',') : 'none'}`);
  });
});
