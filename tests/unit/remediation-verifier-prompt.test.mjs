// BRO-7594: the GPT plan verifier failed the correct fix for issue #1187
// because it read the reader-reported wrong value in the show data as proof
// the value was right. Replay on the real plan (all three productions in
// context): old prompt 0/10 pass, with instruction 5 10/10 pass, and a
// wrong-production plan still fails 5/5. A narrower rewording dropped to
// 8/10, so this guard pins the phrases that carried the effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../scripts/generate-remediation-plan.js', import.meta.url), 'utf8');
const prompt = src.slice(src.indexOf('async function verifyPlanWithGPT'));

test('verifier prompt says the stored value is the disputed one, not evidence', () => {
  assert.match(prompt, /show data is the CURRENT database, which a reader reported as wrong/);
  assert.match(prompt, /oldValue matching the show data is expected, not a contradiction/);
  assert.match(prompt, /newValue that differs from the show data is not a contradiction/);
  assert.match(prompt, /Clearing a disputed value to null is a valid fix/);
  assert.match(prompt, /field the diagnosis does not name, still treat the show data as the reference/);
});
