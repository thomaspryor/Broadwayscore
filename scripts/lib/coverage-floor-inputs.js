/**
 * Reads the three audit files behind the show page's coverage floor
 * (scripts/lib/coverage-floor.js). One loader for the website build
 * (src/lib/data-core.ts) and the app feed (scripts/generate-mobile-data.js),
 * so both see the same verdicts, stamps and acks.
 *
 * Fail-open: a missing or unreadable file (or COVERAGE_GATE_DISABLED) leaves
 * its map empty, so every show keeps the plain review-count gate.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { coverageGateDisabled } = require('./coverage-gate');
const { isPlausibleStamp, stampReferenceDate } = require('./score-public-since');

// Same namespace pre-send-check.mjs writes with --ack-gap=<showId> (see
// scripts/lib/t1-scoreboard.js cellKey/NEWSLETTER_GAP_NS) — one ack covers
// both the newsletter swap gate and this show-page floor gate, since both
// are the owner acknowledging the same underlying coverage gap on the same
// show. The literal name is a historical newsletter-first artifact, not a
// scoping restriction.
const COVERAGE_ACK_NS_SUFFIX = '::newsletter-gap';

// Relative to data/. Outside data/audit/ on purpose: that tree is excluded
// from output file tracing (next.config.js), this file is included.
const COVERAGE_FLOOR_SNAPSHOT_FILE = 'coverage-floor-snapshot.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/**
 * The three audit files' parsed contents (null when missing or unreadable)
 * turned into the floor inputs. Takes contents, not a directory: the website
 * reads them in src/lib/data-core.ts with literal file paths, because Next's
 * file tracer bundles any directory a server module names, and handing it
 * data/ put all of data/ (~290 MB) into every server function (Vercel refused
 * the deploy, 2026-10-21).
 *
 * @param {{ gapAudit: any, stamps: any, acks: any }} audits
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   covByShowId: Map<string, {state: string, liveCount: number, candidateCount: number, computedAt: string | null}>,
 *   scorePublicSinceByShowId: Map<string, string>,
 *   coverageAckedShowIds: Set<string>,
 * }}
 */
function buildCoverageFloorInputs({ gapAudit, stamps, acks }, env = process.env) {
  const covByShowId = new Map();
  const scorePublicSinceByShowId = new Map();
  const coverageAckedShowIds = new Set();
  if (coverageGateDisabled(env)) return { covByShowId, scorePublicSinceByShowId, coverageAckedShowIds };

  for (const r of (gapAudit && Array.isArray(gapAudit.results) ? gapAudit.results : [])) {
    if (!r || !r.showId || !r.censusVerdict) continue;
    covByShowId.set(r.showId, {
      state: r.censusVerdict.verdict,
      liveCount: r.censusVerdict.liveCount,
      candidateCount: r.censusVerdict.candidateCount,
      computedAt: r.computedAt || null,
    });
  }

  if (stamps && typeof stamps === 'object') {
    for (const [showId, iso] of Object.entries(stamps)) {
      if (typeof iso === 'string') scorePublicSinceByShowId.set(showId, iso);
    }
  }

  if (Array.isArray(acks)) {
    for (const a of acks) {
      if (a && typeof a.key === 'string' && a.key.endsWith(COVERAGE_ACK_NS_SUFFIX)) {
        coverageAckedShowIds.add(a.key.slice(0, -COVERAGE_ACK_NS_SUFFIX.length));
      }
    }
  }

  return { covByShowId, scorePublicSinceByShowId, coverageAckedShowIds };
}

/**
 * Reads the floor inputs from literal file paths. src/lib/data-core.ts passes
 * each path built from literal segments (never the data/ root: Next's tracer
 * bundles any directory a server module names, 2026-10-21); scripts pass paths
 * under their data/ dir via loadCoverageFloorInputs.
 *
 * BRO-5811: next.config.js keeps data/audit/** out of the Vercel server
 * functions, so a page re-rendered at runtime (ISR revalidation, or a
 * dynamicParams show added after the build) has no audit files. The prebuild
 * snapshot then stands in for the whole audit directory. It is never mixed
 * with raw files, so a stale snapshot can't leak into a checkout that has the
 * real audits; and it is keyed on the gap audit being ABSENT, not unreadable,
 * so a corrupt gap audit keeps the raw stamps/acks.
 *
 * @param {{ gapAudit: string, stamps: string, acks: string, snapshot: string }} files
 * @param {NodeJS.ProcessEnv} [env]
 */
function readCoverageFloorInputs(files, env = process.env) {
  if (!fs.existsSync(files.gapAudit)) {
    return coverageFloorInputsFromSnapshot(readJson(files.snapshot), env);
  }
  return buildCoverageFloorInputs({
    gapAudit: readJson(files.gapAudit),
    stamps: readJson(files.stamps),
    acks: readJson(files.acks),
  }, env);
}

/**
 * Scripts (not traced): read the floor inputs from a data/ directory.
 * @param {string} dataDir  the repo's data/ directory
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadCoverageFloorInputs(dataDir, env = process.env) {
  return readCoverageFloorInputs({
    gapAudit: path.join(dataDir, 'audit', 'show-review-gap.json'),
    stamps: path.join(dataDir, 'audit', 'score-public-since.json'),
    acks: path.join(dataDir, 'audit', 't1-coverage-ack.json'),
    snapshot: path.join(dataDir, COVERAGE_FLOOR_SNAPSHOT_FILE),
  }, env);
}

/**
 * The slim, JSON-serialisable form of the loaded inputs that prebuild writes
 * to data/coverage-floor-snapshot.json (~200KB vs ~10MB of raw audits) and
 * next.config.js traces into every server function (BRO-5811).
 *
 * @param {ReturnType<typeof buildCoverageFloorInputs>} inputs
 */
function coverageFloorSnapshot(inputs) {
  return {
    cov: Object.fromEntries(inputs.covByShowId),
    stamps: Object.fromEntries(inputs.scorePublicSinceByShowId),
    acked: [...inputs.coverageAckedShowIds],
  };
}

/**
 * Inverse of coverageFloorSnapshot. The kill switch applies here, at read
 * time, so it can be flipped without a rebuild. A missing/unreadable
 * snapshot fails open (empty maps).
 *
 * @param {any} snap  parsed snapshot, or null
 * @param {NodeJS.ProcessEnv} [env]
 */
function coverageFloorInputsFromSnapshot(snap, env = process.env) {
  const covByShowId = new Map();
  const scorePublicSinceByShowId = new Map();
  const coverageAckedShowIds = new Set();
  if (coverageGateDisabled(env) || !snap || typeof snap !== 'object') {
    return { covByShowId, scorePublicSinceByShowId, coverageAckedShowIds };
  }
  for (const [showId, cov] of Object.entries(snap.cov || {})) covByShowId.set(showId, cov);
  for (const [showId, iso] of Object.entries(snap.stamps || {})) {
    if (typeof iso === 'string') scorePublicSinceByShowId.set(showId, iso);
  }
  for (const showId of (Array.isArray(snap.acked) ? snap.acked : [])) coverageAckedShowIds.add(showId);
  return { covByShowId, scorePublicSinceByShowId, coverageAckedShowIds };
}

/**
 * The applyCoverageFloor options for one show, exactly as the website's
 * ComputedShow carries them: a stamp from before the show opened (or, with
 * no opening date yet, before its first preview) is a stale wrong-production
 * blip, not a settled score, so it is ignored.
 *
 * @param {ReturnType<typeof loadCoverageFloorInputs>} inputs
 * @param {{id: string, openingDate?: string | null, previewsStartDate?: string | null}} show
 * @returns {{scorePublicSince: string | undefined, coverageState: string | undefined, coverageAcked: boolean}}
 */
function coverageFloorOptsForShow(inputs, show) {
  const stamp = inputs.scorePublicSinceByShowId.get(show.id);
  const cov = inputs.covByShowId.get(show.id);
  return {
    scorePublicSince: stamp && isPlausibleStamp(stamp, stampReferenceDate(show)) ? stamp : undefined,
    coverageState: cov ? cov.state : undefined,
    coverageAcked: inputs.coverageAckedShowIds.has(show.id),
  };
}

module.exports = {
  COVERAGE_ACK_NS_SUFFIX,
  COVERAGE_FLOOR_SNAPSHOT_FILE,
  buildCoverageFloorInputs,
  readCoverageFloorInputs,
  loadCoverageFloorInputs,
  coverageFloorSnapshot,
  coverageFloorInputsFromSnapshot,
  coverageFloorOptsForShow,
};
