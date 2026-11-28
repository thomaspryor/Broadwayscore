// Every e2e spec that renders My Shows mock data or the UGC fixture pages must
// use tests/e2e/helpers/ugc-test.ts's `test`, which pins the browser clock.
//
// Why: src/app/my-shows/__dev-mock-data.ts has absolute dates, and the page
// buckets rows (Upcoming / To Be Rated) against the browser's real "today".
// On 2026-09-16 a Sep 15 booking silently changed bucket and test-ugc.yml went
// red for weeks. A spec importing `test` from '@playwright/test' directly runs
// on the real date again, so this fails it at unit-test time instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = fileURLToPath(new URL('../e2e', import.meta.url));
// Signals that a spec renders mock data / UGC fixtures.
const RENDERS_MOCK = /mock=1|goToMock\(|\/test\/ugc-fixture/;
const PINNED_IMPORT = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*'\.\/helpers\/ugc-test'/;
const RAW_TEST_IMPORT = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*'@playwright\/test'/;

const specs = readdirSync(e2eDir)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => ({ f, src: readFileSync(join(e2eDir, f), 'utf-8') }))
  .filter(({ src }) => RENDERS_MOCK.test(src));

test('mock-data specs are found (the signal regex still matches something)', () => {
  assert.ok(specs.length >= 4, `expected the My Shows / UGC fixture specs, found: ${specs.map((s) => s.f).join(', ')}`);
});

test('every mock-data spec takes `test` from ./helpers/ugc-test (pinned clock)', () => {
  const bad = specs.filter(({ src }) => !PINNED_IMPORT.test(src) || RAW_TEST_IMPORT.test(src)).map((s) => s.f);
  assert.deepEqual(bad, [], `import { test, expect } from './helpers/ugc-test' in: ${bad.join(', ')}`);
});

test('mock-data specs do not read the real date for "today"', () => {
  const bad = specs.filter(({ src }) => /new Date\(\)\.toISOString\(\)/.test(src)).map((s) => s.f);
  assert.deepEqual(bad, [], `use MOCK_TODAY from ./helpers/ugc-test in: ${bad.join(', ')}`);
});
