// Guards the Rhinoceros-at-A.R.T. defect class (2026-08-24): a JSON-LD reader
// that never descends into schema.org `@graph`, so a real article looks empty.
//
// The repo-wide assertion at the bottom is the load-bearing one — it fails on
// the NEXT parse site somebody adds without the shared helper, which is the
// only thing that actually stops this recurring. The unit tests above it
// exist so a failure names WHICH rule tripped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// CLAUDE.md §15: require the REAL functions — never re-implement them here.
const {
  parsesJsonLd,
  usesHelper,
  findHandRolledFlatten,
  findUnsafeJsonLdParsers,
} = require('./audit-jsonld-graph.js');
const { jsonLdItems, parseJsonLd, hasJsonLdType } = require('./jsonld.js');

// --- the helper itself ----------------------------------------------------

test('jsonLdItems flattens bare nodes, arrays and @graph', () => {
  assert.deepEqual(jsonLdItems({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(jsonLdItems([{ a: 1 }, { b: 2 }]), [{ a: 1 }, { b: 2 }]);

  // The real Playbill shape: wrapper carries no @type/datePublished.
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'NewsArticle', datePublished: '2026-08-24T09:57:00-04:00' }],
  };
  const items = jsonLdItems(graph);
  assert.equal(items.length, 2, 'wrapper is kept alongside its graph nodes');
  assert.ok(items.some((n) => n.datePublished === '2026-08-24T09:57:00-04:00'));

  // A @graph nested inside an array element still yields its nodes.
  assert.equal(jsonLdItems([{ '@graph': [{ x: 1 }] }]).length, 2);

  // Junk never throws and never mints phantom nodes.
  assert.deepEqual(jsonLdItems(null), []);
  assert.deepEqual(jsonLdItems(undefined), []);
  assert.deepEqual(jsonLdItems([null, 'str', 7]), []);
  assert.deepEqual(jsonLdItems({ '@graph': 'not-an-array' }), [{ '@graph': 'not-an-array' }]);
});

test('parseJsonLd swallows malformed blocks instead of throwing', () => {
  assert.deepEqual(parseJsonLd('{not json'), []);
  assert.deepEqual(parseJsonLd(''), []);
  const nodes = parseJsonLd('{"@graph":[{"@type":"NewsArticle","headline":"H"}]}');
  assert.ok(nodes.some((n) => n.headline === 'H'));
});

test('hasJsonLdType accepts the array form the spec allows', () => {
  assert.equal(hasJsonLdType({ '@type': 'TheaterEvent' }, 'TheaterEvent'), true);
  // LondonTheatre.co.uk emits the array form.
  assert.equal(hasJsonLdType({ '@type': ['Event', 'TheaterEvent'] }, 'TheaterEvent'), true);
  assert.equal(hasJsonLdType({ '@type': 'Event' }, 'TheaterEvent'), false);
  assert.equal(hasJsonLdType(null, 'TheaterEvent'), false);
  assert.equal(hasJsonLdType({}, 'TheaterEvent'), false);
});

// --- the detector ---------------------------------------------------------

test('parsesJsonLd needs a JSON.parse NEAR the ld+json reference', () => {
  // Real-world order: the selector comes first, the parse follows it. The
  // window only scans FORWARD from the ld+json reference.
  assert.equal(
    parsesJsonLd(
      `doc.querySelectorAll('script[type="application/ld+json"]');\n` +
        `const d = JSON.parse(el.textContent);`
    ),
    true,
    'parse within the proximity window counts'
  );
  // gather-reviews.js shape: names the selector for Playwright, parses files
  // thousands of lines away. Must NOT be flagged.
  const farApart =
    `await page.waitForSelector('script[type="application/ld+json"]');\n` +
    'x\n'.repeat(500) +
    'const cfg = JSON.parse(fs.readFileSync(p));';
  assert.equal(parsesJsonLd(farApart), false);
  assert.equal(parsesJsonLd(''), false);
  assert.equal(parsesJsonLd(null), false);
});

test('usesHelper recognises both require and import forms', () => {
  assert.equal(usesHelper(`const { jsonLdItems } = require('./jsonld');`), true);
  assert.equal(usesHelper(`const x = require('../lib/jsonld.js');`), true);
  assert.equal(usesHelper(`import { jsonLdItems } from './jsonld.js';`), true);
  assert.equal(usesHelper(`const x = require('./json-ld-other');`), false);
  assert.equal(usesHelper(''), false);
});

test('findHandRolledFlatten names the exact line to replace', () => {
  assert.equal(
    findHandRolledFlatten('const items = Array.isArray(parsed) ? parsed : [parsed];'),
    'Array.isArray(parsed) ? parsed : [parsed]'
  );
  // Different variable name, same defect.
  assert.ok(findHandRolledFlatten('Array.isArray(data) ? data : [data]'));
  // Not the pattern: the two sides differ, so it is not a flatten.
  assert.equal(findHandRolledFlatten('Array.isArray(a) ? a : [b]'), null);
  assert.equal(findHandRolledFlatten('const x = 1;'), null);
});

test('findUnsafeJsonLdParsers flags a parser that skips the helper', () => {
  const files = ['a.js', 'b.js', 'c.test.mjs'];
  const sources = {
    'a.js': `q('script[type="application/ld+json"]');\nconst d = JSON.parse(s.textContent);\nconst i = Array.isArray(d) ? d : [d];`,
    'b.js': `const { jsonLdItems } = require('./jsonld');\nq('script[type="application/ld+json"]');\nconst d = JSON.parse(s.textContent);`,
    // Test files are skipped: they may build malformed JSON-LD on purpose.
    'c.test.mjs': `q('script[type="application/ld+json"]');\nconst d = JSON.parse(s.textContent);`,
  };
  const found = findUnsafeJsonLdParsers(files, (f) => sources[f]);
  assert.deepEqual(found.map((o) => o.file), ['a.js']);
  assert.equal(found[0].snippet, 'Array.isArray(d) ? d : [d]');
  assert.match(found[0].reason, /@graph/);
});

test('findUnsafeJsonLdParsers survives an unreadable file', () => {
  const found = findUnsafeJsonLdParsers(['gone.js'], () => {
    throw new Error('ENOENT');
  });
  assert.deepEqual(found, []);
});

// --- the repo-wide assertion (the one that prevents recurrence) -----------

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|mjs|ts)$/.test(entry.name)) acc.push(path.relative(REPO, full));
  }
  return acc;
}

test('NO file in scripts/ or src/ parses JSON-LD without the shared helper', () => {
  const files = [
    ...walk(path.join(REPO, 'scripts')),
    ...walk(path.join(REPO, 'src')),
  ];
  const offenders = findUnsafeJsonLdParsers(files, (rel) =>
    fs.readFileSync(path.join(REPO, rel), 'utf8')
  );
  assert.deepEqual(
    offenders,
    [],
    'JSON-LD parsed without scripts/lib/jsonld.js — a @graph-wrapped payload ' +
      'would be silently invisible (the Rhinoceros/Playbill defect). Route it ' +
      'through jsonLdItems()/parseJsonLd():\n' +
      offenders.map((o) => `  ${o.file}${o.snippet ? `  [${o.snippet}]` : ''}`).join('\n')
  );
});
