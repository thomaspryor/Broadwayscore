'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveReviewTextsDir, isReviewTextsCheckout } = require('./review-texts-dir');

/**
 * BRO-3954: a prior session ran audit-review-type-wrong-show.js --apply,
 * wrote wrongShow:true to 5 review-text files, then claimed "verified +
 * pushed" from a `git log origin/main..HEAD` check run against the WEB repo
 * (this repo) — which only ever proves scripts/ landed. The DATA repo edit
 * (data/review-texts, a separate private repo — broadway-review-texts) was
 * never committed or pushed there; it evaporated with the session's worktree.
 * 15 hours later a re-run of the same audit found the fields still
 * `undefined` with zero matching commits in broadway-review-texts' history.
 *
 * No shared helper existed to answer the one question that actually matters
 * for any `--apply` script that writes review-text JSON: "is what's on disk
 * ALSO on origin/main of the data repo?" This is that helper. It is a pure
 * read/compare — it never commits or pushes; a script that finds files not
 * pushed must run scripts/sync-review-texts.sh (or safe-sync-review-texts.sh)
 * itself and re-verify, not paper over the gap here.
 *
 * @param {string[]} filePaths - absolute paths of files an --apply pass wrote
 * @param {object} [opts]
 * @param {string} [opts.reviewTextsDir] - override the resolved checkout dir
 * @returns {{ok: boolean, reason?: string, notPushed?: string[], reviewTextsDir: string}}
 */
function verifyReviewTextsPushed(filePaths, opts = {}) {
  const dir = opts.reviewTextsDir || resolveReviewTextsDir();

  if (!isReviewTextsCheckout(dir)) {
    // Fail loud, not silent-pass (corpus-scan-guard.js precedent): a missing
    // .git here means this environment has NO local git history for the data
    // repo at all — the exact shape a cloud/headless bootstrap produces
    // (setup-local-data.sh strips .git before copying). A script that wrote
    // files here cannot have pushed them itself, and this helper cannot
    // verify a push that has no local ref to check against.
    return {
      ok: false,
      reviewTextsDir: dir,
      reason: `${dir} is not a git checkout (no .git, or empty) — this environment has no local ` +
        'history for the review-texts private repo, so a write here cannot be verified as pushed ' +
        'and will be LOST when this session/worktree ends unless synced through a checkout that does ' +
        'have one (see scripts/sync-review-texts.sh / scripts/lib/safe-sync-review-texts.sh).',
    };
  }

  if (filePaths.length === 0) return { ok: true, reviewTextsDir: dir };

  try {
    execFileSync('git', ['fetch', 'origin', 'main', '-q'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30000,
    });
  } catch (e) {
    return { ok: false, reviewTextsDir: dir, reason: `git fetch origin main failed in ${dir}: ${e.message}` };
  }

  const notPushed = [];
  for (const abs of filePaths) {
    const rel = path.relative(dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      notPushed.push(`${abs} (outside ${dir})`);
      continue;
    }
    let remoteRaw;
    try {
      remoteRaw = execFileSync('git', ['show', `origin/main:${rel}`], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      notPushed.push(rel); // file doesn't exist on origin/main at all
      continue;
    }
    let localRaw;
    try {
      localRaw = fs.readFileSync(abs, 'utf8');
    } catch {
      notPushed.push(rel); // local file gone — nothing to compare, treat as unverified
      continue;
    }
    if (normalizeJson(localRaw) !== normalizeJson(remoteRaw)) notPushed.push(rel);
  }

  if (notPushed.length > 0) {
    return {
      ok: false,
      reviewTextsDir: dir,
      notPushed,
      reason: `${notPushed.length} file(s) differ from origin/main in ${dir} — the local write was ` +
        'not committed+pushed to the data repo. Run scripts/sync-review-texts.sh, then re-verify.',
    };
  }
  return { ok: true, reviewTextsDir: dir };
}

// Compares by parsed structure, not raw bytes, so a rebase/commit that
// reformats whitespace or reorders keys doesn't register as "not pushed"
// when the actual field values already match.
function normalizeJson(raw) {
  try { return JSON.stringify(JSON.parse(raw)); } catch { return raw.trim(); }
}

module.exports = { verifyReviewTextsPushed };
