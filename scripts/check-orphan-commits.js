#!/usr/bin/env node
/**
 * check-orphan-commits.js — refuse parentless ("root") commits in a push range.
 *
 * Background (Notion 3a2637c5-416f-81ee, task #209): on 2026-07-19 the opening-
 * night poller fast-path committed a PARENTLESS root commit (53ff06a4a7a) whose
 * tree was a full repo snapshot, then push-with-retry.sh merged it into main via
 * an unrelated-histories merge. Main ended up carrying a SECOND root commit —
 * doubling clone weight and making `git log -- <file>` report the whole tree as
 * changed by a data commit. Root enabler: a shallow (fetch-depth: 1) checkout
 * whose graft boundary let a rebase/merge/reset path produce a rootless commit.
 *
 * This is the catch-all guard: it inspects the commits a push is about to add
 * (or that a push just added) and FAILS if any has zero parents. A legitimate
 * repo never gains a second root through normal work, so any parentless commit
 * inside a push RANGE (A..B) is by definition a bug — the true repo root is an
 * ancestor of A and never appears in A..B.
 *
 * Usage:
 *   node scripts/check-orphan-commits.js --range=<base>..<head>
 *   node scripts/check-orphan-commits.js --base=<ref> [--head=<ref>]   (head defaults HEAD)
 *   node scripts/check-orphan-commits.js --before=<sha> --after=<sha>  (GitHub push payload)
 *
 * Exit 0: no parentless commits in range (or range empty / base missing → nothing to check).
 * Exit 1: one or more parentless commits found (prints them).
 * Exit 2: usage / git error.
 *
 * The pure detector `findOrphanCommits(revListParentsOutput)` is exported for unit
 * tests (scripts/lib/... test requires the real function — CLAUDE.md rule 15).
 */

const { execFileSync } = require('child_process');

/**
 * Parse the output of `git rev-list --parents <range>` and return the SHAs of
 * commits that have NO parents. Each line is: "<commit> [<parent> ...]".
 * A line with a single field (just the commit hash) is a root/parentless commit.
 * @param {string} revListParentsOutput
 * @returns {string[]} parentless commit SHAs, in the order git listed them
 */
function findOrphanCommits(revListParentsOutput) {
  if (!revListParentsOutput) return [];
  const orphans = [];
  for (const rawLine of revListParentsOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    // fields[0] = the commit; fields[1..] = its parents. No parents → orphan.
    if (fields.length === 1) orphans.push(fields[0]);
  }
  return orphans;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

/** Resolve the (base, head) range from CLI flags. Returns null if unresolvable. */
function resolveRange(args) {
  if (args.range && typeof args.range === 'string' && args.range.includes('..')) {
    const [base, head] = args.range.split('..');
    return { base: base || '', head: head || 'HEAD' };
  }
  const base = args.base || args.before || '';
  const head = args.head || args.after || 'HEAD';
  if (!base) return null;
  return { base, head };
}

function gitOrNull(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = resolveRange(args);

  if (!range) {
    console.error(
      'check-orphan-commits: no --range/--base given; nothing to check (pass --range=BASE..HEAD).'
    );
    process.exit(2);
  }

  // An all-zero "before" SHA is GitHub's marker for a brand-new branch / first
  // push — there is no meaningful range to diff, so skip (a new branch's history
  // is not a place we can distinguish a legitimately-shared root from a new one).
  if (/^0+$/.test(range.base)) {
    console.log('check-orphan-commits: base is the all-zero SHA (new branch) — skipping.');
    process.exit(0);
  }

  // If the base ref is not present locally (e.g. force-push rewrote it away),
  // fail open rather than crash — a missing base is not evidence of an orphan.
  if (!gitOrNull(['rev-parse', '--verify', '--quiet', `${range.base}^{commit}`])) {
    console.log(
      `check-orphan-commits: base ref "${range.base}" not found locally — skipping (fail-open).`
    );
    process.exit(0);
  }

  const spec = `${range.base}..${range.head}`;
  const out = gitOrNull(['rev-list', '--parents', spec]);
  if (out === null) {
    console.error(`check-orphan-commits: \`git rev-list --parents ${spec}\` failed.`);
    process.exit(2);
  }

  const orphans = findOrphanCommits(out);
  if (orphans.length === 0) {
    console.log(`check-orphan-commits: OK — no parentless commits in ${spec}.`);
    process.exit(0);
  }

  console.error(
    `::error::check-orphan-commits: ${orphans.length} PARENTLESS (root) commit(s) in ${spec}. ` +
      'A parentless commit inside a push range is a bug (a second repo root) — it doubles clone ' +
      'weight and corrupts per-file history. Root cause is usually a shallow checkout feeding a ' +
      'rebase/merge/reset path (see task #209). Do NOT push this.'
  );
  for (const sha of orphans) {
    const subj = (gitOrNull(['show', '-s', '--format=%s', sha]) || '').trim();
    console.error(`  parentless: ${sha}  ${subj}`);
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { findOrphanCommits, resolveRange, parseArgs };
