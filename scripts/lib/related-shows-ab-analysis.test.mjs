import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { summarizeRelatedShows, analyzeRelatedShows, READOUT_QUERY, CUTOVER } = require('./related-shows-ab-analysis');
const healthy = { ok: true, problem: null };
const rows = () => [['control', 3140, 600, 2200, 0, 0], ['compact-after-reviews', 3140, 650, 2100, 0, 0]];

test('primary uses exposed people, not search landers or exposure event count', () => {
  const s = summarizeRelatedShows(rows(), healthy);
  assert.equal(s.variants[0].n, 3140);
  assert.equal(s.variants[0].searchLanders, 2200);
  assert.equal(s.primary.suppressed, null);
  assert.ok(Number.isFinite(s.primary.p));
  assert.equal(s.startDate, CUTOVER);
  assert.equal(s.stoppingNPerArm, 3140);
  assert.equal(s.floorNPerArm, 906);
  assert.equal('significant' in s.primary, false);
});

test('missing arms and zero-variance data have explicit degenerate reasons', () => {
  for (const r of [[], [rows()[0]], rows().map(r => [r[0], r[1], 0, r[3], 0, 0])]) {
    const s = summarizeRelatedShows(r, healthy);
    assert.ok(s.primary.degenerate);
    assert.equal(s.primary.p, null);
  }
});

test('bad joins, cross-assignment, malformed counts and unknown arms suppress the primary', () => {
  for (const patch of [[4, 1], [5, 1], [1, '3140'], [2, 3200], [3, -1], [0, 'unexpected']]) {
    const r = rows();
    r[0][patch[0]] = patch[1];
    const s = summarizeRelatedShows(r, healthy);
    assert.ok(s.primary.suppressed);
    assert.equal(s.primary.p, null);
  }
  assert.ok(summarizeRelatedShows([...rows(), rows()[0]], healthy).primary.suppressed);
  assert.ok(summarizeRelatedShows(rows(), null).primary.suppressed);
  assert.throws(() => summarizeRelatedShows(Array(100).fill(rows()[0]), healthy), /capped/);
});

test('query selects first mobile exposure per person before joining first session outcomes', () => {
  assert.match(READOUT_QUERY, /event = 'related_shows_ab_exposed'/);
  assert.match(READOUT_QUERY, /properties.flag = 'related-shows-position'/);
  assert.doesNotMatch(READOUT_QUERY, /\$feature\/related-shows-position/);
  assert.match(READOUT_QUERY, /argMin\(coalesce\(properties\.\$session_id/);
  assert.match(READOUT_QUERY, /GROUP BY person_id\s*\), pages AS/);
  assert.match(READOUT_QUERY, /exposed.person_id = pages.person_id AND exposed.sid = pages.sid/);
  assert.match(READOUT_QUERY, /pages.views >= 2/);
  assert.equal(READOUT_QUERY.split("toDateTime('2026-10-23 02:11:00', 'UTC')").length - 1, 2);
  assert.match(READOUT_QUERY, /LIMIT 100/);
  assert.match(READOUT_QUERY, /is_owner/);
});

test('analyzer calls the real readout query and evaluates live flag health', async () => {
  let queries = 0, flagReads = 0;
  const flag = {
    active: true, rollout: 100, ensure_experience_continuity: true,
    variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'compact-after-reviews', rollout_percentage: 50 }],
  };
  const options = {
    query: async q => { queries++; assert.equal(q, READOUT_QUERY); return rows(); },
    fetchFlag: async () => { flagReads++; return flag; },
  };
  const s = await analyzeRelatedShows(options);
  assert.equal(queries, 1);
  assert.equal(flagReads, 1);
  assert.equal(s.flagHealth.ok, true);
  flag.ensure_experience_continuity = false;
  const drifted = await analyzeRelatedShows(options);
  assert.equal(drifted.flagHealth.ok, false);
  assert.ok(drifted.primary.suppressed);
  assert.equal(drifted.primary.p, null);
  await assert.rejects(analyzeRelatedShows({ ...options, query: async () => { throw new Error('PostHog unavailable'); } }), /PostHog unavailable/);
});

test('default flag adapter reads config without writing it and handles missing flags', async t => {
  const oldKey = process.env.POSTHOG_PERSONAL_API_KEY;
  process.env.POSTHOG_PERSONAL_API_KEY = 'offline-test-placeholder';
  let status = 200;
  const reads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    reads.push({ url, method: options.method || 'GET' });
    return { status, ok: status === 200, json: async () => ({
      active: true, ensure_experience_continuity: true,
      filters: {
        groups: [{ rollout_percentage: 100 }],
        multivariate: { variants: [
          { key: 'control', rollout_percentage: 50 },
          { key: 'compact-after-reviews', rollout_percentage: 50 },
        ] },
      },
    }) };
  });
  try {
    const options = { query: async () => rows() };
    assert.equal((await analyzeRelatedShows(options)).flagHealth.ok, true);
    status = 404;
    const missing = await analyzeRelatedShows(options);
    assert.equal(missing.flagHealth.ok, false);
    assert.ok(missing.primary.suppressed);
    status = 403;
    await assert.rejects(analyzeRelatedShows(options), /HTTP 403/);
    assert.ok(reads.every(r => r.method === 'GET' && r.url.endsWith('/feature_flags/992842/')));
  } finally {
    if (oldKey === undefined) delete process.env.POSTHOG_PERSONAL_API_KEY;
    else process.env.POSTHOG_PERSONAL_API_KEY = oldKey;
  }
});
