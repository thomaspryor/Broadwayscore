// BRO-4654: the GITHUB_TOKEN quota guard and the audit scan it now gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const budget = require('./github-api-budget.js');
const hygiene = require('../audit-workflow-hygiene.js');

const NOW = 1_800_000_000;
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test('parseRateLimit reads resources.core, legacy rate, or a bare core object', () => {
  const core = { limit: 1000, remaining: 412, used: 588, reset: NOW + 600 };
  assert.deepEqual(budget.parseRateLimit({ resources: { core }, rate: { limit: 1, remaining: 1 } }), core);
  assert.deepEqual(budget.parseRateLimit({ rate: core }), core);
  assert.deepEqual(budget.parseRateLimit(core), core);
});

test('parseRateLimit rejects bodies without numeric remaining/limit', () => {
  assert.equal(budget.parseRateLimit(null), null);
  assert.equal(budget.parseRateLimit('x'), null);
  assert.equal(budget.parseRateLimit({ message: 'Bad credentials' }), null);
  assert.equal(budget.parseRateLimit({ rate: { limit: 1000, remaining: null } }), null);
});

test('decideBudget allows a batch that leaves the reserve intact', () => {
  const d = budget.decideBudget({ quota: { remaining: 600, limit: 1000, reset: NOW + 900 }, cost: 256, reserve: 300, nowSec: NOW });
  assert.equal(d.ok, true);
  assert.match(d.reason, /600\/1000 left, resets in 15m/);
});

test('decideBudget skips when cost + reserve exceeds what is left (the 2026-10-05 burst)', () => {
  const d = budget.decideBudget({ quota: { remaining: 555, limit: 1000, reset: NOW + 60 }, cost: 256, reserve: 300, nowSec: NOW });
  assert.equal(d.ok, false);
  assert.match(d.reason, /low quota/);
  assert.equal(budget.decideBudget({ quota: { remaining: 0, limit: 1000 }, cost: 1, reserve: 0 }).ok, false);
});

test('decideBudget is exact at the boundary and uses the default reserve', () => {
  assert.equal(budget.decideBudget({ quota: { remaining: 556, limit: 1000 }, cost: 256, reserve: 300 }).ok, true);
  assert.equal(budget.decideBudget({ quota: { remaining: budget.DEFAULT_RESERVE, limit: 1000 }, cost: 1 }).ok, false);
  assert.equal(budget.decideBudget({ quota: { remaining: budget.DEFAULT_RESERVE + 1, limit: 1000 }, cost: 1 }).ok, true);
});

test('decideBudget skips optional calls when the quota is unknown', () => {
  for (const quota of [null, undefined, {}]) {
    const d = budget.decideBudget({ quota, cost: 1, reserve: 0 });
    assert.equal(d.ok, false);
    assert.match(d.reason, /unknown/);
  }
});

test('readRateLimit calls the free /rate_limit endpoint with the token and never throws', async () => {
  const seen = [];
  const quota = await budget.readRateLimit({
    token: 'T',
    fetchImpl: async (url, opts) => { seen.push([url, opts.headers.Authorization]); return okResponse({ resources: { core: { limit: 1000, remaining: 7, reset: NOW } } }); },
  });
  assert.deepEqual(seen, [['https://api.github.com/rate_limit', 'Bearer T']]);
  assert.equal(quota.remaining, 7);

  assert.equal(await budget.readRateLimit({ token: '', fetchImpl: async () => okResponse({}) }), null);
  assert.equal(await budget.readRateLimit({ token: 'T', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), null);
  assert.equal(await budget.readRateLimit({ token: 'T', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), null);
});

test('checkBudget combines the read and the decision', async () => {
  const fetchImpl = async () => okResponse({ resources: { core: { limit: 1000, remaining: 900, reset: NOW + 120 } } });
  const r = await budget.checkBudget({ cost: 256, reserve: 300, token: 'T', fetchImpl, nowSec: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.quota.remaining, 900);
});

test('parseArgs takes --cost/--reserve in both forms and refuses junk', () => {
  assert.deepEqual(budget.parseArgs(['--cost', '260', '--reserve=50']), { cost: 260, reserve: 50 });
  assert.deepEqual(budget.parseArgs([]), { cost: 1, reserve: budget.DEFAULT_RESERVE });
  assert.throws(() => budget.parseArgs(['--cost', '-1']));
  assert.throws(() => budget.parseArgs(['--cost']));
  assert.throws(() => budget.parseArgs(['--bogus', '1']));
});

test('CLI exits 1 (skip) with no token, 2 on bad args', () => {
  const env = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' };
  const cli = path.join(HERE, 'github-api-budget.js');
  const skip = spawnSync(process.execPath, [cli, '--cost', '5'], { env, encoding: 'utf8' });
  assert.equal(skip.status, 1);
  assert.match(skip.stdout, /\[gh-api-budget\] SKIP: quota unknown/);
  assert.equal(spawnSync(process.execPath, [cli, '--cost', 'abc'], { env, encoding: 'utf8' }).status, 2);
});

// The audit that spent ~512 calls per dispatched land run (two gauntlet passes).
test('audit-workflow-hygiene CLI runs the live never-run scan only on explicit opt-in', () => {
  for (const env of [{}, { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_EVENT_NAME: 'push' }, { HYGIENE_NEVER_RUN_SCAN: 'true' }]) {
    assert.equal(hygiene.neverRunCliScanDecision(env).run, false, JSON.stringify(env));
  }
  assert.equal(hygiene.neverRunCliScanDecision({ HYGIENE_NEVER_RUN_SCAN: '1', GITHUB_EVENT_NAME: 'workflow_dispatch' }).run, true);
});

test('checkNeverRunWorkflowCoverage skips without spending calls when the quota is low', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return okResponse({ resources: { core: { limit: 1000, remaining: 120, reset: NOW } } });
  };
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME };
  process.env.GH_TOKEN = 'T';
  process.env.GITHUB_EVENT_NAME = 'schedule';
  try {
    const r = await hygiene.checkNeverRunWorkflowCoverage(['a.yml', 'b.yml']);
    assert.equal(r.skipped, true);
    assert.match(r.reason, /GitHub API budget: low quota/);
    assert.deepEqual(urls, ['https://api.github.com/rate_limit']);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
