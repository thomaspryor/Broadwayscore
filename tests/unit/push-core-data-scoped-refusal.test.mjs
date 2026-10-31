// Synthetic shows fixture: validate-data runs on it, so live-data errors must not leak in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BASELINE_NAME, snapshotReviews, createReviewValidationScope } = require('../../scripts/lib/review-validation-scope');
const { mergeReviewsJson } = require('../../scripts/lib/merge-reviews-json');
const { classifyDateGuardBackstop } = require('../../scripts/lib/date-guard-hold');
const ROOT = path.resolve(import.meta.dirname, '../..');
const action = fs.readFileSync(path.join(ROOT, '.github/actions/push-core-data/action.yml'), 'utf8');
// Execute the actual refusal step, never a mirrored decision table.
const refusal = action.split('      run: |\n')[1].split('\n    - name:')[0]
  .split('\n').map(line => line.replace(/^        /, '')).join('\n');
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5042-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts/validate-data.js'), path.join(dir, 'scripts/validate-data.js'));
    // Image-pointer validation reads the optimizer allow-list from the real config.
    fs.copyFileSync(path.join(ROOT, 'next.config.js'), path.join(dir, 'next.config.js'));
    fs.symlinkSync(path.join(ROOT, 'scripts/lib'), path.join(dir, 'scripts/lib'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    fs.mkdirSync(path.join(dir, 'data/review-texts/scope-show-2026'), { recursive: true });
    // A synthetic corpus, not the live data/shows.json: a data error anywhere in
    // the live corpus (e.g. 28 stale theaterAddress rows on 2026-10-12) made
    // validate-data exit 1 and turned these push-gate tests red on main.
    // Sized to clear validate-data's corpus floors (30 shows, 15 open).
    const words = ['amber', 'birch', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper',
      'kestrel', 'lagoon', 'meadow', 'nickel', 'orchid', 'pewter', 'quartz', 'raven', 'saffron', 'tundra',
      'umber', 'velvet', 'willow', 'xenon', 'yarrow', 'zephyr', 'aspen', 'basalt', 'cypress', 'dune'];
    const shows = { _meta: {}, shows: words.map((w, i) => ({
      id: `${w}-off-broadway-2025`, slug: `${w}-off-broadway-2025`, title: w[0].toUpperCase() + w.slice(1),
      status: i < 15 ? 'open' : 'closed', category: 'off-broadway', market: 'broadway', type: 'play',
      venue: `${w} hall`, openingDate: '2025-01-01', ...(i < 15 ? {} : { closingDate: '2025-06-01' }) })) };
    shows.shows.push({ id: 'scope-show-2026', slug: 'scope-show-2026', title: 'Scoped Review Test',
      status: 'closed', category: 'off-broadway', market: 'broadway', type: 'play',
      venue: 'Test Theatre', openingDate: '2026-01-01', closingDate: '2026-06-01' });
    fs.writeFileSync(path.join(dir, 'data/shows.json'), JSON.stringify(shows));
    fs.mkdirSync(path.join(dir, 'core-data-snapshot'));
    fs.writeFileSync(path.join(dir, 'core-data-snapshot/shows.json'), JSON.stringify(shows));
    const review = { showId: 'scope-show-2026', outletId: 'nyt', outlet: 'The New York Times',
      criticName: 'Test Critic', publishDate: '2020-01-01', assignedScore: 75, allowEarlyDate: true,
      url: 'https://example.com/review', fullText: 'A review of the production.' };
    const source = path.join(dir, 'data/review-texts/scope-show-2026/nyt.json');
    fs.writeFileSync(source, JSON.stringify(review));
    fs.writeFileSync(path.join(dir, 'data/reviews.json'), JSON.stringify({ reviews: [review] }));
    snapshotReviews(path.join(dir, 'data/review-texts'), path.join(dir, BASELINE_NAME));
    fn({ dir, source, review });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function validate(dir) {
  const logFile = path.join(dir, 'validation.log');
  const fd = fs.openSync(logFile, 'w');
  // Redirect only checkout-snapshot reads so parallel tests never share or
  // overwrite the runner's /tmp/core-data-snapshot. Run the real validator.
  const entry = `
    const fs = require('fs');
    const path = require('path');
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (typeof file === 'string' && file.startsWith('/tmp/core-data-snapshot/')) {
        file = path.join(${JSON.stringify(dir)}, 'core-data-snapshot', path.basename(file));
      }
      return read.call(this, file, ...args);
    };
    require(${JSON.stringify(path.join(dir, 'scripts/validate-data.js'))});
  `;
  const result = spawnSync(process.execPath, ['-e', entry], {
    cwd: dir, env: { ...process.env, RUNNER_TEMP: dir, VALIDATE_DATA_SHOWS_JSON: '' },
    stdio: ['ignore', fd, fd], timeout: 120000,
  });
  fs.closeSync(fd);
  assert.ifError(result.error);
  const output = path.join(dir, 'push-output');
  const gate = spawnSync('bash', ['-e', '-c', refusal], {
    env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output }, encoding: 'utf8',
  });
  assert.equal(gate.status, 0, gate.stderr);
  return { status: result.status, log: fs.readFileSync(logFile, 'utf8'), skip: fs.readFileSync(output, 'utf8') };
}
function scopeFor(dir, reviewsBaselineFile) {
  return createReviewValidationScope(path.join(dir, 'data/review-texts'), path.join(dir, BASELINE_NAME),
    reviewsBaselineFile, { showsBaselineFile: path.join(dir, 'core-data-snapshot/shows.json') });
}

test('unchanged per-review ERROR warns, quarantines the row and permits the actual push gate', () => {
  fixture(({ dir }) => {
    const result = validate(dir);
    assert.equal(result.status, 0, result.log);
    assert.match(result.log, /WARNING: \[unchanged-review\].*wrong-production-by-date/);
    assert.equal(result.skip, 'skip=false\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/reviews.json'))).reviews.length, 0);
  });
});
test('the same ERROR in a job-modified file still refuses the actual push gate', () => {
  fixture(({ dir, source, review }) => {
    fs.writeFileSync(source, JSON.stringify({ ...review, excerpt: 'Changed by this job' }));
    const result = validate(dir);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /ERROR: \[wrong-production-by-date\]/);
    assert.equal(result.skip, 'skip=true\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/reviews.json'))).reviews.length, 1);
  });
});
test('an unchanged review refuses the push when this job changes its show openingDate', () => {
  fixture(({ dir, source, review }) => {
    const snapshot = path.join(dir, 'core-data-snapshot/shows.json');
    const shows = JSON.parse(fs.readFileSync(snapshot));
    const show = shows.shows.find(show => show.id === review.showId);
    show.openingDate = review.publishDate;
    assert.equal(classifyDateGuardBackstop({ review, show }).kind, 'ok');
    fs.writeFileSync(snapshot, JSON.stringify(shows));
    show.openingDate = '2026-01-01';
    fs.writeFileSync(path.join(dir, 'data/shows.json'), JSON.stringify(shows));
    // The checkout-time date was plausible. This job moved openingDate to
    // 2026 in data/shows.json, creating the wrong-production-by-date error.
    const before = fs.readFileSync(path.join(dir, 'data/reviews.json'));
    const sourceBefore = fs.readFileSync(source);
    const result = validate(dir);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /ERROR: \[wrong-production-by-date\]/);
    assert.equal(result.skip, 'skip=true\n');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'data/reviews.json')), before);
    assert.deepEqual(fs.readFileSync(source), sourceBefore);
  });
});
test('changed show dates, credits and markets block both source and derived review errors', () => {
  fixture(({ dir, review }) => {
    const file = path.join(dir, 'data/shows.json');
    const original = JSON.parse(fs.readFileSync(file));
    const reviewsBase = path.join(dir, 'core-data-snapshot/reviews.json');
    fs.writeFileSync(reviewsBase, JSON.stringify({ reviews: [review] }));
    for (const patch of [{ openingDate: '2027-01-01' },
      { creativeTeam: [{ name: review.criticName, role: 'Director' }] }, { market: 'west-end' }]) {
      const shows = structuredClone(original);
      Object.assign(shows.shows.find(show => show.id === review.showId), patch);
      fs.writeFileSync(file, JSON.stringify(shows));
      const scope = scopeFor(dir, reviewsBase);
      const errors = [];
      const callbacks = { error: msg => errors.push(msg), warn: assert.fail };
      scope.reportError('source error', 'scope-show-2026/nyt.json', review, callbacks);
      scope.reportRowError('derived error', review, callbacks);
      assert.deepEqual(errors, ['source error', 'derived error']);
      assert.equal(scope.quarantined.size, 0);
    }
  });
});
test('missing, unreadable or malformed show snapshots fail closed for files and rows', () => {
  fixture(({ dir, review }) => {
    const file = path.join(dir, 'core-data-snapshot/shows.json');
    const reviewsBase = path.join(dir, 'core-data-snapshot/reviews.json');
    fs.writeFileSync(reviewsBase, JSON.stringify({ reviews: [review] }));
    for (const contents of [null, '{broken', '{}', '{"shows":[null]}', '{"shows":[]}']) {
      if (contents === null) fs.unlinkSync(file); else fs.writeFileSync(file, contents);
      const scope = scopeFor(dir, reviewsBase);
      const errors = [];
      const callbacks = { error: msg => errors.push(msg), warn: assert.fail };
      scope.reportError('source error', 'scope-show-2026/nyt.json', review, callbacks);
      scope.reportRowError('derived error', review, callbacks);
      assert.deepEqual(errors, ['source error', 'derived error']);
    }
    fs.unlinkSync(file);
    fs.mkdirSync(file); // EISDIR even when the test runner has root permissions.
    const scope = scopeFor(dir, reviewsBase);
    const errors = [];
    const callbacks = { error: msg => errors.push(msg), warn: assert.fail };
    scope.reportError('source unreadable', 'scope-show-2026/nyt.json', review, callbacks);
    scope.reportRowError('derived unreadable', review, callbacks);
    assert.deepEqual(errors, ['source unreadable', 'derived unreadable']);
  });
});
test('changes to another show permit warning, but absent current show records fail closed', () => {
  fixture(({ dir, review }) => {
    const file = path.join(dir, 'data/shows.json');
    const shows = JSON.parse(fs.readFileSync(file));
    shows.shows.find(show => show.id !== review.showId).title += ' updated';
    fs.writeFileSync(file, JSON.stringify(shows));
    const scope = scopeFor(dir);
    scope.reportError('unchanged show', 'scope-show-2026/nyt.json', review, { error: assert.fail, warn: () => {} });
    assert.equal(scope.quarantined.size, 1);
    shows.shows = shows.shows.filter(show => show.id !== review.showId);
    fs.writeFileSync(file, JSON.stringify(shows));
    const errors = [];
    scopeFor(dir).reportError('removed show', 'scope-show-2026/nyt.json', review,
      { error: msg => errors.push(msg), warn: assert.fail });
    assert.deepEqual(errors, ['removed show']);
  });
});
test('show edits after scope creation are checked, and malformed current shows fail closed', () => {
  fixture(({ dir, review }) => {
    const file = path.join(dir, 'data/shows.json');
    const scope = scopeFor(dir);
    const shows = JSON.parse(fs.readFileSync(file));
    shows.shows.find(show => show.id === review.showId).openingDate = '2027-01-01';
    fs.writeFileSync(file, JSON.stringify(shows));
    const errors = [];
    const callbacks = { error: msg => errors.push(msg), warn: assert.fail };
    scope.reportError('edited after creation', 'scope-show-2026/nyt.json', review, callbacks);
    for (const contents of [null, '{broken', '{}', '{"shows":[null]}']) {
      if (contents === null) fs.unlinkSync(file); else fs.writeFileSync(file, contents);
      scopeFor(dir).reportError('unknown current show', 'scope-show-2026/nyt.json', review, callbacks);
    }
    assert.deepEqual(errors, ['edited after creation', ...Array(4).fill('unknown current show')]);
  });
});
test('structural shows.json errors refuse even with unchanged review files', () => {
  fixture(({ dir }) => {
    fs.writeFileSync(path.join(dir, 'data/shows.json'), '{broken');
    const result = validate(dir);
    assert.equal(result.status, 1);
    assert.match(result.log, /shows.json parse error/);
    assert.equal(result.skip, 'skip=true\n');
  });
});
test('missing, corrupt and incomplete baselines fail closed, including newly created files', () => {
  fixture(({ dir, review }) => {
    const file = path.join(dir, BASELINE_NAME);
    for (const contents of [null, '{broken', JSON.stringify({ version: 1, files: {} })]) {
      if (contents === null) fs.unlinkSync(file); else fs.writeFileSync(file, contents);
      const scope = scopeFor(dir);
      const errors = [], warnings = [];
      scope.reportError('bad review', 'scope-show-2026/nyt.json', review, {
        error: msg => errors.push(msg), warn: msg => warnings.push(msg),
      });
      assert.deepEqual(errors, ['bad review']);
      assert.deepEqual(warnings, []);
    }
  });
});
test('quarantine preserves other shows and the existing three-way merger preserves the deletion', () => {
  fixture(({ dir, review }) => {
    const scope = scopeFor(dir);
    scope.reportError('bad review', 'scope-show-2026/nyt.json', review, { error: assert.fail, warn: () => {} });
    const sibling = { ...review, showId: 'another-show-2026' };
    const secondCritic = { ...review, criticName: 'Another Critic' };
    const base = { reviews: [review, sibling, secondCritic] };
    const ours = scope.excludeQuarantinedReviews(base);
    assert.deepEqual(ours.reviews, [sibling, secondCritic]);
    const result = mergeReviewsJson(ours, base, base);
    assert.deepEqual(result.merged.reviews, [sibling, secondCritic]);
  });
});
test('checkout snapshot and validator caller are wired together', () => {
  assert.match(fs.readFileSync(path.join(ROOT, '.github/actions/checkout-review-texts/action.yml'), 'utf8'), /node scripts\/lib\/review-validation-scope.js data\/review-texts/);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/validate-data.js'), 'utf8'), /reviewValidationScope.reportError/);
});

test('derived per-review errors scope to the core snapshot and exclude only the offending row', () => {
  fixture(({ dir, review }) => {
    const baseFile = path.join(dir, 'reviews-base.json');
    const bad = { ...review, assignedScore: 101 };
    fs.writeFileSync(baseFile, JSON.stringify({ reviews: [bad] }));
    const scope = scopeFor(dir, baseFile);
    const errors = [], warnings = [];
    const callbacks = { error: msg => errors.push(msg), warn: msg => warnings.push(msg) };
    scope.reportRowError('out of range', bad, callbacks);
    assert.equal(warnings.length, 1);
    scope.reportRowError('changed', { ...bad, assignedScore: 102 }, callbacks);
    scope.reportRowError('new', { ...bad, criticName: 'New Critic' }, callbacks);
    assert.deepEqual(errors, ['changed', 'new']);
    assert.deepEqual(scope.excludeQuarantinedReviews({ reviews: [bad, { ...bad, criticName: 'Good Critic', assignedScore: 90 }] }).reviews,
      [{ ...bad, criticName: 'Good Critic', assignedScore: 90 }]);
  });
});

test('quarantine still refuses a corpus-wide count regression before writing the payload', () => {
  fixture(({ dir }) => {
    fs.mkdirSync(path.join(dir, 'data/audit'));
    fs.writeFileSync(path.join(dir, 'data/audit/validation-baseline.json'), JSON.stringify({ totalReviews: 2 }));
    const result = validate(dir);
    assert.equal(result.status, 1, result.log);
    assert.equal(result.skip, 'skip=true\n');
    assert.match(fs.readFileSync(path.join(dir, '.skip-push-core-data'), 'utf8'), /corpus-wide review count threshold/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/reviews.json'))).reviews.length, 1);
  });
});

test('a partially malformed derived snapshot cannot downgrade an error', () => {
  fixture(({ dir, review }) => {
    const baseFile = path.join(dir, 'reviews-base.json');
    fs.writeFileSync(baseFile, JSON.stringify({ reviews: [review, null] }));
    const scope = scopeFor(dir, baseFile);
    const errors = [];
    scope.reportRowError('bad row', review, { error: msg => errors.push(msg), warn: assert.fail });
    assert.deepEqual(errors, ['bad row']);
  });
});
