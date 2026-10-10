import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  splitStatements, expandLens, toMarkdownTable, renderReport, runStatements,
  isTransientError, looksSilentlyCapped, formatCell, MAX_RENDERED_ROWS,
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

test('formatCell keeps small fractions readable, escapes pipes inside JSON, dashes nulls', () => {
  assert.equal(formatCell(0.0037), '0.00370');
  assert.equal(formatCell(12.3456), '12.35');
  assert.equal(formatCell(7), '7');
  assert.equal(formatCell(['a|b']), '["a\\|b"]');
  assert.equal(formatCell(null), '—');
  assert.equal(formatCell('x\ny'), 'x y');
});

test('looksSilentlyCapped trusts hasMore when present, else exactly-100-rows-without-LIMIT', () => {
  const rows100 = Array.from({ length: 100 }, (_, i) => [i]);
  assert.equal(looksSilentlyCapped('SELECT a FROM events', { hasMore: true, results: rows100.slice(0, 5) }), true);
  assert.equal(looksSilentlyCapped('SELECT a FROM events', { hasMore: false, results: rows100 }), false);
  assert.equal(looksSilentlyCapped('SELECT a, count() FROM events GROUP BY a', { results: rows100 }), true);
  assert.equal(looksSilentlyCapped('SELECT event, timestamp FROM events', { results: rows100 }), true);
  assert.equal(looksSilentlyCapped('SELECT a FROM events GROUP BY a LIMIT 1000', { results: rows100 }), false);
  assert.equal(looksSilentlyCapped('SELECT a FROM events', { results: rows100.slice(0, 99) }), false);
});

test('renderReport shows each statement, its table, failures, the cap warning, and survives ``` in a statement', () => {
  const md = renderReport([
    { statement: 'SELECT a FROM t GROUP BY a', response: { columns: ['a'], hasMore: true, results: Array.from({ length: 100 }, (_, i) => [i]) } },
    { statement: 'SELECT boom', error: 'PostHog API 400: bad' },
    { statement: "SELECT '```' AS fence", response: { columns: ['fence'], results: [['```']] } },
  ], { title: 'T' });
  assert.ok(md.startsWith('## T\n'));
  assert.ok(md.includes('### Statement 1'));
  assert.ok(md.includes('```sql\nSELECT a FROM t GROUP BY a\n```'));
  assert.ok(md.includes('100 row(s)'));
  assert.ok(md.includes('Result is capped'));
  assert.ok(md.includes('### Statement 2'));
  assert.ok(md.includes('**FAILED:** PostHog API 400: bad'));
  assert.ok(md.includes("````sql\nSELECT '```' AS fence\n````"));
});

test('toMarkdownTable does not blow the stack on very large result sets', () => {
  const results = Array.from({ length: 200000 }, (_, i) => [i, i * 2]);
  const md = toMarkdownTable({ columns: ['a', 'b'], results });
  assert.ok(md.includes(`showing ${MAX_RENDERED_ROWS} of 200000 rows`));
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
