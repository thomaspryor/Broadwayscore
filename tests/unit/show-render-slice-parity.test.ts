// LIVE-DATA-LANE: reads data/shows.json, critic-consensus.json, audience-buzz.json (untracked core data); runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * BRO-8056 1b-iii: a show's slice carries the RAW critic-consensus and
 * audience-buzz entries; normalizeCriticConsensus / normalizeAudienceBuzz turn
 * them into exactly what the build's getters (and so getShowForRender) return.
 * Runs on real core data (skips when data/ is not present, or holds only the
 * empty stubs a cloud checkout gets without the private data repo).
 *
 * Run: npx tsx --test tests/unit/show-render-slice-parity.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const DATA = path.join(__dirname, '../../data');
const FILES = ['shows.json', 'critic-consensus.json', 'audience-buzz.json'];
// Stub files ({"shows":{}} or a few KB) do not exercise the parity: skip, do not fail.
const have = FILES.every(f => fs.existsSync(path.join(DATA, f)) && fs.statSync(path.join(DATA, f)).size > 100_000);

test('slice consensus + audience normalize to the build getters for every show', { skip: !have && 'core data not present' }, async () => {
  const { getCriticConsensus, normalizeCriticConsensus } = await import('../../src/lib/data-consensus');
  const { getAudienceBuzz, normalizeAudienceBuzz } = await import('../../src/lib/data-audience');
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { buildShowInputs, computableShows } = require('../../scripts/lib/show-refresh/inputs');
  const { indexForSlices, sliceFor } = require('../../scripts/lib/show-refresh/slice');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const inputs = buildShowInputs({ showsData: read('shows.json'), reviews: [], blogReviews: [], audience: [], buzz: [] });
  const index = indexForSlices(inputs, {
    consensusById: read('critic-consensus.json').shows,
    audienceBuzzById: read('audience-buzz.json').shows,
    coverageFloorInputs: { covByShowId: new Map(), scorePublicSinceByShowId: new Map(), coverageAckedShowIds: new Set() },
  });
  let withConsensus = 0, withAudience = 0, n = 0;
  for (const row of computableShows(inputs)) {
    const slice = sliceFor(row.id, index);
    assert.ok(slice, row.id);
    n++;
    const { category, status, closingDate } = slice.row;
    assert.deepEqual(normalizeCriticConsensus(slice.consensus), getCriticConsensus(row.id), `consensus ${row.id}`);
    const buzz = slice.audienceBuzz ? normalizeAudienceBuzz(slice.audienceBuzz, { category, status, closingDate }) : undefined;
    assert.deepEqual(buzz, getAudienceBuzz(row.id), `audience ${row.id}`);
    if (slice.consensus) withConsensus++;
    if (slice.audienceBuzz) withAudience++;
  }
  console.log(`parity: ${n} shows, ${withConsensus} with consensus, ${withAudience} with audience buzz`);
  assert.ok(withConsensus > 100 && withAudience > 100, 'real data should exercise both paths');
});
