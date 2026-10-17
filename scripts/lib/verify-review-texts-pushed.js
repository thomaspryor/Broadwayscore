'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveReviewTextsDir, isReviewTextsCheckout } = require('./review-texts-dir');
const { repoDepthArgs } = require('./shallow-fetch-args');

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
 * @param {function} [opts.predicate] - (parsedRemoteJson, relPath) => boolean.
 *   BRO-3954 ship-check finding (Codex adversarial review): comparing local
 *   disk to origin/main proves nothing if LOCAL was already reverted before
 *   this runs — e.g. sync-review-texts.sh's own `git pull --rebase origin
 *   main` conflict-resolving a concurrent remote edit by silently dropping
 *   the local wrongShow:true write. Both sides then agree on the WRONG
 *   value and a bare diff reports ok:true. When a caller knows the specific
 *   postcondition its write is supposed to establish (e.g. `wrongShow ===
 *   true`), passing it here checks that condition directly against
 *   origin/main's actual content instead of trusting local disk at all.
 *   Falls back to the local-vs-remote diff below when omitted, for callers
 *   with no single uniform postcondition to check.
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

  // BRO-3954 ship-check finding: a bare `git fetch origin main` has no depth
  // bound — from a shallow checkout (e.g. this repo's own check-corpus-
  // drift.yml, fetch-depth: 1) that asks upload-pack for main's ENTIRE
  // history (165k+ commits / ~2.1 GB here, task #466's audit-unbounded-
  // fetch.js caught it live in this exact file). Depth-bound it to `dir`'s
  // OWN shallow-ness via scripts/lib/shallow-fetch-args.js's repoDepthArgs()
  // ([] on a complete clone, which the review-texts checkout usually is)
  // BEFORE the try block, so the waiver comment below can sit directly above
  // the fetch call with no intervening statement — audit-unbounded-fetch.js's
  // isWaived() walks up through a CONTIGUOUS comment block only; a `const`
  // line between the waiver and the git call breaks that walk and the
  // waiver silently stops applying.
  const extraArgs = repoDepthArgs({ repoRoot: dir });
  try {
    // unbounded-fetch-ok: bound arrives via the extraArgs spread below —
    // scripts/audit-unbounded-fetch.js is a static text scan and cannot see
    // through a runtime-computed array, same "waiver lives here, not a fake
    // flag on the git line" shape as push-with-retry.sh's git_fetch() wrapper
    // (scripts/lib/push-with-retry.sh ~line 154), the canonical precedent.
    execFileSync('git', ['fetch', 'origin', 'main', ...extraArgs, '-q'], {
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

    if (opts.predicate) {
      // Check the postcondition against origin/main directly — never trust
      // local disk as a stand-in for "the fix shipped" (see the opts.predicate
      // doc comment above for why that trust is misplaced).
      let remoteParsed;
      try {
        remoteParsed = JSON.parse(remoteRaw);
      } catch {
        notPushed.push(rel); // invalid JSON on origin/main — fail closed, not a silent pass
        continue;
      }
      if (!opts.predicate(remoteParsed, rel)) notPushed.push(rel);
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
// reformats whitespace doesn't register as "not pushed" when the actual
// field values already match. Recursively sorts object keys before
// stringifying — `JSON.stringify(JSON.parse(raw))` alone PRESERVES key
// insertion order (Codex ship-check finding: the original version of this
// function claimed order-insensitivity it didn't actually have — two JSON
// texts with identical values in different key order stringify to different
// strings and would falsely report "not pushed"). Arrays are left in place:
// element order is semantic for a JSON array, unlike object key order.
function normalizeJson(raw) {
  try { return JSON.stringify(sortKeysDeep(JSON.parse(raw))); } catch { return raw.trim(); }
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

module.exports = { verifyReviewTextsPushed };
