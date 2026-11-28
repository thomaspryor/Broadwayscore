'use strict';
/**
 * BRO-8397 (parent BRO-8056): the "covered" stamp that lets the deploy gate
 * skip a production build for a data-only change the show-refresh store already
 * serves.
 *
 * Writer side (publish-show-refresh.ts --write): after each write-mode run the
 * publisher writes covered.json (private bucket, service role only) saying
 * which build it published against (manifestId, publicSha), which home
 * generation it verified, the git blob SHAs of the core-data files it computed
 * from, and whether EVERY show that differs from the build is served by that
 * home (complete). Any doubt writes complete:false.
 *
 * Gate side (should-deploy-gate.js): evaluateCoverage() turns the stamp, the
 * live home/kill rows, the reader state and the core-data blob SHAs into one
 * yes/no. Every unknown is "not covered", so the gate's decision is unchanged
 * unless everything lines up, and it is always unchanged while the reader is
 * off in production.
 *
 * Pure except dataBlobShas (reads files).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonical } = require('./store');
const { OUTCOMES, SKIPS } = require('./publish-plan');

const COVERED_SCHEMA = 1;
/** Core-data files whose changes the per-show store carries (slice inputs). */
const COVERED_DATA_FILES = Object.freeze(['reviews.json', 'shows.json', 'critic-consensus.json']);
/** A reader env change must predate the live deployment by this much (deploy job window). */
const READER_ENV_SETTLE_MS = 2 * 3600 * 1000;
/** publish-write outcomes after which the home row was read back and matches the plan. */
const VERIFIED_WRITE_OUTCOMES = Object.freeze(['published', 'home-unchanged']);

/** git hash-object of a buffer (same value the deploy step stamps on Vercel). */
function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** { file: blobSha | null } for the covered core-data files in dataDir. */
function dataBlobShas(dataDir, files = COVERED_DATA_FILES) {
  const out = {};
  for (const f of files) {
    try { out[f] = gitBlobSha(fs.readFileSync(path.join(dataDir, f))); } catch { out[f] = null; }
  }
  return out;
}

/** Short signature of a home's show pointers (key-order independent). */
function homeShowsSig(shows) {
  return crypto.createHash('sha256').update(canonical(shows || {})).digest('hex').slice(0, 16);
}

/**
 * Does the plan's home serve every show whose HEAD data differs from the build?
 * Covered: a target (published), unchanged (HEAD == build), or held in the
 * build AND still held at HEAD (invisible either way). Anything else (a reveal,
 * a new show, an images or slug change, a review-list hold, a cap) needs a build.
 */
function planCoverage({ plan, head }) {
  if (!plan || ![OUTCOMES.PUBLISH, OUTCOMES.NOTHING_TO_DO].includes(plan.outcome)) {
    return { complete: false, why: `plan ${plan ? plan.outcome : 'missing'}`, uncovered: [], uncoveredCount: 0 };
  }
  const headShows = (head && head.shows) || {};
  const uncovered = [];
  for (const id of plan.dirty || []) uncovered.push({ id, why: 'not-in-build' });
  for (const [id, why] of Object.entries(plan.skips || {})) {
    if (why === SKIPS.UNCHANGED) continue;
    const cur = Object.hasOwn(headShows, id) ? headShows[id] : null;
    if (why === SKIPS.HELD_BUILD && cur && !cur.error && cur.held === true) continue;
    uncovered.push({ id, why });
  }
  return {
    complete: uncovered.length === 0,
    why: uncovered.length ? `${uncovered.length} show(s) not served by the store` : 'all changed shows served',
    uncovered: uncovered.slice(0, 20),
    uncoveredCount: uncovered.length,
  };
}

/** Revalidation finished for this run: secret present, nothing left queued or abandoned. */
function revalidateSettled(r) {
  if (!r || typeof r.message !== 'string') return false;
  if (/SHOW_REFRESH_REVALIDATE_SECRET unset/.test(r.message)) return false;
  // An unreadable or unsaved queue hides earlier failures: never settled (BRO-8397 review).
  if (/read failed|save failed|no queue store/.test(String(r.queueNote || ''))) return false;
  return Array.isArray(r.pending) && r.pending.length === 0 && Array.isArray(r.abandoned) && r.abandoned.length === 0;
}

/**
 * The covered.json value for one write-mode run.
 * @param {object} o
 * @param {object} o.plan         planPublish result
 * @param {object} o.head         { shows } as given to planPublish
 * @param {object} o.manifest     the live build manifest
 * @param {object|null} o.writeResult writePublish result (null = no write happened)
 * @param {object|null} o.revalidate  revalidateWithQueue result ({ message, pending, abandoned })
 * @param {Record<string,string|null>} o.dataShas dataBlobShas() of the checkout
 * @param {number} o.now
 */
function coverageRecord({ plan, head, manifest, writeResult, revalidate, dataShas, now }) {
  const pc = planCoverage({ plan, head });
  const reasons = [];
  if (!pc.complete) reasons.push(pc.why);
  if (!writeResult || !VERIFIED_WRITE_OUTCOMES.includes(writeResult.outcome)) reasons.push(`write ${writeResult ? writeResult.outcome : 'not run'}`);
  if (!revalidateSettled(revalidate)) reasons.push('revalidation not settled');
  const shas = {};
  for (const f of COVERED_DATA_FILES) shas[f] = (dataShas && dataShas[f]) || null;
  if (COVERED_DATA_FILES.some((f) => !shas[f])) reasons.push('data blob sha unknown');
  const generation = writeResult && Number.isInteger(writeResult.generation) ? writeResult.generation : null;
  if (generation === null) reasons.push('no verified generation');
  return {
    schema: COVERED_SCHEMA,
    at: new Date(now).toISOString(),
    complete: reasons.length === 0,
    reasons,
    manifestId: (manifest && manifest.manifestId) || null,
    publicSha: (manifest && manifest.publicSha) || null,
    generation,
    homeSig: plan && plan.nextHome ? homeShowsSig(plan.nextHome.shows) : null,
    dataShas: shas,
    uncovered: pc.uncovered,
    uncoveredCount: pc.uncoveredCount,
  };
}

/**
 * Pure: per tracked core-data file, does the current blob differ from the one
 * stamped on the live deployment? Mirrors compareDataShas' per-file rules.
 * @returns {{changed: string[], unknown: string[]}}
 */
function changedDataFiles(nowShas, baselineBlobShas, files, metaKey) {
  const changed = [];
  const unknown = [];
  if (!nowShas) return { changed, unknown: [...files] };
  const base = baselineBlobShas || {};
  for (const f of files) {
    const now = nowShas[f] || null;
    const was = base[metaKey(f)] || null;
    if (now && was) { if (now !== was) changed.push(f); } else if (now || was) unknown.push(f);
  }
  return { changed, unknown };
}

/**
 * Pure gate-side check: may this data-only change skip the build?
 * Returns { covered: boolean, why: string }. Only covered:true changes a decision.
 *
 * @param {object} o
 * @param {boolean|null} o.readerOn   reader on for the LIVE production deployment (null = unknown)
 * @param {{killed: boolean}|null} o.kill effectiveKill() of the kill row (null = unread)
 * @param {{state: string, value?: object}|null} o.homeRead readJsonObject of home
 * @param {{state: string, value?: object}|null} o.coveredRead readJsonObject of covered.json
 * @param {Record<string,string|null>|null} o.nowShas core-data blob SHAs now
 * @param {{changed: string[], unknown: string[]}} o.dataFiles changedDataFiles() result
 * @param {string|null} o.baselineSha live deployment commit
 */
function evaluateCoverage({ readerOn, kill, homeRead, coveredRead, nowShas, dataFiles, baselineSha }) {
  const no = (why) => ({ covered: false, why });
  if (readerOn !== true) return no(readerOn === false ? 'reader-off' : 'reader-unknown');
  if (!dataFiles || dataFiles.unknown.length) return no(`data-unknown ${dataFiles ? dataFiles.unknown.join(',') : ''}`.trim());
  if (!dataFiles.changed.length) return no('no-data-change');
  const outside = dataFiles.changed.filter((f) => !COVERED_DATA_FILES.includes(f));
  if (outside.length) return no(`not-covered-file ${outside.join(',')}`);
  if (!kill || kill.killed !== false) return no('killed-or-unknown');
  if (!coveredRead || coveredRead.state !== 'ok') return no(`stamp-${coveredRead ? coveredRead.state : 'unread'}`);
  const c = coveredRead.value;
  if (!c || c.schema !== COVERED_SCHEMA) return no('stamp-schema');
  if (c.complete !== true) return no('stamp-incomplete');
  if (!baselineSha || c.publicSha !== baselineSha) return no('stamp-other-deploy');
  if (!homeRead || homeRead.state !== 'ok' || !homeRead.value) return no(`home-${homeRead ? homeRead.state : 'unread'}`);
  const h = homeRead.value;
  if (h.manifestId !== c.manifestId || h.generation !== c.generation || homeShowsSig(h.shows) !== c.homeSig) return no('home-moved');
  for (const f of COVERED_DATA_FILES) {
    const now = nowShas && nowShas[f];
    if (!now || !c.dataShas || c.dataShas[f] !== now) return no(`data-moved ${f}`);
  }
  return { covered: true, why: `served by home generation ${h.generation}` };
}

/**
 * Pure: the reader is on for the live production deployment only when the
 * production env entry SHOW_REFRESH_READER is exactly 'on' (showRefreshEnabled's
 * test) AND was last changed more than READER_ENV_SETTLE_MS before that
 * deployment was created (env changes reach new deployments only). Anything else, including a sensitive value we
 * cannot read, is off/unknown.
 * @param {object} o
 * @param {object[]} o.entries Vercel /v9/projects/:id/env `envs`
 * @param {string|null} o.value decrypted value of the single production entry
 * @param {number|null} o.deployCreatedMs
 * @returns {{on: boolean|null, why: string}}
 */
function readerOnFromVercel({ entries, value, deployCreatedMs }) {
  const prod = readerEnvEntries(entries);
  if (prod === null) return { on: null, why: 'env list unreadable' };
  if (prod.length === 0) return { on: false, why: 'SHOW_REFRESH_READER unset in production' };
  if (prod.length > 1) return { on: null, why: 'several production entries' };
  if (value !== 'on') return { on: value == null ? null : false, why: value == null ? 'value unreadable' : 'value is not on' };
  const changed = Number(prod[0].updatedAt || prod[0].createdAt);
  if (!Number.isFinite(changed) || !Number.isFinite(deployCreatedMs)) return { on: null, why: 'timestamps unknown' };
  // The deploy job pulls the env (vercel pull) and builds BEFORE the deployment
  // exists, so a flip inside that window may not be in the live build: require
  // the change to predate the deployment by more than any deploy job runs.
  if (changed > deployCreatedMs - READER_ENV_SETTLE_MS) return { on: false, why: 'changed too close to (or after) the live deployment' };
  return { on: true, why: 'on for the live deployment' };
}

/** Production, non-branch SHOW_REFRESH_READER entries; null when the list is not an array. */
function readerEnvEntries(entries) {
  if (!Array.isArray(entries)) return null;
  return entries.filter((e) => e && e.key === 'SHOW_REFRESH_READER' && Array.isArray(e.target) && e.target.includes('production') && !e.gitBranch);
}

module.exports = {
  COVERED_SCHEMA, COVERED_DATA_FILES, VERIFIED_WRITE_OUTCOMES, READER_ENV_SETTLE_MS,
  gitBlobSha, dataBlobShas, homeShowsSig, planCoverage, revalidateSettled, coverageRecord,
  changedDataFiles, evaluateCoverage, readerOnFromVercel, readerEnvEntries,
};
