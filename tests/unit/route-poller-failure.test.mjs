// TESTS-VS-DERIVED-DATA-EXEMPT: synthetic show lists only; never reads data/*.json.
/**
 * BRO-5479 (owner decision 2026-10-16): poller failures email the owner only
 * when a Broadway show is in the poll; other markets file an auto-fix card,
 * one condition per market. Pattern: require() the real functions (rule 15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseShowIds, isBroadwayPoll, marketsInPoll, marketsToResolve, pollerFailureAlert, conditionKeyFor,
  cardNotFiledAlert, CARD_NOT_FILED_KEY,
} = require('../../scripts/route-poller-failure.js');
const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');

const SHOWS = [
  { id: 'bway-show', category: 'broadway' },
  { id: 'ob-show', category: 'off-broadway' },
  { id: 'we-show', category: 'west-end' },
  { id: 'owe-show', category: 'off-west-end' },
  { id: 'no-category-show' },
];

describe('isBroadwayPoll', () => {
  test('a Broadway show in the poll emails', () => {
    assert.equal(isBroadwayPoll(['we-show', 'bway-show'], SHOWS), true);
  });
  test('only non-Broadway shows do not email (Off-Broadway included)', () => {
    assert.equal(isBroadwayPoll(['ob-show', 'we-show', 'owe-show'], SHOWS), false);
  });
  test('fails open: empty poll, unknown id, missing category all email', () => {
    assert.equal(isBroadwayPoll([], SHOWS), true);
    assert.equal(isBroadwayPoll(['not-in-shows-json'], SHOWS), true);
    assert.equal(isBroadwayPoll(['no-category-show'], SHOWS), true);
  });
});

describe('per-market conditions', () => {
  test('marketsInPoll lists each market once, so success resolves only polled markets', () => {
    assert.deepEqual(marketsInPoll(parseShowIds(' we-show, owe-show ,we-show'), SHOWS), ['off-west-end', 'west-end']);
    assert.deepEqual(marketsInPoll(['bway-show'], SHOWS), ['broadway']);
  });
  test('alert is an auto-fix card keyed by market with a dispatch-now marker and a VERIFY line', () => {
    const a = pollerFailureAlert({ market: 'west-end', showIds: ['we-show'], runId: 42, runUrl: 'https://x/42' });
    assert.equal(a.conditionKey, conditionKeyFor('west-end'));
    assert.equal(a.conditionKey, 'opening-night-poller:failure:west-end');
    assert.equal(a.disposition, 'auto');
    assert.deepEqual(a.dispatchAtFiling, { runId: '42', runUrl: 'https://x/42' });
    assert.match(a.verify.line, /^VERIFY: /);
    const b64 = Buffer.from('opening-night-poller:failure:west-end').toString('base64url');
    assert.ok(a.verify.line.includes(b64), `VERIFY must target this market's key: ${a.verify.line}`);
  });
});

describe('resolve and fallback', () => {
  test('a targeted run resolves only what it polled; a full auto run also clears markets with nothing left to poll', () => {
    assert.deepEqual(marketsToResolve(['we-show'], SHOWS, false), ['west-end']);
    assert.deepEqual(marketsToResolve([], SHOWS, true), ['off-broadway', 'off-west-end', 'west-end']);
    assert.deepEqual(marketsToResolve(['bway-show'], SHOWS, true), ['broadway', 'off-broadway', 'off-west-end', 'west-end']);
  });
  test('an auto run does not clear a market whose show is still inside the 4-day West End window', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const shows = [{ id: 'we-recent', category: 'west-end', openingDate: '2026-10-13' }, { id: 'ob-old', category: 'off-broadway', openingDate: '2026-09-01' }];
    assert.deepEqual(marketsToResolve([], shows, true, now), ['off-broadway', 'off-west-end']);
  });
  test('when the card cannot be filed the owner is emailed through a page-worthy key', () => {
    const a = cardNotFiledAlert({ showIds: ['we-show'], runUrl: 'u' });
    assert.equal(a.conditionKey, CARD_NOT_FILED_KEY);
    assert.equal(a.disposition, 'human');
    assert.equal(isPageWorthy(CARD_NOT_FILED_KEY), true, 'key must be on the page-worthy allowlist or the router demotes it to the digest');
  });
});

describe('opening-night-poller.yml wiring', () => {
  const wf = fs.readFileSync(path.join(process.cwd(), '.github/workflows/opening-night-poller.yml'), 'utf8');
  test('notify email fails open: only an explicit broadway=false stops it', () => {
    assert.match(wf, /email: \$\{\{ steps\.audience\.outputs\.broadway == 'false' && 'false' \|\| 'true' \}\}/);
  });
  test('auto-fix routing needs an explicit broadway=false and the same streak gate as Notify', () => {
    const m = wf.match(/id: route_failure\n\s+if: (.+)/);
    assert.ok(m, 'route_failure step missing');
    assert.match(m[1], /steps\.audience\.outputs\.broadway == 'false'/);
    assert.match(m[1], /steps\.notify\.outputs\.suppressed != 'true'/);
  });
  test('audience runs before notify (fail-open depends on the order) and streaks are per run name', () => {
    assert.ok(wf.indexOf('id: audience') < wf.indexOf('id: notify'), 'audience must come before notify');
    assert.match(wf, /streak_per_run_name: 'true'/);
  });
});
