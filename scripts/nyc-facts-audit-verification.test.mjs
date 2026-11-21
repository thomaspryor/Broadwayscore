// LIVE-DATA-LANE: reads data/pending-fixes/bro-6548.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const report = require('../docs/specs/nyc-facts-source-checks.json');
const plan = require('../data/pending-fixes/bro-6548.json');
const actions = plan.plan.actions;
const { applyDataEdit } = require('./lib/data-edit-action.js');
const audit = readFileSync(new URL('../docs/specs/nyc-facts-audit.md', import.meta.url), 'utf8');
const expected = [
  ['peter-panto-off-broadway-2026', 'type', 'retired'],
  ['nature-theater-of-oklahoma-pizza-or-a-door-in-the-dark-does-not-dance-off-broadway-2027', 'type', 'correction-planned'],
  ['the-unsinkable-off-broadway-2026', 'type', 'source-unreadable'],
  ['isla-off-broadway-2026', 'openingDate', 'source-silent'],
  ['the-gin-game-2026', 'openingDate', 'source-silent'],
  ['el-quijote-off-broadway-2026', 'closingDate', 'source-unreadable'],
  ['that-math-show-off-broadway-2026', 'openingDate', 'source-silent'],
  ['whats-eating-gilbert-grape-off-broadway-2026', 'id', 'rename-decision'],
];

test('the audit links the eight-row BRO-6548 source report', () => {
  assert.equal(report.issue, 'BRO-6548');
  assert.equal(report.rows.length, expected.length);
  assert.equal(new Set(report.rows.map(r => `${r.showId}|${r.field}`)).size, expected.length);
  assert.match(audit, /nyc-facts-source-checks\.json/);
  assert.match(audit, /pending runner application/);
});

for (const [showId, field, status] of expected) {
  test(`${showId}: ${field} has a documented disposition and fetched source`, () => {
    const row = report.rows.find(r => r.showId === showId && r.field === field);
    assert.ok(row, 'required audit row');
    assert.equal(row.status, status);
    assert.ok(row.decision?.trim(), 'field-specific decision');
    assert.ok(row.sources.length > 0);
    for (const source of row.sources) {
      assert.equal(new URL(source.url).protocol, 'https:');
      assert.ok(Number.isFinite(Date.parse(source.checkedAt)), 'fetch timestamp');
      assert.equal(source.method, 'fetchPage(directOnly)');
      assert.ok(source.observation?.trim(), 'field-specific observation');
      if (source.outcome === 'unreadable') {
        assert.ok(source.error?.trim(), 'failure evidence');
      } else {
        assert.ok(source.bytes > 0, 'nonempty response');
        assert.match(source.sha256, /^[a-f0-9]{64}$/);
      }
    }
  });
}

test('only the explicitly sourced Pizza type correction is planned', () => {
  const row = report.rows.find(r => r.status === 'correction-planned');
  assert.equal(plan.issueNumber, 'bro-6548');
  // The pending-fixes runner flips status to 'applied' once it lands the edit;
  // the plan content (checked below) is what this test pins, not run state.
  assert.ok(['pending', 'applied'].includes(plan.status), `unexpected plan status ${plan.status}`);
  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.equal(action.type, 'data-edit');
  assert.equal(action.file, 'shows.json');
  assert.equal(action.showId, row.showId);
  assert.equal(action.field, row.field);
  assert.equal(action.oldValue, row.storedValue);
  assert.equal(action.newValue, row.proposedValue);
  assert.equal(row.proposedValue, 'opera');
  assert.ok(action.description.includes(row.sources[0].url), 'authoritative citation');
  const data = { shows: [{ id: row.showId, type: row.storedValue }] };
  assert.equal(applyDataEdit(data, action).ok, true);
  assert.equal(data.shows[0].type, 'opera');
});

test('Gilbert Grape records the real rename path without claiming application', () => {
  const row = report.rows.find(r => r.field === 'id');
  assert.match(row.rename.command, /^node scripts\/rename-show-id\.js /);
  assert.ok(row.rename.command.includes(row.storedValue));
  assert.ok(row.rename.command.includes(row.proposedValue));
  assert.equal(row.rename.mode, 'dry-run');
  assert.equal(row.rename.ok, true);
  assert.equal(row.rename.refusals, 0);
  assert.equal(row.rename.applicationStatus, 'deferred-private-repo-write');
  assert.ok(row.rename.summary.filesRewritten > 0);
  assert.equal(actions.some(a => a.field === 'id'), false);
});
