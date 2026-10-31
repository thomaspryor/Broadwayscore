// Tests for opening-events-for-week.js — BRO-2594 regression: reopeningDate
// must not be short-circuited when openingDate also falls in the same week.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyOpeningEvent } = require('./opening-events-for-week.js');

const WEEK_START = '2026-08-24';
const WEEK_END = '2026-08-30';
const inWeek = (d) => !!d && d >= WEEK_START && d <= WEEK_END;

test('openingDate in week, no reopeningDate -> fresh opening', () => {
  const show = { openingDate: '2026-08-25' };
  assert.deepEqual(classifyOpeningEvent(show, inWeek), { isReopening: false });
});

test('reopeningDate in week, openingDate outside week -> reopening', () => {
  const show = { openingDate: '2024-01-10', reopeningDate: '2026-08-26' };
  assert.deepEqual(classifyOpeningEvent(show, inWeek), { isReopening: true });
});

test('BRO-2594: both openingDate and reopeningDate fall in the same week -> reopening wins', () => {
  const show = { openingDate: '2026-08-25', reopeningDate: '2026-08-27' };
  assert.deepEqual(classifyOpeningEvent(show, inWeek), { isReopening: true });
});

test('neither date in week -> null', () => {
  const show = { openingDate: '2024-01-10', reopeningDate: '2025-03-01' };
  assert.equal(classifyOpeningEvent(show, inWeek), null);
});

test('null show -> null', () => {
  assert.equal(classifyOpeningEvent(null, inWeek), null);
});

test('show with neither field set -> null', () => {
  assert.equal(classifyOpeningEvent({}, inWeek), null);
});
