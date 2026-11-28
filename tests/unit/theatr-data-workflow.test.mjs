import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertShowsQuerySuccess } = require('../../scripts/lib/theatr-api-response.js');

// Regression coverage for BRO-2743: Update Theatr Data failed 17x between
// 2026-08-30 and 2026-09-05, then self-resolved with zero code changes on
// our side. The upstream response was `{ success: false, message: "###
// Error querying database. Cause: java.sql.SQLSyntaxErrorException: Unknown
// column 'genre_category'..." }` — a Theatr-side schema error, not ours.
// What actually mattered for triage speed was that the thrown error
// surfaced Theatr's message verbatim instead of crashing opaquely; that's
// the behavior this guards.
describe('Theatr shows-query response handling', () => {
  test('surfaces the full upstream error message verbatim on a failed query', () => {
    const upstreamMessage = "### Error querying database.  Cause: java.sql.SQLSyntaxErrorException: Unknown column 'genre_category'";
    assert.throws(
      () => assertShowsQuerySuccess({ success: false, message: upstreamMessage }),
      { message: `Shows query failed: ${upstreamMessage}` }
    );
  });

  test('falls back to a generic message when the upstream gives none', () => {
    assert.throws(
      () => assertShowsQuerySuccess({ success: false }),
      { message: 'Shows query failed: unknown error' }
    );
  });

  test('throws on a missing/malformed response instead of a raw TypeError', () => {
    assert.throws(() => assertShowsQuerySuccess(null), { message: 'Shows query failed: unknown error' });
    assert.throws(() => assertShowsQuerySuccess(undefined), { message: 'Shows query failed: unknown error' });
  });

  test('throws instead of a raw TypeError when success is true but content.records is missing', () => {
    assert.throws(
      () => assertShowsQuerySuccess({ success: true }),
      /Shows query failed: success response missing content\.records/
    );
    assert.throws(
      () => assertShowsQuerySuccess({ success: true, content: {} }),
      /Shows query failed: success response missing content\.records/
    );
  });

  test('returns the records array on success', () => {
    const records = [{ id: 'abc', name: 'Hamilton' }];
    assert.deepStrictEqual(
      assertShowsQuerySuccess({ success: true, content: { records } }),
      records
    );
  });
});
