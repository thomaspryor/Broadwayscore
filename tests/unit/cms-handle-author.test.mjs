/**
 * BRO-5317: a CMS account ("Sam - Admin", "Ri-admin") is the site, not the
 * critic. extractHighConfidenceAuthor fed article:author / JSON-LD straight
 * into criticName, so these showed on the site as critics.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractHighConfidenceAuthor } = require('../../scripts/lib/content-quality.js');

for (const handle of ['Sam - Admin', 'Ri-admin', 'Vivantadmin', 'OperaWireAdmin2']) {
  test(`article:author "${handle}" is not a critic`, () => {
    const html = `<head><meta property="article:author" content="${handle}"></head>`;
    assert.strictEqual(extractHighConfidenceAuthor(html), null);
  });
}

test('JSON-LD Person "Sam - Admin" is not a critic', () => {
  const html = '<script type="application/ld+json">{"author":{"@type":"Person","name":"Sam - Admin"}}</script>';
  assert.strictEqual(extractHighConfidenceAuthor(html), null);
});

test('a real critic still comes through', () => {
  const html = '<head><meta property="article:author" content="Raphael Kohn"></head>';
  assert.deepStrictEqual(extractHighConfidenceAuthor(html), { name: 'Raphael Kohn', source: 'article:author' });
});
