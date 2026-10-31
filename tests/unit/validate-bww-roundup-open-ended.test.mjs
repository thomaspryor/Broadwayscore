// A show with no recorded openingDate anchors the roundup year check on its
// first preview. Press night can come many months later (repertory shows:
// mas-sabe-el-saulo-por-viejo, previews since 2025-12-19), so with
// openEnded the "published after opening" limit is 18 months, not 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateBWWRoundupYear } = require('../../scripts/gather-reviews.js');

const ld = (iso) => `<script type="application/ld+json">{"datePublished":"${iso}"}</script>`;
const reviews = [{ outlet: 'BroadwayWorld' }];

test('open-ended: roundup 10 months after first preview is kept', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-10-05T12:00:00Z'), '2025-12-19', 's', 'u', { openEnded: true }).length, 1);
});

test('recorded opening: roundup 10 months after opening is still rejected', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-10-05T12:00:00Z'), '2025-12-19', 's', 'u').length, 0);
});

test('open-ended: a much later production (2+ years on) is still rejected', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2026-09-01T12:00:00Z'), '2024-01-06', 's', 'u', { openEnded: true }).length, 0);
});

test('open-ended: an older production roundup is still rejected', () => {
  assert.equal(validateBWWRoundupYear(reviews, ld('2013-05-01T12:00:00Z'), '2025-12-19', 's', 'u', { openEnded: true }).length, 0);
});
