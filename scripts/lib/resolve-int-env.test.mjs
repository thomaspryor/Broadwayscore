import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveIntEnv } = require('./resolve-int-env');
const { resolveSbPageCreditBudget } = require('./crt-sb-credit-guard');

for (const [name, fallback] of [
  ['OPENING_NIGHT_SERP_BUDGET', 80],
  ['SD_SERP_DISCOVERY_CAP', 20],
  ['SB_PAGE_CREDIT_BUDGET', 200],
]) {
  test(`${name}: unset and blank values use the fallback`, () => {
    for (const raw of [undefined, null, '', ' ', '\t\n']) {
      assert.equal(resolveIntEnv(raw, { fallback, name }), fallback);
    }
    assert.equal(resolveIntEnv(undefined, { fallback: 0, name }), 0);
  });

  test(`${name}: whole trimmed integers parse, including zero`, () => {
    for (const [raw, expected] of [
      ['0', 0], ['20', 20], [' 80\t', 80], ['00200', 200],
      [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ]) {
      assert.equal(resolveIntEnv(raw, { fallback, name }), expected);
    }
  });

  test(`${name}: malformed and unsafe overrides throw naming the variable`, () => {
    for (const raw of [
      'abc', 'NaN', 'Infinity', '200oops', '80oops', '-1', '+20', '2.0',
      '1e3', '0x14', '1_000', '2 0', '20#comment', 'CAP=20',
      String(Number.MAX_SAFE_INTEGER + 1), '9'.repeat(400),
    ]) {
      assert.throws(() => resolveIntEnv(raw, { fallback, name }), error => {
        assert.match(error.message, /must be a non-negative integer/);
        assert.ok(error.message.includes(name));
        return true;
      });
    }
  });
}

test('resolveSbPageCreditBudget delegates with its existing defaults and variable name', () => {
  assert.equal(resolveSbPageCreditBudget(undefined), 200);
  assert.equal(resolveSbPageCreditBudget(' \t'), 200);
  assert.equal(resolveSbPageCreditBudget(undefined, 75), 75);
  assert.equal(resolveSbPageCreditBudget(undefined, 0), 0);
  assert.equal(resolveSbPageCreditBudget(' 1000 '), 1000);
  assert.equal(resolveSbPageCreditBudget('0'), 0);
  for (const raw of ['200oops', '-5', '1e3', '9'.repeat(400)]) {
    assert.throws(() => resolveSbPageCreditBudget(raw), /SB_PAGE_CREDIT_BUDGET must be a non-negative integer/);
  }
});
