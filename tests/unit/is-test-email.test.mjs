/**
 * Guard: sync-followers must drop test/QA addresses before they reach a
 * subscriber list or Resend audience. Real subscribers using plus-addressing to
 * TAG their signup must NOT be filtered.
 *
 * 2026-05-30: the West End audience was ~60% owner test accounts
 * (thomas.pryor+testN@gmail.com, test-we-subscriber@example.com) — the first WE
 * broadcast reached only 4 real people; the rest landed in the owner's inbox or
 * bounced. sync-followers only validated email FORMAT, so the aliases persisted.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isTestEmail } = require('../../scripts/sync-followers.js');

describe('isTestEmail', () => {
  test('flags owner +test / +testing aliases', () => {
    for (const e of ['thomas.pryor+test@gmail.com', 'thomas.pryor+test7@gmail.com', 'thomas.pryor+testing11@gmail.com']) {
      assert.strictEqual(isTestEmail(e), true, `${e} should be a test address`);
    }
  });

  test('flags example.* domains and test- prefixes', () => {
    for (const e of ['test-we-subscriber@example.com', 'test-probe-delete-me@example.com', 'foo@example.org']) {
      assert.strictEqual(isTestEmail(e), true, `${e} should be a test address`);
    }
  });

  test('does NOT flag real subscribers, including plus-tagged signups', () => {
    for (const e of [
      'down-town1@hotmail.com',
      'daniel.beeson@lwtickets.co.uk',
      'mattrobgee@gmail.com',
      'gajwalker@sky.com',
      'josephmagic+broadwayscorecard@gmail.com', // real subscriber tagging their signup
      'thomas.pryor@gmail.com',                  // owner's real address (not a test alias)
    ]) {
      assert.strictEqual(isTestEmail(e), false, `${e} is a real address and must not be filtered`);
    }
  });
});
