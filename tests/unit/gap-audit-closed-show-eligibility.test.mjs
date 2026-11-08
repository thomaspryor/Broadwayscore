// BRO-7163 F05: a short-run show that closed inside the opening window stays in the default gap audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isShowEligible, closedShowStillInWindow } = require('../../scripts/audit-show-review-gap.js');
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const show = (status, opened) => ({ id: 'x-off-west-end-2026', status, openingDate: daysAgo(opened), category: 'off-west-end' });

test('closed 12-day run, opened 12 days ago, is eligible', () => assert.equal(isShowEligible(show('closed', 12)), true));
test('closed show inside the 7-day grace after the window is eligible', () => assert.equal(isShowEligible(show('closed', 27)), true));
test('closed show long past the window is not', () => assert.equal(isShowEligible(show('closed', 90)), false));
test('grace boundary', () => { assert.equal(closedShowStillInWindow(28, 21), true); assert.equal(closedShowStillInWindow(29, 21), false); });
test('open show behaviour unchanged (inside window)', () => assert.equal(isShowEligible(show('open', 5)), true));
