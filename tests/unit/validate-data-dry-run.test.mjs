// TESTS-VS-DERIVED-DATA-EXEMPT: the spawn case copies data/shows.json only as an opaque fixture (hash before must equal hash after); no factual pins.
/**
 * --dry-run for validate-data.js (Sprint 0 / S0-T1).
 *
 * The flag is enforced at ONE seam: createShowsWriteGuard(path, { dryRun })
 * returns a saveShows() that records the intended write on a ledger and
 * returns without touching disk. validate-data.js passes the flag through,
 * so its four auto-fix write sites need no per-site handling, and prints
 * "DRY RUN: N shows.json writes suppressed" at exit.
 *
 * Unit cases require() the real factory (CLAUDE.md §15) against a throwaway
 * fixture. The spawn case runs the real script with --dry-run against a copy
 * of the live corpus with one stale-previews row planted, so at least one
 * auto-fix write is attempted and must be suppressed; it pins the CLI wiring
 * (flag → guard → summary line) that the unit cases cannot. Isolation mirrors
 * validate-data-venue-complex-wiring.test.mjs: RUNNER_TEMP is sandboxed so the
 * child's sentinel path is inside the test's own directory, and both streams
 * go to a file (warn() is stderr; buffered capture hits maxBuffer on CI).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShowsWriteGuard } = require('../../scripts/lib/shows-write-guard.js');
const { AtomicWriteShrinkError } = require('../../scripts/lib/atomic-shows-write.js');

const ROOT = path.join(import.meta.dirname, '..', '..');
const VALIDATE = path.join(ROOT, 'scripts', 'validate-data.js');
const REAL_SHOWS_JSON = path.join(ROOT, 'data', 'shows.json');

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const FIXTURE = {
  _meta: { lastUpdated: '2026-01-01T00:00:00.000Z', totalShows: 3 },
  shows: [
    { id: 'alpha-2026', title: 'Alpha', slug: 'alpha-2026', status: 'previews', openingDate: '2026-01-10' },
    { id: 'beta-2026', title: 'Beta', slug: 'beta-2026', status: 'open', openingDate: '2025-11-01' },
    { id: 'gamma-2026', title: 'Gamma', slug: 'gamma-2026', status: 'closed', openingDate: '2025-01-01', closingDate: '2025-06-01' },
  ],
};

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-data-dry-run-'));
  const showsPath = path.join(dir, 'shows.json');
  fs.writeFileSync(showsPath, JSON.stringify(FIXTURE, null, 2) + '\n');
  try { return fn(showsPath, dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('createShowsWriteGuard({ dryRun: true })', () => {
  test('saveShows records the write and leaves the file byte-identical', () => {
    withFixture((showsPath) => {
      const before = fs.readFileSync(showsPath);
      const hashBefore = sha256(showsPath);

      const guard = createShowsWriteGuard(showsPath, { dryRun: true });
      assert.equal(guard.dryRun, true);
      const data = guard.loadShows();
      data.shows.find((s) => s.id === 'alpha-2026').status = 'open';
      const result = guard.saveShows(data, { reason: 'validateDates' });

      assert.equal(Buffer.compare(before, fs.readFileSync(showsPath)), 0, 'file bytes changed under dryRun');
      assert.equal(sha256(showsPath), hashBefore);
      assert.equal(guard.suppressedWrites.length, 1, 'exactly one suppressed write recorded');
      assert.equal(guard.suppressedWrites[0].reason, 'validateDates');
      assert.equal(guard.suppressedWrites[0].showCount, 3);
      assert.equal(result.wrote, false);
      assert.equal(result.dryRun, true);
      assert.equal(result.reason, 'validateDates');
      // No lock was taken, so no lock dir can have been left behind.
      assert.equal(fs.existsSync(guard.lockDir), false, 'dry run must not touch the lock');

      // A second call is a second ledger entry, still no write.
      guard.saveShows(data);
      assert.equal(guard.suppressedWrites.length, 2);
      assert.equal(guard.suppressedWrites[1].reason, null);
      assert.equal(sha256(showsPath), hashBefore);
    });
  });
});

describe('createShowsWriteGuard({ dryRun: false }) and the default', () => {
  test('dryRun: false — the same mutation reaches disk and nothing is recorded', () => {
    withFixture((showsPath) => {
      const hashBefore = sha256(showsPath);
      const guard = createShowsWriteGuard(showsPath, { dryRun: false });
      assert.equal(guard.dryRun, false);
      const data = guard.loadShows();
      data.shows.find((s) => s.id === 'alpha-2026').status = 'open';
      const result = guard.saveShows(data, { reason: 'validateDates' });

      assert.notEqual(sha256(showsPath), hashBefore, 'file must change when dryRun is off');
      const onDisk = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      assert.equal(onDisk.shows.find((s) => s.id === 'alpha-2026').status, 'open');
      assert.equal(onDisk._meta.totalShows, 3);
      assert.equal(result.wrote, true);
      assert.equal(guard.suppressedWrites.length, 0);
    });
  });

  test('no options at all — existing callers keep writing (back-compat)', () => {
    withFixture((showsPath) => {
      const hashBefore = sha256(showsPath);
      const guard = createShowsWriteGuard(showsPath);
      assert.equal(guard.dryRun, false);
      const data = guard.loadShows();
      data.shows.find((s) => s.id === 'beta-2026').status = 'closed';
      guard.saveShows(data);
      assert.notEqual(sha256(showsPath), hashBefore);
      assert.equal(JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows.find((s) => s.id === 'beta-2026').status, 'closed');
    });
  });

  test('`reason` is stripped before the real write; other save options still forward', () => {
    withFixture((showsPath) => {
      const guard = createShowsWriteGuard(showsPath);
      // Dropping 2 of 3 shows is a >5% line-count shrink: refused unless the
      // caller passes allowShrink. `reason` alongside it must not get in the way.
      const shrunk = () => {
        const data = guard.loadShows();
        data.shows = data.shows.slice(0, 1);
        return data;
      };
      assert.throws(() => guard.saveShows(shrunk(), { reason: 'test' }), AtomicWriteShrinkError);
      const result = guard.saveShows(shrunk(), { reason: 'test', allowShrink: true });
      assert.equal(result.wrote, true);
      assert.equal(JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows.length, 1);
    });
  });
});

describe('validate-data.js --dry-run (CLI wiring, real script)', () => {
  // Skip when the private core data isn't wired in (CI without the checkout).
  if (!fs.existsSync(REAL_SHOWS_JSON)) {
    test('[skip] data/shows.json absent in this context', () => {});
    return;
  }

  test('leaves the corpus byte-identical, suppresses the planted auto-fix write, and prints the summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-data-dry-run-spawn-'));
    const fixturePath = path.join(dir, 'shows.json');
    const outPath = path.join(dir, 'validate-data.out');
    const sandboxSentinel = path.join(dir, '.skip-push-core-data');
    let out = '';
    let status = 0;
    let hashBefore;
    let hashAfter;
    let sentinelLandedInSandbox = false;
    let fd;
    try {
      // Copy of the live corpus plus one row validateDates MUST auto-fix
      // (status previews, opening long past) — that is the write --dry-run has
      // to swallow. Everything else the row trips is irrelevant here; we never
      // assert on the exit code.
      const data = JSON.parse(fs.readFileSync(REAL_SHOWS_JSON, 'utf8'));
      data.shows.push({
        id: 'dry-run-stale-previews-fixture-2020',
        title: 'Dry Run Stale Previews Fixture',
        slug: 'dry-run-stale-previews-fixture-2020',
        venue: 'Fixture Theatre',
        category: 'broadway',
        market: 'broadway',
        status: 'previews',
        type: 'play',
        openingDate: '2020-01-01',
        closingDate: null,
        previewsStartDate: null,
        isRevival: false,
        tags: [],
        cast: [],
        creativeTeam: [],
        images: {},
        synopsis: '',
        runtime: null,
        intermissions: null,
        ageRecommendation: null,
      });
      fs.writeFileSync(fixturePath, JSON.stringify(data, null, 2) + '\n');
      hashBefore = sha256(fixturePath);

      fd = fs.openSync(outPath, 'w');
      const res = spawnSync('node', [VALIDATE, '--dry-run'], {
        stdio: ['ignore', fd, fd],
        env: { ...process.env, VALIDATE_DATA_SHOWS_JSON: fixturePath, RUNNER_TEMP: dir },
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.error) throw res.error;
      status = res.status ?? 0;
      fs.closeSync(fd);
      fd = undefined;
      out = fs.readFileSync(outPath, 'utf8');
      hashAfter = sha256(fixturePath);
      assert.ok(out.length > 0, 'validate-data.js produced no output at all — the redirect or the spawn is broken');
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      sentinelLandedInSandbox = fs.existsSync(sandboxSentinel);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    assert.equal(hashAfter, hashBefore, 'shows.json fixture changed under --dry-run');
    assert.match(out, /Mode: (STRICT|STANDARD) \(DRY RUN — no writes\)/);

    const summary = out.match(/^DRY RUN: (\d+) shows\.json writes suppressed$/m);
    assert.ok(summary, 'exit summary line "DRY RUN: N shows.json writes suppressed" missing');
    assert.ok(Number(summary[1]) >= 1, `planted stale-previews row should have produced >=1 suppressed write, got ${summary[1]}`);
    assert.match(out, /validateDates \(stale previews\/upcoming → open\)/, 'ledger should name the validator that tried to write');
    assert.match(out, /Would auto-fix \(dry run\) \d+ stale previews → open/);

    // Audit artifacts: reported, not written.
    assert.match(out, /^DRY RUN: \d+ audit artifact writes suppressed$/m);
    assert.match(out, /DRY RUN: would write .+ → data\/audit\/.+ \(\d+ bytes\) — suppressed/);

    // The sentinel is suppressed too — even on a failing run, which the
    // planted row makes likely — and the run says so.
    assert.equal(sentinelLandedInSandbox, false, '--dry-run wrote the push-refusal sentinel');
    if (status !== 0) {
      assert.match(out, /DRY RUN: would write push-refusal sentinel/);
    }
  });
});
