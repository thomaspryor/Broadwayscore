import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimelineJsonl } from './opening-night-timeline.js';

const row = (t, rc) => JSON.stringify({ t, rc, s: 50 });

test('parseTimelineJsonl re-sorts union-disturbed rows by t', () => {
  // Shape a union recovery produces: origin rows, then a local row whose
  // timestamp is OLDER than origin's last row.
  const text = [row('2026-04-23T04:00:00.000Z', 1), row('2026-04-25T04:00:00.000Z', 3), row('2026-04-24T04:00:00.000Z', 2)].join('\n') + '\n';
  assert.deepEqual(parseTimelineJsonl(text).map((r) => r.rc), [1, 2, 3]);
});

test('parseTimelineJsonl sorts by instant, not string order (offset form, no zero-padding)', () => {
  // '2026-04-23T10:00:00+05:00' is 05:00Z, earlier than '2026-04-23T06:00:00Z'
  // though it sorts later as a string; '2026-4-9 ...' is not zero-padded and
  // sorts after '2026-04-23...' as a string though it is earlier in time.
  const text = [row('2026-04-23T06:00:00.000Z', 3), row('2026-04-23T10:00:00+05:00', 2), row('2026-4-9 12:00:00Z', 1)].join('\n');
  assert.deepEqual(parseTimelineJsonl(text).map((r) => r.rc), [1, 2, 3]);
});

test('parseTimelineJsonl collapses exact-duplicate lines from both merge sides', () => {
  const a = row('2026-04-23T04:00:00.000Z', 1);
  const text = [a, row('2026-04-24T04:00:00.000Z', 2), a].join('\n');
  assert.deepEqual(parseTimelineJsonl(text).map((r) => r.rc), [1, 2]);
});

test('parseTimelineJsonl drops torn lines and rows without a parseable timestamp', () => {
  const text = [row('2026-04-23T04:00:00.000Z', 1), '{"t":"2026-04-2', JSON.stringify({ rc: 9 }), row('not-a-date', 8), ''].join('\n');
  assert.deepEqual(parseTimelineJsonl(text).map((r) => r.rc), [1]);
});

test('parseTimelineJsonl returns [] for empty or non-string input', () => {
  assert.deepEqual(parseTimelineJsonl(''), []);
  assert.deepEqual(parseTimelineJsonl(undefined), []);
});
