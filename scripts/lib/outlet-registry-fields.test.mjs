import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ALLOWED_STAR_SCALES, findInvalidRegistryFields } = require('./outlet-registry-fields.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('starScale: null is REJECTED — the exact value that put main red on 2026-09-06', () => {
  const invalid = findInvalidRegistryFields({
    outlets: { arbuturian: { displayName: 'The Arbuturian', tier: 3, starScale: null } },
  });
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].outletId, 'arbuturian');
  assert.equal(invalid[0].field, 'starScale');
  assert.equal(invalid[0].value, null);
});

test('an OMITTED starScale key is accepted — that is how a no-star outlet is spelled', () => {
  const invalid = findInvalidRegistryFields({
    outlets: { arbuturian: { displayName: 'The Arbuturian', tier: 3 } },
  });
  assert.deepEqual(invalid, []);
});

test('null and absent are NOT interchangeable — the distinction is the whole contract', () => {
  const withNull = findInvalidRegistryFields({ outlets: { o: { starScale: null } } });
  const withAbsent = findInvalidRegistryFields({ outlets: { o: {} } });
  assert.equal(withNull.length, 1);
  assert.equal(withAbsent.length, 0);
});

test('every allowed denominator passes, and a plausible-but-unsupported one fails', () => {
  for (const scale of ALLOWED_STAR_SCALES) {
    assert.deepEqual(
      findInvalidRegistryFields({ outlets: { o: { starScale: scale } } }),
      [],
      `starScale ${scale} should be accepted`,
    );
  }
  // 6 is the shape of a real mistake (a 6-star outlet does not exist here) and
  // must not slip through just because it is a number.
  assert.equal(findInvalidRegistryFields({ outlets: { o: { starScale: 6 } } }).length, 1);
  // A stringified number is the other real mistake shape.
  assert.equal(findInvalidRegistryFields({ outlets: { o: { starScale: '5' } } }).length, 1);
});

test('ALLOWED_STAR_SCALES is pinned — widening it silently weakens both gates AND the writer', () => {
  // scripts/audit-outlet-star-scales.js --apply imports this set to refuse
  // writing an inferred denominator outside it. Adding a value here quietly
  // permits that denominator in three places at once, so the set is pinned and
  // a deliberate widening has to update this test in the same commit.
  assert.deepEqual([...ALLOWED_STAR_SCALES].sort((a, b) => a - b), [4, 5, 10, 100]);
});

test('the star-scale writer imports the shared allow-list rather than re-deriving one', () => {
  // Structural assertion: the guard added at the --apply write site is the
  // thing that stops an inferred "/6" landing in the registry and breaking the
  // next CI run. If someone deletes the import or the membership check, this
  // fails rather than the regression reappearing silently in production.
  const writerPath = path.join(HERE, '..', 'audit-outlet-star-scales.js');
  const src = fs.readFileSync(writerPath, 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/outlet-registry-fields['"]\)/,
    'audit-outlet-star-scales.js must import the shared allow-list');
  assert.match(src, /ALLOWED_STAR_SCALES\.has\(/,
    'audit-outlet-star-scales.js must gate its registry write on ALLOWED_STAR_SCALES');
});

test('multiAuthor must be a real boolean, not a truthy string', () => {
  assert.deepEqual(findInvalidRegistryFields({ outlets: { o: { multiAuthor: true } } }), []);
  assert.deepEqual(findInvalidRegistryFields({ outlets: { o: { multiAuthor: false } } }), []);
  const invalid = findInvalidRegistryFields({ outlets: { o: { multiAuthor: 'true' } } });
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].field, 'multiAuthor');
});

test('_meta and _aliasIndex siblings are skipped, not scanned as outlets', () => {
  const invalid = findInvalidRegistryFields({
    outlets: {
      _meta: { starScale: 'not-an-outlet' },
      _aliasIndex: { multiAuthor: 'not-an-outlet' },
      real: { starScale: 5 },
    },
  });
  assert.deepEqual(invalid, []);
});

test('both fields wrong on one outlet report as TWO findings, not one', () => {
  const invalid = findInvalidRegistryFields({
    outlets: { o: { starScale: null, multiAuthor: 'yes' } },
  });
  assert.equal(invalid.length, 2);
  assert.deepEqual(new Set(invalid.map(i => i.field)), new Set(['starScale', 'multiAuthor']));
});

test('a bare id->entry map (no outlets wrapper) is accepted, and junk input does not throw', () => {
  assert.equal(findInvalidRegistryFields({ o: { starScale: null } }).length, 1);
  assert.deepEqual(findInvalidRegistryFields({}), []);
  assert.deepEqual(findInvalidRegistryFields(null), []);
  assert.deepEqual(findInvalidRegistryFields({ outlets: { o: null, p: 'string' } }), []);
});

test('the REAL registry conforms — this is the check CI runs, not a fixture', (t) => {
  const registryPath = path.join(HERE, '..', '..', 'data', 'outlet-registry.json');
  if (!fs.existsSync(registryPath)) {
    // Loud skip, never a vacuous pass: data/outlet-registry.json is gitignored
    // and absent in a bare worktree.
    t.skip(`SKIPPED — ${registryPath} absent (gitignored core data not present here)`);
    return;
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const outletCount = Object.keys(registry.outlets || registry).length;
  assert.ok(outletCount > 100, `expected a real registry, scanned only ${outletCount} entries`);
  const invalid = findInvalidRegistryFields(registry);
  assert.deepEqual(
    invalid.map(i => i.message),
    [],
    'live data/outlet-registry.json violates the starScale/multiAuthor contract',
  );
});
