// detectEngagementStamp's reply parser (BRO-4726): a tour page must not show
// one stop's dates or venue, and an unreadable reply must read as "not
// cleared" (null), never as "clean".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseStampResponse } = require('./verify-image.js');

test('parseStampResponse reads plain and fenced JSON', () => {
  assert.deepEqual(parseStampResponse('{"stamped":true,"text":"JAN 26-31"}'), { stamped: true, text: 'JAN 26-31' });
  assert.deepEqual(parseStampResponse('```json\n{"stamped":false,"text":""}\n```'), { stamped: false, text: '' });
});

test('parseStampResponse falls back to the bare field, and gives null when it cannot tell', () => {
  assert.deepEqual(parseStampResponse('{"stamped": true, "text": "Segerstrom'), { stamped: true, text: '' });
  assert.equal(parseStampResponse('I think it has dates'), null);
  assert.equal(parseStampResponse('{"stamped":"maybe"}'), null);
  assert.equal(parseStampResponse(''), null);
});
