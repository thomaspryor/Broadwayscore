/**
 * BRO-7747: a press-night review goes ingest -> score -> rebuild-fast -> deploy
 * with no hand step. Locks the three links that broke on 2026-11-17:
 *  1. scoring picks rebuild-fast.yml for an urgent show even without fast_rebuild
 *  2. ingest dispatches scoring with fast_rebuild=true and no parallel slow rebuild
 *  3. rebuild-reviews.yml and the poller fast_path restore the fingerprint memo
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { pickRebuildTarget } = require('../../scripts/lib/rebuild-target.js');
const { downstreamWorkflows } = require('../../scripts/lib/ingest-downstream.js');
const { dispatchDownstream } = require('../../scripts/lib/land-ingested-reviews.js');
const wf = (f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');

test('pickRebuildTarget: fast_rebuild input wins', () => {
  assert.equal(pickRebuildTarget({ fastRebuild: 'true', showIds: 'x' }).workflow, 'rebuild-fast.yml');
  assert.equal(pickRebuildTarget({ fastRebuild: true }).workflow, 'rebuild-fast.yml');
});

test('pickRebuildTarget: an urgent show in the list takes the fast lane', () => {
  const isUrgent = (id) => id === 'pn-2026';
  assert.equal(pickRebuildTarget({ fastRebuild: 'false', showIds: 'old-2015,pn-2026', isUrgent }).workflow, 'rebuild-fast.yml');
  assert.deepEqual(pickRebuildTarget({ showIds: 'pn-2026', isUrgent }).urgentShows, ['pn-2026']);
});

test('pickRebuildTarget: no show, non-urgent show, or a throwing check keeps the full rebuild', () => {
  assert.equal(pickRebuildTarget({ showIds: '', isUrgent: () => true }).workflow, 'rebuild-reviews.yml');
  assert.equal(pickRebuildTarget({ showIds: 'old-2015', isUrgent: () => false }).workflow, 'rebuild-reviews.yml');
  assert.equal(pickRebuildTarget({ showIds: 'x', isUrgent: () => { throw new Error('no data'); } }).workflow, 'rebuild-reviews.yml');
});

test('downstreamWorkflows: urgent = scoring with fast_rebuild, no parallel rebuild-reviews', () => {
  const urgent = downstreamWorkflows('pn-2026', 1, { urgent: true });
  assert.deepEqual(urgent.map((w) => w.file), ['llm-ensemble-score.yml']);
  assert.match(urgent[0].args, /-f show_id=pn-2026 -f fast_rebuild=true/);
  const normal = downstreamWorkflows('old-2015', 2);
  assert.deepEqual(normal.map((w) => w.file), ['llm-ensemble-score.yml', 'rebuild-reviews.yml']);
  assert.doesNotMatch(normal[0].args, /fast_rebuild/);
});

test('dispatchDownstream: an urgent show dispatches only the fast scoring run', () => {
  const calls = [];
  const exec = (cmd) => { calls.push(cmd); return ''; };
  dispatchDownstream({ showId: 'pn-2026', newReviews: 1, exec, log: () => {}, capCheck: null, urgent: () => true });
  assert.deepEqual(calls, ['gh workflow run llm-ensemble-score.yml -f show_id=pn-2026 -f fast_rebuild=true']);
  calls.length = 0;
  dispatchDownstream({ showId: 'old-2015', newReviews: 1, exec, log: () => {}, capCheck: null, urgent: () => false });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /rebuild-reviews\.yml/);
});

test('llm-ensemble-score.yml auto-trigger asks rebuild-target.js, with inputs passed through env', () => {
  const y = wf('llm-ensemble-score.yml');
  const step = y.slice(y.indexOf('- name: Auto-trigger rebuild for non-chain runs'));
  const body = step.slice(0, step.indexOf('\n      - name:', 10));
  assert.match(body, /node scripts\/lib\/rebuild-target\.js/);
  assert.match(body, /SHOW_IDS: \$\{\{ github\.event\.inputs\.show_id \}\}/);
  assert.match(body, /\$TARGET_WF" = "rebuild-fast\.yml"/);
});

test('llm-ensemble-score.yml starts npm ci before the data checkouts and waits for it', () => {
  const y = wf('llm-ensemble-score.yml');
  const start = y.indexOf('- name: Start npm ci in the background');
  assert.ok(start > 0);
  assert.ok(start < y.indexOf('- name: Checkout review-texts (private repo)'));
  assert.ok(y.indexOf('- name: Install dependencies') > y.indexOf('- name: Checkout review-texts (private repo)'));
  assert.ok(y.indexOf('- name: Setup Node.js') < start);
});

test('rebuild-reviews.yml and the poller fast_path restore the fingerprint memo before rebuilding', () => {
  const r = wf('rebuild-reviews.yml');
  assert.ok(r.indexOf('- name: Restore fingerprint memo') > 0);
  assert.ok(r.indexOf('- name: Restore fingerprint memo') < r.indexOf('- name: Rebuild reviews.json\n'));
  assert.match(r, /- name: Save fingerprint memo/);
  const p = wf('opening-night-poller.yml');
  const restore = p.indexOf('- name: Restore fingerprint memo (fast_path)');
  assert.ok(restore > 0 && restore < p.indexOf('- name: Rebuild reviews.json (fast_path)'));
  assert.doesNotMatch(p, /actions\/cache\/save@[^\n]*\n[^\n]*\n\s*path: \.cache\/rebuild-fp-cache\.json/);
  for (const y of [r, p]) assert.match(y, /rebuild-fp-memo-v1-\$\{\{ hashFiles\('scripts\/lib\/text-cleaning\.js'/);
});

test('pickRebuildTarget: a plain backlog run (urgent shows only) takes the fast lane', () => {
  assert.equal(pickRebuildTarget({ showIds: '', onlyUrgent: 'true' }).workflow, 'rebuild-fast.yml');
  assert.equal(pickRebuildTarget({ showIds: '', onlyUrgent: 'false' }).workflow, 'rebuild-reviews.yml');
});

test('llm-ensemble-score.yml: a press-night run that skipped the auto-trigger still dispatches rebuild-fast (always())', () => {
  const y = wf('llm-ensemble-score.yml');
  const at = y.indexOf('- name: Fallback fast rebuild for press-night runs');
  assert.ok(at > y.indexOf('- name: Auto-trigger rebuild for non-chain runs'));
  const step = y.slice(at, y.indexOf('\n      - name:', at + 10));
  assert.match(step, /if: \$\{\{ always\(\) && !cancelled\(\)/);
  assert.match(step, /steps\.auto_rebuild\.outcome != 'success'/);
  // A dispatch that failed inside the auto-trigger (it does not fail the step) still gets the fallback.
  assert.match(step, /steps\.auto_rebuild\.outputs\.fast_dispatched != 'true'/);
  assert.match(y, /echo "fast_dispatched=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(step, /github\.event\.inputs\.show_id != ''/);
  // A no-op rescore (dispatch-rescore.js always sends fast_rebuild=true) must not start a rebuild.
  assert.match(step, /github\.event\.inputs\.rescore_reason == ''/);
  assert.doesNotMatch(step, /^\s+FAST_REBUILD:/m);
  assert.match(step, /node scripts\/lib\/rebuild-target\.js/);
  assert.match(step, /dispatch_with_retry rebuild-fast\.yml/);
  assert.match(y, /- name: Auto-trigger rebuild for non-chain runs\n\s+id: auto_rebuild/);
});
