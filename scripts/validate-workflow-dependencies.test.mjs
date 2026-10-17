// BRO-934: dependency-graph validation. `node --test scripts/validate-workflow-dependencies.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = path.join(root, '.github', 'workflows');
const g = require('./lib/workflow-dependency-graph.js');
const freeze = require('./lib/automation-freeze.js');
const { render, fingerprint } = require('./generate-workflow-dependencies.js');

const workflows = g.loadWorkflows(WF_DIR);
const files = new Set(workflows.map((w) => w.file));
const { edges, unresolved } = g.buildGraph(workflows);

// Cross-repo writers allowed to have no concurrency block. Add a reason, never a bare entry.
// One violation per line as the assertion message. The merged-tree floor
// treats this file as an aggregate guard and compares message lines, and
// deepEqual's own diff is cut off there, so without this a NEW violation in
// an already-failing check reads as pre-existing (BRO-4812 review).
const violations = (list) => list.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');

const NO_CONCURRENCY_OK = {
  'opening-night-orchestrator.yml': 'BW + WE orchestrators must run in parallel; serialized externally via wait-for-run.sh per poller',
};

test('DEPENDENCIES.md covers the current graph (edges + cross-repo writers): run scripts/generate-workflow-dependencies.js', () => {
  const cur = fs.readFileSync(path.join(WF_DIR, 'DEPENDENCIES.md'), 'utf8');
  const m = cur.match(/graph-fingerprint: ([0-9a-f]+)/);
  assert.ok(m, 'fingerprint line missing');
  // Both fingerprints in the message (BRO-4812): the merged-tree floor
  // compares failure payloads for this aggregate guard, so on an already
  // stale main a branch that drifts the graph FURTHER reads as new.
  const actual = fingerprint(workflows);
  assert.ok(m[1] === actual, `DEPENDENCIES.md stale: committed fingerprint ${m[1]}, current graph ${actual}`);
});

test('generator renders deterministically', () => {
  assert.equal(render(workflows), render(workflows));
});

test('every workflow file is valid YAML (the regex parser would otherwise read a broken file happily)', () => {
  const yaml = require('js-yaml');
  const bad = [];
  for (const f of files) {
    try { yaml.load(fs.readFileSync(path.join(WF_DIR, f), 'utf8')); } catch (e) { bad.push(`${f}: ${e.reason}`); }
  }
  assert.deepEqual(bad, [], violations(bad));
});

test('every workflow_run trigger names a workflow that exists (a typo means the trigger never fires)', () => {
  assert.deepEqual(unresolved, [], violations(unresolved));
});

test('every explicit dispatch targets an existing workflow file', () => {
  const missing = edges.filter((e) => e.via === 'dispatch' && !files.has(e.to)).map((e) => `${e.from} -> ${e.to}`);
  assert.deepEqual(missing, [], violations(missing));
});

test('every workflow that pushes to a private repo has a concurrency group', () => {
  const bare = g.writersWithoutConcurrency(workflows).filter((f) => !NO_CONCURRENCY_OK[f]);
  assert.deepEqual(bare, [], violations(bare));
});

test('NO_CONCURRENCY_OK entries are still real (no stale exemptions)', () => {
  const bare = new Set(g.writersWithoutConcurrency(workflows));
  for (const f of Object.keys(NO_CONCURRENCY_OK)) assert.ok(bare.has(f), `${f} now has concurrency; remove it from the exemption list`);
});

test('cross-repo writers never use bare cancel-in-progress: true on a shared group', () => {
  const bad = [];
  for (const w of workflows.filter((x) => x.pushesCrossRepo)) {
    for (const c of w.concurrency) {
      if (c.cancelRaw === 'true' && !/github\.run_id|github\.sha/.test(c.group)) {
        const raw = fs.readFileSync(path.join(WF_DIR, w.file), 'utf8');
        if (!raw.includes('concurrency-cancel-ok')) bad.push(`${w.file}: ${c.group}`);
      }
    }
  }
  assert.deepEqual(bad, [], violations(bad));
});

test('workflows sharing a resource group agree on cancel-in-progress', () => {
  const byGroup = new Map();
  for (const w of workflows) for (const c of w.concurrency) {
    if (c.group.includes('${{')) continue;
    byGroup.set(c.group, new Set([...(byGroup.get(c.group) || []), String(c.cancelRaw)]));
  }
  const mixed = [...byGroup].filter(([, v]) => v.size > 1).map(([k]) => k);
  assert.deepEqual(mixed, [], violations(mixed));
});

test('class rules: rebuild/deploy workflows classified as such', () => {
  assert.equal(g.classify('rebuild-reviews.yml'), 'rebuild');
  assert.equal(g.classify('vercel-deploy.yml'), 'deploy');
  assert.equal(g.classify('llm-ensemble-score.yml'), 'scoring');
  assert.equal(g.classify('scrape-aggregators.yml'), 'scraping');
});

test('parser reads job-level concurrency (fetch-all-image-formats)', () => {
  const w = workflows.find((x) => x.file === 'fetch-all-image-formats.yml');
  assert.equal(w.concurrency[0].group, 'fetch-images');
  assert.equal(w.concurrency[0].level, 'job');
});

// ---- freeze ----

const critical = freeze.parseCriticalCrons(fs.readFileSync(path.join(WF_DIR, 'check-cron-health.yml'), 'utf8'));

test('freeze: CRITICAL_CRONS parsed from check-cron-health.yml', () => {
  assert.ok(critical.size > 40);
  assert.ok(critical.has('update-show-status.yml'));
});

test('freeze: NEVER_FREEZE files exist', () => {
  for (const f of freeze.NEVER_FREEZE) assert.ok(files.has(f), `${f} not in .github/workflows`);
});

test('freeze: plan never touches critical, never-freeze, or the freeze itself; only active workflows', () => {
  const { targets } = freeze.planFreeze(workflows, critical, null);
  assert.ok(targets.length > 20);
  for (const t of targets) {
    assert.ok(!critical.has(t) && !freeze.NEVER_FREEZE.has(t), t);
  }
  const states = new Map(targets.map((t) => [t, 'active']));
  states.set(targets[0], 'disabled_manually');
  const plan = freeze.planFreeze(workflows, critical, states);
  assert.ok(!plan.targets.includes(targets[0]), 'a workflow already disabled on purpose must not enter the ledger');
});

test('freeze: never targets an opening-night workflow or the opening-night monitors', () => {
  const { targets } = freeze.planFreeze(workflows, critical, null);
  for (const f of ['opening-night-completeness-check.yml', 'aggregator-url-watcher.yml', 'opening-digest.yml', 'check-push-ledger.yml']) {
    assert.ok(!targets.includes(f), f);
  }
  assert.deepEqual(targets.filter((t) => /opening-night/.test(t)), []);
});

test('parser: a dispatch input named schedule is not a cron trigger', () => {
  const w = g.parseWorkflow('x.yml', 'name: X\non:\n  workflow_dispatch:\n    inputs:\n      schedule:\n        default: a\njobs:\n  a:\n    runs-on: x\n');
  assert.equal(w.triggers.schedule, false);
  assert.equal(w.triggers.dispatch, true);
});

test('freeze: unfreeze re-enables only ledger entries; auto waits for expiry', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const ledger = freeze.buildLedger({ disabled: ['b.yml', 'a.yml'], hours: 8, now, by: 't' });
  assert.deepEqual(ledger.disabled, ['a.yml', 'b.yml']);
  assert.equal(ledger.expiresAt, '2026-10-05T08:00:00.000Z');
  assert.deepEqual(freeze.planUnfreeze(ledger, { now: new Date('2026-10-05T07:00:00Z'), auto: true }).enable, []);
  assert.deepEqual(freeze.planUnfreeze(ledger, { now: new Date('2026-10-05T08:00:01Z'), auto: true }).enable, ['a.yml', 'b.yml']);
  assert.deepEqual(freeze.planUnfreeze(ledger, { now, auto: false }).enable, ['a.yml', 'b.yml']);
  assert.deepEqual(freeze.planUnfreeze({ ...ledger, status: 'released' }, { now, auto: false }).enable, []);
  assert.deepEqual(freeze.planUnfreeze(null, { now, auto: false }).enable, []);
  assert.equal(freeze.clampHours(500), freeze.MAX_FREEZE_HOURS);
  assert.equal(freeze.clampHours('x'), 8);
});
