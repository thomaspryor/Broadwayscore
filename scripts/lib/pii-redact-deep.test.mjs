import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { redactEmailsDeep } = createRequire(import.meta.url)('./pii-scan.js');
test('redacts emails in nested audit rows (BRO-7322)', () => {
  const out = redactEmailsDeep({ openai: { bylineInText: 'Pam Kragen pam.kragen@sduniontribune.com', n: 3, a: ['x@y.com ok'] } });
  assert.ok(!JSON.stringify(out).includes('kragen@'));
  assert.ok(!JSON.stringify(out).includes('x@y.com'));
  assert.equal(out.openai.n, 3);
});
