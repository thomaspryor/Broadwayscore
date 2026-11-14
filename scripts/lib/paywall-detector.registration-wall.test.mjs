import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const { hasRegistrationWallTail } = createRequire(import.meta.url)('./paywall-detector.js');

test('registration wall tail is detected', () => {
  const t = 'Cinderella opening night. A minimum of 8 characters At least 1 letter At least 1 number Youll receive regular news updates';
  assert.equal(hasRegistrationWallTail(t), true);
});
test('real review text and non-strings are not flagged', () => {
  assert.equal(hasRegistrationWallTail('A joyous adaptation returns to the Old Vic with a minimum of fuss.'), false);
  assert.equal(hasRegistrationWallTail(null), false);
});
