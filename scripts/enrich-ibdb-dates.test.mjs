// task #1863 (BRO-102 follow-up): buildVerifiedCreativeTeamChange() routes
// ibdb.creativeTeam through the same SERP-verification gate as
// auto-fix-show-data.js before staging a showChanges write. Previously this
// file wrote ibdb.creativeTeam verbatim — a wrong table cell or stale IBDB
// entry would ship a hallucinated attribution.
//
// Mocks verifyCreativeTeamViaSerp (the network boundary) rather than
// re-implementing its decision logic — CLAUDE.md rule 15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const creativeTeamVerifyPath = require.resolve('./lib/creative-team-verify.js');
const targetPath = require.resolve('./enrich-ibdb-dates.js');

function loadWithMockedVerify(verifyImpl) {
  const real = require(creativeTeamVerifyPath);
  delete require.cache[creativeTeamVerifyPath];
  delete require.cache[targetPath];
  require.cache[creativeTeamVerifyPath] = {
    id: creativeTeamVerifyPath, filename: creativeTeamVerifyPath, loaded: true,
    exports: { ...real, verifyCreativeTeamViaSerp: verifyImpl },
  };
  try {
    return require(targetPath);
  } finally {
    delete require.cache[creativeTeamVerifyPath];
    delete require.cache[targetPath];
    require.cache[creativeTeamVerifyPath] = { id: creativeTeamVerifyPath, filename: creativeTeamVerifyPath, loaded: true, exports: real };
  }
}

function fakeShow(overrides = {}) {
  return { id: 'example-2026', title: 'Example', openingDate: '2026-01-15', ...overrides };
}

test('buildVerifiedCreativeTeamChange: no ibdb.creativeTeam -> null', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async () => []);
  const result = await buildVerifiedCreativeTeamChange(fakeShow(), { creativeTeam: [] }, { mergeCredits: false, force: false });
  assert.equal(result, null);
});

test('buildVerifiedCreativeTeamChange: non-merge mode, unconfirmed member -> null (wrong-table-cell case)', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async () => []);
  const show = fakeShow({ creativeTeam: [] });
  const ibdb = { creativeTeam: [{ name: 'Hallucinated Name', role: 'Playwright' }] };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: false, force: false });
  assert.equal(result, null);
});

test('buildVerifiedCreativeTeamChange: non-merge mode, confirmed member -> creativeTeam showChanges entry', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async (show, proposed, year, sourceTag) =>
    proposed.map(m => ({ ...m, _source: sourceTag }))
  );
  const show = fakeShow({ creativeTeam: [] });
  const ibdb = { creativeTeam: [{ name: 'Mary Zimmerman', role: 'Director' }] };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: false, force: false });
  assert.ok(result);
  assert.equal(result.field, 'creativeTeam');
  assert.equal(result.new.length, 1);
  assert.equal(result.new[0].name, 'Mary Zimmerman');
  assert.equal(result.new[0]._source, 'serp-verified-ibdb-enrich');
});

test('buildVerifiedCreativeTeamChange: existing non-empty team blocks a write without force', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async (show, proposed) => proposed);
  const show = fakeShow({ creativeTeam: [{ name: 'Existing Person', role: 'Director' }] });
  const ibdb = { creativeTeam: [{ name: 'New Person', role: 'Playwright' }] };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: false, force: false });
  assert.equal(result, null);
});

test('buildVerifiedCreativeTeamChange: merge mode adds only new confirmed roles, inserted after Director', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async (show, proposed, year, sourceTag) =>
    proposed.map(m => ({ ...m, _source: sourceTag }))
  );
  const show = fakeShow({
    creativeTeam: [
      { name: 'Existing Director', role: 'Director' },
      { name: 'Existing Designer', role: 'Scenic Design' },
    ],
  });
  const ibdb = {
    creativeTeam: [
      { name: 'Existing Director', role: 'Director' }, // already present — must not duplicate
      { name: 'New Playwright', role: 'Playwright' },
    ],
  };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: true, force: false });
  assert.ok(result);
  assert.equal(result.new.length, 3);
  assert.equal(result.new[1].name, 'New Playwright', 'new role inserted right after Director, before design roles');
});

test('buildVerifiedCreativeTeamChange: merge mode rejects an unconfirmed new role -> null', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async () => []);
  const show = fakeShow({ creativeTeam: [{ name: 'Existing Director', role: 'Director' }] });
  const ibdb = { creativeTeam: [{ name: 'Hallucinated Playwright', role: 'Playwright' }] };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: true, force: false });
  assert.equal(result, null);
});

test('buildVerifiedCreativeTeamChange: force mode with a partial verified result does not shrink an existing complete team', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async (show, proposed) =>
    // Simulate one member failing (network error / rejection) — only 1 of 2 survives.
    proposed.slice(0, 1)
  );
  const show = fakeShow({
    creativeTeam: [
      { name: 'Existing Director', role: 'Director' },
      { name: 'Existing Playwright', role: 'Playwright' },
    ],
  });
  const ibdb = {
    creativeTeam: [
      { name: 'IBDB Director', role: 'Director' },
      { name: 'IBDB Playwright', role: 'Playwright' },
    ],
  };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: false, force: true });
  assert.equal(result, null, 'a partial verified result must not silently shrink an existing complete team on --force');
});

test('buildVerifiedCreativeTeamChange: force mode with a full verified result still overwrites', async () => {
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async (show, proposed, year, sourceTag) =>
    proposed.map(m => ({ ...m, _source: sourceTag }))
  );
  const show = fakeShow({ creativeTeam: [{ name: 'Old Director', role: 'Director' }] });
  const ibdb = { creativeTeam: [{ name: 'New Director', role: 'Director' }] };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: false, force: true });
  assert.ok(result);
  assert.equal(result.new[0].name, 'New Director');
});

test('buildVerifiedCreativeTeamChange: merge mode with no new roles -> null (no SERP call needed)', async () => {
  let calls = 0;
  const { buildVerifiedCreativeTeamChange } = loadWithMockedVerify(async () => { calls++; return []; });
  const show = fakeShow({ creativeTeam: [{ name: 'Existing Director', role: 'Director' }] });
  const ibdb = { creativeTeam: [{ name: 'Existing Director', role: 'Director' }] };
  const result = await buildVerifiedCreativeTeamChange(show, ibdb, { mergeCredits: true, force: false });
  assert.equal(result, null);
  assert.equal(calls, 0, 'no new roles means no verification call should be made');
});
