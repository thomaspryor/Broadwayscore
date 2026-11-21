import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateVerifiability } = require('../../scripts/lib/verify-gate.js');

// BRO-2822: a card that HAS an acceptance section or VERIFY line whose
// command fails safe-form validation must say so, naming the rejected
// candidate. It used to report "card has no acceptance-criteria section"
// whenever the failing candidate lived in a comment, which sent the author to
// add a section they had already added.

const NO_SECTION = /no acceptance-criteria section/;

test('a comment-only VERIFY line with a rejected shape reports the shape, not no-section', () => {
  const r = evaluateVerifiability('Plain description, no criteria.', ['VERIFY: grep -q foo .github/workflows/y.yml']);
  assert.equal(r.armed, false);
  assert.equal(r.kind, 'shape');
  assert.doesNotMatch(r.reason, NO_SECTION);
  assert.match(r.reason, /grep -q foo \.github\/workflows\/y\.yml/);
  assert.equal(r.source, 'comment:0');
});

test('a description acceptance section with a rejected command names the candidate', () => {
  for (const body of [
    '## Acceptance criteria\n`grep -q foo .github/workflows/y.yml`',
    'VERIFY: node -e "process.exit(0)"',
    'VERIFY: test -f .github/workflows/commercial-rss-poll.yml',
  ]) {
    const r = evaluateVerifiability(body);
    assert.equal(r.armed, false, body);
    assert.notEqual(r.kind, 'no-section', body);
    assert.doesNotMatch(r.reason, NO_SECTION, body);
    assert.match(r.reason, /first candidate: /, body);
    assert.equal(r.source, 'description', body);
  }
});

test('the newest document with scope supplies the refusal', () => {
  const r = evaluateVerifiability('VERIFY: node -e "1"', ['chat', 'VERIFY: grep -q x .github/workflows/a.yml']);
  assert.equal(r.source, 'comment:1');
  assert.match(r.reason, /grep -q x/);
});

test('no scope anywhere still reports no-section (original message kept)', () => {
  const r = evaluateVerifiability('prose', ['prose']);
  assert.equal(r.kind, 'no-section');
  assert.match(r.reason, NO_SECTION);
});
