// BRO-6695 (The Moth, 2026-10-30): gap-audit ingests reached prod 53 min after
// ingest (bar 30) because the job held the files to its last step and then ran
// the full 17-min rebuild -> scoring -> rebuild -> deploy chain. These tests pin
// the fast path: helper behaviour + the workflow wiring that uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newShowIdsFromPaths, fastPublish } = require('./gap-ingest-fast-path.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('newShowIdsFromPaths: show dirs only, unique, skips _pending and non-json', () => {
  const ids = newShowIdsFromPaths([
    'the-moth-off-west-end-2026/fringereview--unknown.json',
    'the-moth-off-west-end-2026/londonpubtheatres--katie-walker-cook.json',
    '_pending/foo--bar.json',
    'README.md',
    'other-show-2026/nested/x.json',
    'other-show-2026/a--b.json',
    '',
  ]);
  assert.deepEqual(ids, ['other-show-2026', 'the-moth-off-west-end-2026']);
});

test('fastPublish: dispatches urgent shows through the per-show lane, all handled', async () => {
  const calls = [];
  const r = await fastPublish({
    showIds: ['the-moth-off-west-end-2026'],
    urgentIds: new Set(['the-moth-off-west-end-2026']),
    dispatch: async (id, opts) => { calls.push([id, opts]); return { ok: true }; },
  });
  assert.deepEqual(calls, [['the-moth-off-west-end-2026', { reason: 'gap-ingest' }]]);
  assert.equal(r.allHandled, true);
});

test('fastPublish: non-urgent or failed shows leave the slow rebuild trigger in charge', async () => {
  const urgentIds = new Set(['hot-2026']);
  const ok = async () => ({ ok: true });
  const mixed = await fastPublish({ showIds: ['hot-2026', 'cold-2017'], urgentIds, dispatch: ok });
  assert.deepEqual(mixed.dispatched, ['hot-2026']);
  assert.deepEqual(mixed.notUrgent, ['cold-2017']);
  assert.equal(mixed.allHandled, false);
  const failed = await fastPublish({ showIds: ['hot-2026'], urgentIds, dispatch: async () => ({ ok: false, error: 'no-token' }) });
  assert.deepEqual(failed.failed, ['hot-2026']);
  assert.equal(failed.allHandled, false);
  const thrown = await fastPublish({ showIds: ['hot-2026'], urgentIds, dispatch: async () => { throw new Error('boom'); } });
  assert.equal(thrown.allHandled, false);
  const none = await fastPublish({ showIds: [], urgentIds, dispatch: ok });
  assert.equal(none.allHandled, false);
});

test('audit-aggregator-gap.yml publishes ingests right after the ingest step', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/audit-aggregator-gap.yml'), 'utf8');
  const ingest = wf.indexOf('- name: Run gap audit');
  const fast = wf.indexOf('- name: Fast-publish ingested reviews');
  const firstReport = wf.indexOf('- name: Stateless coverage-candidate report');
  assert.ok(ingest > 0 && fast > ingest && fast < firstReport,
    'fast-publish step must sit between "Run gap audit" and the slow reporting steps');
  const block = wf.slice(fast, firstReport);
  assert.match(block, /uses: \.\/\.github\/actions\/push-review-texts/);
  assert.match(block, /gap-ingest-fast-path\.js/);
  assert.match(block, /BEFORE_SHA: \$\{\{ steps\.rt_before\.outputs\.sha \}\}/);
  const trigger = wf.slice(wf.indexOf('- name: Trigger rebuild if review-texts changed'));
  assert.match(trigger.split('run:')[0], /steps\.fast_publish\.outputs\.all_handled != 'true'/,
    'full rebuild must be skipped only when every new show was fast-dispatched');
});
