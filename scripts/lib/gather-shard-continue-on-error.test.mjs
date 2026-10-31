// BRO-6021: a gather shard whose Playwright install stalls must keep going.
// Behaviour of the action's optional input is tested in
// tests/unit/setup-playwright-retry.test.mjs (runs the real run: block); this
// file locks the wiring: only the gather job (and, since BRO-5955, the
// opening-night poller's poll job) opts in, and gather-reviews.js
// drops `chromium` when the browser binary is missing so its HTTP fallbacks run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Jobs in a workflow whose Setup Playwright step passes optional: 'true'.
function optionalJobs(file) {
  const lines = read(file).split('\n');
  let job = null;
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(/^  ([\w-]+):\s*$/);
    if (m) job = m[1];
    if (l.includes('./.github/actions/setup-playwright')) {
      const withBlock = lines.slice(i + 1, i + 4).join('\n');
      if (/optional:\s*'true'/.test(withBlock)) out.push(job);
    }
  });
  return out;
}

// BRO-5955: the opening-night poller opts in too. An apt mirror stall in
// Setup Playwright failed the whole poll run (39880121721); its fetches fall
// through to the paid tiers without a local browser.
const OPTED_IN = {
  'gather-reviews.yml': ['gather-reviews'],
  'opening-night-poller.yml': ['poll'],
};

test('only the gather-reviews and poller poll jobs pass optional: true to Setup Playwright', () => {
  for (const [f, jobs] of Object.entries(OPTED_IN)) {
    assert.deepEqual(optionalJobs(`.github/workflows/${f}`), jobs, f);
  }
});

test('no other workflow opts in to optional Playwright (fail-closed elsewhere)', () => {
  const dir = path.join(root, '.github', 'workflows');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml') && !(n in OPTED_IN))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /setup-playwright\s*\n\s+with:\s*\n\s+optional:/, f);
  }
});

test('gather-reviews.js nulls chromium when the browser binary is missing', () => {
  const src = read('scripts/gather-reviews.js');
  assert.match(src, /const candidate = playwright\.chromium;\s*if \(fs\.existsSync\(candidate\.executablePath\(\)\)\s*\|\|\s*require\('\.\/lib\/playwright-exe'\)\.launchExtras\(candidate\)\.executablePath\) \{\s*chromium = candidate;/);
});
