import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PROJECTS, projectOf, buildAutoTitle, stripAutoPrefix, AUTO_GLYPH, modelGlyph } = require('./workspace-naming.js');

test('projectOf: tag-based inference wins over category', () => {
  assert.equal(projectOf({ tags: 'commercial, data-quality', category: 'Product' }), 'Biz');
  assert.equal(projectOf({ tags: 'infra, ci-infrastructure', category: 'Admin' }), 'Infra');
  assert.equal(projectOf({ tags: 'scraping, bww', category: 'Product' }), 'Data');
  assert.equal(projectOf({ tags: 'friction, rage-click', category: 'Product' }), 'Site');
  assert.equal(projectOf({ tags: 'autonomous-loop, opening-night' }), 'Loop');
});

test('projectOf: falls back to category default when no tag matches', () => {
  assert.equal(projectOf({ tags: 'opening-night', category: 'Admin' }), 'Infra');
  assert.equal(projectOf({ tags: 'opening-night', category: 'Marketing' }), 'Biz');
  assert.equal(projectOf({ tags: 'opening-night', category: 'Product' }), 'Data');
});

test('projectOf: falls back to Data when nothing matches at all', () => {
  assert.equal(projectOf({}), 'Data');
  assert.equal(projectOf({ tags: 'mystery-tag', category: 'UnknownCategory' }), 'Data');
});

test('projectOf: subject text alone can trigger a match (no tags/category)', () => {
  assert.equal(projectOf({ subject: 'Rage clicks on Hamilton show page' }), 'Site');
});

// Real card #52 (2026-07-14): tags "commercial, data-integrity,
// ci-infrastructure, incident" span 3 buckets — Infra wins per-tag scoring
// (1 point each for Biz/Infra/Data, Infra ranked first on tie) rather than
// the single-haystack-regex version, which non-deterministically favored
// whichever rule happened to be listed first and picked Biz for a P0 CI
// pipeline incident.
test('projectOf: per-tag scoring resolves a multi-bucket tag set to the tie-priority winner, not first-match-in-string', () => {
  assert.equal(projectOf({ tags: 'commercial, data-integrity, ci-infrastructure, incident', category: 'Product' }), 'Infra');
});

test('buildAutoTitle: emoji + project + middle dot + 50-char subject slice', () => {
  const t = buildAutoTitle({ subject: 'Fix the thing', project: 'Data' });
  assert.equal(t, `${AUTO_GLYPH} Data·Fix the thing`);
});

test('buildAutoTitle: truncates subject to 50 chars, matching bsc-next.js convention', () => {
  const long = 'A'.repeat(80);
  const t = buildAutoTitle({ subject: long, project: 'Infra' });
  assert.equal(t, `${AUTO_GLYPH} Infra·${'A'.repeat(50)}`);
});

test('stripAutoPrefix: removes a leading "<Project>·" once the emoji/glyphs are already gone', () => {
  for (const p of PROJECTS) {
    assert.equal(stripAutoPrefix(`${p}·Fix the thing`), 'Fix the thing');
  }
});

test('stripAutoPrefix: leaves non-prefixed titles untouched', () => {
  assert.equal(stripAutoPrefix('Fix the thing'), 'Fix the thing');
  assert.equal(stripAutoPrefix('[Lost Boys postmortem] Issue #1'), '[Lost Boys postmortem] Issue #1');
});

test('stripAutoPrefix: does not false-positive on a subject that merely starts with a project word', () => {
  // "Data" without the middle dot must NOT be stripped — avoids eating real content.
  assert.equal(stripAutoPrefix('Data integrity sweep'), 'Data integrity sweep');
});

test('modelGlyph: maps each model family; unknown/empty -> no glyph', () => {
  assert.equal(modelGlyph('claude-fable-5'), '🧠');
  assert.equal(modelGlyph('claude-fable-5[1m]'), '🧠');
  assert.equal(modelGlyph('opus'), '🔮');
  assert.equal(modelGlyph('claude-sonnet-5'), '⚡');
  assert.equal(modelGlyph('claude-haiku-4-5-20251001'), '🪶');
  assert.equal(modelGlyph('gpt-4o'), '');
  assert.equal(modelGlyph(null), '');
});

test('buildAutoTitle: model glyph rides next to the auto glyph and stays matcher-invisible', () => {
  const t = buildAutoTitle({ subject: 'Fix the thing', project: 'Data', model: 'sonnet' });
  assert.equal(t, `${AUTO_GLYPH}⚡ Data·Fix the thing`);
  // The exact strip both matchers apply (leading non-letter/digit, '[' kept):
  const cleaned = t.replace(/^[^\p{L}\p{N}[]+/u, '');
  assert.equal(stripAutoPrefix(cleaned), 'Fix the thing');
});

test('buildAutoTitle: omitted model keeps the pre-glyph title byte-for-byte', () => {
  assert.equal(buildAutoTitle({ subject: 'Fix the thing', project: 'Data' }),
    `${AUTO_GLYPH} Data·Fix the thing`);
});
