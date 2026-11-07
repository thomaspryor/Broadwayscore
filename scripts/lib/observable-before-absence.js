#!/usr/bin/env node

/**
 * Task #1075 — "a verification that cannot observe what it claims to check
 * reports false success".
 *
 * A check that greps a target and finds nothing has learned ONE of two very
 * different things:
 *   1. the target is observable and the thing genuinely isn't there  → ABSENT
 *   2. the target was never readable in the first place              → CANNOT_OBSERVE
 * Collapsing (2) into (1) is how a monitor reports "wrong ticket link GONE"
 * forever, whether or not the bug was ever fixed (caught by luck 2026-08-05:
 * a watcher grepped `git show origin/main:data/shows.json` in THIS repo, where
 * shows.json is gitignored because core data lives in a private repo — the
 * git read threw, the catch swallowed it, and absence read as success).
 *
 * Same class, different disguise, same day: jobBranchLanded() returned false
 * for work that HAD landed, because worktree-gc had deleted the branch it was
 * asking about. The ref was gone, so the question was unanswerable — but the
 * answer came back "no".
 *
 * The invariant this module encodes: NOT-FOUND and CANNOT-OBSERVE are distinct
 * verdicts, and CANNOT-OBSERVE must never read as success.
 *
 * Generalizes assertCorpusScanned (scripts/lib/corpus-scan-guard.js, task
 * #1069) — "fail loud on missing corpus, never vacuous-pass" — from CI corpus
 * gates to ad-hoc verification/monitor scripts.
 *
 * Scope note: this models CONTENT checks ("is string X in file F?"). A missing
 * file makes that question unanswerable. An EXISTENCE check ("F must not
 * exist") is a different shape where absence IS the evidence — don't route it
 * through here.
 *
 * Layering, per CLAUDE.md §15: the classify* functions are pure (no fs, no
 * child_process) and are what tests require(); the probe/observe wrappers do
 * the IO and are injectable so tests can drive them without a real repo.
 *
 *   const { observePresence, PRESENCE } = require('./lib/observable-before-absence');
 *   const r = observePresence({ ref: 'origin/main', filePath: 'data/shows.json', contains: 'badlink' });
 *   if (r.presence === PRESENCE.CANNOT_OBSERVE) throw new Error(`cannot verify: ${r.reason}`);
 */

'use strict';

const OBSERVABILITY = {
  OBSERVABLE: 'OBSERVABLE',
  CANNOT_OBSERVE: 'CANNOT_OBSERVE',
};

const PRESENCE = {
  PRESENT: 'PRESENT',
  ABSENT: 'ABSENT',
  CANNOT_OBSERVE: 'CANNOT_OBSERVE',
};

class CannotObserveError extends Error {
  constructor(observability, label) {
    super(
      `cannot observe ${label || 'target'} — ${observability && observability.reason}: ` +
        `${(observability && observability.detail) || 'no detail'}. ` +
        'Absence is not evidence here; the check must report CANNOT-OBSERVE, not pass.'
    );
    this.name = 'CannotObserveError';
    this.observability = observability;
  }
}

// ── Pure classifiers ────────────────────────────────────────────────────────

/**
 * Classify whether `<ref>:<path>` is readable.
 *
 * @param {object} facts
 * @param {boolean} facts.refResolved  the ref itself resolves (false = gc'd/never-fetched branch)
 * @param {boolean} facts.blobExists   the path exists at that ref
 * @param {string}  [facts.error]      the probe itself failed (not a repo, git missing, …)
 * @param {boolean} [facts.gitIgnored] path is gitignored in the inspecting repo (diagnostic only)
 */
function classifyGitObservability(facts = {}) {
  const { refResolved, blobExists, error, gitIgnored } = facts;
  if (error) {
    return { status: OBSERVABILITY.CANNOT_OBSERVE, reason: 'git-probe-failed', detail: String(error) };
  }
  if (!refResolved) {
    return {
      status: OBSERVABILITY.CANNOT_OBSERVE,
      reason: 'ref-missing',
      detail: 'the ref does not resolve (deleted/gc\'d branch, or never fetched)',
    };
  }
  if (!blobExists) {
    return {
      status: OBSERVABILITY.CANNOT_OBSERVE,
      reason: gitIgnored ? 'path-gitignored-here' : 'path-not-in-ref',
      detail: gitIgnored
        ? 'path is gitignored in this repo, so it is never committed here — read it from the repo that owns it (private core-data/review-texts repo), or from the working tree'
        : 'path does not exist at that ref, so its contents cannot be read',
    };
  }
  return { status: OBSERVABILITY.OBSERVABLE, reason: 'readable-at-ref', detail: '' };
}

/**
 * Classify whether a working-tree path is readable for a CONTENT check.
 *
 * @param {object} facts
 * @param {boolean} facts.fileExists
 * @param {boolean} [facts.gitIgnored] diagnostic: explains WHY it may be missing here
 * @param {string}  [facts.error]      stat/read blew up
 */
function classifyFsObservability(facts = {}) {
  const { fileExists, gitIgnored, error } = facts;
  if (error) {
    return { status: OBSERVABILITY.CANNOT_OBSERVE, reason: 'read-failed', detail: String(error) };
  }
  if (!fileExists) {
    return {
      status: OBSERVABILITY.CANNOT_OBSERVE,
      reason: gitIgnored ? 'file-missing-gitignored' : 'file-missing',
      detail: gitIgnored
        ? 'file is absent AND gitignored here — it lives in a private repo, so this checkout may simply never have had it'
        : 'file is absent, so its contents cannot be read',
    };
  }
  return { status: OBSERVABILITY.OBSERVABLE, reason: 'readable', detail: '' };
}

/** True only when a not-found result is real evidence rather than blindness. */
function absenceIsEvidence(observability) {
  return !!observability && observability.status === OBSERVABILITY.OBSERVABLE;
}

/**
 * Fold an observability verdict together with a found/not-found result into a
 * tri-state presence verdict. This is the whole point of the module: `found:
 * false` on an unobservable target does NOT become ABSENT.
 */
function classifyPresence({ observability, found } = {}) {
  if (!absenceIsEvidence(observability)) {
    return {
      presence: PRESENCE.CANNOT_OBSERVE,
      reason: (observability && observability.reason) || 'unknown',
      detail: (observability && observability.detail) || '',
    };
  }
  return {
    presence: found ? PRESENCE.PRESENT : PRESENCE.ABSENT,
    reason: observability.reason,
    detail: '',
  };
}

/** Throw rather than let a caller treat blindness as a clean result. */
function assertObservable(observability, label) {
  if (!absenceIsEvidence(observability)) throw new CannotObserveError(observability, label);
  return observability;
}

// ── IO probes (thin; every dependency injectable) ───────────────────────────

function defaultRunner(cwd) {
  const { execFileSync } = require('child_process');
  return (args) => {
    try {
      const stdout = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      });
      return { ok: true, stdout };
    } catch (e) {
      return { ok: false, stdout: '', error: e };
    }
  };
}

/** Is `relPath` gitignored in the repo at `cwd`? Never throws. */
function isGitIgnored(relPath, { cwd = process.cwd(), run } = {}) {
  const git = run || defaultRunner(cwd);
  return git(['check-ignore', '-q', '--', relPath]).ok;
}

/** Probe `<ref>:<relPath>` for readability. Returns an observability verdict. */
function probeGitPath({ ref, filePath, cwd = process.cwd(), run } = {}) {
  const git = run || defaultRunner(cwd);
  if (!ref || !filePath) {
    return classifyGitObservability({ error: 'probeGitPath requires { ref, filePath }' });
  }
  const refResolved = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
  const blobExists = refResolved ? git(['cat-file', '-e', `${ref}:${filePath}`]).ok : false;
  const gitIgnored = blobExists ? false : isGitIgnored(filePath, { cwd, run: git });
  return classifyGitObservability({ refResolved, blobExists, gitIgnored });
}

/** Probe a working-tree path for readability. Returns an observability verdict. */
function probeFsPath({ filePath, cwd = process.cwd(), run, fsImpl } = {}) {
  const fs = fsImpl || require('fs');
  const path = require('path');
  if (!filePath) return classifyFsObservability({ error: 'probeFsPath requires { filePath }' });
  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  let fileExists = false;
  try {
    fileExists = fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch (e) {
    return classifyFsObservability({ error: e.message });
  }
  const gitIgnored = fileExists ? false : isGitIgnored(filePath, { cwd, run });
  return classifyFsObservability({ fileExists, gitIgnored });
}

/**
 * The full check: read the target (git ref or working tree), test it for
 * `contains`, and return a tri-state presence verdict.
 *
 * @param {object} opts
 * @param {string} [opts.ref]      read `<ref>:<filePath>` instead of the working tree
 * @param {string} opts.filePath
 * @param {string|RegExp|function} opts.contains
 * @param {string} [opts.cwd]
 */
function observePresence({ ref, filePath, contains, cwd = process.cwd(), run, fsImpl } = {}) {
  const observability = ref
    ? probeGitPath({ ref, filePath, cwd, run })
    : probeFsPath({ filePath, cwd, run, fsImpl });
  if (!absenceIsEvidence(observability)) return { ...classifyPresence({ observability }), observability };

  let content;
  try {
    if (ref) {
      const git = run || defaultRunner(cwd);
      const res = git(['show', `${ref}:${filePath}`]);
      if (!res.ok) {
        // Readable a moment ago, unreadable now (concurrent gc, permissions):
        // still CANNOT_OBSERVE — never a silent pass.
        const raced = classifyGitObservability({ error: (res.error && res.error.message) || 'git show failed' });
        return { ...classifyPresence({ observability: raced }), observability: raced };
      }
      content = res.stdout;
    } else {
      const fs = fsImpl || require('fs');
      const path = require('path');
      const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      content = fs.readFileSync(abs, 'utf8');
    }
  } catch (e) {
    const failed = classifyFsObservability({ fileExists: true, error: e.message });
    return { ...classifyPresence({ observability: failed }), observability: failed };
  }

  let found;
  if (typeof contains === 'function') found = !!contains(content);
  else if (contains instanceof RegExp) found = contains.test(content);
  else found = content.includes(String(contains));

  return { ...classifyPresence({ observability, found }), observability };
}

module.exports = {
  OBSERVABILITY,
  PRESENCE,
  CannotObserveError,
  // pure
  classifyGitObservability,
  classifyFsObservability,
  classifyPresence,
  absenceIsEvidence,
  assertObservable,
  // io
  isGitIgnored,
  probeGitPath,
  probeFsPath,
  observePresence,
};
