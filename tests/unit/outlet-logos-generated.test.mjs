// Guard: src/config/outlet-logos-generated.json must stay in sync with the
// canonical data/outlet-registry.json. Outlet logos in ReviewsList resolve by
// outletId against this generated map; if the registry gains outlets/domains
// and the map isn't regenerated, those outlets silently lose their logos (the
// exact regression this fix addressed — 378 unmapped outlets rendered a gray
// letter-circle). Regenerate with: node scripts/generate-outlet-logos.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const { buildMap, serialize, OUT_PATH } = require(resolve(ROOT, 'scripts/generate-outlet-logos.js'));

test('generated outlet-logos map is in sync with the registry (no drift)', () => {
  const { map } = buildMap();
  const committed = readFileSync(OUT_PATH, 'utf8');
  assert.equal(
    serialize(map),
    committed,
    'outlet-logos-generated.json is stale — run `node scripts/generate-outlet-logos.js` and commit the result'
  );
});

test('map covers a healthy share of registry domains', () => {
  const { map } = buildMap();
  // Sanity floor: the registry had ~590 outlets with domains when this guard
  // was written. A sharp drop means the generator or registry shape broke.
  assert.ok(Object.keys(map).length >= 400, `expected >=400 outlets with domains, got ${Object.keys(map).length}`);
});

test('known outletIds resolve to the correct domain', () => {
  const { map } = buildMap();
  const expect = {
    nytimes: 'nytimes.com',
    'theater-scene': 'theaterscene.net',
    ny1: 'ny1.com',
    financialtimes: 'ft.com',
    culturesauce: 'culturesauce.net',
    slantmagazine: 'slantmagazine.com',
    stageandcinema: 'stageandcinema.com',
  };
  for (const [id, domain] of Object.entries(expect)) {
    assert.equal(map[id]?.domain, domain, `${id} should map to ${domain}`);
  }
});

test('every emitted entry has a domain and an abbrev', () => {
  const { map } = buildMap();
  for (const [id, cfg] of Object.entries(map)) {
    assert.ok(cfg.domain, `${id} missing domain`);
    assert.ok(cfg.abbrev, `${id} missing abbrev`);
  }
});
