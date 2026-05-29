// Unit tests for the BSC Daily digest "OB Discovery — Action Needed" section.
// Requires the real renderer from scripts/health-check.js (CLAUDE.md §15 — no
// copied logic). Guards the acceptance criterion: a week with >=1 staged
// candidate (or a typo-rejection) renders a visible line naming the promoter
// command; a zero week stays silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildObCandidatesHtml } = require('../../scripts/health-check.js');

test('zero week stays silent', () => {
  assert.equal(buildObCandidatesHtml([], 0), '');
  assert.equal(buildObCandidatesHtml(null, null), '');
  assert.equal(buildObCandidatesHtml(undefined, undefined), '');
});

test('staged candidates render heading + promoter command + list', () => {
  const html = buildObCandidatesHtml(
    [{ title: 'Broken Snow', venue: 'Theatre 71', source: 'playbill-verdict' }],
    0
  );
  assert.match(html, /OB Discovery — Action Needed/);
  assert.match(html, /1 OB candidate /);
  assert.match(html, /promote-ob-venue-candidates\.js --dry-run/);
  assert.match(html, /Broken Snow/);
  assert.match(html, /Theatre 71/);
});

test('count is pluralized and capped at 5 listed', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ title: `Show ${i}`, venue: 'V', source: 'bww-roundup' }));
  const html = buildObCandidatesHtml(many, 0);
  assert.match(html, /7 OB candidates /);
  // Only the first 5 titles are listed.
  assert.match(html, /Show 4/);
  assert.doesNotMatch(html, /Show 5/);
});

test('typo-only week surfaces a fix line without a phantom staged line', () => {
  const html = buildObCandidatesHtml([], 2);
  assert.match(html, /OB Discovery — Action Needed/);
  assert.match(html, /2 aggregator slug typos need a source fix/);
  assert.doesNotMatch(html, /staged for review/);
});

test('single typo is singular', () => {
  const html = buildObCandidatesHtml([], 1);
  assert.match(html, /1 aggregator slug typo needs a source fix/);
});
