// Guard: the outlet-logos generator (scripts/generate-outlet-logos.js) must keep
// producing a healthy, well-formed map from the canonical outlet-registry.json.
// OutletLogo in ReviewsList resolves logos by outletId against this map; a broken
// generator or registry-shape change would silently drop logos back to gray
// letter-circles (the regression this fix addressed — 378 unmapped outlets).
//
// NOTE: we deliberately do NOT assert byte-equality against the committed
// src/config/outlet-logos-generated.json. The registry is bot-updated ~daily
// (push-core-data), so a strict drift check would turn CI red on unrelated
// registry commits. Instead, prebuild.sh always regenerates the file from the
// current registry, and these tests assert the generator's output is sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const { buildMap } = require(resolve(ROOT, 'scripts/generate-outlet-logos.js'));

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
