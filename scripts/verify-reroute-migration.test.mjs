/**
 * Verifies a migrate-reroute-backlog.js run actually landed cleanly.
 *
 * Delegates the core checks (source gone, target present, target showId
 * correct, no lingering wrongProduction flag) to the script's own
 * `--verify` mode (scripts/migrate-reroute-backlog.js:477-522) rather than
 * re-implementing them here — two independently-maintained copies of "what
 * does a clean migration look like" would silently desync the moment the
 * safety classifier changes. This suite only adds checks `--verify` doesn't
 * already do: the routedFromShowId audit trail, and no filename landing at
 * more than one target.
 *
 * The log files (data/reroute-migration-log[-cross-market].json) are
 * one-time, gitignored artifacts (see .gitignore — they embed full review
 * text, so they must never reach the public repo). When neither is present
 * — the normal state in CI, and once a migration's been reviewed and the
 * log cleaned up locally — this suite skips rather than fails, so it stays
 * green as a permanent regression check without requiring the artifact
 * forever.
 *
 * Run: node --test scripts/verify-reroute-migration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveReviewTextsDir } = require('./lib/review-texts-dir.js');

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE_SCRIPT = path.join(SCRIPTS_DIR, 'migrate-reroute-backlog.js');

const reviewTextsDir = resolveReviewTextsDir();
const dataDir = path.dirname(reviewTextsDir);

const MODES = [
  { flag: [], logFile: path.join(dataDir, 'reroute-migration-log.json') },
  { flag: ['--cross-market'], logFile: path.join(dataDir, 'reroute-migration-log-cross-market.json') },
];

// A present-but-empty log is a legitimate real state (a dry-run found zero
// safe candidates and --execute was run anyway) — proved live in this repo:
// running --cross-market --execute against an already-cleaned corpus wrote
// `[]`. That's "nothing to verify", not a broken migration, so it's treated
// the same as absent rather than failing the suite.
const present = MODES
  .filter((m) => fs.existsSync(m.logFile))
  .map((m) => ({ ...m, entries: JSON.parse(fs.readFileSync(m.logFile, 'utf8')) }))
  .filter((m) => m.entries.length > 0);

if (present.length === 0) {
  test('reroute migration verification (skipped — no non-empty log artifact present)', (t) => {
    t.skip('No reroute-migration-log*.json with entries found; nothing to verify. Expected in CI, once a migration has been reviewed and its (gitignored) log cleaned up locally, or after a run that found zero safe candidates.');
  });
} else {
  for (const { flag, logFile, entries } of present) {
    const label = path.basename(logFile);

    test(`${label}: migrate-reroute-backlog.js --verify${flag.length ? ' ' + flag.join(' ') : ''} reports clean`, () => {
      // Throws (non-zero exit) on any unclean move; a clean run just logs and exits 0.
      execFileSync(process.execPath, [MIGRATE_SCRIPT, ...flag, '--verify'], { stdio: 'pipe' });
    });

    test(`${label}: every entry carries the routedFromShowId audit trail`, () => {
      for (const entry of entries) {
        const target = JSON.parse(fs.readFileSync(entry.targetPath, 'utf8'));
        assert.equal(
          target.routedFromShowId,
          entry.sourceShowId,
          `${entry.sourceShowId}/${entry.file} -> ${entry.targetShowId}: target missing routedFromShowId audit trail`,
        );
      }
    });

    test(`${label}: no duplicate filename landed at more than one target`, () => {
      const seen = new Map();
      for (const entry of entries) {
        const key = `${entry.targetShowId}/${entry.file}`;
        assert.equal(seen.has(key), false, `${key} appears more than once in ${logFile} (double-write risk)`);
        seen.set(key, true);
      }
    });
  }
}
