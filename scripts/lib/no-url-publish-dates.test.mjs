// BRO-5614 / CLAUDE.md rule 3: a date parsed from a review URL is never stored as
// publishDate. These six backfill scripts used to; they must not parse URL dates
// at all (the rebuild dates a dateless file itself, backfill-publish-date.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SCRIPTS = [
  'backfill-review-dates.js',
  'backfill-url-dates.js',
  'backfill-network-tier-dates.js',
  'cleanup-fake-publish-dates.js',
  'fix-null-dates-from-url.js',
  'recover-null-dates.js',
];
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

for (const f of SCRIPTS) {
  test(`${f} does not derive a stored date from a URL`, () => {
    const src = read(f);
    assert.doesNotMatch(src, /extractDateFromUrl|extractYearMonthFromUrl/, 'no URL date extractor');
    assert.doesNotMatch(src, /dateSource\s*=\s*[`'"]url/, 'no url-* dateSource written');
  });
}

for (const f of ['backfill-url-dates.js', 'fix-null-dates-from-url.js', 'recover-null-dates.js']) {
  test(`${f} is retired and exits non-zero without touching data`, () => {
    assert.throws(
      () => execFileSync('node', [new URL(`../${f}`, import.meta.url).pathname, '--apply', '--write'], { stdio: 'pipe' }),
      (e) => e.status === 1 && /retired \(BRO-5614\)/.test(String(e.stderr)),
    );
  });
}
