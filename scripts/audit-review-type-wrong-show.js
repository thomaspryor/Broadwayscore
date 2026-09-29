#!/usr/bin/env node

/**
 * Audit isNonReview:true files whose classifier contentType is literally
 * 'review' but which have never been promoted to wrongShow:true (BRO-3862).
 *
 * See scripts/lib/nonreview-contenttype-wrongshow.js for the full background
 * on why this class exists and why audit-cross-show-url.js's URL-slug
 * detector can't catch it (content mismatch, not URL-shape mismatch).
 *
 * Report-only by default. --apply promotes matches to wrongShow:true,
 * mirroring the field shape audit-cross-show-url.js's --fix already writes
 * (wrongShow, isValid:false, rejectionReason, wrongShowReason,
 * wrongShowFlaggedDate) so downstream consumers (isScoreable, the
 * cross-attribution fix tools) treat these identically to every other
 * wrongShow file. isNonReview is left untouched — it already correctly
 * excludes the file from reviews.json; this audit only makes that exclusion
 * visible to the wrongShow-keyed pipeline instead of silently
 * piggy-backing on a flag that means something else.
 *
 * Usage:
 *   node scripts/audit-review-type-wrong-show.js                # report, exits 0
 *   node scripts/audit-review-type-wrong-show.js --apply         # promote matches
 *   node scripts/audit-review-type-wrong-show.js --show=ID
 *   node scripts/audit-review-type-wrong-show.js --gate --max=0
 *   node scripts/audit-review-type-wrong-show.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { isReviewTypeWrongShowGap } = require('./lib/nonreview-contenttype-wrongshow');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');
const { safeWriteReview, invalidateWrongShowAutoClear } = require('./lib/review-write-guard');
const { verifyReviewTextsPushed } = require('./lib/verify-review-texts-pushed');
const { execFileSync } = require('child_process');
const { resolveReviewTextsDir, isReviewTextsCheckout } = require('./lib/review-texts-dir');
const { repoDepthArgs } = require('./lib/shallow-fetch-args');

const USAGE = `audit-review-type-wrong-show.js — promote isNonReview:true/nonReviewType:'review' files to wrongShow (BRO-3862)

Usage:
  node scripts/audit-review-type-wrong-show.js [--apply] [--show=ID] [--gate] [--max=0] [--json]
  node scripts/audit-review-type-wrong-show.js --verify-pushed

  --apply          write wrongShow:true (+ reason/flag fields) to matched files.
                    Default is report-only.
  --show=ID        scope the sweep to one show directory
  --gate           exit 1 when the match count exceeds --max (baseline floor, wired into CI)
  --max=N          ceiling for --gate (default 0 — every instance of this gap is actionable)
  --json           machine-readable output
  --verify-pushed  BRO-3954: confirm the files from the LAST --apply run (per
                    ${'`'}data/audit/review-type-wrong-show-audit.json${'`'}) are actually on
                    origin/main of the review-texts private repo — not just written to local
                    disk. Run this AFTER --apply and AFTER pushing (scripts/sync-review-texts.sh)
                    and BEFORE reporting the fix done. Exits 1 loudly if any file's edit never
                    made it to the data repo (this is what would have caught BRO-3862's silent
                    push failure before it was reported Done).
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const LOG_PATH = path.join(AUDIT_DIR, 'review-type-wrong-show-audit.json');

const SKIP_DIRS = new Set(['_pending', '_superseded-misattributed']);

function parseArgs(argv) {
  const args = {
    apply: argv.includes('--apply'),
    gate: argv.includes('--gate'),
    json: argv.includes('--json'),
    show: null,
    max: parseMaxArgOrExit(argv, { defaultMax: 0, scriptName: 'audit-review-type-wrong-show' }),
  };
  for (const a of argv) {
    if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

// Same { dirs, rootMissing } contract as audit-exclusion-flags.js's
// listShowDirs — a missing/empty REVIEW_TEXTS_DIR has no legitimate reading
// distinct from a --show filter matching nothing (BRO-2283 vacuous-pass class).
function listShowDirs(dir, showFilter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dirs: [], rootMissing: true };
  }
  if (entries.length === 0) return { dirs: [], rootMissing: true };
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => !showFilter || name === showFilter)
    .filter((name) => {
      try { return fs.statSync(path.join(dir, name)).isDirectory(); }
      catch { return false; }
    });
  return { dirs, rootMissing: false };
}

function applyPromote(data, showId, file) {
  const now = new Date().toISOString();
  data.wrongShow = true;
  invalidateWrongShowAutoClear(data);
  data.isValid = false;
  data.rejectionReason = 'wrong_show';
  data.wrongShowReason = `nonReviewType='review' promoted: classify-non-reviews.js (${data.nonReviewClassifiedBy || 'gemini'}) identified this content as a genuine review, but not of ${showId} — content mismatch, not a URL-shape match (audit-review-type-wrong-show.js, BRO-3862).`;
  data.wrongShowFlaggedDate = now.slice(0, 10);
  return data;
}

// BRO-3954 ship-check finding (Codex adversarial review, P1): running --apply
// twice before pushing makes the SECOND run find 0 new matches (the files are
// already promoted on local disk) and overwrite the log with hits:[] — a
// verify step that only trusts the log's hit count then reports "nothing to
// verify" while the FIRST run's real, still-unpushed write sits on disk. This
// asks the checkout itself, not a receipt that can go stale: uncommitted
// changes OR local commits ahead of origin/main mean something is pending
// regardless of what the log currently says.
function reviewTextsCleanAndPushed(dir) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (dirty) return { clean: false, reason: `${dir} has uncommitted changes:\n${dirty}` };
    const ahead = execFileSync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (ahead !== '0') return { clean: false, reason: `${dir} is ${ahead} commit(s) ahead of origin/main — committed locally but not pushed` };
    return { clean: true };
  } catch (e) {
    return { clean: false, reason: `could not check git state of ${dir}: ${e.message}` };
  }
}

// BRO-3954: reads back the LAST --apply run's audit log and confirms every
// file it touched is actually reflected on origin/main of the review-texts
// private repo — the check missing from the BRO-3862 incident, where the
// session's own "verified + pushed" claim only ever checked THIS (web) repo's
// git log, never the data repo the write actually landed in.
function verifyPushed() {
  const dir = resolveReviewTextsDir();
  if (!isReviewTextsCheckout(dir)) {
    console.error(`FAIL: ${dir} is not a git checkout — cannot verify anything was pushed.`);
    process.exit(1);
  }

  const extraArgs = repoDepthArgs({ repoRoot: dir });
  try {
    // unbounded-fetch-ok: bound arrives via the extraArgs spread below, same
    // shape/precedent as scripts/lib/verify-review-texts-pushed.js's own fetch
    // (see that file's identical comment for the full rationale).
    execFileSync('git', ['fetch', 'origin', 'main', ...extraArgs, '-q'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
  } catch (e) {
    console.error(`FAIL: git fetch origin main failed in ${dir}: ${e.message}`);
    process.exit(1);
  }

  const cleanState = reviewTextsCleanAndPushed(dir);
  if (!cleanState.clean) {
    console.error(`FAIL: ${cleanState.reason}`);
    console.error('\nThis fires independently of the audit log below — it means data/review-texts itself has');
    console.error('pending local changes right now, regardless of what the last --apply run reported (e.g. a');
    console.error('second --apply run before pushing can overwrite the log with 0 matches while the FIRST');
    console.error('run\'s real write is still sitting unpushed). Run scripts/sync-review-texts.sh, then re-verify.');
    process.exit(1);
  }

  if (!fs.existsSync(LOG_PATH)) {
    console.error(`FAIL: no audit log at ${LOG_PATH} — run --apply first.`);
    process.exit(1);
  }
  const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  if (!log._meta || log._meta.applied !== true) {
    console.error(`FAIL: ${LOG_PATH} is from a report-only run (applied=${log._meta && log._meta.applied}) — nothing was written, so there is nothing to verify pushed.`);
    process.exit(1);
  }
  const allHits = log.hits || [];
  // Only a hit whose write actually stuck locally (see the `hit.written`
  // stamp in the --apply loop) can ever be certified as pushed — a failed
  // write must not be certifiable just because the unchanged file happens to
  // already match origin/main (Codex ship-check P1 finding).
  const writtenHits = allHits.filter((h) => h.written === true);
  const failedHits = allHits.filter((h) => h.written !== true);
  if (failedHits.length > 0) {
    console.error(`FAIL: ${failedHits.length} of ${allHits.length} hit(s) from the last --apply run never wrote successfully — fix those before verifying:`);
    for (const h of failedHits) console.error(`  ${h.showId}/${h.file}`);
    process.exit(1);
  }
  if (writtenHits.length === 0) {
    console.log('Nothing to verify — the last --apply run had 0 matches, and data/review-texts is clean and fully pushed.');
    return;
  }
  const filePaths = writtenHits.map((h) => path.join(REVIEW_TEXTS_DIR, h.showId, h.file));
  // predicate checks origin/main's ACTUAL content, not "does local match
  // remote" — both can silently agree on the wrong value if local was
  // reverted (e.g. by a rebase) after a real push already landed the fix,
  // or reverted before a push ever happened (Codex ship-check P1 finding).
  const result = verifyReviewTextsPushed(filePaths, { reviewTextsDir: dir, predicate: (data) => data.wrongShow === true });
  if (!result.ok) {
    console.error(`FAIL: ${result.reason}`);
    if (result.notPushed) {
      for (const f of result.notPushed) console.error(`  NOT PUSHED: ${f}`);
    }
    console.error('\nRun scripts/sync-review-texts.sh (or scripts/lib/safe-sync-review-texts.sh) to push, then re-run --verify-pushed before reporting this fix done.');
    process.exit(1);
  }
  console.log(`OK: all ${filePaths.length} file(s) from the last --apply run are confirmed wrongShow:true on origin/main in ${result.reviewTextsDir}.`);
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  if (argv.includes('--verify-pushed')) { verifyPushed(); return; }
  const args = parseArgs(argv);

  const hits = [];
  let scanned = 0;

  const { dirs: showDirs, rootMissing } = listShowDirs(REVIEW_TEXTS_DIR, args.show);
  try {
    assertCorpusScanned(0, { corpusRootMissing: rootMissing });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      scanned++;

      if (!isReviewTypeWrongShowGap(data)) continue;

      hits.push({
        showId,
        file,
        outlet: data.outlet || data.outletId || null,
        critic: data.criticName || null,
        url: data.url || null,
        score: (data.llmScore && data.llmScore.score) || data.assignedScore || null,
        classifiedAt: data.classifiedAt || null,
      });

      if (args.apply) {
        const hit = hits[hits.length - 1];
        try {
          applyPromote(data, showId, file);
          safeWriteReview(filePath, data, { force: true });
          const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          // BRO-3954 ship-check finding (Codex adversarial review, P1): a
          // failed write only ever printed an error — the hit still went into
          // the log with the run's blanket `applied:true`, so --verify-pushed
          // certified it if the (unchanged) local file happened to already
          // match origin/main. Stamping per-hit `written` and filtering on it
          // at verify time means a failed write can never be certified pushed.
          hit.written = after.wrongShow === true;
          if (!hit.written) {
            console.error(`  ERROR: write did not stick for ${showId}/${file} (wrongShow=${after.wrongShow})`);
          }
        } catch (e) {
          hit.written = false;
          console.error(`  ERROR applying promote to ${showId}/${file}: ${e.message}`);
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, count: hits.length, applied: args.apply, hits }, null, 2));
  } else {
    console.log(`Review-type wrongShow gap audit: ${scanned} review file(s) scanned, ${hits.length} match(es) (${args.apply ? 'APPLIED' : 'report-only, pass --apply to promote'}).`);
    for (const h of hits) {
      console.log(`  ${h.showId}/${h.file}  score=${h.score} outlet=${h.outlet} url=${(h.url || '').slice(0, 80)}`);
    }
  }

  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify({
    _meta: { generatedAt: new Date().toISOString(), scanned, count: hits.length, applied: args.apply },
    hits,
  }, null, 2) + '\n');
  if (!args.json) console.log(`\nAudit log: ${LOG_PATH}`);

  // BRO-3954: writing the file locally is NOT the same as landing the fix — the
  // data repo (broadway-review-texts) is separate from this one and this
  // script never pushes to it. Say so loudly instead of letting a caller
  // assume the write alone is done (that assumption is exactly what produced
  // BRO-3862's silent regression). stderr, not stdout (Codex ship-check P2
  // finding): `--apply --json` must stay valid JSON on stdout for machine
  // consumers even when this reminder also fires.
  if (args.apply && hits.length > 0) {
    console.error(`\n${hits.length} file(s) written to local disk only. Next: run scripts/sync-review-texts.sh to push to the data repo, then\n  node scripts/audit-review-type-wrong-show.js --verify-pushed\nbefore reporting this fix done.`);
  }

  try {
    assertCorpusScanned(scanned, { gate: args.gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (args.gate && hits.length > args.max && !args.apply) {
    console.error(`\nFAIL: ${hits.length} hit(s) > max ${args.max}. A new classify-non-reviews.js run stamped nonReviewType='review' without a wrongShow promotion — run with --apply to promote, or raise --max if the new hits are false positives.`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { applyPromote, main, REVIEW_TEXTS_DIR };
