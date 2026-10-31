// TESTS-VS-DERIVED-DATA-EXEMPT: live data is advisory diagnostics only; assertions use source-cited fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { auditAwardsData } = require('../../scripts/lib/awards-data-audit.js');

function audit(shows, types = {}, options = {}) {
  return auditAwardsData({ shows }, Object.entries(types).map(([id, type]) => ({ id, type })), options);
}

function issuesOf(report, type) {
  return report.issues.filter(issue => issue.type === type);
}

// Official totals and categories, not the audit's own expected values:
// https://www.tonyawards.com/shows/hadestown/
// https://www.tonyawards.com/shows/the-lehman-trilogy/
const historical = {
  'hadestown-2019': {
    tony: {
      season: '2018-19', ceremony: '73rd', nominations: 14,
      nominatedFor: [
        'Best Musical', 'Best Book of a Musical', 'Best Original Score',
        'Best Actress in a Musical', 'Best Featured Actor in a Musical',
        'Best Featured Actor in a Musical', 'Best Featured Actress in a Musical',
        'Best Scenic Design of a Musical', 'Best Costume Design of a Musical',
        'Best Lighting Design of a Musical', 'Best Sound Design of a Musical',
        'Best Direction of a Musical', 'Best Choreography', 'Best Orchestrations',
      ],
      wins: [
        'Best Musical', 'Best Original Score', 'Best Featured Actor in a Musical',
        'Best Scenic Design of a Musical', 'Best Lighting Design of a Musical',
        'Best Sound Design of a Musical', 'Best Direction of a Musical', 'Best Orchestrations',
      ],
    },
  },
  'the-lehman-trilogy-2021': {
    tony: {
      season: '2021-22', ceremony: '75th', nominations: 8,
      nominatedFor: [
        'Best Play', 'Best Actor in a Play', 'Best Actor in a Play', 'Best Actor in a Play',
        'Best Scenic Design of a Play', 'Best Lighting Design of a Play',
        'Best Sound Design of a Play', 'Best Direction of a Play',
      ],
      wins: [
        'Best Play', 'Best Actor in a Play', 'Best Scenic Design of a Play',
        'Best Lighting Design of a Play', 'Best Direction of a Play',
      ],
    },
  },
};

test('official Hadestown and Lehman totals pass every spot-check field', () => {
  const report = audit(historical);
  for (const id of Object.keys(historical)) {
    const result = report.spotCheckResults.find(row => row.showId === id);
    assert.equal(result.nominationsMatch, true, id);
    assert.equal(result.winsMatch, true, id);
    assert.equal(result.seasonMatch, true, id);
    assert.deepEqual(report.issues.filter(issue => issue.type.startsWith('spot-check-') && issue.context.showId === id), []);
  }
});

test('spot checks still flag incorrect nomination and win totals', () => {
  const broken = structuredClone(historical);
  broken['hadestown-2019'].tony.nominations = 10;
  broken['hadestown-2019'].tony.wins.pop();
  broken['the-lehman-trilogy-2021'].tony.nominations = 6;
  const report = audit(broken);
  assert.equal(issuesOf(report, 'spot-check-nominations').length, 2);
  assert.equal(issuesOf(report, 'spot-check-wins').length, 1);
});

test('Score, Choreography and Orchestrations are valid for plays and musicals', () => {
  // Score and Orchestrations: https://www.tonyawards.com/shows/stereophonic/
  // Choreography: https://www.tonyawards.com/shows/choir-boy/
  for (const type of ['play', 'musical']) {
    for (const category of ['Best Original Score', 'Best Choreography', 'Best Orchestrations']) {
      for (const field of ['nominatedFor', 'wins']) {
        const report = audit({ example: { tony: { [field]: [category] } } }, { example: type });
        assert.deepEqual(issuesOf(report, 'type-category-mismatch'), [], `${type}: ${field}: ${category}`);
      }
    }
  }
});

test('type-specific Tony categories still flag genuine mismatches in nominations or wins', () => {
  for (const [type, category] of [
    ['play', 'Best Musical'], ['play', 'Best Book of a Musical'],
    ['play', 'Best Direction of a Musical'], ['play', 'Best Featured Actor in a Musical'],
    ['musical', 'Best Play'], ['musical', 'Best Revival of a Play'],
    ['musical', 'Best Direction of a Play'], ['musical', 'Best Actress in a Play'],
  ]) {
    for (const field of ['nominatedFor', 'wins']) {
      const report = audit({ example: { tony: { [field]: [category] } } }, { example: type });
      assert.equal(issuesOf(report, 'type-category-mismatch').length, 1, `${type}: ${field}: ${category}`);
    }
  }
});

test('performer nominations stay informational; unexpected duplicates are still warnings', () => {
  const before = structuredClone(historical);
  const report = audit(historical);
  const duplicates = issuesOf(report, 'duplicate-nomination');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every(issue => issue.severity === 'low' && issue.context.isPerformingCategory));
  assert.deepEqual(historical, before, 'audit must not deduplicate or otherwise mutate award data');
  const unexpected = audit({ example: { tony: { nominatedFor: ['Best Musical', 'Best Musical'] } } });
  assert.equal(issuesOf(unexpected, 'duplicate-nomination')[0].severity, 'medium');
});

test('confirmed ties suppress only the exact registered season, category and winner set', () => {
  const category = 'Best Original Score';
  const shows = Object.fromEntries(['one', 'two'].map(id => [id, {
    tony: { season: '1992-93', nominatedFor: [category], wins: [category] },
  }]));
  const tie = { season: '1992-93', category, showIds: ['two', 'one'] };
  assert.equal(issuesOf(audit(shows), 'multiple-winners').length, 1);
  assert.equal(issuesOf(audit(shows, {}, { confirmedTies: [tie] }), 'multiple-winners').length, 0);
  for (const wrong of [
    { ...tie, season: '1991-92' }, { ...tie, category: 'Best Musical' },
    { ...tie, showIds: ['one', 'other'] }, { ...tie, showIds: ['one', 'two', 'three'] },
  ]) {
    assert.equal(issuesOf(audit(shows, {}, { confirmedTies: [wrong] }), 'multiple-winners').length, 1);
  }
  const extraWinner = { ...shows, three: structuredClone(shows.one) };
  assert.equal(issuesOf(audit(extraWinner, {}, { confirmedTies: [tie] }), 'multiple-winners').length, 1);
});

test('season/ceremony inconsistencies are still reported', () => {
  const report = audit({
    one: { tony: { season: '2018-19', ceremony: '73rd' } },
    two: { tony: { season: '2018-19', ceremony: '74th' } },
  });
  assert.equal(issuesOf(report, 'season-ceremony-mismatch').length, 1);
});

test('awards audit on checkout data is advisory in the existing CI unit batch', t => {
  // Do not gate unrelated changes on live data. The deterministic tests above
  // verify the audit rules; this diagnostic makes the full audit run in CI.
  const readData = name => JSON.parse(fs.readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8'));
  try {
    const report = auditAwardsData(readData('awards.json'), readData('shows.json'), {
      confirmedTies: readData('awards-confirmed-ties.json').ties,
    });
    t.diagnostic(`Advisory awards audit: ${report.summary.totalShowsInAwards} records, ${report.summary.totalIssues} findings`);
    t.diagnostic(JSON.stringify(report.summary.issuesByType));
    for (const result of report.spotCheckResults) {
      t.diagnostic(`[${result.nominationsMatch && result.winsMatch && result.seasonMatch ? 'PASS' : 'FAIL'}] ${result.description}`);
    }
    for (const issue of report.issues.filter(issue => issue.severity === 'high')) {
      t.diagnostic(`[HIGH] ${issue.type}: ${issue.detail}`);
    }
  } catch (error) {
    t.diagnostic(`Advisory awards audit unavailable: ${error.message}`);
  }
});
