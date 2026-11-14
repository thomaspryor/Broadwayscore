import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGrossesAnalysisPost, parseMoneyAmount, parsePercentageRange } = require('../../scripts/lib/parse-grosses.js');

describe('parseMoneyAmount', () => {
  test('$1.3M -> 1300000', () => {
    assert.strictEqual(parseMoneyAmount('$1.3M'), 1300000);
  });

  test('$600k -> 600000', () => {
    assert.strictEqual(parseMoneyAmount('$600k'), 600000);
  });

  test('$600K -> 600000', () => {
    assert.strictEqual(parseMoneyAmount('$600K'), 600000);
  });

  test('$248 -> 248', () => {
    assert.strictEqual(parseMoneyAmount('$248'), 248);
  });

  test('($150k) negative -> -150000', () => {
    assert.strictEqual(parseMoneyAmount('($150k)'), -150000);
  });

  test('-$150k negative -> -150000', () => {
    assert.strictEqual(parseMoneyAmount('-$150k'), -150000);
  });

  test('N/A -> null', () => {
    assert.strictEqual(parseMoneyAmount('N/A'), null);
  });

  test('null input -> null', () => {
    assert.strictEqual(parseMoneyAmount(null), null);
  });

  test('$1.300M -> 1300000', () => {
    assert.strictEqual(parseMoneyAmount('$1.300M'), 1300000);
  });
});

describe('parsePercentageRange', () => {
  test('80%-100% -> [80, 100]', () => {
    assert.deepStrictEqual(parsePercentageRange('80%-100%'), [80, 100]);
  });

  test('102% -> [102, 102]', () => {
    assert.deepStrictEqual(parsePercentageRange('102%'), [102, 102]);
  });

  test('N/A -> null', () => {
    assert.strictEqual(parsePercentageRange('N/A'), null);
  });
});

describe('parseGrossesAnalysisPost', () => {
  test('standard show block with all fields', () => {
    const text = `**Hamilton** - $2.1M gross, 102% capacity, $303 atp
Gross Less-Fees: $1.890M; Estimated Weekly Operating Cost: $643k/week
Estimated Profit (Loss): $1.247M+
Estimated percentage recouped: N/A`;

    const result = parseGrossesAnalysisPost(text);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].showName, 'Hamilton');
    assert.strictEqual(result[0].weeklyGross, 2100000);
    assert.strictEqual(result[0].capacity, 102);
    assert.strictEqual(result[0].atp, 303);
    assert.strictEqual(result[0].grossLessFees, 1890000);
    assert.strictEqual(result[0].estimatedWeeklyCost, 643000);
    assert.strictEqual(result[0].estimatedProfitLoss, 1247000);
    assert.strictEqual(result[0].estimatedRecoupmentPct, null);
  });

  test('show with percentage range', () => {
    const text = `**Death Becomes Her** - $1.5M gross, 95% capacity, $198 atp
Gross Less-Fees: $1.350M; Estimated Weekly Operating Cost: $1.1M/week
Estimated Profit (Loss): $250k+
Estimated percentage recouped: 60%-80%`;

    const result = parseGrossesAnalysisPost(text);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].estimatedRecoupmentPct, [60, 80]);
  });

  test('show with loss (parenthetical negative)', () => {
    const text = `**Some Show** - $0.8M gross, 70% capacity, $150 atp
Gross Less-Fees: $0.720M; Estimated Weekly Operating Cost: $900k/week
Estimated Profit (Loss): ($180k)
Estimated percentage recouped: 10%-20%`;

    const result = parseGrossesAnalysisPost(text);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].estimatedProfitLoss, -180000);
  });

  test('multiple shows in text', () => {
    const text = `**Show One** - $1.0M gross, 85% capacity, $100 atp
Gross Less-Fees: $0.900M; Estimated Weekly Operating Cost: $500k/week
Estimated Profit (Loss): $400k+
Estimated percentage recouped: 50%-60%

**Show Two** - $2.0M gross, 99% capacity, $200 atp
Gross Less-Fees: $1.800M; Estimated Weekly Operating Cost: $800k/week
Estimated Profit (Loss): $1.0M+
Estimated percentage recouped: N/A

**Show Three** - $0.5M gross, 60% capacity, $80 atp
Gross Less-Fees: $0.450M; Estimated Weekly Operating Cost: $600k/week
Estimated Profit (Loss): ($150k)
Estimated percentage recouped: 20%-30%`;

    const result = parseGrossesAnalysisPost(text);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].showName, 'Show One');
    assert.strictEqual(result[1].showName, 'Show Two');
    assert.strictEqual(result[2].showName, 'Show Three');
  });

  test('empty input -> empty array', () => {
    assert.deepStrictEqual(parseGrossesAnalysisPost(''), []);
  });

  test('show with only gross and capacity', () => {
    const text = `**Minimal Show** - $1.0M gross, 80% capacity, $120 atp`;
    const result = parseGrossesAnalysisPost(text);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].showName, 'Minimal Show');
    assert.strictEqual(result[0].weeklyGross, 1000000);
    assert.strictEqual(result[0].capacity, 80);
    assert.strictEqual(result[0].estimatedWeeklyCost, null);
    assert.strictEqual(result[0].estimatedRecoupmentPct, null);
  });
});
