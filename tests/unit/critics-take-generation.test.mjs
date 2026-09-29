/**
 * BRO-927 — Critics' Take not auto-generated on opening night, falls back to
 * synopsis. Fear of 13 had 21 scored reviews live but no Critics' Take; the
 * show page substituted its (unrelated) documentary synopsis in the verdict
 * slot.
 *
 * Covers the two halves of the fix:
 *  1. getCriticsTakeDisplayMode() (scripts/lib/critics-take-display.js) — the
 *     show page's decision function. Once a show clears the review-count
 *     floor, a missing consensus must render "coming soon", never silently
 *     fall back to the synopsis.
 *  2. The opening-night-poller.yml fast path now dispatches
 *     update-critic-consensus.yml --show=X per polled show after the inline
 *     rebuild — the orchestrator's fast path never went through
 *     rebuild-reviews.yml, the only place that previously auto-dispatched
 *     that workflow. Dispatch (not an inline generate-critic-consensus.js
 *     call) deliberately preserves critic-consensus.json's single-writer
 *     invariant (scripts/lib/core-data-merge-registry.js) — this fast path
 *     runs on a ~15-min cycle for both markets concurrently on a live
 *     opening night, so an inline write here would race concurrent BW/WE
 *     poller pushes with no reconciliation.
 *
 * Run: node --test tests/unit/critics-take-generation.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { getCriticsTakeDisplayMode, REVIEW_COUNT_FLOOR } = require('../../scripts/lib/critics-take-display.js');

describe('getCriticsTakeDisplayMode', () => {
  it('consensus present + criticScore present → consensus', () => {
    assert.equal(getCriticsTakeDisplayMode(true, true, 21, true), 'consensus');
  });

  it('no consensus, review count above the floor → coming-soon (never the synopsis)', () => {
    // The Fear of 13 case: 21 scored reviews, no generated take.
    assert.equal(getCriticsTakeDisplayMode(false, true, 21, true), 'coming-soon');
  });

  it('no consensus, review count exactly at the floor → coming-soon (acceptance criteria: "5 or more")', () => {
    assert.equal(getCriticsTakeDisplayMode(false, true, REVIEW_COUNT_FLOOR, true), 'coming-soon');
  });

  it('no consensus, review count just below the floor with a synopsis → synopsis', () => {
    assert.equal(getCriticsTakeDisplayMode(false, false, REVIEW_COUNT_FLOOR - 1, true), 'synopsis');
    assert.equal(getCriticsTakeDisplayMode(false, false, 0, true), 'synopsis');
  });

  it('no consensus, below the floor, no synopsis → none', () => {
    assert.equal(getCriticsTakeDisplayMode(false, false, 0, false), 'none');
  });

  it('consensus text exists but criticScore is missing → does not render as consensus', () => {
    // consensus.text without show.criticScore is a data-consistency gap, not
    // a real verdict — mirrors the `consensus && show.criticScore` guard the
    // show page used before this fix.
    assert.equal(getCriticsTakeDisplayMode(true, false, 21, true), 'coming-soon');
  });
});

describe('opening-night-poller.yml fast path dispatches update-critic-consensus.yml', () => {
  const workflowPath = path.join(__dirname, '../../.github/workflows/opening-night-poller.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  it('has a Critics\' Take generation step gated on the fast_path rebuild succeeding', () => {
    assert.match(workflow, /Generate Critics' Take \(fast_path\)/);
  });

  it('dispatches update-critic-consensus.yml per polled show, not an inline generator call', () => {
    assert.match(workflow, /gh workflow run update-critic-consensus\.yml -f show="\$SHOW_ID"/);
    // Must NOT call the generator script directly from this job — that would
    // write data/critic-consensus.json outside its registered single writer.
    assert.doesNotMatch(workflow, /node scripts\/generate-critic-consensus\.js/);
  });

  it('the new step runs before the fast_path push to the private data repo', () => {
    const genIdx = workflow.indexOf("Generate Critics' Take (fast_path)");
    const pushIdx = workflow.indexOf('Push core data to private repo (fast_path)');
    assert.ok(genIdx > -1, 'generation step must exist');
    assert.ok(pushIdx > -1, 'push step must exist');
    assert.ok(genIdx < pushIdx, 'dispatch must be queued before this job pushes core data');
  });
});

describe('critic-consensus.json single-writer invariant', () => {
  it('is still registered single-writer (dispatch approach must not need to flip this)', () => {
    const registryPath = path.join(__dirname, '../../scripts/lib/core-data-merge-registry.js');
    const registry = fs.readFileSync(registryPath, 'utf8');
    assert.match(registry, /file: 'critic-consensus\.json'.*status: 'single-writer'/s);
  });
});
