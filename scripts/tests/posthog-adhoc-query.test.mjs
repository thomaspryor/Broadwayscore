import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  splitStatements, expandLens, toMarkdownTable, renderReport, runStatements,
  isTransientError, looksSilentlyCapped, MAX_RENDERED_ROWS,
} = require('../posthog-adhoc-query.js');
const { REAL_USERS_WHERE } = require('../lib/posthog-query.js');

test('splitStatements splits on a --- line, trims, drops empties, keeps -- comments', () => {
  const out = splitStatements('\n-- a comment\nSELECT 1\n---\n\n  SELECT 2  \n---\n');
  assert.deepEqual(out, ['-- a comment\nSELECT 1', 'SELECT 2']);
  assert.deepEqual(splitStatements(''), []);
  assert.deepEqual(splitStatements(undefined), []);
  // A --- inside a line (not alone on it) is not a separator.
  assert.equal(splitStatements("SELECT '---' AS x").length, 1);
});

test('expandLens replaces {{REAL_USERS_WHERE}} with the shared lens, parenthesised', () => {
  const out = expandLens('SELECT 1 FROM events WHERE {{ REAL_USERS_WHERE }} AND x');
  assert.ok(out.includes(`(${REAL_USERS_WHERE.trim()})`));
  assert.ok(!out.includes('{{'));
  assert.equal(expandLens('SELECT 1'), 'SELECT 1');
});

test('toMarkdownTable uses API column names, escapes pipes, renders null as a dash', () => {
  const md = toMarkdownTable({ columns: ['page', 'views'], results: [['/a|b', 3], ['/c', null]] });
  assert.equal(md, '| page | views |\n| --- | --- |\n| /a\\|b | 3 |\n| /c | — |\n');
});

test('toMarkdownTable falls back to col0..colN headers and handles empty results', () => {
  assert.equal(toMarkdownTable({ results: [[1, 2]] }), '| col0 | col1 |\n| --- | --- |\n| 1 | 2 |\n');
  assert.equal(toMarkdownTable({ columns: ['only-one'], results: [[1, 2]] }).split('\n')[0], '| col0 | col1 |');
  assert.equal(toMarkdownTable({ columns: ['n'], results: [] }), '_No rows_\n');
});

test('toMarkdownTable caps rendered rows and says so', () => {
  const results = Array.from({ length: MAX_RENDERED_ROWS + 7 }, (_, i) => [i]);
  const md = toMarkdownTable({ columns: ['i'], results });
  assert.equal(md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| i |') && !l.startsWith('| ---')).length, MAX_RENDERED_ROWS);
  assert.ok(md.includes(`showing ${MAX_RENDERED_ROWS} of ${MAX_RENDERED_ROWS + 7} rows`));
});

test('looksSilentlyCapped fires only for GROUP BY without LIMIT returning exactly 100 rows', () => {
  assert.equal(looksSilentlyCapped('SELECT a, count() FROM events GROUP BY a', 100), true);
  assert.equal(looksSilentlyCapped('SELECT a, count() FROM events GROUP BY a LIMIT 1000', 100), false);
  assert.equal(looksSilentlyCapped('SELECT a, count() FROM events GROUP BY a', 99), false);
  assert.equal(looksSilentlyCapped('SELECT count() FROM events', 100), false);
});

test('renderReport shows each statement, its table, failures, and the cap warning', () => {
  const md = renderReport([
    { statement: 'SELECT a FROM t GROUP BY a', response: { columns: ['a'], results: Array.from({ length: 100 }, (_, i) => [i]) } },
    { statement: 'SELECT boom', error: 'PostHog API 400: bad' },
  ], { title: 'T' });
  assert.ok(md.startsWith('## T\n'));
  assert.ok(md.includes('### Statement 1'));
  assert.ok(md.includes('```sql\nSELECT a FROM t GROUP BY a\n```'));
  assert.ok(md.includes('100 row(s)'));
  assert.ok(md.includes('Exactly 100 rows from a GROUP BY with no LIMIT'));
  assert.ok(md.includes('### Statement 2'));
  assert.ok(md.includes('**FAILED:** PostHog API 400: bad'));
});

test('isTransientError follows the analyze-traffic-sources rule: status first, then timeout text', () => {
  assert.equal(isTransientError(new Error('PostHog API 504: <html>')), true);
  assert.equal(isTransientError(new Error('PostHog API 429: slow down')), true);
  assert.equal(isTransientError(new Error('PostHog API 400: Query timeout exceeded')), false);
  assert.equal(isTransientError(new Error('fetch failed')), true);
  assert.equal(isTransientError(new Error('PostHog API 403: bad key')), false);
});

test('runStatements retries a transient failure once, records a hard failure, and keeps going', async () => {
  const calls = [];
  const query = async (s) => {
    calls.push(s);
    if (s === 'flaky' && calls.filter((c) => c === 'flaky').length === 1) throw new Error('PostHog API 503: try again');
    if (s === 'bad') throw new Error('PostHog API 400: nope');
    return { columns: ['x'], results: [[s]] };
  };
  const sections = await runStatements(['flaky', 'bad', 'ok'], query, { retryDelayMs: 0, sleep: async () => {} });
  assert.deepEqual(calls, ['flaky', 'flaky', 'bad', 'ok']);
  assert.equal(sections[0].response.results[0][0], 'flaky');
  assert.equal(sections[1].error, 'PostHog API 400: nope');
  assert.equal(sections[2].response.results[0][0], 'ok');
});
