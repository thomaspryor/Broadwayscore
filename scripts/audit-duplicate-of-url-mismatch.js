#!/usr/bin/env node
/**
 * audit-duplicate-of-url-mismatch.js
 *
 * Flags review files where `duplicateOf` points at a sibling whose URL no
 * longer matches our own. Catches the Sommers/Bernardo failure mode: a stale
 * duplicate flag persists after the URL that triggered the collision has been
 * corrected, silently excluding a legitimate review.
 *
 * Usage:
 *   node scripts/audit-duplicate-of-url-mismatch.js          # Report (exit 1 on ANY mismatch)
 *   node scripts/audit-duplicate-of-url-mismatch.js --gate   # Per-push trunk catastrophe FLOOR
 *   node scripts/audit-duplicate-of-url-mismatch.js --fix    # Clear stale flags
 *   node scripts/audit-duplicate-of-url-mismatch.js --json   # JSON output (CI)
 *
 * --gate (vs report mode) as of 2026-06-29: review-texts live in a SEPARATE private
 * repo that data bots mutate every ~2min, so report mode (block on ANY mismatch)
 * reddened the trunk for every UNRELATED code push whenever a single stale
 * duplicateOf pointer existed in the window before its self-heal cleared it (the
 * 4-BWW sinatra-the-musical-west-end-2026 case, run 28388064370). EVERY mismatch is
 * auto-healable by clear-stale-duplicate-of.yml --fix, so single-file drift must NOT
 * block. --gate blocks only on a mass SPIKE past FIX_SURGE_THRESHOLD — a producer
 * regression where auto-clearing would flood scoring with double-counted reviews.
 * Decision logic + tests: scripts/lib/duplicate-of-gate.{js,test.mjs}. The FULL
 * report-mode triage runs daily in check-corpus-drift.yml, surfaced non-blocking.
 *
 * Exit codes:
 *   0 — no mismatches (report) / not a catastrophe (--gate)
 *   1 — mismatches found (report/CI gate) / spike past floor (--gate)
 */

const fs = require('fs');
const path = require('path');
const { normalizeUrl } = require('./lib/review-normalization');
const { safeWriteReview } = require('./lib/review-write-guard');
const { shouldBlockDuplicateOfGate } = require('./lib/duplicate-of-gate');
const { findDuplicateOfCycle } = require('./lib/duplicate-cycle');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-duplicate-of-url-mismatch.js — Flags review files where 'duplicateOf' points at a sibling whose URL no.

Usage:
  node scripts/audit-duplicate-of-url-mismatch.js [options]
  node scripts/audit-duplicate-of-url-mismatch.js --help, -h    print this usage and exit
`;
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const GATE = args.includes('--gate');
const JSON_OUT = args.includes('--json');
const FORCE_BULK = args.includes('--force-bulk');

// Surge guard: --fix nulls duplicateOf flags, which re-admits those reviews to
// scoring. A handful per day is normal churn. A sudden spike means a producer
// regression (e.g. review-write-guard writing bad pointers, or a mass sibling
// rename) — auto-clearing it would flood scoring with double-counted reviews.
// Above this count, --fix refuses and reddens CI for manual review unless
// --force-bulk is passed. See plan-review pre-mortem (SECONDARY) 2026-05-31.
const FIX_SURGE_THRESHOLD = 25;

// Canonicalize for comparison: drop the query string, then trim trailing
// encoded-spaces / whitespace / slashes that normalizeUrl leaves intact. A
// genuinely different article still differs by PATH; only trivially-dirty
// variants of the SAME url collapse to equal. Exported for the unit test.
function stripTrivial(u) {
  if (!u) return u;
  return u.split('?')[0].replace(/(?:%20|\s|\/)+$/gi, '');
}

/**
 * Non-show buckets under review-texts/ that this audit must not scan.
 *
 * `_superseded-misattributed/` is a TOMBSTONE dir: a duplicateOf pointer inside
 * it is a historical record whose sibling stayed behind in the real show dir,
 * so it reads as `sibling-missing` forever and never self-heals. On 2026-08-04
 * the 27 files task #988 archived there pushed the auto-healable count to 32,
 * past the 25 floor, and reddened the trunk for every unrelated push — a false
 * spike, not the producer regression this gate exists to catch. Its entries are
 * also flat (`show-id--outlet--critic.json`), so they have no sibling namespace
 * to resolve a pointer against in the first place. rebuild-all-reviews.js
 * already ignores it from the other side (not in shows.json), so nothing in it
 * reaches scoring.
 *
 * `_pending/` is listed for honesty, not effect: it nests one level deeper
 * (`_pending/<showId>/<file>.json`), so this audit's flat per-dir scan has
 * always found zero files there. Naming it documents that _pending duplicateOf
 * pointers are UNCOVERED by this gate rather than implying they were checked.
 *
 * Deliberately an explicit list, not a `_`-prefix rule: a future bucket
 * (`_quarantine/`) should show up as noise here and force a decision, not be
 * silently exempted. Note locks-index.js SHOW_DIR_SKIPLIST is a DIFFERENT,
 * narrower list (`_pending` + `.git`) — this is not a shared constant.
 */
const NON_SHOW_DIRS = new Set(['_pending', '_superseded-misattributed']);

function isShowDir(name) {
  return !name.startsWith('.') && !NON_SHOW_DIRS.has(name);
}

function walkShowDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && isShowDir(e.name))
    .map(e => path.join(root, e.name));
}

function audit() {
  const mismatches = [];
  const showDirs = walkShowDirs(REVIEW_TEXTS_DIR);
  let scanned = 0;

  for (const showDir of showDirs) {
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    const cache = {};
    const load = (name) => {
      if (cache[name] !== undefined) return cache[name];
      try { cache[name] = JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf-8')); }
      catch { cache[name] = null; }
      return cache[name];
    };

    for (const file of files) {
      const data = load(file);
      if (!data) continue;
      scanned++;

      // duplicateTextOf: content-fingerprint dedup. A URL mismatch against the
      // sibling is EXPECTED (same text syndicated at different URLs), so only
      // the structurally-impossible pointer states are stale:
      //   - self-reference: a file cannot be a duplicate of itself. Born when
      //     safeRenameReview renames `outlet--unknown.json` (flagged as a dupe
      //     of `outlet--critic.json`) onto that very name once the byline is
      //     identified — the pointer rides along and now targets its own file
      //     (jesus-christ-superstar-west-end-2026 Time Out/LBO/Radio Times,
      //     116 corpus-wide, 2026-07-09).
      //   - sibling-missing: pointer target was deleted; this file is the
      //     survivor and must re-enter scoring.
      if (typeof data.duplicateTextOf === 'string' && data.duplicateTextOf.endsWith('.json')) {
        if (data.duplicateTextOf === file) {
          mismatches.push({
            showId: path.basename(showDir),
            file,
            field: 'duplicateTextOf',
            duplicateOf: data.duplicateTextOf,
            reason: 'self-reference',
            url: data.url || null,
            siblingUrl: null,
          });
        } else if (!load(data.duplicateTextOf)) {
          mismatches.push({
            showId: path.basename(showDir),
            file,
            field: 'duplicateTextOf',
            duplicateOf: data.duplicateTextOf,
            reason: 'sibling-missing',
            url: data.url || null,
            siblingUrl: null,
          });
        }
      }

      if (!data.duplicateOf) continue;
      if (typeof data.duplicateOf !== 'string' || !data.duplicateOf.endsWith('.json')) continue;

      if (data.duplicateOf === file) {
        mismatches.push({
          showId: path.basename(showDir),
          file,
          field: 'duplicateOf',
          duplicateOf: data.duplicateOf,
          reason: 'self-reference',
          url: data.url || null,
          siblingUrl: null,
        });
        continue;
      }

      const sibling = load(data.duplicateOf);
      if (!sibling) {
        mismatches.push({
          showId: path.basename(showDir),
          file,
          field: 'duplicateOf',
          duplicateOf: data.duplicateOf,
          reason: 'sibling-missing',
          url: data.url || null,
          siblingUrl: null,
        });
        continue;
      }

      // Compare path WITHOUT the query string. normalizeUrl strips a fixed
      // allow-list of tracking params (utm_*, ref, fbclid, …) but not every
      // outlet's — e.g. WSJ's Google-news-feed `?st=…&mod=googlenewsfeed`,
      // which made a correctly-deduped WSJ review (same article, tracked vs
      // bare URL) flag as a false-positive url-mismatch and flap the CI gate
      // (home-2024/wsj 2026-06-06). A genuine stale flag (the Sommers case —
      // a URL corrected to a DIFFERENT article) differs by PATH, so dropping
      // the query keeps that detection while killing tracking-only noise.
      // Done here (not in normalizeUrl, which is on the scoring watchlist).
      //
      // Also strip a trailing encoded-space / whitespace / slash. normalizeUrl
      // does NOT trim a trailing "%20" (the-maids-off-broadway-2026 thewrap stub
      // differed from its genuine duplicate only by a trailing %20). Without
      // this, --fix would read the trivially-dirty URL as a DIFFERENT article,
      // clear the duplicateOf, and resurface a real duplicate into scoring. The
      // Sommers/much-ado genuine-stale case still differs by PATH and survives.
      const canon = (u) => stripTrivial(normalizeUrl(u));
      const a = canon(data.url);
      const b = canon(sibling.url);
      if (a && b && a !== b) {
        mismatches.push({
          showId: path.basename(showDir),
          file,
          field: 'duplicateOf',
          duplicateOf: data.duplicateOf,
          reason: 'url-mismatch',
          url: data.url,
          siblingUrl: sibling.url,
        });
        continue;
      }

      // Cycle detection: walk the duplicateOf chain from `file`. The single-hop
      // 2-cycle (A.duplicateOf=B, B.duplicateOf=A) is handled by rebuild-all-reviews.js's
      // circular-tiebreak (content-fingerprint comparison), and (since Notion #967)
      // rebuild also handles N-node cycles via the same shared walk below — but this
      // audit still reports both lengths as a defense-in-depth signal, and as the
      // human-triage surface for cycles rebuild can't auto-resolve (no unambiguous
      // canonical member). Originally added because a 3+-node cycle (A->B->C->A)
      // never found a terminal non-duplicate node, so EVERY member fell through
      // rebuild's old "ref is also a dupe" skip check and ALL of them landed in
      // reviews.json as same-URL duplicates (Notion #941 — washpost 3-cycle:
      // andor-brodeur -> justin-davidson -> michael-andor-brodeur -> andor-brodeur).
      // Bound by the show dir's own file count, not a fixed constant — a cycle
      // can't be longer than the number of files that could participate in it,
      // and a fixed cap (e.g. 20) would silently MISS longer cycles (caught by a
      // 30-file stress test in duplicate-of-url-mismatch.test.mjs).
      const { cycleFound, chain } = findDuplicateOfCycle(file, load, files.length);
      if (cycleFound) {
        mismatches.push({
          showId: path.basename(showDir),
          file,
          field: 'duplicateOf',
          duplicateOf: data.duplicateOf,
          reason: 'duplicateOf-cycle',
          url: data.url || null,
          siblingUrl: null,
          chain,
        });
      }
    }
  }

  return { mismatches, scanned };
}

function fix(mismatches) {
  let cleared = 0;
  for (const m of mismatches) {
    // Cycles have no unambiguous auto-fix: unlike a stale pointer (one clear
    // "right" side — the surviving file), picking which cycle member becomes
    // canonical requires judgment (byline completeness, which copy has real
    // content/score, etc. — see the Notion #941 washpost fix). Surfaced in the
    // report for manual triage instead of silently nulling an arbitrary member.
    if (m.reason === 'duplicateOf-cycle') continue;
    const filePath = path.join(REVIEW_TEXTS_DIR, m.showId, m.file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const field = m.field || 'duplicateOf';
    const reason = m.reason === 'self-reference'
      ? `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: ${field} pointed at this file itself`
      : m.reason === 'sibling-missing'
        ? `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: sibling ${m.duplicateOf} no longer exists`
        : `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: our URL ${data.url} ≠ sibling ${m.duplicateOf} URL ${m.siblingUrl}`;
    data.duplicateClearReason = reason;
    if (field === 'duplicateTextOf') {
      // No duplicateTextOfCleared: the content-fingerprint pass must stay free
      // to re-flag this file with a CORRECT pointer if a genuine dupe exists.
      // Delete rather than null — validate-data flags null as "should be string".
      delete data.duplicateTextOf;
    } else {
      data.duplicateOf = null;
      data.duplicateReason = null;
    }
    safeWriteReview(filePath, data);
    cleared++;
  }
  return cleared;
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const { mismatches, scanned } = audit();

  try {
    assertCorpusScanned(scanned, { gate: GATE });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ count: mismatches.length, mismatches }, null, 2));
    process.exit(mismatches.length === 0 ? 0 : 1);
  }

  if (mismatches.length === 0) {
    console.log('OK: no duplicateOf URL mismatches found');
    process.exit(0);
  }

  console.log(`Found ${mismatches.length} duplicateOf URL mismatch(es):\n`);
  for (const m of mismatches) {
    console.log(`  ${m.showId}/${m.file}`);
    console.log(`    → duplicateOf: ${m.duplicateOf}  (${m.reason})`);
    console.log(`    → our url:     ${m.url}`);
    console.log(`    → sibling url: ${m.siblingUrl}`);
    if (m.chain) console.log(`    → chain:       ${m.chain.join(' -> ')} -> ...`);
    console.log('');
  }

  const cycles = mismatches.filter(m => m.reason === 'duplicateOf-cycle');
  // Cycles never self-heal (fix() explicitly refuses them — picking the canonical
  // member needs human judgment) and their count scales with cycle SIZE, not
  // incident count (one 7-file cycle = 7 entries). Mixing them into the surge/gate
  // floor below — designed around self-healing, one-mismatch-per-incident churn —
  // would let a single uncleared cycle permanently eat headroom off the 25-item
  // floor, eventually blocking --fix or reddening --gate for unrelated, genuinely
  // auto-healable stale flags. Count only the auto-healable reasons against it.
  const autoHealable = mismatches.filter(m => m.reason !== 'duplicateOf-cycle');

  if (FIX) {
    if (autoHealable.length > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
      console.error(`::error::Refusing to auto-clear ${autoHealable.length} stale duplicateOf flags (> ${FIX_SURGE_THRESHOLD}). A spike this large usually means a producer regression, not routine churn — auto-clearing would re-admit a flood of reviews to scoring. Investigate the cause, then re-run with --force-bulk if the clears are legitimate.`);
      process.exit(1);
    }
    const cleared = fix(mismatches);
    console.log(`\nCleared ${cleared} stale duplicateOf flag(s). Re-run rebuild to surface the recovered reviews.`);
    if (cycles.length > 0) {
      console.log(`\n${cycles.length} duplicateOf-cycle mismatch(es) were NOT auto-fixed — choosing which file becomes canonical needs manual review. See the chains above.`);
    }
    process.exit(0);
  }

  // --gate: catastrophe floor only. Every AUTO-HEALABLE mismatch (i.e. excluding
  // duplicateOf-cycle, which never self-heals — see autoHealable above) is
  // auto-healable by clear-stale-duplicate-of.yml --fix, so a sub-floor count is
  // surfaced above but does NOT block the trunk. A spike past FIX_SURGE_THRESHOLD
  // is a producer regression where auto-clearing would flood scoring — that blocks.
  if (GATE) {
    if (shouldBlockDuplicateOfGate({ mismatchCount: autoHealable.length, floor: FIX_SURGE_THRESHOLD })) {
      console.error(`\n❌ GATE: ${autoHealable.length} auto-healable duplicateOf URL mismatch(es) > floor ${FIX_SURGE_THRESHOLD}. A spike this large signals a producer regression, not routine churn — failing the trunk for manual review before the self-heal re-admits a flood of reviews.`);
      process.exit(1);
    }
    console.log(`\n✅ GATE: ${autoHealable.length} auto-healable duplicateOf URL mismatch(es) ≤ floor ${FIX_SURGE_THRESHOLD}${cycles.length > 0 ? ` (+ ${cycles.length} duplicateOf-cycle, excluded — needs manual triage, never auto-clears)` : ''}. Auto-healable churn — surfaced above, not blocking the trunk. clear-stale-duplicate-of.yml --fix clears these; full report-mode triage runs daily in check-corpus-drift.yml (→ digest).`);
    process.exit(0);
  }

  console.log('Run with --fix to clear stale flags.');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { stripTrivial, audit, fix };
