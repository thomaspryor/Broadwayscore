import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./reconcile-core-data-registry.js', import.meta.url));

function run(cwd, snapshotDir) {
  return execFileSync('node', [SCRIPT, snapshotDir], { cwd, encoding: 'utf8' });
}

test('reconcile-core-data-registry: unions remote-only slugs into a registered private-core-data file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    fs.writeFileSync(
      path.join(checkout, 'awards.json'),
      JSON.stringify({ shows: { a: { tony: {} } } }, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(snapshot, 'awards.json'),
      JSON.stringify({ shows: { a: { tony: {} }, b: { olivier: {} } } }, null, 2) + '\n',
    );

    const out = run(checkout, snapshot);
    assert.equal(out.trim(), 'awards.json');

    const merged = JSON.parse(fs.readFileSync(path.join(checkout, 'awards.json'), 'utf8'));
    assert.deepEqual(Object.keys(merged.shows).sort(), ['a', 'b']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: no-op when local already matches (nothing printed, file untouched)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    const content = JSON.stringify({ shows: { a: { tony: {} } } }, null, 2) + '\n';
    fs.writeFileSync(path.join(checkout, 'awards.json'), content);
    fs.writeFileSync(path.join(snapshot, 'awards.json'), content);

    const out = run(checkout, snapshot);
    assert.equal(out.trim(), '');
    assert.equal(fs.readFileSync(path.join(checkout, 'awards.json'), 'utf8'), content);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: skips a file that is untouched locally (was never synced this run)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    // No awards.json locally at all — reconciliation must not fabricate one.
    fs.writeFileSync(path.join(snapshot, 'awards.json'), JSON.stringify({ shows: {} }));

    const out = run(checkout, snapshot);
    assert.equal(out.trim(), '');
    assert.equal(fs.existsSync(path.join(checkout, 'awards.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: fails open on a corrupt remote snapshot (skips that file, exits 0)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    const content = JSON.stringify({ shows: { a: {} } }, null, 2) + '\n';
    fs.writeFileSync(path.join(checkout, 'awards.json'), content);
    fs.writeFileSync(path.join(snapshot, 'awards.json'), '{not valid json');

    const out = run(checkout, snapshot); // must not throw
    assert.equal(out.trim(), '');
    assert.equal(fs.readFileSync(path.join(checkout, 'awards.json'), 'utf8'), content);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: reconciles multiple registered files independently in one run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });

    fs.writeFileSync(path.join(checkout, 'awards.json'), JSON.stringify({ shows: { a: {} } }));
    fs.writeFileSync(path.join(snapshot, 'awards.json'), JSON.stringify({ shows: { a: {}, b: {} } }));
    fs.writeFileSync(path.join(checkout, 'opening-night-sent.json'), JSON.stringify({ shows: { x: {} } }));
    fs.writeFileSync(path.join(snapshot, 'opening-night-sent.json'), JSON.stringify({ shows: { x: {}, y: {} } }));

    const out = run(checkout, snapshot);
    assert.deepEqual(out.trim().split('\n').sort(), ['awards.json', 'opening-night-sent.json']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reconcile-core-data-registry: a dropped Unknown-byline fossil leaves a durable tombstone file (BRO-2918)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    const base = { showId: 's', outlet: 'Radio Times', outletId: 'radio-times', url: 'https://www.radiotimes.com/a/review/', assignedScore: 80 };
    fs.writeFileSync(path.join(checkout, 'reviews.json'), JSON.stringify({
      _meta: { lastUpdated: '2026-10-02T00:00:00Z' },
      reviews: [{ ...base, criticName: 'Olivia Garrett', fullText: 'x'.repeat(500) }],
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(snapshot, 'reviews.json'), JSON.stringify({
      _meta: { lastUpdated: '2026-10-01T00:00:00Z' },
      reviews: [{ ...base, criticName: 'Unknown' }],
    }, null, 2) + '\n');

    // Fossil only in the remote snapshot: local bytes are unchanged, but the
    // merge still declined to carry it, so the decision is recorded and
    // reviews.json is NOT listed as changed.
    const quiet = run(checkout, snapshot).trim().split('\n');
    assert.equal(quiet.length, 1);
    assert.match(quiet[0], /^review-merge-tombstones\/.+\.jsonl$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(checkout, quiet[0]), 'utf8').trim()).supersededBy, 'Olivia Garrett');

    // Fossil present in ours (local carried the stale identity): merge drops it.
    fs.writeFileSync(path.join(checkout, 'reviews.json'), JSON.stringify({
      _meta: { lastUpdated: '2026-10-02T00:00:00Z' },
      reviews: [{ ...base, criticName: 'Olivia Garrett', fullText: 'x'.repeat(500) }, { ...base, criticName: 'Unknown' }],
    }, null, 2) + '\n');
    const out = run(checkout, snapshot).trim().split('\n');
    assert.equal(out.length, 2);
    assert.equal(out[1], 'reviews.json');
    assert.match(out[0], /^review-merge-tombstones\/.+\.jsonl$/);
    const row = JSON.parse(fs.readFileSync(path.join(checkout, out[0]), 'utf8').trim());
    assert.equal(row.supersededBy, 'Olivia Garrett');
    assert.equal(row.url, base.url);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// BRO-4809: the action consumed this script's stdout with `while read -r f`,
// which skips an unterminated last line. reviews.json is always listed last, so
// the reconciled (deduped) file was never staged and the duplicate got pushed.
// These tests run the REAL consumer loop extracted from push-core-data/action.yml.
const ACTION = fileURLToPath(new URL('../../.github/actions/push-core-data/action.yml', import.meta.url));

function extractConsumerLoop() {
  const yml = fs.readFileSync(ACTION, 'utf8');
  const m = yml.match(/(while IFS= read -r f(?:(?!while IFS= read)[\s\S])*?done < \/tmp\/\.reconciled-registry-files)/);
  assert.ok(m, 'could not find the reconciled-registry-files consumer loop in push-core-data/action.yml');
  return m[1].replace('/tmp/.reconciled-registry-files', '"$LIST"');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('reconcile-core-data-registry: stdout is newline-terminated (BRO-4809)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'awards.json'), JSON.stringify({ shows: { a: {} } }, null, 2) + '\n');
    fs.writeFileSync(path.join(snapshot, 'awards.json'), JSON.stringify({ shows: { a: {}, b: {} } }, null, 2) + '\n');
    const out = run(checkout, snapshot);
    assert.ok(out.endsWith('\n'), `stdout must end with a newline, got ${JSON.stringify(out)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('push-core-data consumer loop stages the deduped reviews.json that follows a tombstone (BRO-4809 regression)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const snapshot = path.join(tmp, 'snapshot');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(snapshot, { recursive: true });
    const row = { showId: 's', outlet: 'Off Off Online', outletId: 'off-off-online', url: 'https://x.test/a', criticName: 'Marc Miller', assignedScore: 56 };
    const doc = (rows) => JSON.stringify({ _meta: { lastUpdated: '2026-10-06T18:43:08Z' }, reviews: rows }, null, 2) + '\n';
    fs.writeFileSync(path.join(snapshot, 'reviews.json'), doc([row]));
    // "ours" already holds the duplicate (the run-37502222919 shape)
    fs.writeFileSync(path.join(checkout, 'reviews.json'), doc([row, { ...row }]));
    git(checkout, 'init', '-q');
    git(checkout, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'reviews.json');
    git(checkout, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');

    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, run(checkout, snapshot));
    assert.ok(fs.readFileSync(list, 'utf8').includes('reviews.json'), 'merge must have rewritten reviews.json');

    // `bash -e` mirrors the composite step's shell; LIST avoids the /tmp path.
    execFileSync('bash', ['-e', '-c', extractConsumerLoop()], { cwd: checkout, env: { ...process.env, LIST: list } });
    const staged = git(checkout, 'diff', '--staged', '--name-only').split('\n');
    assert.ok(staged.includes('reviews.json'), `reviews.json must be staged, got ${JSON.stringify(staged)}`);
    const stagedDoc = JSON.parse(git(checkout, 'show', ':reviews.json'));
    assert.equal(stagedDoc.reviews.length, 1, 'staged reviews.json must be the deduped copy');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('push-core-data consumer loop tolerates an unterminated / missing last line under bash -e', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    git(tmp, 'init', '-q');
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}\n');
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, 'a.json\ngone.json'); // no trailing newline, last file absent
    execFileSync('bash', ['-e', '-c', extractConsumerLoop()], { cwd: tmp, env: { ...process.env, LIST: list } });
    assert.deepEqual(git(tmp, 'diff', '--staged', '--name-only').split('\n').filter(Boolean), ['a.json']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// BRO-4852: the third arg is the job's pre-run snapshot; reviews.json uses it
// so a row our rebuild excluded is not unioned back from remote.
test('reconcile-core-data-registry: base dir keeps rebuild exclusions out of reviews.json; bad/missing base falls back to union', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-core-data-'));
  try {
    const checkout = path.join(tmp, 'checkout');
    const remoteDir = path.join(tmp, 'remote');
    const baseDir = path.join(tmp, 'base');
    for (const d of [checkout, remoteDir, baseDir]) fs.mkdirSync(d, { recursive: true });
    const kept = { showId: 'wicked-2003', outlet: 'Variety', criticName: 'Marilyn Stasio', assignedScore: 80 };
    const wrong = { showId: 'two-girls-off-broadway-2026', outlet: 'The Guardian', criticName: null, assignedScore: 87 };
    const added = { showId: 'soon-off-broadway-2026', outlet: 'Time Out', criticName: 'Adam Feldman', assignedScore: 70 };
    const write = (dir, reviews) => fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ _meta: {}, reviews }, null, 2) + '\n');
    const showIds = () => JSON.parse(fs.readFileSync(path.join(checkout, 'reviews.json'), 'utf8')).reviews.map((r) => r.showId).sort();

    write(checkout, [kept]); write(remoteDir, [kept, wrong, added]); write(baseDir, [kept, wrong]);
    execFileSync('node', [SCRIPT, remoteDir, baseDir], { cwd: checkout, encoding: 'utf8' });
    assert.deepEqual(showIds(), ['soon-off-broadway-2026', 'wicked-2003']);
    assert.ok(fs.readdirSync(path.join(checkout, 'review-merge-tombstones')).length >= 1, 'drop leaves a tombstone');

    write(checkout, [kept]); fs.writeFileSync(path.join(baseDir, 'reviews.json'), '{not json');
    execFileSync('node', [SCRIPT, remoteDir, baseDir], { cwd: checkout, encoding: 'utf8' });
    assert.deepEqual(showIds(), ['soon-off-broadway-2026', 'two-girls-off-broadway-2026', 'wicked-2003']);

    write(checkout, [kept]);
    execFileSync('node', [SCRIPT, remoteDir, path.join(tmp, 'missing')], { cwd: checkout, encoding: 'utf8' });
    assert.deepEqual(showIds(), ['soon-off-broadway-2026', 'two-girls-off-broadway-2026', 'wicked-2003']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
