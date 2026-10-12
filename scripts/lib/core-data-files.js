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
function findStaleCopies({ dataDir, coreDataDir, files = getLocalCopyFiles() }) {
  const stale = [];
  for (const f of files) {
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

module.exports = { getLocalCopyFiles, planCoreDataCopy, publicTrackedDataFiles, findStaleCopies };

// CLI:
//   node scripts/lib/core-data-files.js plan <privateCheckoutDir> [repoDir]
//     prints one basename per line to copy; ::warning:: per skipped file (stderr)
//   node scripts/lib/core-data-files.js stale-copies <dataDir> <coreDataDir> [--warn]
//     prints one stale basename per line; --warn prints session-start.sh's
//     warning instead (nothing when clean or the clone is absent)
if (require.main === module) {
  const [cmd, a, b, flag] = process.argv.slice(2);
  if (cmd === 'plan' && a) {
    const tracked = publicTrackedDataFiles(b || process.cwd());
    const names = fs.readdirSync(a).filter((f) => f.endsWith('.json')).sort();
    const { copy, skipped } = planCoreDataCopy(names, { isPublicTracked: (n) => tracked.has(n) });
    for (const s of skipped) {
      console.error(`::warning::core-data: not copying ${s} from the private repo; data/${s} is tracked in the public repo and is not in CORE_FILES (BRO-3521)`);
    }
    if (copy.length) process.stdout.write(copy.join('\n') + '\n');
  } else if (cmd === 'stale-copies' && a && b) {
    const stale = fs.existsSync(b) ? findStaleCopies({ dataDir: a, coreDataDir: b }) : [];
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
    console.error('usage: core-data-files.js plan <privateCheckoutDir> [repoDir] | stale-copies <dataDir> <coreDataDir>');
    process.exit(2);
  }
}
