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

const present = MODES.filter((m) => fs.existsSync(m.logFile));

if (present.length === 0) {
  test('reroute migration verification (skipped — no log artifact present)', (t) => {
    t.skip('No reroute-migration-log*.json found; nothing to verify. This is expected in CI and once a migration has been reviewed and its (gitignored) log cleaned up locally.');
  });
} else {
  for (const { flag, logFile } of present) {
    const entries = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const label = path.basename(logFile);

    test(`${label}: migrate-reroute-backlog.js --verify${flag.length ? ' ' + flag.join(' ') : ''} reports clean`, () => {
      assert.ok(entries.length > 0, `${logFile} is empty`);
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
