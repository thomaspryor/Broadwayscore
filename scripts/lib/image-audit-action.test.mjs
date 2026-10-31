/**
 * image-audit-action.test.mjs
 *
 * The audit ladder can DELETE a live thumbnail, so it gets direct tests.
 *
 * Regression locked down (2026-08-02): audit-images-llm.js adopted the shared
 * market-aware prompt from lib/verify-image.js, which rejects production photos
 * (match:false, imageType:"production_still"). This auditor turns match:false +
 * high confidence into DELETE — so the unguarded adoption would have started
 * auto-deleting every legitimate production-still thumbnail on the site.
 *
 * These call the REAL decideImageAuditAction (CLAUDE.md §15), and each one FAILS
 * if the carve-out is reverted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideImageAuditAction, isProductionStillOnly } = require('./image-audit-action.js');

const productionStill = {
  match: false, confidence: 'high', imageType: 'production_still',
  issues: ['production_photo'], description: 'actors mid-performance',
};

test('a production-still-only rejection is NEVER deleted', () => {
  const { action, reason } = decideImageAuditAction(productionStill, null);
  assert.notEqual(action, 'delete', 'production still would be auto-deleted');
  assert.equal(action, 'needs_review');
  assert.match(reason, /production_still/);
});

test('production-still survives even inside a cross-contamination group', () => {
  // The cross-contam branch also deletes on match === false; match:null must
  // make the production-still case inert there too.
  const { action } = decideImageAuditAction(productionStill, { sharedWith: ['other-show-2024'] });
  assert.notEqual(action, 'delete', 'cross-contam branch re-deleted a production still');
});

test('a genuinely wrong image IS still deleted (carve-out is not a blanket amnesty)', () => {
  const wrongShow = {
    match: false, confidence: 'high', imageType: 'promotional_art',
    issues: ['wrong_show'], description: 'poster for a different show',
  };
  const { action, reason } = decideImageAuditAction(wrongShow, null);
  assert.equal(action, 'delete');
  assert.match(reason, /wrong_show/);
});

test('a production still that is ALSO flagged wrong_show is not amnestied', () => {
  const both = { ...productionStill, issues: ['production_photo', 'wrong_show'] };
  assert.equal(isProductionStillOnly(both), false);
  assert.equal(decideImageAuditAction(both, null).action, 'delete');
});

test('unchanged paths: api error, medium/low confidence, correct image', () => {
  assert.equal(decideImageAuditAction({ match: null, confidence: 'error', issues: ['api_error'] }, null).action, 'needs_review');
  assert.equal(decideImageAuditAction({ match: false, confidence: 'medium', imageType: 'other', issues: [] }, null).action, 'needs_review');
  assert.equal(decideImageAuditAction({ match: false, confidence: 'low', imageType: 'other', issues: [] }, null).action, 'needs_review');
  assert.equal(decideImageAuditAction({ match: true, confidence: 'high', imageType: 'promotional_art', issues: [] }, null).action, 'keep');
});
