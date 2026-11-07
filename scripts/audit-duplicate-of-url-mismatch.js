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

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { stripTrivial, normalizeOutlet, canonicalizeHost, canonicalArticleKey } = require('./lib/review-normalization');
const { safeWriteReview } = require('./lib/review-write-guard');
const { shouldBlockDuplicateOfGate } = require('./lib/duplicate-of-gate');
const { findDuplicateOfCycle } = require('./lib/duplicate-cycle');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { clearCrossOutletFields } = require('./lib/cascade-clear-duplicate-refs');
const { crossOutletCyclePartner } = require('./lib/cross-outlet-cycle');
const { isCrossOutletSyndicationPair } = require('./lib/syndication-pairs');
const { isDuplicateOfUrlMismatch, clearDuplicateMismatch } = require('./lib/duplicate-of-url-mismatch');

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
// variants of the SAME url collapse to equal.
//
// Moved to lib/review-normalization.js (BRO-2409) so review-write-guard.js's
// write-time stale-duplicateOf self-heal can use the SAME comparator this
// audit does — re-exported here (not just required, see the require above)
// so the existing tests/unit/duplicate-of-url-mismatch.test.mjs import keeps
// working unchanged.

// Domain-alias folding (canonicalizeHost) lives in review-normalization.js
// (BRO-5321) with canonicalArticleKey, the one comparator the write guard's
// collision setter and stale-duplicateOf clearer also use. Re-exported below
// for tests/unit/duplicate-of-url-mismatch.test.mjs.

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

// Same comparator the duplicateOf URL check uses (also used to spot a renamed crossOutlet primary).
const canonUrl = (u) => canonicalArticleKey(u, { ignoreQuery: true });

// "<outlet>--<critic>.json": same known critic under a different outlet = likely the
// same piece re-filed after a rename (amny--matt-windman vs newsday--matt-windman).
function sameCriticSlug(a, b) {
  const crit = (n) => (n.replace(/\.json$/, '').split('--')[1] || '');
  const ca = crit(a);
  return !!ca && ca !== 'unknown' && ca === crit(b) && a !== b;
}

// The copy a dangling crossOutletPrimaryFile most likely meant: same canonical
// URL, a known syndication pair, or the same named critic under another outlet.
// Searches this show dir and the pointer's show dir. Returns {ref, data, showId,
// file} or null.
function findCrossOutletTwins(data, showDir, file, targetShow, load) {
  const mine = canonUrl(data.url);
  const dirs = new Set([showDir, path.join(REVIEW_TEXTS_DIR, targetShow)]);
  const twins = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!isReviewTextFile(f) || (dir === showDir && f === file)) continue;
      let o;
      try { o = dir === showDir ? load(f) : JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { o = null; }
      if (o && ((o.url && mine && canonUrl(o.url) === mine) || isCrossOutletSyndicationPair(data, o, normalizeOutlet) || sameCriticSlug(file, f))) {
        twins.push({ ref: `${path.basename(dir)}/${f}`, data: o, showId: path.basename(dir), file: f });
      }
    }
  }
  return twins;
}

// Does `twin`'s crossOutletPrimaryFile name exactly <showId>/<file>? A bare
// pointer resolves against the twin's own show dir.
function twinPointsAt(twin, showId, file) {
  const ptr = twin.data && twin.data.crossOutletDuplicate === true ? twin.data.crossOutletPrimaryFile : null;
  if (typeof ptr !== 'string') return false;
  const ptrShow = ptr.includes('/') ? ptr.split('/')[0] : twin.showId;
  return ptrShow === showId && path.basename(ptr) === file;
}

/**
 * BRO-3870: what --fix does with a crossOutletDuplicate whose primary was renamed
 * (one or more twin copies survive). Pure over its inputs.
 *   'repoint' — some twin is live in the rebuild: point at it. Score-neutral (we
 *               stay excluded), and the ref stops dangling. Checked FIRST: a live
 *               copy means clearing us would score the article twice.
 *   'clear'   — no twin is live, and a twin is itself crossOutletDuplicate naming
 *               exactly this file: the pair excluded each other and the review
 *               vanished; the twin's own verdict names us the primary.
 *   null      — anything else: report-only, a person decides.
 * @param {string} showId @param {string} file
 * @param {Array<{data: object, showId: string, live: boolean}>} twins
 * @returns {{action: 'repoint'|'clear'|null, twin: object|null}}
 */
function crossOutletRenamedAction(showId, file, twins) {
  const live = (twins || []).find((t) => t && t.live);
  if (live) return { action: 'repoint', twin: live };
  const defers = (twins || []).find((t) => t && twinPointsAt(t, showId, file));
  if (defers) return { action: 'clear', twin: defers };
  return { action: null, twin: (twins && twins[0]) || null };
}

let _showsById = null;
function showById(showId) {
  if (!_showsById) {
    _showsById = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf-8'));
      for (const s of (Array.isArray(raw) ? raw : raw.shows || [])) _showsById.set(s.id, s);
    } catch { /* no shows.json: show-aware guards see undefined, as in fixtures */ }
  }
  return _showsById.get(showId);
}

function isTwinLive(twin) {
  const { isIncludableForRebuild } = require('./lib/review-guards');
  try {
    return !!isIncludableForRebuild(twin.data, showById(twin.showId), path.join(REVIEW_TEXTS_DIR, twin.showId, twin.file));
  } catch (e) {
    console.warn(`::warning::isTwinLive(${twin.showId}/${twin.file}) failed: ${e.message} — treated as not live (report-only)`);
    return false;
  }
}

function audit() {
  const mismatches = [];
  const showDirs = walkShowDirs(REVIEW_TEXTS_DIR);
  let scanned = 0;

  for (const showDir of showDirs) {
    const files = fs.readdirSync(showDir).filter(f => isReviewTextFile(f));
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

      // crossOutletDuplicate (BRO-3872): explainExclusion treats the flag as
      // unconditionally exclusionary, so a primary deleted outside the cascade-clear
      // call sites (manual rm, migration, future script) silently drops a real review
      // forever. Detector writes crossOutletPrimaryFile as "<showId>/<file>"; resolve
      // against that show dir (1 of 202 flagged files points cross-dir), bare names
      // against this one. Missing/non-string pointer is reported but never auto-cleared.
      if (data.crossOutletDuplicate === true) {
        const showId = path.basename(showDir);
        const ptr = data.crossOutletPrimaryFile;
        if (typeof ptr !== 'string' || !ptr.endsWith('.json')) {
          mismatches.push({ showId, file, field: 'crossOutletDuplicate', duplicateOf: ptr ?? null, reason: 'pointer-missing', url: data.url || null, siblingUrl: null });
        } else {
          const targetShow = ptr.includes('/') ? ptr.split('/')[0] : showId;
          const targetFile = path.basename(ptr);
          const sameDir = targetShow === showId;
          const exists = sameDir
            ? (targetFile !== file && !!load(targetFile))
            : fs.existsSync(path.join(REVIEW_TEXTS_DIR, targetShow, targetFile));
          const base = { showId, file, field: 'crossOutletDuplicate', duplicateOf: ptr, url: data.url || null, siblingUrl: null };
          if (sameDir && targetFile === file) {
            // Renamed onto its own pointer target (safeRenameReview carries the
            // pointer along), so the old primary's text now lives in THIS file.
            // With no other copy left it is the only one and must score (BRO-3870);
            // a surviving same-URL/syndication/same-critic copy keeps it report-only.
            const twins = findCrossOutletTwins(data, showDir, file, targetShow, load);
            mismatches.push(twins.length
              ? { ...base, reason: 'self-reference', siblingUrl: twins[0].ref }
              : { ...base, reason: 'self-reference', action: 'clear' });
          } else if (sameDir && crossOutletCyclePartner(data, file, showId, load)) {
            // BRO-5265: mutual 2-cycle (the primary names this file as ITS primary).
            // Scoring keeps exactly one copy (cross-outlet-cycle.js tiebreak), but
            // the pair needs a byline check, so report-only (no action) for triage.
            mismatches.push({ ...base, reason: 'crossOutlet-cycle', siblingUrl: targetFile });
          } else if (!exists) {
            // A missing primary is not proof the review is unique: the primary is
            // often just RENAMED (outlet--unknown -> outlet--critic, show-dir rename)
            // and a same-URL or syndication-pair twin still sits next to us. Clearing then would score
            // the same article twice, so that case never clears unless the twin itself
            // defers to us (see crossOutletRenamedAction).
            const twins = findCrossOutletTwins(data, showDir, file, targetShow, load);
            if (twins.length) {
              for (const t of twins) t.live = isTwinLive(t);
              const { action, twin } = crossOutletRenamedAction(showId, file, twins);
              mismatches.push({ ...base, reason: 'primary-renamed', siblingUrl: twin.ref, ...(action ? { action } : {}) });
            } else {
              mismatches.push({ ...base, reason: 'sibling-missing', action: 'clear' });
            }
          }
        }
      }

      // BRO-5907: a file carrying only duplicateTextOf never reached the cycle
      // walk below, so a pure duplicateTextOf cycle (A -> B -> C -> A) was
      // never reported. findDuplicateOfCycle already follows both fields.
      if (!data.duplicateOf) {
        if (typeof data.duplicateTextOf === 'string' && data.duplicateTextOf.endsWith('.json')
            && data.duplicateTextOf !== file && load(data.duplicateTextOf)) {
          const { cycleFound, chain } = findDuplicateOfCycle(file, load, files.length);
          // Members only: a tail pointing into the cycle is a plain duplicate
          // and its target's own entry already reports the loop.
          if (cycleFound && chain.indexOf(chain[chain.length - 1]) === 0) {
            mismatches.push({
              showId: path.basename(showDir),
              file,
              field: 'duplicateTextOf',
              duplicateOf: data.duplicateTextOf,
              reason: 'duplicateOf-cycle',
              url: data.url || null,
              siblingUrl: null,
              chain,
            });
          }
        }
        continue;
      }
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
      // BRO-2406: a cross-outlet syndication pointer (same critic, Tribune-group
      // reprint, wire pair, or a human-declared syndication reason) differs by
      // URL BY DEFINITION — nulling it re-admits the double-counted review.
      // BRO-5329: explicit protectedFields: ['duplicateOf'] also covers manual
      // repost decisions whose criticName is unknown.
      if (isDuplicateOfUrlMismatch(data, sibling)) {
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
    if (m.field === 'crossOutletDuplicate') {
      // pointer-missing and undecided renamed primaries have no unambiguous
      // action (m.action unset) — report only.
      const today = new Date().toISOString().slice(0, 10);
      if (m.action === 'repoint') {
        // Score-neutral: stays excluded, now against the surviving copy.
        data.crossOutletPrimaryFile = m.siblingUrl;
        data.crossOutletRepointReason = `audit-duplicate-of-url-mismatch.js (--fix) on ${today}: ${m.duplicateOf} no longer exists; repointed to surviving copy ${m.siblingUrl}`;
        safeWriteReview(filePath, data);
        continue;
      }
      if (m.action !== 'clear') continue;
      const why = m.reason === 'self-reference'
        ? `crossOutletPrimaryFile pointed at this file itself and no other copy exists`
        : m.reason === 'primary-renamed'
          ? `crossOutletPrimaryFile ${m.duplicateOf} no longer exists and its surviving copy ${m.siblingUrl} names this file as its primary`
          : `crossOutletPrimaryFile ${m.duplicateOf} no longer exists`;
      clearCrossOutletFields(data, `audit-duplicate-of-url-mismatch.js (--fix) on ${today}: ${why}`);
      if (safeWriteReview(filePath, data)?.wrote !== false) cleared++;
      continue;
    }
    if (clearDuplicateMismatch(filePath, data, m)) cleared++;
  }
  return cleared;
}

function main() {
  // process.exit() after a large report truncates a piped stdout (the cycle report is ~30KB):
  // set exitCode and return so the pipe drains first. BRO-6086: this flaked the land check.
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const { mismatches, scanned } = audit();

  try {
    assertCorpusScanned(scanned, { gate: GATE });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exitCode = 1; return;
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ count: mismatches.length, mismatches }, null, 2));
    process.exitCode = mismatches.length === 0 ? 0 : 1; return;
  }

  if (mismatches.length === 0) {
    console.log('OK: no duplicateOf URL mismatches found');
    process.exitCode = 0; return;
  }

  const dupMismatches = mismatches.filter(m => m.field !== 'crossOutletDuplicate');
  console.log(`Found ${mismatches.length} duplicateOf/crossOutletDuplicate URL mismatch(es):\n`);
  for (const m of dupMismatches) {
    console.log(`  ${m.showId}/${m.file}`);
    console.log(`    → ${m.field === 'duplicateTextOf' ? 'duplicateTextOf' : 'duplicateOf'}: ${m.duplicateOf}  (${m.reason})`);
    console.log(`    → our url:     ${m.url}`);
    console.log(`    → sibling url: ${m.siblingUrl}`);
    if (m.chain) console.log(`    → chain:       ${m.chain.join(' -> ')} -> ...`);
    console.log('');
  }

  const crossOutlet = mismatches.filter(m => m.field === 'crossOutletDuplicate');
  const crossOutletHealable = crossOutlet.filter(m => m.action === 'clear');
  const crossOutletRepoint = crossOutlet.filter(m => m.action === 'repoint');
  if (crossOutlet.length > 0) {
    console.log(`crossOutletDuplicate: ${crossOutlet.length} primary pointer issue(s) (${crossOutletHealable.length} auto-healable, ${crossOutletRepoint.length} repointable to a live copy, ${crossOutlet.length - crossOutletHealable.length - crossOutletRepoint.length} report-only: undecided renamed primary / self-reference with a twin / pointer-missing / mutual 2-cycle):\n`);
    // Capped: the drift digest keeps only the last 40 output lines; --json has the full list.
    for (const m of crossOutlet.slice(0, 10)) console.log(`  ${m.showId}/${m.file}  → crossOutletPrimaryFile: ${m.duplicateOf}  (${m.reason}${m.reason === 'primary-renamed' ? `: ${m.siblingUrl}` : ''})`);
    if (crossOutlet.length > 10) console.log(`  … ${crossOutlet.length - 10} more (use --json)`);
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
  // crossOutletDuplicate entries (BRO-3872) are bucketed apart: a pre-existing
  // backlog (BRO-3870: 37 files / 36 shows at 2026-10-05) already exceeds the floor,
  // so counting them would redden --gate and make --fix refuse for unrelated flags.
  // They self-heal under their OWN surge guard below instead.
  const autoHealable = mismatches.filter(m => m.reason !== 'duplicateOf-cycle' && m.field !== 'crossOutletDuplicate');

  if (FIX) {
    if (autoHealable.length > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
      console.error(`::error::Refusing to auto-clear ${autoHealable.length} stale duplicateOf flags (> ${FIX_SURGE_THRESHOLD}). A spike this large usually means a producer regression, not routine churn — auto-clearing would re-admit a flood of reviews to scoring. Investigate the cause, then re-run with --force-bulk if the clears are legitimate.`);
      process.exitCode = 1; return;
    }
    let toFix = mismatches.filter(m => m.field !== 'crossOutletDuplicate');
    if (crossOutletHealable.length > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
      // Skip (exit 0), never fail: rebuild-reviews/rebuild-fast run --fix inline.
      console.warn(`::warning::Skipping ${crossOutletHealable.length} crossOutletDuplicate clears (> ${FIX_SURGE_THRESHOLD}) — a producer regression or a mass primary deletion; re-run with --force-bulk once reviewed.`);
      // Repoints re-admit nothing, so the surge guard does not hold them back.
      toFix = toFix.concat(crossOutletRepoint);
    } else {
      toFix = mismatches;
    }
    const cleared = fix(toFix);
    console.log(`\nCleared ${cleared} stale duplicateOf flag(s). Re-run rebuild to surface the recovered reviews.`);
    if (cycles.length > 0) {
      console.log(`\n${cycles.length} duplicateOf-cycle mismatch(es) were NOT auto-fixed — choosing which file becomes canonical needs manual review. See the chains above.`);
    }
    process.exitCode = 0; return;
  }

  // --gate: catastrophe floor only. Every AUTO-HEALABLE mismatch (i.e. excluding
  // duplicateOf-cycle, which never self-heals — see autoHealable above) is
  // auto-healable by clear-stale-duplicate-of.yml --fix, so a sub-floor count is
  // surfaced above but does NOT block the trunk. A spike past FIX_SURGE_THRESHOLD
  // is a producer regression where auto-clearing would flood scoring — that blocks.
  if (GATE) {
    if (shouldBlockDuplicateOfGate({ mismatchCount: autoHealable.length, floor: FIX_SURGE_THRESHOLD })) {
      console.error(`\n❌ GATE: ${autoHealable.length} auto-healable duplicateOf URL mismatch(es) > floor ${FIX_SURGE_THRESHOLD}. A spike this large signals a producer regression, not routine churn — failing the trunk for manual review before the self-heal re-admits a flood of reviews.`);
      process.exitCode = 1; return;
    }
    console.log(`\n✅ GATE: ${autoHealable.length} auto-healable duplicateOf URL mismatch(es) ≤ floor ${FIX_SURGE_THRESHOLD}${cycles.length > 0 ? ` (+ ${cycles.length} duplicateOf-cycle, excluded — needs manual triage, never auto-clears)` : ''}${crossOutlet.length > 0 ? ` (+ ${crossOutlet.length} crossOutletDuplicate, excluded — own surge guard in --fix)` : ''}. Auto-healable churn — surfaced above, not blocking the trunk. clear-stale-duplicate-of.yml --fix clears these; full report-mode triage runs daily in check-corpus-drift.yml (→ digest).`);
    process.exitCode = 0; return;
  }

  console.log('Run with --fix to clear stale flags.');
  process.exitCode = 1; return;
}

if (require.main === module) {
  main();
}

module.exports = { stripTrivial, canonicalizeHost, audit, fix, crossOutletRenamedAction };
