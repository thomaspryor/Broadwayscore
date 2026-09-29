import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  classifyHealthCheck, splitHealthByAudience, categoryOf, INTERNAL_WORKFLOWS,
} = require('./digest-audience.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');

// The real rows from the 2026-09-24 digest the owner complained about.
const INTERNAL_2026_09_24 = [
  'Main: red streak', 'Main: green rate', 'Push-retry deadman',
  'Autofix: throughput (dispatched/passed, daily)', 'Autofix: daily canary (dispatch pipeline proof)',
  'Infra: worktree GC log stale', 'Infra: notion-schedule-coupling audit',
  'Stuck work: paused P0/P1 cards', 'Stuck work: orphaned in-progress cards', 'Stuck work: paused P2/other cards',
  'Infra-review: gate telemetry', 'Dispatch outcomes: abandoned',
  'Dispatch health: dead-launch rate (unmeasurable here)', 'Headless dispatch: success rate (unmeasurable here)',
  'cmux socket: reachability (unmeasurable here)', 'Digest: content-invariant check',
  'Cron failed: Test Suite',
  // Folded into health.errors locally by send-morning-digest.js main().
  'Dispatch: board targeting',
];
const VISITORS_2026_09_24 = [
  'Data: reviewed shows missing from shows.json', 'Audience coverage: open-show gaps',
  'Sync: social-pulse per-show freshness', 'Sync: baseline drift',
  'Quality: star-vs-score mismatch', 'Quality: corpus drift', 'Quality: DMARC deliverability', 'Quality: outlet domain moves',
  'Data quality: cross-outlet attribution drift', 'Data quality: missed opening-night broadcasts',
  'Coverage: SERP census recall', 'Coverage: adversarial probe',
  'Data: OB closing candidates awaiting review', 'Commercial model drift', 'SEO: health',
  'Feedback: needs-manual-review backlog', 'Data: T1/T2 silent review gaps', 'Data: uncollected live review strands',
];

test('classifyHealthCheck: every internal row from the 2026-09-24 digest is internal', () => {
  for (const n of INTERNAL_2026_09_24) assert.equal(classifyHealthCheck(n), 'internal', n);
});

test('classifyHealthCheck: every visitor-facing row from the 2026-09-24 digest stays visitors', () => {
  for (const n of VISITORS_2026_09_24) assert.equal(classifyHealthCheck(n), 'visitors', n);
});

test('classifyHealthCheck: unknown / empty / renamed checks fail SAFE to visitors', () => {
  for (const n of ['Brand new check: something', 'Totally unknown', '', null, undefined, 'Deploy: production freshness', 'Secrets: health']) {
    assert.equal(classifyHealthCheck(n), 'visitors', String(n));
  }
});

test('classifyHealthCheck: workflow rows classify by the workflow, not the "Cron failed" prefix', () => {
  assert.equal(classifyHealthCheck('Cron failed: Test Suite'), 'internal');
  assert.equal(classifyHealthCheck('Workflow repeat-failure: Land'), 'internal');
  assert.equal(classifyHealthCheck('Cron failed: Deploy to Vercel'), 'visitors');
  assert.equal(classifyHealthCheck('Workflow repeat-failure: Collect Review Texts'), 'visitors');
  assert.equal(classifyHealthCheck('Cron: Update Show Status'), 'visitors');
  // Tests that exercise the LIVE site's features are visitor-facing.
  assert.equal(classifyHealthCheck('Cron failed: Test UGC Features'), 'visitors');
});

test('classifyHealthCheck: exact internal names in a visitor category', () => {
  assert.equal(classifyHealthCheck('Data: undispatchable backlog cards'), 'internal');
  assert.equal(classifyHealthCheck('Data: cards the drain cannot finish unattended'), 'internal');
  assert.equal(classifyHealthCheck('Data: live show with zero critic reviews on site'), 'visitors');
});

test('classifyHealthCheck accepts a row object', () => {
  assert.equal(classifyHealthCheck({ name: 'Main: red streak', message: 'x' }), 'internal');
  assert.equal(classifyHealthCheck({ message: 'nameless' }), 'visitors');
});

test('categoryOf splits on the first colon', () => {
  assert.equal(categoryOf('Quality: corpus drift'), 'Quality');
  assert.equal(categoryOf('Push-retry deadman'), 'Push-retry deadman');
});

test('splitHealthByAudience buckets errors and warns, tolerating strings and nulls', () => {
  const s = splitHealthByAudience({
    errors: [{ name: 'Main: red streak' }, { name: 'Data: reviewed shows missing from shows.json' }, null],
    warns: ['SEO: health', 'Stuck work: paused P0/P1 cards'],
  });
  assert.deepEqual(s.visitors.errors.map(r => r.name), ['Data: reviewed shows missing from shows.json']);
  assert.deepEqual(s.internal.errors.map(r => r.name), ['Main: red streak']);
  assert.deepEqual(s.visitors.warns.map(r => r.name), ['SEO: health']);
  assert.deepEqual(s.internal.warns.map(r => r.name), ['Stuck work: paused P0/P1 cards']);
  assert.deepEqual(splitHealthByAudience(null).visitors.errors, []);
});

// Drift guard: an INTERNAL_WORKFLOWS entry that no longer matches a real
// workflow name silently stops classifying (renamed workflow -> visitors,
// which is the safe direction, but the list should not rot).
test('INTERNAL_WORKFLOWS: every entry is a real workflow name in .github/workflows', () => {
  const dir = path.join(REPO, '.github', 'workflows');
  const names = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const m = /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (m) names.add(m[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  for (const wf of INTERNAL_WORKFLOWS) assert.ok(names.has(wf), `"${wf}" is not a workflow name`);
});
