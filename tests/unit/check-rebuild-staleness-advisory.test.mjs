import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { run } = require('../../scripts/check-rebuild-staleness-advisory.js');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// A real (temp) data/ tree run through the real scan — no mocks of the
// includability predicates (memory/feedback_includability_predicates_must_be_canonical.md).
function fixture({ reviewsShowIds, reviewsJson } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-adv-'));
  const show = { id: 'x-2026', title: 'X', openingDate: '2026-01-01', status: 'open' };
  fs.writeFileSync(path.join(dataDir, 'shows.json'), JSON.stringify({ shows: [show] }));
  fs.writeFileSync(
    path.join(dataDir, 'reviews.json'),
    reviewsJson ?? JSON.stringify({ reviews: (reviewsShowIds || []).map((showId) => ({ showId })) }),
  );
  const dir = path.join(dataDir, 'review-texts', 'x-2026');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nytimes--jane-doe.json'), JSON.stringify({
    showId: 'x-2026', outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jane Doe',
    url: 'https://www.nytimes.com/2026/01/01/theater/x-review.html', publishDate: '2026-01-01',
    assignedScore: 80, contentTier: 'complete', fullText: 'word '.repeat(400),
  }));
  const showsFile = path.join(dataDir, 'drifted.txt');
  fs.writeFileSync(showsFile, 'x-2026\n');
  return { dataDir, showsFile };
}

test('no drift (missing/empty shows file) exits 0', () => {
  const { dataDir } = fixture();
  assert.equal(run(['--shows-file=/nonexistent/shows.txt'], dataDir), 0);
  assert.equal(run([], dataDir), 0);
});

test('drifted scoreable show present in reviews.json exits 0', () => {
  const { dataDir, showsFile } = fixture({ reviewsShowIds: ['x-2026'] });
  assert.equal(run([`--shows-file=${showsFile}`], dataDir), 0);
});

test('drifted scoreable show missing from reviews.json exits 1 and writes the step summary', () => {
  const { dataDir, showsFile } = fixture({ reviewsShowIds: ['other-show'] });
  const summary = path.join(dataDir, 'summary.md');
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    assert.equal(run([`--shows-file=${showsFile}`], dataDir), 1);
  } finally {
    delete process.env.GITHUB_STEP_SUMMARY;
  }
  assert.match(fs.readFileSync(summary, 'utf8'), /Shows: x-2026/);
});

test('unreadable reviews.json exits 1', () => {
  const { dataDir, showsFile } = fixture({ reviewsJson: '{not json' });
  assert.equal(run([`--shows-file=${showsFile}`], dataDir), 1);
});

test('never writes tracked state: no data/audit/ or guard-escalation writes', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/check-rebuild-staleness-advisory.js'), 'utf8');
  assert.doesNotMatch(src, /require\([^)]*(guard-escalation|owner-alert-router)/);
  assert.doesNotMatch(src, /writeFileSync/);
});

test('CLI entry point runs (exit 0 on no drift)', () => {
  const out = execFileSync('node', ['scripts/check-rebuild-staleness-advisory.js', '--shows-file=/nonexistent'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  assert.match(out, /nothing to verify/);
});
