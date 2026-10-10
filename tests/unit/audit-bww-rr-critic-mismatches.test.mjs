/**
 * Unit test for scripts/audit-bww-rr-critic-mismatches.js extractor.
 *
 * The script's value is detecting authorName mismatches in BWW JSON-LD. The
 * extractor has to parse the same 3 authorName formats that gather-reviews'
 * extractBWWRoundupReviews Method 1 handles:
 *   - "Outlet - Critic"
 *   - "Critic, Outlet"
 *   - "Outlet: Critic"
 *
 * If this extractor drifts from the real extractor, the audit will miss
 * mismatches silently. These tests lock the format handling.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { extractAuthorPairs } = require('../../scripts/audit-bww-rr-critic-mismatches.js');
const SCRIPT_PATH = require.resolve('../../scripts/audit-bww-rr-critic-mismatches.js');

function mkHtml(author, headline = 'Test headline') {
  return `<script type="application/ld+json">
{
  "@type": "BlogPosting",
  "author": {"name": ${JSON.stringify(author)}},
  "headline": ${JSON.stringify(headline)},
  "articleBody": "test body"
}
</script>`;
}

describe('extractAuthorPairs — author format recognition', () => {
  test('"Outlet - Critic" → outletId + criticName', () => {
    const r = extractAuthorPairs(mkHtml('The New York Times - Helen Shaw'));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].outletId, 'nytimes');
    assert.strictEqual(r[0].criticName, 'Helen Shaw');
  });

  test('"Critic, Outlet" (comma) — canonical BWW format', () => {
    const r = extractAuthorPairs(mkHtml('David Finkle, Cote Notices'));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].outletId, 'cote-notices');
    assert.strictEqual(r[0].criticName, 'David Finkle');
  });

  test('"Outlet: Critic" (colon)', () => {
    const r = extractAuthorPairs(mkHtml('NY Post: Johnny Oleksinski'));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].outletId, 'nypost');
    assert.strictEqual(r[0].criticName, 'Johnny Oleksinski');
  });

  test('author name with no recognizable separator returns no pair', () => {
    const r = extractAuthorPairs(mkHtml('Just A Name'));
    assert.strictEqual(r.length, 0);
  });

  test('author name with comma but neither side is a registered outlet → no pair (ambiguous)', () => {
    const r = extractAuthorPairs(mkHtml('John Doe, Jane Smith'));
    assert.strictEqual(r.length, 0);
  });

  test('LiveBlogPosting with nested BlogPosting entries', () => {
    const html = `<script type="application/ld+json">
{
  "@type": "LiveBlogPosting",
  "liveBlogUpdate": [
    {"@type": "BlogPosting", "author": {"name": "The New York Times - Jesse Green"}, "articleBody": "a"},
    {"@type": "BlogPosting", "author": {"name": "Variety - Marilyn Stasio"}, "articleBody": "b"}
  ]
}
</script>`;
    const r = extractAuthorPairs(html);
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].outletId, 'nytimes');
    assert.strictEqual(r[0].criticName, 'Jesse Green');
    assert.strictEqual(r[1].outletId, 'variety');
    assert.strictEqual(r[1].criticName, 'Marilyn Stasio');
  });

  test('ignores non-BlogPosting JSON-LD', () => {
    const html = `<script type="application/ld+json">
{"@type": "Organization", "name": "BWW"}
</script>`;
    const r = extractAuthorPairs(html);
    assert.strictEqual(r.length, 0);
  });
});

// BRO-4157: JSON_OUTPUT used to `return` before the `newCount > 0` exit-code
// check ran, so `--json` could never report a real mismatch — the workflow's
// own $RC check was reading an exit code that was structurally always 0/1,
// never 2. Regression-test the CLI directly (not just extractAuthorPairs) so
// this can't silently regress again.
describe('CLI exit code — findings must surface the same way in both output modes', () => {
  function runCli(args, archiveDir) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
      env: { ...process.env, BWW_RR_ARCHIVE_DIR_OVERRIDE: archiveDir },
      encoding: 'utf8',
    });
  }

  function mkFixtureDir(authorName) {
    const dir = mkdtempSync(join(tmpdir(), 'bww-rr-audit-fixture-'));
    writeFileSync(join(dir, 'test-show.html'), `<script type="application/ld+json">
{"@type": "BlogPosting", "author": {"name": ${JSON.stringify(authorName)}}, "headline": "Test", "articleBody": "x"}
</script>`);
    return dir;
  }

  test('a real mismatch exits 2 in --json mode (previously always 0)', () => {
    // cote-notices is a real single-author outlet (defaultCritic: "David Cote").
    const dir = mkFixtureDir('Wrong Name, Cote Notices');
    try {
      const jsonRun = runCli(['--json'], dir);
      assert.strictEqual(jsonRun.status, 2, `--json run: ${jsonRun.stderr}`);
      const parsed = JSON.parse(jsonRun.stdout);
      assert.strictEqual(parsed.findings.filter((f) => !f.alreadyInCanonMap).length, 1);

      const textRun = runCli([], dir);
      assert.strictEqual(textRun.status, 2, `text run: ${textRun.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no mismatch exits 0 in both modes', () => {
    const dir = mkFixtureDir('David Cote, Cote Notices');
    try {
      assert.strictEqual(runCli(['--json'], dir).status, 0);
      assert.strictEqual(runCli([], dir).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
