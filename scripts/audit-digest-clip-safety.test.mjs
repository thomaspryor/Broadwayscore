// Colocated test for the static extraction logic in audit-digest-clip-safety.js
// (card #1078 follow-up). require()s the module directly rather than shelling
// out to the CLI, per feedback_test_extraction_pattern.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { __test } = require('./audit-digest-clip-safety.js');
const { extractField, staticPrefix, fullStaticText } = __test;

test('extractField pulls the raw expression text for a named key', () => {
  const body = "title: 'Some title',\n    description: `front-loaded text`,\n    severity: 'warn',";
  assert.equal(extractField(body, 'description').trim(), '`front-loaded text`');
  assert.equal(extractField(body, 'title').trim(), "'Some title'");
  assert.equal(extractField(body, 'decisionPrompt'), null);
});

test('staticPrefix extracts a template literal head up to the first interpolation', () => {
  const expr = '`${v.domain} / ${v.tier} (${v.direction}): ${v.reason}`';
  // static prefix here is empty — interpolation starts immediately
  assert.equal(staticPrefix(expr), '');
});

test('staticPrefix returns the full text of a plain string literal', () => {
  assert.equal(staticPrefix("'Nothing to fix — all clear.'"), 'Nothing to fix — all clear.');
});

test('staticPrefix returns null for a bare variable/expression', () => {
  assert.equal(staticPrefix('description'), null);
  assert.equal(staticPrefix('someHelper()'), null);
});

test('fullStaticText requires the ENTIRE expression to be static, not just a prefix', () => {
  assert.equal(fullStaticText('`domain-tier-skip.json drift: ${n} verdict(s)`'), null);
  assert.equal(fullStaticText('`domain-tier-skip.json drift`'), 'domain-tier-skip.json drift');
  assert.equal(fullStaticText("'Fixed title'"), 'Fixed title');
});
