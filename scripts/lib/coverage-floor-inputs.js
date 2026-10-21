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
 * Scripts (not traced): read the three audit files from a data/ directory.
 * @param {string} dataDir  the repo's data/ directory
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadCoverageFloorInputs(dataDir, env = process.env) {
  return buildCoverageFloorInputs({
    gapAudit: readJson(path.join(dataDir, 'audit', 'show-review-gap.json')),
    stamps: readJson(path.join(dataDir, 'audit', 'score-public-since.json')),
    acks: readJson(path.join(dataDir, 'audit', 't1-coverage-ack.json')),
  }, env);
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

module.exports = { COVERAGE_ACK_NS_SUFFIX, buildCoverageFloorInputs, loadCoverageFloorInputs, coverageFloorOptsForShow };
