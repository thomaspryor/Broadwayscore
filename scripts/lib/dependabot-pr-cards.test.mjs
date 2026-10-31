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
