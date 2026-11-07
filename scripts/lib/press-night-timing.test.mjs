// BRO-6695 (The Moth, 2026-10-30): gap-audit ingests reached prod 53 min after
// ingest (bar 30) because the job held the files to its last step and then ran
// the full 17-min rebuild -> scoring -> rebuild -> deploy chain. These tests pin
// the fast path: helper behaviour + the workflow wiring that uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newShowIdsFromPaths, fastPublish, listAddedPaths } = require('./gap-ingest-fast-path.js');
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

test('fastPublish: dispatches urgent shows through the per-show lane', async () => {
  const calls = [];
  const r = await fastPublish({
    showIds: ['the-moth-off-west-end-2026'],
    urgentIds: new Set(['the-moth-off-west-end-2026']),
    dispatch: async (id, opts) => { calls.push([id, opts]); return { ok: true }; },
  });
  assert.deepEqual(calls, [['the-moth-off-west-end-2026', { reason: 'verify-all-scored' }]]);
  assert.deepEqual(r.dispatched, ['the-moth-off-west-end-2026']);
});

test('fastPublish: non-urgent, failed and thrown dispatches are reported, never raised', async () => {
  const urgentIds = new Set(['hot-2026']);
  const ok = async () => ({ ok: true });
  const mixed = await fastPublish({ showIds: ['hot-2026', 'cold-2017'], urgentIds, dispatch: ok });
  assert.deepEqual(mixed.dispatched, ['hot-2026']);
  assert.deepEqual(mixed.notUrgent, ['cold-2017']);
  const failed = await fastPublish({ showIds: ['hot-2026'], urgentIds, dispatch: async () => ({ ok: false, error: 'no-token' }) });
  assert.deepEqual(failed.failed, ['hot-2026']);
  const thrown = await fastPublish({ showIds: ['hot-2026'], urgentIds, dispatch: async () => { throw new Error('boom'); } });
  assert.deepEqual(thrown.failed, ['hot-2026']);
});

test('fastPublish: caps dispatches per run', async () => {
  const ids = ['a', 'b', 'c', 'd'];
  const r = await fastPublish({ showIds: ids, urgentIds: new Set(ids), dispatch: async () => ({ ok: true }), max: 2 });
  assert.deepEqual(r.dispatched, ['a', 'b']);
  assert.deepEqual(r.deferred, ['c', 'd']);
  assert.deepEqual(r.notUrgent, []);
});

test('fastPublish shares the verify-all-scored concurrency lane (no parallel double scoring)', async () => {
  const seen = [];
  await fastPublish({ showIds: ['a'], urgentIds: new Set(['a']), dispatch: async (id, o) => { seen.push(o.reason); return { ok: true }; } });
  assert.deepEqual(seen, ['verify-all-scored']);
});

test('listAddedPaths: new files only, other writers\' edits to existing files are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapfp-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'old-show'));
  fs.writeFileSync(path.join(dir, 'old-show', 'a--b.json'), '{}');
  git('add', '-A'); git('commit', '-qm', 'base');
  const before = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'old-show', 'a--b.json'), '{"edited":1}');
  fs.mkdirSync(path.join(dir, 'the-moth'));
  fs.writeFileSync(path.join(dir, 'the-moth', 'fringereview--unknown.json'), '{}');
  git('add', '-A'); git('commit', '-qm', 'ingest');
  assert.deepEqual(newShowIdsFromPaths(listAddedPaths(dir, before)), ['the-moth']);
});

test('audit-aggregator-gap.yml publishes ingests right after the ingest step', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/audit-aggregator-gap.yml'), 'utf8');
  const ingest = wf.indexOf('- name: Run gap audit');
  const fast = wf.indexOf('- name: Push ingested review-texts now (fast path)');
  const firstReport = wf.indexOf('- name: Stateless coverage-candidate report');
  assert.ok(ingest > 0 && fast > ingest && fast < firstReport,
    'fast-publish step must sit between "Run gap audit" and the slow reporting steps');
  const block = wf.slice(fast, firstReport);
  assert.match(block, /GAP_FAST_PUBLISH_DISABLED/, 'kill switch');
  assert.match(block, /uses: \.\/\.github\/actions\/push-review-texts/);
  assert.match(block, /gap-ingest-fast-path\.js/);
  assert.match(block, /BEFORE_SHA: \$\{\{ steps\.rt_before\.outputs\.sha \}\}/);
  assert.match(block, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, 'dispatchRescore needs GITHUB_TOKEN');
  assert.match(block, /steps\.fast_push\.outputs\.pushed == 'true'/, 'dispatch only after the files are on the remote');
  const trigger = wf.slice(wf.indexOf('- name: Trigger rebuild if review-texts changed')).split('run:')[0];
  assert.doesNotMatch(trigger, /fast_publish|fast_push/,
    'the full-rebuild trigger stays unconditional: stubs/back-catalogue still need it');
});
