// BRO-3528: same-date OB shows that Playbill never indexes (Repertorio Español,
// Met Opera titles, ...) stop burning a SERP credit every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serpBackoffDecision, isBackoffEligible } = require('./ob-serp-miss-backoff.js');

const REPERTORIO = [
  'los-soles-truncos-off-broadway-2025',
  'la-llamada-off-broadway-2024',
  'la-breve-y-maravillosa-vida-de-oscar-wao-off-broadway-2024',
];

const miss = (showId) => ({ showId, reason: 'no-playbill-production-url' });
const run = (runAt, ...entries) => ({ runAt, script: 'enrich-off-broadway-dates', entries });
const NOW = new Date('2026-10-13T12:00:00Z');

// The last 5 runs of data/audit/date-enrichment-corrections.json as committed
// on 2026-10-13, filtered to the three shows (each run also logged ~20 other
// shows' misses). Frozen so later runs cannot change this test's answer.
const REAL_RUNS = [{"runAt":"2026-09-28T15:35:42.106Z","script":"enrich-off-broadway-dates","entries":[{"showId":"los-soles-truncos-off-broadway-2025","reason":"no-playbill-production-url"},{"showId":"la-llamada-off-broadway-2024","reason":"no-playbill-production-url"},{"showId":"la-breve-y-maravillosa-vida-de-oscar-wao-off-broadway-2024","reason":"no-playbill-production-url"}]},{"runAt":"2026-10-01T15:31:12.463Z","script":"enrich-off-broadway-dates","entries":[{"showId":"los-soles-truncos-off-broadway-2025","reason":"no-playbill-production-url"},{"showId":"la-llamada-off-broadway-2024","reason":"no-playbill-production-url"},{"showId":"la-breve-y-maravillosa-vida-de-oscar-wao-off-broadway-2024","reason":"no-playbill-production-url"}]},{"runAt":"2026-10-05T15:59:58.376Z","script":"enrich-off-broadway-dates","entries":[{"showId":"los-soles-truncos-off-broadway-2025","reason":"no-playbill-production-url"},{"showId":"la-llamada-off-broadway-2024","reason":"no-playbill-production-url"},{"showId":"la-breve-y-maravillosa-vida-de-oscar-wao-off-broadway-2024","reason":"no-playbill-production-url"}]},{"runAt":"2026-10-08T15:42:12.375Z","script":"enrich-off-broadway-dates","entries":[{"showId":"los-soles-truncos-off-broadway-2025","reason":"no-playbill-production-url"},{"showId":"la-llamada-off-broadway-2024","reason":"no-playbill-production-url"},{"showId":"la-breve-y-maravillosa-vida-de-oscar-wao-off-broadway-2024","reason":"no-playbill-production-url"}]},{"runAt":"2026-10-12T16:56:09.679Z","script":"enrich-off-broadway-dates","entries":[{"showId":"los-soles-truncos-off-broadway-2025","reason":"no-playbill-production-url"},{"showId":"la-llamada-off-broadway-2024","reason":"no-playbill-production-url"},{"showId":"la-breve-y-maravillosa-vida-de-oscar-wao-off-broadway-2024","reason":"no-playbill-production-url"}]}];

test('real run log: the three Repertorio Español shows are skipped the day after the last run', () => {
  const now = new Date('2026-10-13T16:56:09Z');
  for (const id of REPERTORIO) {
    const d = serpBackoffDecision(id, REAL_RUNS, now);
    assert.equal(d.misses, 5, id);
    assert.equal(d.lastMissAt, '2026-10-12T16:56:09.679Z');
    assert.equal(d.skip, true, id);
  }
});

test('fewer than 3 consecutive misses: still probed', () => {
  const runs = [run('2026-10-05T00:00:00Z', miss('a')), run('2026-10-08T00:00:00Z', miss('a'))];
  assert.equal(serpBackoffDecision('a', runs, NOW).skip, false);
});

test('cooldown: one probe again once the newest miss is 30+ days old', () => {
  const runs = [run('2026-08-01T00:00:00Z', miss('a')), run('2026-08-05T00:00:00Z', miss('a')), run('2026-08-08T00:00:00Z', miss('a'))];
  const d = serpBackoffDecision('a', runs, NOW);
  assert.equal(d.misses, 3);
  assert.equal(d.skip, false);
  assert.equal(serpBackoffDecision('a', runs, new Date('2026-08-20T00:00:00Z')).skip, true);
});

test('a found page (any other outcome) ends the streak', () => {
  const runs = [
    run('2026-10-01T00:00:00Z', miss('a')),
    run('2026-10-02T00:00:00Z', miss('a')),
    run('2026-10-03T00:00:00Z', { showId: 'a', reason: 'page-title-or-year-mismatch' }),
    run('2026-10-05T00:00:00Z', miss('a')),
    run('2026-10-08T00:00:00Z', miss('a')),
  ];
  const d = serpBackoffDecision('a', runs, NOW);
  assert.equal(d.misses, 2);
  assert.equal(d.skip, false);
});

test('transient SERP errors are neutral: they neither count nor reset', () => {
  const runs = [
    run('2026-10-01T00:00:00Z', miss('a')),
    run('2026-10-03T00:00:00Z', miss('a')),
    run('2026-10-05T00:00:00Z', { showId: 'a', reason: 'serp-error', detail: 'quota' }),
    run('2026-10-08T00:00:00Z', miss('a')),
  ];
  const d = serpBackoffDecision('a', runs, NOW);
  assert.equal(d.misses, 3);
  assert.equal(d.skip, true);
});

test('duplicate entries in one run count once; other shows do not interfere', () => {
  const runs = [
    run('2026-10-05T00:00:00Z', miss('a'), miss('a'), miss('b')),
    run('2026-10-08T00:00:00Z', miss('b')),
    run('2026-10-12T00:00:00Z', miss('a'), miss('a')),
  ];
  assert.equal(serpBackoffDecision('a', runs, NOW).misses, 2);
  assert.equal(serpBackoffDecision('c', runs, NOW).skip, false);
  assert.deepEqual(serpBackoffDecision('a', [], NOW), { skip: false, misses: 0, lastMissAt: null });
});

test('only the same-date class backs off; a show in previews with no opening date is always probed', () => {
  assert.equal(isBackoffEligible({ previewsStartDate: '2025-02-20', openingDate: '2025-02-20' }), true);
  assert.equal(isBackoffEligible({ previewsStartDate: '2026-10-01', openingDate: null }), false);
  assert.equal(isBackoffEligible({ previewsStartDate: '2026-09-01', openingDate: '2026-09-20' }), false);
  assert.equal(isBackoffEligible(null), false);
});

test('an applied fix (logged with id, not showId) ends the streak', () => {
  const runs = [
    run('2026-10-01T00:00:00Z', miss('a')),
    run('2026-10-02T00:00:00Z', miss('a')),
    run('2026-10-03T00:00:00Z', miss('a')),
    run('2026-10-05T00:00:00Z', { kind: 'applied', id: 'a', field: 'openingDate' }),
    run('2026-10-08T00:00:00Z', miss('a')),
  ];
  const d = serpBackoffDecision('a', runs, NOW);
  assert.equal(d.misses, 1);
  assert.equal(d.skip, false);
});
