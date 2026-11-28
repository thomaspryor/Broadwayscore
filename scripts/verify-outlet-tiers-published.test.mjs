/**
 * verify-outlet-tiers-published.test.mjs — RECHECK-AFTER acceptance for
 * BRO-4930 (57 outlet tier moves landed 2026-10-09). The config change only
 * reaches the site when rebuild-reviews.yml (04:00 UTC cron) regenerates
 * public/data/shows/*.json. Asserts against LIVE published data, not fixtures:
 * every published review from a moved outlet must carry the adopted tier
 * (`t`). Run by scripts/autonomous-acceptance-recheck.js. A red run means the
 * nightly rebuild did not pick up the new tiers, not a code regression.
 *
 * timebomb-audit-exempt: dated RECHECK-AFTER probe of live rebuild output; it waits for the first rebuild after 2026-10-09 and a shifted clock cannot simulate that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const SHOWS_DIR = path.join(ROOT, 'public', 'data', 'shows');
// land.js runs every changed *.test.mjs, so this skips until the first nightly
// rebuild after the tiers landed (2026-10-09 23:46 UTC).
const PENDING = Date.now() < Date.parse('2026-10-10T07:00:00Z')
  ? 'waits for the 2026-10-10 04:00 UTC rebuild-reviews run' : false;

test('every published review from a 2026-10 moved outlet shows its adopted tier', { skip: PENDING }, () => {
  const tiers = readJson('src/config/outlet-tiers.json');
  const cfg = tiers.outlets || tiers;
  const registry = readJson('data/outlet-registry.json').outlets;
  const { rows } = readJson('tests/unit/outlet-tiers-adopted-2026-10.json');
  // Published reviews name the outlet (`o`), not its id, so key by every name
  // the outlet is known by in the config and the registry.
  const expected = new Map();
  for (const [id, region, tier] of rows) {
    for (const name of [cfg[id]?.name, registry[id]?.displayName, registry[id]?.name].filter(Boolean)) {
      expected.set(`${name}|${region}`, tier);
    }
  }
  let checked = 0;
  const wrong = [];
  for (const f of fs.readdirSync(SHOWS_DIR).filter((x) => x.endsWith('.json'))) {
    const show = JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, f), 'utf8'));
    const region = /west-end/.test(show.cat || '') ? 'london' : 'nyc';
    for (const r of show.rv || []) {
      const tier = expected.get(`${r.o}|${region}`);
      if (tier == null) continue;
      checked++;
      if (r.t !== tier) wrong.push(`${show.id}: ${r.o} T${r.t}, expected T${tier}`);
    }
  }
  assert.ok(checked > 500, `expected hundreds of published reviews from moved outlets, found ${checked}`);
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length}/${checked} published reviews still carry the old tier`);
});
