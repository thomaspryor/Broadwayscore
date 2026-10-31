// task #1863 (BRO-102 follow-up): verifyAndMergePlaywright() routes
// IBDB-scraped Playwright credits through the same SERP-verification gate
// as auto-fix-show-data.js before merging into show.creativeTeam.
// Previously this file merged ibdb.creativeTeam verbatim.
//
// Mocks verifyCreativeTeamViaSerp (the network boundary) rather than
// re-implementing its decision logic — CLAUDE.md rule 15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const creativeTeamVerifyPath = require.resolve('./lib/creative-team-verify.js');
const targetPath = require.resolve('./backfill-playwright-credits.js');

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
  return { id: 'example-2026', title: 'Example', openingDate: '2026-01-15', creativeTeam: [], ...overrides };
}

test('verifyAndMergePlaywright: no Playwright entries in IBDB team -> no-op, no SERP call', async () => {
  let calls = 0;
  const { verifyAndMergePlaywright } = loadWithMockedVerify(async () => { calls++; return []; });
  const show = fakeShow();
  const { merged, added } = await verifyAndMergePlaywright(show, [{ name: 'Some Director', role: 'Director' }], '2026');
  assert.deepEqual(merged, []);
  assert.deepEqual(added, []);
  assert.equal(calls, 0, 'no Playwright entries means no verification call should be made');
});

test('verifyAndMergePlaywright: unconfirmed Playwright is rejected (wrong-table-cell case)', async () => {
  const { verifyAndMergePlaywright } = loadWithMockedVerify(async () => []);
  const show = fakeShow();
  const { merged, added } = await verifyAndMergePlaywright(show, [{ name: 'Hallucinated Writer', role: 'Playwright' }], '2026');
  assert.deepEqual(merged, []);
  assert.deepEqual(added, []);
});

test('verifyAndMergePlaywright: a confirmed Playwright is merged in', async () => {
  const { verifyAndMergePlaywright } = loadWithMockedVerify(async (show, proposed, year, sourceTag) =>
    proposed.map(m => ({ ...m, _source: sourceTag }))
  );
  const show = fakeShow({ creativeTeam: [{ name: 'Existing Director', role: 'Director' }] });
  const { merged, added } = await verifyAndMergePlaywright(show, [{ name: 'Reginald Rose', role: 'Playwright' }], '2026');
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'Reginald Rose');
  assert.equal(added[0]._source, 'serp-verified-ibdb-playwright-backfill');
  assert.equal(merged.length, 2);
  assert.equal(merged[1].name, 'Reginald Rose', 'inserted after Director');
});

test('verifyAndMergePlaywright: a combined Playwright credit is split before SERP verification', async () => {
  let seenProposed;
  const { verifyAndMergePlaywright } = loadWithMockedVerify(async (show, proposed) => {
    seenProposed = proposed;
    return [];
  });
  const show = fakeShow();
  await verifyAndMergePlaywright(show, [{ name: 'John Doe & Jane Smith', role: 'Playwright' }], '2026');
  assert.equal(seenProposed.length, 2, 'combined name must be split into individual entries before verification');
  assert.deepEqual(seenProposed.map(m => m.name).sort(), ['Jane Smith', 'John Doe']);
});

test('verifyAndMergePlaywright: role already present -> mergeCreativeTeam no-ops even if verified', async () => {
  const { verifyAndMergePlaywright } = loadWithMockedVerify(async (show, proposed, year, sourceTag) =>
    proposed.map(m => ({ ...m, _source: sourceTag }))
  );
  const show = fakeShow({ creativeTeam: [{ name: 'Existing Playwright', role: 'Playwright' }] });
  const { merged, added } = await verifyAndMergePlaywright(show, [{ name: 'Another Playwright', role: 'Playwright' }], '2026');
  assert.deepEqual(added, []);
  assert.equal(merged.length, 1);
});
