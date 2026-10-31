import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { audit } = require('./audit-audience-buzz-contamination.js');

// Task #57: title-collision sweep — a show's title also belongs to a
// different production (revival/transfer/other-market run). Reddit is
// searched by title, so one production's chatter can be swept into another's
// audience-buzz record. TITLE_COLLISION_SIBLING_DIVERGENCE compares siblings
// directly and fires even when neither show alone has 2+ other credible
// sources to build its own median (REDDIT_SCORE_DIVERGENCE's blind spot).
const TODAY = '2026-08-03';

describe('TITLE_COLLISION_SIBLING_DIVERGENCE', () => {
  const collisionShows = [
    { id: 'glengarry-glen-ross-2025', title: 'Glengarry Glen Ross', category: 'broadway', openingDate: '2025-03-31', status: 'closed' },
    { id: 'glengarry-glen-ross-west-end-2026', title: 'Glengarry Glen Ross', category: 'west-end', openingDate: '2026-06-17', status: 'closed' },
  ];

  test('fires when two same-titled productions have divergent, independently-scraped reddit scores', () => {
    const buzz = {
      shows: {
        'glengarry-glen-ross-2025': { sources: { reddit: { score: 88, reviewCount: 446 } } },
        'glengarry-glen-ross-west-end-2026': { sources: { reddit: { score: 48, reviewCount: 16 } } },
      },
    };
    const issues = audit({ shows: collisionShows, buzz, today: TODAY });
    for (const id of ['glengarry-glen-ross-2025', 'glengarry-glen-ross-west-end-2026']) {
      const issue = issues.find(i => i.id === id);
      assert.ok(issue, `expected ${id} flagged`);
      const flag = issue.flags.find(f => f.startsWith('TITLE_COLLISION_SIBLING_DIVERGENCE'));
      assert.ok(flag, `expected TITLE_COLLISION_SIBLING_DIVERGENCE on ${id}, got: ${issue.flags.join(',')}`);
    }
  });

  test('does NOT fire once the divergent sibling reddit is suppressed', () => {
    const buzz = {
      shows: {
        'glengarry-glen-ross-2025': { sources: { reddit: { score: 88, reviewCount: 446 } } },
        'glengarry-glen-ross-west-end-2026': { sources: { reddit: { score: 48, reviewCount: 16, suppressed: true } } },
      },
    };
    const issues = audit({ shows: collisionShows, buzz, today: TODAY });
    const bway = issues.find(i => i.id === 'glengarry-glen-ross-2025');
    const collision = bway && bway.flags.find(f => f.startsWith('TITLE_COLLISION_SIBLING_DIVERGENCE'));
    assert.strictEqual(collision, undefined, `suppressed sibling reddit must not fire collision divergence, got: ${bway ? bway.flags.join(',') : 'none'}`);
  });

  test('does NOT fire when siblings agree', () => {
    const buzz = {
      shows: {
        'glengarry-glen-ross-2025': { sources: { reddit: { score: 63, reviewCount: 446 } } },
        'glengarry-glen-ross-west-end-2026': { sources: { reddit: { score: 52, reviewCount: 17 } } },
      },
    };
    const issues = audit({ shows: collisionShows, buzz, today: TODAY });
    for (const id of ['glengarry-glen-ross-2025', 'glengarry-glen-ross-west-end-2026']) {
      const issue = issues.find(i => i.id === id);
      const collision = issue && issue.flags.find(f => f.startsWith('TITLE_COLLISION_SIBLING_DIVERGENCE'));
      assert.strictEqual(collision, undefined, `${id} siblings within threshold should NOT fire, got: ${issue ? issue.flags.join(',') : 'none'}`);
    }
  });

  test('does NOT fire when the title has no collision sibling', () => {
    const soloShows = [
      { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06', status: 'open' },
    ];
    const buzz = { shows: { 'hamilton-2015': { sources: { reddit: { score: 90, reviewCount: 500 } } } } };
    const issues = audit({ shows: soloShows, buzz, today: TODAY });
    const issue = issues.find(i => i.id === 'hamilton-2015');
    const collision = issue && issue.flags.find(f => f.startsWith('TITLE_COLLISION_SIBLING_DIVERGENCE'));
    assert.strictEqual(collision, undefined, `no sibling exists — must not fire, got: ${issue ? issue.flags.join(',') : 'none'}`);
  });

  test('does NOT fire when the sibling has no reddit data at all', () => {
    const buzz = {
      shows: {
        'glengarry-glen-ross-2025': { sources: { reddit: { score: 63, reviewCount: 446 } } },
      },
    };
    const issues = audit({ shows: collisionShows, buzz, today: TODAY });
    const issue = issues.find(i => i.id === 'glengarry-glen-ross-2025');
    const collision = issue && issue.flags.find(f => f.startsWith('TITLE_COLLISION_SIBLING_DIVERGENCE'));
    assert.strictEqual(collision, undefined, `sibling never scraped — must not fire, got: ${issue ? issue.flags.join(',') : 'none'}`);
  });

  test('does NOT fire below reviewCount=10 credibility floor on either side', () => {
    const buzz = {
      shows: {
        'glengarry-glen-ross-2025': { sources: { reddit: { score: 88, reviewCount: 446 } } },
        'glengarry-glen-ross-west-end-2026': { sources: { reddit: { score: 48, reviewCount: 4 } } },
      },
    };
    const issues = audit({ shows: collisionShows, buzz, today: TODAY });
    const bway = issues.find(i => i.id === 'glengarry-glen-ross-2025');
    const collision = bway && bway.flags.find(f => f.startsWith('TITLE_COLLISION_SIBLING_DIVERGENCE'));
    assert.strictEqual(collision, undefined, `sibling below rc=10 floor must not fire, got: ${bway ? bway.flags.join(',') : 'none'}`);
  });
});

describe('audit() regression guard — real corpus', () => {
  test('runs against live data/shows.json + data/audience-buzz.json without throwing', () => {
    const issues = audit();
    assert.ok(Array.isArray(issues));
  });
});
