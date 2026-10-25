'use strict';

/**
 * Which private-repo (broadway-scorecard-data) files land in data/, and
 * whether a local data/ copy has drifted from its core-data clone.
 *
 * BRO-3521: checkout-core-data used to `cp -f /tmp/core-data-checkout/*.json
 * data/`, so ANY private-repo json with the same name as a public-repo
 * tracked file silently overwrote it on every CI run. A stale 747-entry
 * show-score-urls.json in the private repo shadowed the public 815-entry one
 * and re-introduced an already-fixed wrong-production URL (BRO-3471/3416).
 * outlet-registry.json had a one-off skip for the same reason (BRO-1084).
 * planCoreDataCopy() makes that rule general: a public-tracked name is only
 * copied when it is deliberately core data (CORE_FILES, e.g. the awards.json
 * dual-track exception).
 *
 * BRO-3523/BRO-3331: setup-local-data.sh copies COPY_FILES as plain
 * files with no version marker, so a fresh core-data clone could still sit
 * behind a stale data/ copy (outlet-registry.json missing 4 outlets read as
 * a live regression). findStaleCopies() is the byte-compare session-start.sh
 * (repo copy and the Mac master in claude-config) runs after its
 * clone-vs-origin check; the CLI's --warn prints the hook's message.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getShippedCoreFiles } = require('./tracked-and-ignored-guard');

const SETUP_LOCAL_DATA = path.join(__dirname, '..', 'setup-local-data.sh');

/** COPY_FILES=(...) from setup-local-data.sh, parsed live so the two never drift. */
function getLocalCopyFiles({ scriptPath = SETUP_LOCAL_DATA } = {}) {
  const m = fs.readFileSync(scriptPath, 'utf8').match(/^COPY_FILES=\(([^)]*)\)/m);
  if (!m) throw new Error(`could not find COPY_FILES=(...) in ${scriptPath}`);
  return m[1].split(/\s+/).filter(Boolean);
}

/** SYMLINK_FILES=(...) from setup-local-data.sh: links on the Mac, plain copies in cloud (BRO-5217). */
function getLocalSymlinkFiles({ scriptPath = SETUP_LOCAL_DATA } = {}) {
  const m = fs.readFileSync(scriptPath, 'utf8').match(/^SYMLINK_FILES=\(([^)]*)\)/m);
  if (!m) throw new Error(`could not find SYMLINK_FILES=(...) in ${scriptPath}`);
  return m[1].split(/\s+/).filter(Boolean);
}

/**
 * @param {string[]} names  basenames of *.json in the private checkout
 * @param {{isPublicTracked: (name: string) => boolean, coreFiles?: string[]}} opts
 *   coreFiles defaults to push-core-data's CORE_FILES (parsed live)
 * @returns {{copy: string[], skipped: string[]}}
 */
function planCoreDataCopy(names, { isPublicTracked, coreFiles = getShippedCoreFiles() }) {
  const core = new Set(coreFiles);
  const copy = [];
  const skipped = [];
  for (const name of names) {
    if (core.has(name) || !isPublicTracked(name)) copy.push(name);
    else skipped.push(name);
  }
  return { copy, skipped };
}

/** Basenames under data/ that git tracks in the repo at repoDir. */
function publicTrackedDataFiles(repoDir) {
  const out = execFileSync('git', ['-C', repoDir, 'ls-files', '-z', '--', 'data/*.json'], { encoding: 'utf8' });
  // Git pathspec `*` crosses `/`, so keep only top-level data/*.json.
  return new Set(out.split('\0').filter((p) => p && path.dirname(p) === 'data').map((p) => path.basename(p)));
}


/**
 * data/ copies whose bytes differ from the core-data clone. Files missing on
 * either side are not reported (setup-local-data.sh already warns on those).
 * @returns {string[]}
 */
// COPY_FILES only by default: in cloud the SYMLINK_FILES copies are refreshed by
// cloud-bootstrap-data.sh, which may still be running when session-start.sh calls this.
// BRO-5940: files the repo tracks (audience-reviews-lbo.json, awards.json) are
// never refreshed by setup-local-data.sh (BRO-5261), so they always differ from
// the clone and no refresh clears them. Pass repoDir to exclude them; without a
// git repo there, nothing is excluded.
function findStaleCopies({ dataDir, coreDataDir, files = getLocalCopyFiles(), repoDir = null }) {
  let tracked = new Set();
  if (repoDir) {
    try { tracked = publicTrackedDataFiles(repoDir); } catch { tracked = new Set(); }
  }
  const stale = [];
  for (const f of files) {
    if (tracked.has(f)) continue;
    const local = path.join(dataDir, f);
    const src = path.join(coreDataDir, f);
    if (!fs.existsSync(local) || !fs.existsSync(src)) continue;
    if (fs.lstatSync(local).isSymbolicLink()) continue;
    // Size first: mezzanine-productions-raw.json alone is ~47MB and this runs
    // at every session start.
    if (fs.statSync(local).size !== fs.statSync(src).size || !fs.readFileSync(local).equals(fs.readFileSync(src))) {
      stale.push(f);
    }
  }
  return stale;
}

const ALWAYS_REQUIRED = ['shows.json', 'reviews.json'];
// An emptied shows/reviews file parses fine and every consumer reads zero rows.
const NON_EMPTY_ARRAYS = { 'shows.json': 'shows', 'reviews.json': 'reviews' };

/**
 * BRO-2937: the canary after checkout-core-data's copy. It used to check only
 * shows.json and reviews.json, so a private repo that lost any other core file
 * (opening-night-sent.json, subscribers*.json, ...) passed and every consumer
 * silently read a default (BRO-2934: check-missed-broadcasts would have claimed
 * no show was ever emailed). Pure apart from reading dataDir.
 *
 * @param {{checkoutNames: string[], plannedCopy: string[], coreFiles?: string[], dataDir: string}} opts
 * @returns {string[]} one message per problem; [] when the copy is sound
 */
function verifyCoreDataCopy({ checkoutNames, plannedCopy, coreFiles = getShippedCoreFiles(), dataDir }) {
  const problems = [];
  const inCheckout = new Set(checkoutNames);
  // shows.json + reviews.json were the whole old canary: keep them required even
  // if a CORE_FILES edit (or a parse miss) ever drops them (BRO-5261 retro-review).
  const required = [...new Set([...ALWAYS_REQUIRED, ...coreFiles])];
  for (const f of required) {
    if (!inCheckout.has(f)) {
      // Never advise an empty seed for a file that existed: an empty
      // opening-night-sent.json or subscribers file is the silent default this
      // canary exists to stop, and it would parse clean.
      problems.push(`${f} is required core data but missing from the private core-data repo. If it was lost, restore it from that repo's git history (git log --diff-filter=D -- ${f}); never seed an empty value. Only a NEW CORE_FILES name is seeded ({} or []) before it is added.`);
    }
  }
  for (const f of plannedCopy) {
    if (!fs.existsSync(path.join(dataDir, f))) problems.push(`${f} was planned for copy but is not in data/ after the copy.`);
  }
  for (const f of required) {
    const p = path.join(dataDir, f);
    if (!inCheckout.has(f) || !fs.existsSync(p)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      problems.push(`data/${f} is not valid JSON (${e.message}).`);
      continue;
    }
    const key = NON_EMPTY_ARRAYS[f];
    if (key) {
      const rows = Array.isArray(parsed) ? parsed : parsed && parsed[key];
      if (!Array.isArray(rows) || rows.length === 0) problems.push(`data/${f} parses but holds no ${key} (emptied file).`);
    }
  }
  return problems;
}

module.exports = { getLocalCopyFiles, getLocalSymlinkFiles, planCoreDataCopy, publicTrackedDataFiles, findStaleCopies, verifyCoreDataCopy };

// CLI:
//   node scripts/lib/core-data-files.js plan <privateCheckoutDir> [repoDir]
//     prints one basename per line to copy; ::warning:: per skipped file (stderr)
//   node scripts/lib/core-data-files.js verify <privateCheckoutDir> [repoDir]
//     after the copy: ::error:: per problem from verifyCoreDataCopy, exit 1
//   node scripts/lib/core-data-files.js stale-copies <dataDir> <coreDataDir> [--warn]
//     prints one stale basename per line; --warn prints session-start.sh's
//     warning instead (nothing when clean or the clone is absent)
if (require.main === module) {
  const [cmd, a, b, flag] = process.argv.slice(2);
  if ((cmd === 'plan' || cmd === 'verify') && a) {
    const repoDir = b || process.cwd();
    const tracked = publicTrackedDataFiles(repoDir);
    const names = fs.readdirSync(a).filter((f) => f.endsWith('.json')).sort();
    const { copy, skipped } = planCoreDataCopy(names, { isPublicTracked: (n) => tracked.has(n) });
    if (cmd === 'verify') {
      const problems = verifyCoreDataCopy({ checkoutNames: names, plannedCopy: copy, dataDir: path.join(repoDir, 'data') });
      for (const p of problems) console.error(`::error::Core data checkout FAILED: ${p}`);
      process.exit(problems.length ? 1 : 0);
    }
    for (const s of skipped) {
      console.error(`::warning::core-data: not copying ${s} from the private repo; data/${s} is tracked in the public repo and is not in CORE_FILES (BRO-3521)`);
    }
    if (copy.length) process.stdout.write(copy.join('\n') + '\n');
  } else if (cmd === 'stale-copies' && a && b) {
    const stale = fs.existsSync(b) ? findStaleCopies({ dataDir: a, coreDataDir: b, repoDir: path.dirname(path.resolve(a)) }) : [];
    if (stale.length && flag === '--warn') {
      console.log([
        '',
        `🔶 STALE LOCAL CORE-DATA COPY: data/ differs from ${b} for: ${stale.join(' ')}`,
        '   These are plain copies, not symlinks, so they do not follow the clone.',
        '   Conclusions drawn from them may be wrong. Refresh:',
        '     ./scripts/setup-local-data.sh',
        '',
      ].join('\n'));
    } else if (stale.length) {
      process.stdout.write(stale.join('\n') + '\n');
    }
  } else {
    console.error('usage: core-data-files.js plan|verify <privateCheckoutDir> [repoDir] | stale-copies <dataDir> <coreDataDir>');
    process.exit(2);
  }
}
