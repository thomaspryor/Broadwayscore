// LIVE-DATA-LANE: reads data/audit/outlet-display-name-proposals.json (read by the test); data/outlet-registry.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-5507: hand-reviewed outlet display names (data/audit/outlet-display-name-proposals.json)
// applied by scripts/audit-registry-slug-displaynames.js --apply-proposals through a
// pending-fix plan. Rules: scripts/lib/outlet-display-name-proposals.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { applyDisplayNameProposals, proposalShapeProblem } = require(resolve(ROOT, 'scripts/lib/outlet-display-name-proposals.js'));
const { ALLOWED_SCRIPTS } = require(resolve(ROOT, 'scripts/lib/run-script-allowlist.js'));

const EV = '2026-11-05 https://example.com/ og:site_name "X"';

function fixture() {
  return {
    outlets: {
      theatrecat: { displayName: 'Theatrecat', tier: 3, aliases: ['theatrecat'], domain: 'theatrecat.com', displayNameInferred: true },
      monstagigz: { displayName: 'Monstagigz', tier: 3, aliases: ['monstagigz'] },
      jewishnews: { displayName: 'Jewishnews', tier: 3, aliases: [] },
      latimes: { displayName: 'Los Angeles Times', tier: 1, aliases: ['la times'] },
      lacritic: { displayName: 'Lacritic', tier: 3, aliases: ['lacritic'] },
    },
    _aliasIndex: {},
  };
}

test('rename writes the masthead, keeps the old name resolvable, drops the inferred flag', () => {
  const reg = fixture();
  const out = applyDisplayNameProposals(reg, [
    { outletId: 'theatrecat', from: 'Theatrecat', action: 'rename', to: 'theatreCat', evidence: EV },
    { outletId: 'jewishnews', from: 'Jewishnews', action: 'rename', to: 'Jewish News', evidence: EV },
  ]);
  assert.deepEqual(out.refused, []);
  assert.equal(out.changed.length, 2);
  assert.equal(reg.outlets.theatrecat.displayName, 'theatreCat');
  assert.equal(reg.outlets.theatrecat.displayNameSource, 'homepage-reviewed');
  assert.equal(reg.outlets.theatrecat.displayNameInferred, undefined);
  assert.deepEqual(reg.outlets.theatrecat.aliases, ['theatrecat'], 'old name already an alias: not added twice');
  assert.deepEqual(reg.outlets.jewishnews.aliases, ['jewishnews'], 'old name added so existing review labels still resolve');
});

test('reviewed stamps displayNameReviewed and leaves the name alone', () => {
  const reg = fixture();
  const out = applyDisplayNameProposals(reg, [{ outletId: 'monstagigz', from: 'Monstagigz', action: 'reviewed', evidence: EV }]);
  assert.equal(out.changed.length, 1);
  assert.equal(reg.outlets.monstagigz.displayName, 'Monstagigz');
  assert.equal(reg.outlets.monstagigz.displayNameReviewed, true);
});

test('a re-run is a no-op, a name changed since review is refused', () => {
  const reg = fixture();
  const rows = [
    { outletId: 'theatrecat', from: 'Theatrecat', action: 'rename', to: 'theatreCat', evidence: EV },
    { outletId: 'monstagigz', from: 'Monstagigz', action: 'reviewed', evidence: EV },
  ];
  applyDisplayNameProposals(reg, rows);
  const again = applyDisplayNameProposals(reg, rows);
  assert.equal(again.changed.length, 0);
  assert.equal(again.unchanged.length, 2);
  reg.outlets.jewishnews.displayName = 'Jewish News Online';
  const drift = applyDisplayNameProposals(reg, [{ outletId: 'jewishnews', from: 'Jewishnews', action: 'rename', to: 'Jewish News', evidence: EV }]);
  assert.equal(drift.changed.length, 0);
  assert.match(drift.refused[0].reason, /displayName is now "Jewish News Online"/);
  assert.equal(reg.outlets.jewishnews.displayName, 'Jewish News Online');
});

test('a rename that would resolve to another outlet is refused and rolled back', () => {
  const reg = fixture();
  const before = JSON.stringify(reg.outlets.lacritic);
  const out = applyDisplayNameProposals(reg, [{ outletId: 'lacritic', from: 'Lacritic', action: 'rename', to: 'The LA Times', evidence: EV }]);
  assert.equal(out.changed.length, 0);
  assert.match(out.refused[0].reason, /would collide with another outlet on .*la times/);
  assert.equal(JSON.stringify(reg.outlets.lacritic), before);
});

test('malformed rows, unknown outlets and duplicates are refused', () => {
  assert.match(proposalShapeProblem({ outletId: 'x', from: 'Xy', action: 'rename', to: 'Xy', evidence: EV }), /to equals from/);
  assert.match(proposalShapeProblem({ outletId: 'x', from: 'X', action: 'rename', to: ' Yz', evidence: EV }), /whitespace/);
  assert.match(proposalShapeProblem({ outletId: 'x', from: 'X', action: 'guess', evidence: EV }), /action/);
  assert.match(proposalShapeProblem({ outletId: 'x', from: 'X', action: 'reviewed' }), /evidence/);
  const reg = fixture();
  const out = applyDisplayNameProposals(reg, [
    { outletId: 'nosuch', from: 'Nosuch', action: 'reviewed', evidence: EV },
    { outletId: 'monstagigz', from: 'Monstagigz', action: 'reviewed', evidence: EV },
    { outletId: 'monstagigz', from: 'Monstagigz', action: 'reviewed', evidence: EV },
  ]);
  assert.deepEqual(out.refused.map((r) => r.reason), ['not in outlet-registry.json', 'listed twice']);
});

test('the committed proposals file is well formed and applies to the live registry without collisions', () => {
  const doc = JSON.parse(readFileSync(resolve(ROOT, 'data/audit/outlet-display-name-proposals.json'), 'utf8'));
  assert.ok(doc.proposals.length >= 50, `expected the reviewed rows, got ${doc.proposals.length}`);
  for (const row of doc.proposals) assert.equal(proposalShapeProblem(row), null, JSON.stringify(row));
  const registry = JSON.parse(readFileSync(resolve(ROOT, 'data/outlet-registry.json'), 'utf8'));
  const out = applyDisplayNameProposals(registry, doc.proposals);
  // A row someone renamed since review is allowed (refused as drift); a collision or bad row is not.
  const hard = out.refused.filter((r) => !/^displayName is now /.test(r.reason));
  assert.deepEqual(hard, []);
  const unresolvedIds = new Set((doc.unresolved || []).map((u) => u.outletId));
  for (const row of doc.proposals) assert.ok(!unresolvedIds.has(row.outletId), `${row.outletId} is both proposed and unresolved`);
});

test('pending-fix plans may run the applier', () => {
  assert.ok(ALLOWED_SCRIPTS.includes('audit-registry-slug-displaynames.js'));
});
