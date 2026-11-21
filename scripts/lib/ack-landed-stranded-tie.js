'use strict';

const { execFileSync, spawnSync } = require('child_process');

// A job-level ack must identify the recorded tip, never just an earlier part
// of the job. Rebased tips have different SHAs but the same stable patch ID.
// includeEarlierCommits is ONLY for --landed-elsewhere's ownership refusal:
// any of a dispatch's own work disqualifies it from that mode, even a partial
// landing. It must not be enabled when proving completion for decideAck.
function computeStrandedTie(sha, strandedSha, opts = {}) {
  const noTie = { tiedToStranded: false, tiedToStrandedByPatch: false, tiedToStrandedByContent: false };
  if (!sha || !strandedSha) return noTie;
  const cwd = opts.cwd || require('./repo-root').MAIN_REPO_ROOT;
  const git = (args, extra = {}) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    // Large review/data diffs can exceed execFileSync's default 1 MiB.
    maxBuffer: 64 * 1024 * 1024, ...extra,
  }).trim();
  try {
    // Resolve both IDs: prefixes alone can also match nonexistent objects.
    const commit = git(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
    const tip = git(['rev-parse', '--verify', '--end-of-options', `${strandedSha}^{commit}`]);
    const tiedToStranded = commit === tip || (opts.includeEarlierCommits === true
      && spawnSync('git', ['merge-base', '--is-ancestor', commit, tip], { cwd }).status === 0);
    if (tiedToStranded) return { ...noTie, tiedToStranded: true };
    // The caller checks reachability on freshly fetched origin/main first.
    if (opts.landed === false) return noTie;

    let candidates = [tip];
    if (opts.includeEarlierCommits === true) {
      const base = git(['merge-base', tip, 'origin/main']);
      candidates = git(['cherry', 'origin/main', tip, base]).split('\n')
        .filter(line => line.startsWith('-'))
        .map(line => line.slice(1).trim()).filter(Boolean);
    }
    const patchId = target => {
      try {
        const patch = git(['show', '--no-color', target]);
        // Override stdin too: input with stdin:'ignore' silently produces no ID.
        return git(['patch-id', '--stable'], {
          input: patch, stdio: ['pipe', 'pipe', 'pipe'],
        }).split(/\s+/)[0] || '';
      } catch {
        // An unreadable candidate must not hide another ownership match.
        return '';
      }
    };
    const got = patchId(commit);
    if (got && candidates.some(target => patchId(target) === got)) return { ...noTie, tiedToStrandedByPatch: true };
    // BRO-8008: a rebase that also absorbed a merge of origin/main into the
    // job branch leaves a merge tip whose patch IDs no longer match the
    // landed twins. The work is still fully on main when every file the job's
    // own (non-merge, first-parent) commits touched is identical between the
    // tip and origin/main, and the sha itself touches one of those files.
    // decideAck adds the card-name + job-window checks for this tie.
    if (opts.includeEarlierCommits !== true && contentIdentical(git, tip, commit)) return { ...noTie, tiedToStrandedByContent: true };
    return noTie;
  } catch {
    // Missing objects or failed git commands cannot establish a tie.
    return noTie;
  }
}

// Files touched by the job's own commits: walk the tip's first-parent chain
// down to the first commit already on origin/main, skipping merge commits
// (their second parent is main's own history, not the job's work).
function jobTouchedFiles(git, tip) {
  const chain = git(['rev-list', '--first-parent', '--no-merges', tip, '--not', 'origin/main']).split('\n').filter(Boolean);
  // --no-merges + --first-parent still lists main's commits that arrived via a
  // merge only if they sit on the first-parent line, which they do not.
  const files = new Set();
  for (const c of chain) {
    git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', c]).split('\n').filter(Boolean).forEach(f => files.add(f));
  }
  return [...files];
}

function contentIdentical(git, tip, commit) {
  const files = jobTouchedFiles(git, tip);
  if (!files.length) return false;
  const sameAsMain = git(['--literal-pathspecs', 'diff', '--name-only', tip, 'origin/main', '--', ...files]);
  if (sameAsMain) return false;
  const shaFiles = new Set(git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', commit]).split('\n').filter(Boolean));
  return files.some(f => shaFiles.has(f));
}

module.exports = { computeStrandedTie };
