import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dependabotPrAlerts } = require('./dependabot-pr-cards.js');

const pr = (over) => ({ number: 964, title: 'chore(deps): Bump the all-updates group', url: 'https://github.com/o/r/pull/964', headRefName: 'dependabot/npm_and_yarn/all-updates-852b384430', isCrossRepository: false, ...over });

test('one alert per open same-repo Dependabot PR, keyed by PR number', () => {
  const out = dependabotPrAlerts([pr(), pr({ number: 970, headRefName: 'dependabot/github_actions/actions-updates-1' })]);
  assert.deepEqual(out.map((a) => a.conditionKey), ['dependabot-pr:964', 'dependabot-pr:970']);
  assert.match(out[0].title, /^Land Dependabot PR #964: /);
  assert.equal(out[0].url, 'https://github.com/o/r/pull/964');
});

test('ignores forks, non-Dependabot branches and malformed rows', () => {
  assert.deepEqual(dependabotPrAlerts([
    pr({ isCrossRepository: true }),
    pr({ headRefName: 'claude/some-branch' }),
    pr({ number: 'x' }),
    null,
  ]), []);
  assert.deepEqual(dependabotPrAlerts(undefined), []);
});

const { staleDependabotPrKeys } = require('./dependabot-pr-cards.js');

test('staleDependabotPrKeys: open conditions whose PR is no longer listed (BRO-6445)', () => {
  const conditions = {
    'dependabot-pr:1111': { status: 'open' },
    'dependabot-pr:1165': { status: 'open' },
    'dependabot-pr:1175': { status: 'open' },
    'dependabot-pr:900': { status: 'resolved' },
    'dependabot-pr:x': { status: 'open' },
    'health-check:foo': { status: 'open' },
  };
  assert.deepEqual(staleDependabotPrKeys(conditions, [pr({ number: 1175 })]), ['dependabot-pr:1111', 'dependabot-pr:1165']);
  // every open PR counts, even one dependabotPrAlerts filters out
  assert.deepEqual(staleDependabotPrKeys(conditions, [pr({ number: 1175 }), pr({ number: 1165, headRefName: 'other' })]), ['dependabot-pr:1111']);
  // empty listing = nothing open = all stale
  assert.deepEqual(staleDependabotPrKeys(conditions, []), ['dependabot-pr:1111', 'dependabot-pr:1165', 'dependabot-pr:1175']);
});

test('staleDependabotPrKeys never mass-resolves on a bad or truncated listing', () => {
  const conditions = { 'dependabot-pr:1': { status: 'open' } };
  assert.deepEqual(staleDependabotPrKeys(conditions, undefined), []);
  assert.deepEqual(staleDependabotPrKeys(conditions, { message: 'error' }), []);
  assert.deepEqual(staleDependabotPrKeys(conditions, [pr({ number: 2 }), pr({ number: 3 })], { limit: 2 }), []);
  assert.deepEqual(staleDependabotPrKeys(undefined, []), []);
});
