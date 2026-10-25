// BRO-5420 follow-up: the scorer must score only the named critic's verdict.
// dreamgirls-1981's AP review was scored on a quoted Douglas Watt line (42)
// instead of Mary Campbell's rave (87). Both prompt versions carry the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const config = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../llm-scoring/config.ts'), 'utf8');

test('both scorer prompt versions tell the model to ignore other critics\' quoted verdicts', () => {
  const rows = config.match(/\| \*\*Quotes other critics\*\* \| Score only the named critic's own evaluation\./g) || [];
  assert.equal(rows.length, 2, 'v5 and v6 edge-case tables');
});
