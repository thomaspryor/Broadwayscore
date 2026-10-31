#!/usr/bin/env node

// hygiene-help-flag-ok: audit-help-flag-safety.js flags the execSync(cmd, ...) call inside
// executeRunScript()'s try block — a function DECLARATION, not a call. It's only invoked from
// main() → applyTransform-adjacent action dispatch, well after the --help guard at the top of
// main(). Verified: node execute-approved-fix.js --help exits 0 with no subprocess/fs side effects.

/**
 * Executes a human-approved remediation plan from data/pending-fixes/{issue}.json.
 *
 * Triggered by execute-approved-fix.yml after Tom clicks "Approve" in his email.
 *
 * Actions:
 *   data-edit      — Field changes in shows.json, commercial.json, audience-buzz.json
 *   add-show       — Append one new shows.json entry (scripts/lib/add-show-action.js)
 *   retire-show    — Remove one provisional shows.json entry and record it in the
 *                    retired-id registry (scripts/lib/retire-show-action.js)
 *   retitle-show   — Cosmetic title repair on one shows.json entry
 *                    (scripts/lib/retitle-show-action.js)
 *   run-script     — Execute allowlisted pipeline scripts
 *   review-file-op — Move/delete/rename review files in data/review-texts/
 *   review-field-edit — Compare-and-set one allowlisted field on a review file
 *                       (scripts/lib/review-field-edit.js; BRO-4216)
 *   drop-orphan-key: Remove an orphan commercial.json or audience-buzz.json
 *                    key, or move an audience key (scripts/lib/orphan-key-action.js)
 *   ingest-html-handoff: Decrypt page HTML a session fetched outside CI and run
 *                    ingest-review-from-url.js --html-file on it
 *                    (scripts/lib/html-handoff.js; BRO-5886). Needs HTML_HANDOFF_PRIVATE_KEY.
 *
 * Env vars:
 *   ISSUE_NUMBER       - GitHub issue number (reader feedback), or bro-N[-x] for
 *                        a session-authored plan (CLOUD.md; no owner email)
 *   ANTHROPIC_API_KEY  - For any scripts that need it
 *   RESEND_API_KEY     - For confirmation emails
 *   OWNER_EMAIL        - Tom's email
 */

import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import https from 'https';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Labels every ingest-review-from-url.js run this script starts (BRO-6588).
process.env.INGEST_CALLER = process.env.INGEST_CALLER || 'execute-approved-fix';
const { runScriptArgs } = require('./lib/run-script-args');
const { buildFeedbackThankYouEmail } = require('./lib/email-templates.js');
const showsWriteGuard = require('./lib/shows-write-guard.js');
const commercialWriteGuard = require('./lib/commercial-write-guard.js');
const { planStatusAction, planRunOrigin, alreadyAppliedResult } = require('./lib/plan-status.js');
const audienceBuzzWriteGuard = require('./lib/audience-buzz-write-guard.js');
const { MAX_PLAN_ACTIONS } = require('./lib/pending-fix-limits.js');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { applyAddShow, gatherableAddedShowIds } = require('./lib/add-show-action.js');
const { applyRetireShow } = require('./lib/retire-show-action.js');
const { isReviewTextFile } = require('./lib/review-text-sidecars.js');
const { applyOutletRegistryFlag } = require('./lib/outlet-registry-flag-action.js');
const { applyOutletRegistryAlias } = require('./lib/outlet-registry-alias-action.js');
const { applyCoverageExpectationRedecide } = require('./lib/coverage-expectation-redecide-action.js');
const { outletFieldShapeErrors } = require('./lib/outlet-registry-field-shape.js');
const { applyDropOrphanKey, DROP_ORPHAN_KEY_FILES } = require('./lib/orphan-key-action.js');
const { applyRetitleShow } = require('./lib/retitle-show-action.js');
const { applyAddCommercialEntry } = require('./lib/commercial-entry-action.js');
const { touchedRecordProblems } = require('./lib/commercial-record-checks.js');
const { unretireId, loadRetiredIds } = require('./lib/retired-show-ids.js');
const { executeReviewFieldEditIn } = require('./lib/review-field-edit.js');
const { shouldEmailOwnerOnFix, readerFromDiagnosis, sendReaderFixOwnerEmail } = require('./lib/owner-fix-email.js');
const { loadIssueDiagnosis } = require('./lib/feedback-submitter-store.js');
const htmlHandoff = require('./lib/html-handoff.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const USAGE = `execute-approved-fix.js — Executes a human-approved remediation plan from data/pending-fixes/{issue}.json.

Usage:
  node scripts/execute-approved-fix.js [options]
  node scripts/execute-approved-fix.js --help, -h    print this usage and exit
`;

// --- Safety rails ---

// The data-edit allowlist (feedback-pipeline-fields.js) and the edit itself
// live in lib/data-edit-action.js (BRO-5892).
const { applyDataEdit, dataEditAllowProblem } = require('./lib/data-edit-action.js');

const ALLOWED_SCRIPTS = [
  // BRO-5582: stamp wrongProductionLegacyAudit on legacy wrongProduction flags with no trail.
  // Needs --apply --expect=N in args.
  'backfill-wrongproduction-legacy-audit.js',
  // BRO-5276: delete Theatr audience data attached to shows that closed before
  // Theatr existed, recompute their combined score. Needs --apply in args.
  'neutralize-stale-theatr-buzz.js',
  // BRO-5499: delete Show Score audience data that came from a UK production page on a US show
  // (stored rating must equal the archived UK page's). Needs --apply in args.
  'purge-uk-show-score-audience.js',
  // BRO-5866: delete Show Score data from another production's page (review dates outside this
  // run, or recorded under show-score-urls.json _productionMismatch). Needs --apply in args.
  'purge-wrong-production-show-score.js',
  // BRO-5499: publishDate stored one day late (UTC truncation) -> permalink date; evidence rules in the script.
  'fix-utc-shifted-publish-dates.js',
  // BRO-4779: delete sibling-misfiled aggregator-archive pages (+ tombstone ids).
  // Needs --delete --expect=N; the workflow checks out and pushes the archive.
  'audit-sibling-misfile-archive.js',
  // BRO-6141: delete aggregator-archive pages that fail their own category check (the pages
  // audit-aggregator-archive-integrity --strict reports). Needs --delete --expect=N; same archive checkout/push as above.
  'quarantine-poisoned-aggregator-archive.js',
  // BRO-6690: delete WestEndTheatre archives filed under a non-London show (a West End roundup on a
  // Broadway/off-Broadway row). Needs --delete --expect=N; same archive checkout/push as above.
  'audit-wet-archive-market.js',
  // BRO-4371: repair bwwExcerpt cut at digit-leading outlets from the private BWW archive. Dry run unless
  // --write; --write needs --expect=N and exits nonzero on any refusal or count mismatch.
  'repair-bww-digit-outlets.js',
  'rebuild-all-reviews.js',
  'gather-reviews.js',
  'collect-review-texts.js',
  'generate-critic-consensus.js',
  'validate-data.js',
  'fetch-show-images-auto.js',
  // BRO-4431: session-authored plans can ingest a specific review URL
  // (fans multi-show articles out, retry stub on an unreadable page), re-run
  // the multi-show split on an already-collected article, and re-read a
  // show's theatre.reviews round-up (paywalled rows + star relay).
  'ingest-review-from-url.js',
  'split-multi-show-roundups.js',
  'scrape-theatre-reviews.js',
  // BRO-4623: remove id-keyed duplicate commercial records (the fix command
  // the weekly strict gate names). run-script alone triggers no validation;
  // pair it with a data-edit on commercial.json in the same plan so the
  // executor's commercial-record check runs on the touched keys.
  'dedupe-commercial-id-keys.js',
  // BRO-5182: drop pending-review entries commercial.json already covers with a cited
  // record (never writes commercial.json or a recouped flag; rules in lib/pending-commercial-reconcile.js).
  'reconcile-pending-commercial.js',
  // BRO-4947: move review files from a wrong or duplicate outlet id to the canonical one
  // (rules are code, in scripts/lib/outlet-id-migrations.js; conflicts are left in place).
  'migrate-outlet-ids.js',
  // BRO-5133: add a URL to a show's _blocklist.json (a wrong-production review or
  // a news item an aggregator cites) so ingest and the gap audit both skip it.
  // execSync splits args on spaces: pass --reason without spaces.
  'block-review.js',
  // BRO-2851: put a quarantined review body back after its wrong-content flag
  // was released by a human or override (refuses anything else; the plan
  // author must have read the text). One --file per action.
  'restore-released-quarantined-body.js',
  // BRO-5294: queue named multi-review-column rows for a rescore that reads
  // only the target show's section (llm-scoring/venue-box-sections.ts).
  'flag-multishow-column-rescore.js',
  // BRO-5325: file a show's section of a multi-review column stored under
  // another show into its own row (rules: scripts/lib/multishow-section-copy.js;
  // refuses ambiguous sections; --expect-start/--expect-end use `_` for spaces).
  'copy-multishow-section.js',
  // BRO-5243: re-run the content verifier on named rows' stored text after a
  // byline/text fix left a stale verdict. Plans pass --file=<show>/<file>.json
  // (lib/reverify-file-mode.js: flagged rows and excluding verdicts are not written).
  'reverify-stale-cv-promoted.js',
  // BRO-5356: recompute contentTier on named invalid rows whose wrong-content
  // flag was cleared (plans pass --file=<show>/<file>.json --apply).
  'reclassify-invalid-reviews.js',
  // BRO-3139: refetch londontheatre.co.uk review pages once and store the critic's stars
  // (--limit chunks it inside the 5-minute run-script cap; it skips files already done).
  'backfill-london-theatre-stars.js',
  // BRO-4977: re-extract stored review texts that have other articles glued
  // on (refetch + same-article check in scripts/lib/page-bleed-repair.js;
  // queues a rescore for each trimmed file).
  'repair-page-bleed.js',
  'strip-variety-promo-bleed.js', // BRO-5254: strip Variety promo modules from stored texts
  'strip-leading-site-nav.js', // BRO-5859: cut site nav menus / Stage and Cinema footer from stored texts
  // BRO-5080: West End historical rows whose openingDate is a WhatsOnStage
  // first-performance date (221 rows, past the plan action cap). --apply
  // recomputes from live data and is idempotent; rules in
  // scripts/lib/we-historical-dates.js.
  'plan-we-historical-opening-repair.js',
  // BRO-3564: strip westendtheatre excerpts/stars an archived round-up about
  // another show planted (page judged by scripts/lib/aggregator-page-show-guard.js),
  // then delete that archive page. Idempotent.
  'clear-wrong-show-roundup-excerpts.js',
  // BRO-4490: refetch named tier-1.5-cleared rows and keep a star only when the
  // page structure shows it (plans pass --outlet=X --tier15-cleared --execute
  // --files=<show>/<file>.json,...; --limit keeps a chunk inside the 5-minute cap).
  'recollect-for-scores.js',
  // BRO-4490: stamp textFetchedAt on review texts that lack it (git history first,
  // then firstSeenAt/addedAt/collectedAt; plans pass --apply).
  'backfill-text-fetched-at.js',
];

// --- Helpers ---

function loadJsonFile(relPath) {
  // All three core-data files need the lock+merge layer (concurrent
  // writers) — see scripts/lib/{shows,commercial,audience-buzz}-write-guard.js.
  if (relPath === 'data/shows.json') return showsWriteGuard.loadShows();
  if (relPath === 'data/commercial.json') return commercialWriteGuard.loadCommercial();
  if (relPath === 'data/audience-buzz.json') return audienceBuzzWriteGuard.loadAudienceBuzz();
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function saveJsonFile(relPath, data) {
  if (relPath === 'data/shows.json') { showsWriteGuard.saveShows(data); return; }
  if (relPath === 'data/commercial.json') { commercialWriteGuard.saveCommercial(data); return; }
  if (relPath === 'data/audience-buzz.json') { audienceBuzzWriteGuard.saveAudienceBuzz(data); return; }
  fs.writeFileSync(path.join(ROOT, relPath), JSON.stringify(data, null, 2) + '\n');
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function runValidation(changedFiles, touchedCommercialKeys = [], priorCommercial = null) {
  // Targeted validation: check that each modified data file is valid JSON
  // with expected structure. Full validate-data.js catches pre-existing
  // review-text quality issues (garbage outlets, etc.) that are unrelated
  // to the fix and would block every approved fix from landing.
  const checks = {
    'data/shows.json': (data) => {
      const shows = data.shows || data;
      if (!Array.isArray(shows) || shows.length < 1000) throw new Error(`Expected 1000+ shows, got ${shows?.length}`);
      for (const s of shows.slice(0, 50)) {
        if (!s.id || !s.title || !s.status) throw new Error(`Show missing required fields: ${JSON.stringify(s).slice(0, 100)}`);
      }
      // BRO-6400: a plan sets a transfer pair as two actions; if one was refused
      // the other would leave a one-way link that fails validate-data.
      const transferProblems = require('./lib/transfer-link-rules.js').transferLinkProblems(shows);
      if (transferProblems.length) throw new Error(`transfer links: ${transferProblems.slice(0, 5).join('; ')}`);
    },
    'data/commercial.json': (data) => {
      if (!data?.shows || !data?._meta) throw new Error('Missing shows or _meta');
      // The same per-record rules validate-data.js enforces, so a plan cannot
      // push what the site build then rejects (BRO-4623). Only the records
      // this plan touched: like the rest of this targeted check, a problem
      // some other writer left elsewhere must not block every approved fix.
      // The run-status warnings count as errors for a record a plan writes.
      const showsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
      const problems = touchedRecordProblems(data, showsData.shows || showsData, touchedCommercialKeys, priorCommercial);
      if (problems.length) throw new Error(`commercial rules: ${problems.slice(0, 5).join('; ')}`);
    },
    'data/audience-buzz.json': (data) => {
      if (!data?.shows) throw new Error('Missing shows key');
    },
    // BRO-6122: outlet-registry-flag. Tracked in the web repo, so rollback is git checkout.
    'data/outlet-registry.json': (data) => {
      const ids = Object.keys(data?.outlets || {});
      if (ids.length < 500) throw new Error(`Expected 500+ outlets, got ${ids.length}`);
      if (!data._aliasIndex || typeof data._aliasIndex !== 'object') throw new Error('Missing _aliasIndex');
      // Only flagged outlets: a shape problem some other writer left on an unrelated outlet must not block this fix.
      const flagged = ids.filter((id) => data.outlets[id] && data.outlets[id].standingCoverage !== undefined);
      const errs = flagged.flatMap((id) => [
        ...(data.outlets[id].standingCoverage === true && !Array.isArray(data.outlets[id].standingMarkets) ? [`outlet "${id}": standingCoverage without standingMarkets`] : []),
        ...(typeof data.outlets[id].standingCoverage !== 'boolean' ? [`outlet "${id}": standingCoverage must be a boolean`] : []),
        ...outletFieldShapeErrors(id, data.outlets[id]),
      ]);
      if (errs.length) throw new Error(errs.slice(0, 5).join('; '));
    },
  };

  for (const file of changedFiles) {
    const relPath = file.startsWith('data/') ? file : `data/${file}`;
    const check = checks[relPath];
    if (!check) continue;

    try {
      const raw = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      const parsed = JSON.parse(raw);
      check(parsed);
      console.log(`  ✓ ${relPath} is valid`);
    } catch (err) {
      console.error(`  ✗ ${relPath} validation failed: ${err.message}`);
      return false;
    }
  }
  console.log('Validation passed');
  return true;
}

// Core-data files are gitignored here, so `git checkout -- data/` cannot
// restore them; the plan runner snapshots them before the first action and
// rollbackDataFiles puts them back (BRO-4398: a failed retire-show plan must
// not push a deleted row, or a registry entry without its deletion).
const CORE_SNAPSHOT_FILES = ['data/shows.json', 'data/commercial.json', 'data/audience-buzz.json', 'data/retired-show-ids.json', 'data/deleted-shows.json'];

function snapshotCoreData() {
  const snap = new Map();
  for (const rel of CORE_SNAPSHOT_FILES) {
    const abs = path.join(ROOT, rel);
    let target = abs;
    try {
      target = fs.realpathSync(abs);
    } catch {
      // A dangling link (local setup-local-data.sh link whose clone file does
      // not exist yet): writers follow it and create the target, so the
      // rollback must address the target too, never the link.
      try { target = path.resolve(path.dirname(abs), fs.readlinkSync(abs)); } catch { /* plain absent file */ }
    }
    snap.set(target, fs.existsSync(target) ? fs.readFileSync(target) : null);
  }
  return snap;
}

// commercial.json's records as they stood before the plan, from the snapshot,
// so a record check can tell a link the plan added from one already there.
function priorCommercialShows(snapshot) {
  if (!snapshot) return null;
  let target = path.join(ROOT, 'data/commercial.json');
  try { target = fs.realpathSync(target); } catch { /* absent or dangling */ }
  const buf = snapshot.get(target);
  try { return buf ? JSON.parse(buf.toString('utf8')).shows || null : null; } catch { return null; }
}

function rollbackDataFiles(snapshot) {
  try {
    execSync('git checkout -- data/', { cwd: ROOT, stdio: 'pipe' });
  } catch { /* best effort */ }
  if (!snapshot) return;
  for (const [target, content] of snapshot) {
    try {
      const now = fs.existsSync(target) ? fs.readFileSync(target) : null;
      // Only files this plan changed; atomic tmp+rename like the write guards.
      if (content === null ? now === null : (now !== null && now.equals(content))) continue;
      if (content === null) { fs.unlinkSync(target); continue; }
      const tmp = `${target}.rollback.${process.pid}`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, target);
    } catch (e) {
      console.error(`  rollback could not restore ${target}: ${e.message}`);
    }
  }
}

async function sendEmail(to, from, subject, html) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('No RESEND_API_KEY'); return; }
  const data = JSON.stringify({ from, to: [to], subject, html });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`Email ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- Action executors ---

function executeDataEdit(action) {
  const notAllowed = dataEditAllowProblem(action);
  if (notAllowed) return { ok: false, reason: notAllowed };
  const relPath = `data/${action.file}`;
  // Load and save stay here (write guards); the edit itself is shared with
  // preflight-review-fix-plan.js so a plan is checked before it lands (BRO-5892).
  // `data` is mutated in place, so shows-write-guard's identity lookup still matches.
  const data = loadJsonFile(relPath);
  const result = applyDataEdit(data, action, { root: ROOT });
  if (result.ok) saveJsonFile(relPath, data);
  return result;
}

function executeAddCommercialEntry(action) {
  const commercial = loadJsonFile('data/commercial.json');
  const showsData = loadJsonFile('data/shows.json');
  const shows = showsData.shows || showsData;
  const result = applyAddCommercialEntry(commercial, shows, action);
  if (result.ok) saveJsonFile('data/commercial.json', commercial);
  return result;
}

function executeAddShow(action) {
  const data = loadJsonFile('data/shows.json');
  const shows = data.shows || data;
  const result = applyAddShow(shows, action);
  if (result.ok) saveJsonFile('data/shows.json', Array.isArray(data) ? shows : data);
  return result;
}

// Reviews per show id in data/reviews.json (a duplicate retire refuses a row
// that still has reviews).
function reviewCountFor(showId) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8'));
  const list = Array.isArray(data) ? data : (data.reviews || []);
  const scored = list.filter(r => r && r.showId === showId).length;
  // Collected texts not yet rebuilt into reviews.json (unscored, or newer
  // than the last rebuild) live here and would be orphaned too.
  const dir = path.join(ROOT, 'data/review-texts', showId);
  const texts = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => isReviewTextFile(f)).length : 0;
  return scored + texts;
}

function executeRetireShow(action) {
  const data = loadJsonFile('data/shows.json');
  const shows = data.shows || data;
  const result = applyRetireShow(shows, action, { reviewCount: reviewCountFor });
  if (!result.ok) return result;
  try {
    saveJsonFile('data/shows.json', Array.isArray(data) ? shows : data);
  } catch (e) {
    // The registry entry is already written: take it back out so the row
    // (still in shows.json) and the registry agree and the plan can re-run.
    let reverted = false;
    let revertError = null;
    // reMinted removed only the row: the registry entry is the FIRST retirement's, never ours to revert.
    if (action.reMinted === true) return { ok: false, reason: `retire-show ${action.id}: shows.json save failed (${e.message}); registry untouched (reMinted)` };
    try { reverted = unretireId(action.id); } catch (re) { revertError = re.message; }
    const tail = reverted ? 'registry entry reverted' : `registry entry NOT reverted (${revertError || 'not found'}) — remove ${action.id} from data/retired-show-ids.json and data/deleted-shows.json by hand`;
    return { ok: false, reason: `retire-show ${action.id}: shows.json save failed (${e.message}); ${tail}` };
  }
  // The retired id's audience-buzz key would be an orphan from now on
  // (BRO-3248). A duplicate's data moves to the kept row when that row has
  // none; otherwise it is dropped. Best-effort: the row is retired either way.
  try {
    const buzz = loadJsonFile('data/audience-buzz.json');
    if (buzz && buzz.shows && Object.prototype.hasOwnProperty.call(buzz.shows, action.id)) {
      const kept = action.duplicateOf;
      if (kept && !Object.prototype.hasOwnProperty.call(buzz.shows, kept)) {
        buzz.shows[kept] = buzz.shows[action.id];
        result.msg = `${result.msg}; moved its audience-buzz.json entry to ${kept}`;
      } else {
        result.msg = `${result.msg}; dropped its audience-buzz.json key`;
      }
      delete buzz.shows[action.id];
      saveJsonFile('data/audience-buzz.json', buzz);
    }
  } catch (e) {
    result.msg = `${result.msg}; audience-buzz.json key NOT dropped (${e.message}), audit-orphan-show-ids.js will report it`;
  }
  return result;
}

// Cached across consecutive drop-orphan-key actions; any other action may
// change shows.json or the retired registry, so it clears the cache.
let _idSets = null;
function _showIdSets() {
  if (_idSets) return _idSets;
  const data = loadJsonFile('data/shows.json');
  const liveIds = new Set((data.shows || data).map(s => s && s.id).filter(Boolean));
  const liveSlugs = new Set((data.shows || data).map(s => s && s.slug).filter(Boolean));
  const retiredIds = new Set(loadRetiredIds().map(e => e.id));
  _idSets = { liveIds, liveSlugs, retiredIds };
  return _idSets;
}

function executeDropOrphanKey(action) {
  // Fail this action, not the run: a throw here skipped validation/rollback
  // while the always() push step still pushed earlier actions' writes.
  if (!action || !DROP_ORPHAN_KEY_FILES.has(action.file)) return { ok: false, reason: `drop-orphan-key: unsupported file ${action && action.file}` };
  const rel = `data/${action.file}`;
  let data, idSets;
  try {
    data = loadJsonFile(rel);
    idSets = _showIdSets();
  } catch (e) {
    return { ok: false, reason: `drop-orphan-key ${action.showId}: cannot read inputs (${e.message})` };
  }
  const result = applyDropOrphanKey(data && data.shows, action, idSets);
  if (result.ok) saveJsonFile(rel, data);
  return result;
}

const REGISTRY_FILE = path.join(ROOT, 'data/outlet-registry.json');

function executeOutletRegistryAction(action, apply, label) {
  const rel = 'data/outlet-registry.json';
  let registry, shows, reviews;
  try {
    registry = loadJsonFile(rel);
    const sd = loadJsonFile('data/shows.json');
    shows = sd.shows || sd;
    reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')).reviews;
  } catch (e) {
    return { ok: false, reason: `${label} ${action && action.outletId}: cannot read inputs (${e.message})` };
  }
  // Fail this action, not the run: a throw would skip validation/rollback while
  // the always() push step still publishes earlier actions' writes.
  try {
    const result = apply(registry, action, { shows, reviews });
    // The registry file has no trailing newline (rebuild-all-reviews.js writes it that way).
    if (result.ok && result.changed) fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
    return result;
  } catch (e) {
    return { ok: false, reason: `${label} ${action && action.outletId}: ${e.message}` };
  }
}

const executeOutletRegistryFlag = (action) => executeOutletRegistryAction(action, applyOutletRegistryFlag, 'outlet-registry-flag');
const executeOutletRegistryAlias = (action) => executeOutletRegistryAction(action, applyOutletRegistryAlias, 'outlet-registry-alias');
const executeCoverageExpectationRedecide = (action) => executeOutletRegistryAction(action, applyCoverageExpectationRedecide, 'coverage-expectation-redecide');

function executeRetitleShow(action) {
  const data = loadJsonFile('data/shows.json');
  const shows = data.shows || data;
  const result = applyRetitleShow(shows, action);
  if (!result.ok) return result;
  saveJsonFile('data/shows.json', Array.isArray(data) ? shows : data);
  return result;
}

function executeRunScript(action) {
  const { script } = action;

  if (!ALLOWED_SCRIPTS.includes(script)) {
    return { ok: false, reason: `Script "${script}" not in allowlist` };
  }

  // Sanitized (no shell metacharacters); an `arguments` array counts too (BRO-5866).
  const parsed = runScriptArgs(action);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const safeArgs = parsed.args;

  try {
    const cmd = `node scripts/${script} ${safeArgs}`.trim();
    console.log(`Running: ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 300000 }); // 5 min timeout
    return { ok: true, msg: `Ran ${script} successfully` };
  } catch (err) {
    return { ok: false, reason: `Script ${script} failed: ${err.message}` };
  }
}

// Review files this plan deleted or moved away (relative to review-texts), for
// stampRecreatedReviews after the last action (BRO-5942).
const deletedReviewPaths = new Set();

function executeReviewFileOp(action) {
  const { operation, sourcePath, destPath } = action;
  const reviewTextsDir = path.join(ROOT, 'data/review-texts');

  // BRO-5133: bring back a file from review-texts history (source need not exist now).
  if (operation === 'restore') {
    return require('./lib/review-file-restore').restoreReviewFileFromCommit(reviewTextsDir, action);
  }

  // Ensure paths are within review-texts/
  const absSource = path.resolve(reviewTextsDir, sourcePath);
  if (!absSource.startsWith(reviewTextsDir)) {
    return { ok: false, reason: `Source path escapes review-texts/: ${sourcePath}` };
  }

  if (!fs.existsSync(absSource)) {
    return { ok: false, reason: `Source not found: ${sourcePath}` };
  }

  const relSource = path.relative(reviewTextsDir, absSource).split(path.sep).join('/');
  if (operation === 'delete') {
    fs.unlinkSync(absSource);
    deletedReviewPaths.add(relSource);
    return { ok: true, msg: `Deleted ${sourcePath}` };

  } else if (operation === 'move' || operation === 'rename') {
    const moved = require('./lib/review-file-move').moveReviewFile(reviewTextsDir, sourcePath, destPath, { overwrite: action.overwrite === true });
    if (moved && moved.ok) deletedReviewPaths.add(relSource);
    return moved;
  }

  return { ok: false, reason: `Unknown operation: ${operation}` };
}

function executeReviewFieldEdit(action, stamp) {
  return executeReviewFieldEditIn(path.join(ROOT, 'data/review-texts'), action, stamp);
}

function executeBatchTransform(action) {
  const { file, field, transform } = action;

  if (file !== 'shows.json') {
    return { ok: false, reason: `batch-transform only supports shows.json, got "${file}"` };
  }

  if (transform === 'split-comma-roles' && field === 'creativeTeam') {
    const relPath = 'data/shows.json';
    const data = loadJsonFile(relPath);
    const shows = data.shows || data;
    const showsList = Array.isArray(shows) ? shows : Object.values(shows);

    let splitCount = 0;
    let showsAffected = 0;

    for (const show of showsList) {
      if (!show.creativeTeam) continue;
      let hasCombined = false;
      for (const ct of show.creativeTeam) {
        if (ct.role && ct.role.includes(', ')) { hasCombined = true; break; }
      }
      if (!hasCombined) continue;

      showsAffected++;
      const newTeam = [];
      for (const ct of show.creativeTeam) {
        if (ct.role && ct.role.includes(', ')) {
          splitCount++;
          for (const role of ct.role.split(', ')) {
            newTeam.push({ name: ct.name, role: role.trim() });
          }
        } else {
          newTeam.push(ct);
        }
      }
      show.creativeTeam = newTeam;
    }

    if (splitCount === 0) {
      return { ok: true, msg: 'No combined roles found — already fixed' };
    }

    saveJsonFile(relPath, Array.isArray(data) ? shows : data);
    return { ok: true, msg: `Split ${splitCount} combined roles across ${showsAffected} shows` };
  }

  return { ok: false, reason: `Unknown transform: ${transform}` };
}

// --- Main ---

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  // BRO-5886: read the handoff key and delete its file before any action runs,
  // so no child script can read it.
  const handoffKeyPem = htmlHandoff.takePrivateKey();
  const issueNumber = process.env.ISSUE_NUMBER;
  if (!issueNumber) {
    console.error('ISSUE_NUMBER not set');
    output('result', 'error');
    return;
  }

  // Plan ids name a file under data/pending-fixes/: GitHub issue numbers
  // ("925", "504-systematic") or Linear ids ("bro-4202", BRO-4216).
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(issueNumber))) {
    console.error(`Invalid plan id: ${issueNumber}`);
    output('result', 'error');
    return;
  }

  // 1. Load plan
  const planFile = path.join(ROOT, 'data/pending-fixes', `${issueNumber}.json`);
  if (!fs.existsSync(planFile)) {
    console.error(`Plan file not found: ${planFile}`);
    output('result', 'error');
    return;
  }

  const planData = JSON.parse(fs.readFileSync(planFile, 'utf8'));

  // 1b. Stale-link guard: the approval URL is HMAC-bound to the planId that
  // existed when the email was sent. A regenerated plan for the same issue
  // overwrites {issue}.json; executing it under the OLD link would apply a
  // plan nobody reviewed. Refuse on any mismatch.
  const expectedPlanId = process.env.PLAN_ID || null;
  if ((planData.planId || null) !== expectedPlanId) {
    console.error(`Plan ID mismatch: link carries ${expectedPlanId || '(none)'}, ` +
      `current plan is ${planData.planId || '(unversioned)'} — the plan was ` +
      `regenerated after this link was issued. Refusing to execute.`);
    output('result', 'error');
    return;
  }

  // Session-authored plans (BRO-4216) may omit submitter; step 7 reads it.
  if (!planData.submitter || typeof planData.submitter !== 'object') planData.submitter = { name: null, email: null };

  // 2. Check status
  const statusAction = planStatusAction(planData.status);
  if (statusAction === 'error') {
    console.error(`Plan status "${planData.status}" is not one the executor knows; a new plan must be "pending". Refusing.`);
    output('result', 'error');
    return;
  }
  if (statusAction === 'already-applied') {
    const result = alreadyAppliedResult(issueNumber, planData);
    if (result === 'applied-elsewhere') {
      console.error(`Plan is already ${planData.status}, by a local execute-approved-fix run (executedIn: local), not by this workflow, so nothing was applied. Reset it to "pending", drop executedAt/results/rejectedAt/executedIn, land it, then dispatch again.`);
    } else {
      console.log(`Plan already ${planData.status} — skipping`);
    }
    output('result', result);
    return;
  }

  // 2b. Reject mode: the owner clicked Reject — persist the rejection so an
  // unexpired Approve link for the same plan can no longer execute it.
  if (process.env.EXEC_MODE === 'reject') {
    planData.plan.actions = (planData.plan.actions || []).map(htmlHandoff.scrubAction);
    planData.status = 'rejected';
    planData.rejectedAt = new Date().toISOString();
    planData.executedIn = planRunOrigin();
    fs.writeFileSync(planFile, JSON.stringify(planData, null, 2) + '\n');
    console.log(`Plan for #${issueNumber} marked rejected — nothing executed`);
    output('result', 'rejected');
    return;
  }

  // BRO-4216: plans can now be written by sessions, not only by the feedback
  // pipeline. Cap the blast radius of any single plan.
  if ((planData.plan.actions || []).length > MAX_PLAN_ACTIONS) {
    console.error(`Plan has ${planData.plan.actions.length} actions (max ${MAX_PLAN_ACTIONS}) — refusing`);
    output('result', 'error');
    return;
  }
  const handoffProblems = htmlHandoff.planHandoffProblems(planData.plan.actions);
  if (handoffProblems.length) {
    console.error(`Refusing plan: ${handoffProblems.join('; ')}`);
    output('result', 'error');
    return;
  }

  console.log(`Executing plan for issue #${issueNumber}`);
  console.log(`  Summary: ${planData.plan.summary}`);
  console.log(`  Actions: ${planData.plan.actions.length}`);

  const coreSnapshot = snapshotCoreData();

  // 3. Execute each action
  const results = [];
  const applied = [];
  const addedShows = []; // BRO-6629: rows add-show wrote, for the gather dispatch step
  const failed = [];
  const ingestedHandoffs = new Set(); // BRO-5886: only these lose their ciphertext

  for (const action of planData.plan.actions) {
    console.log(`\nExecuting: ${action.type} — ${action.description || action.field || action.script || action.operation}`);

    let result;
    if (action.type !== 'drop-orphan-key') _idSets = null;
    switch (action.type) {
      case 'data-edit':
        result = executeDataEdit(action);
        break;
      case 'run-script':
        result = executeRunScript(action);
        break;
      case 'review-file-op':
        result = executeReviewFileOp(action);
        break;
      case 'add-show':
        result = executeAddShow(action);
        // A rerun after a deferred gather finds the row already added; collect it again so
        // the rerun dispatches the gather the first run could not.
        if (result.ok || /already exists/.test(result.reason || '')) addedShows.push(action.show);
        break;
      case 'retire-show':
        result = executeRetireShow(action);
        break;
      case 'retitle-show':
        result = executeRetitleShow(action);
        break;
      case 'add-commercial-entry':
        result = executeAddCommercialEntry(action);
        break;
      case 'drop-orphan-key':
        result = executeDropOrphanKey(action);
        break;
      case 'outlet-registry-flag':
        result = executeOutletRegistryFlag(action);
        break;
      case 'outlet-registry-alias':
        result = executeOutletRegistryAlias(action);
        break;
      case 'coverage-expectation-redecide':
        result = executeCoverageExpectationRedecide(action);
        break;
      case 'review-field-edit':
        result = executeReviewFieldEdit(action, { fixId: planData.planId || String(issueNumber), at: new Date().toISOString() });
        break;
      case 'batch-transform':
        result = executeBatchTransform(action);
        break;
      case htmlHandoff.ACTION_TYPE:
        if (htmlHandoff.isScrubbed(action)) { result = { ok: true, msg: `Already ingested ${action.url} (envelope scrubbed)` }; break; }
        // argv array, no shell: the action's fields never reach a command line parser.
        result = htmlHandoff.executeHandoff(action, {
          privateKeyPem: handoffKeyPem,
          run: (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', timeout: 300000 }),
        });
        if (result.ok) ingestedHandoffs.add(action);
        break;
      default:
        result = { ok: false, reason: `Unknown action type: ${action.type}` };
    }

    results.push({ action: action.type, ...result });
    if (result.ok) {
      // An edit another fix already made is not this plan's fix: it must not
      // email or thank the reader a second time (BRO-6489).
      if (!result.noop) applied.push(result.msg);
      console.log(`  OK: ${result.msg}`);
    } else {
      failed.push(result.reason);
      console.log(`  FAILED: ${result.reason}`);
    }
  }

  // BRO-5942: a file the plan deleted and a later action wrote anew has no
  // history of its own; without the stamp push-review-texts restores the
  // deleted copy's protected fields (a stale wrongProduction, an old score).
  if (deletedReviewPaths.size) {
    const stamped = require('./lib/rename-identity').stampRecreatedReviews(path.join(ROOT, 'data/review-texts'), deletedReviewPaths, planData.planId || String(issueNumber));
    for (const rel of stamped) console.log(`  Recreated after delete: ${rel} (push-time restore skips its committed copy)`);
  }

  // BRO-5886: the plan is written back to main below; an ingested handoff keeps
  // only a hash. A failed one keeps its (already public) envelope for a retry.
  planData.plan.actions = planData.plan.actions.map((a) => (ingestedHandoffs.has(a) ? htmlHandoff.scrubAction(a) : a));

  // 4. Validate if we made data changes. batch-transform mutates data files
  // too — it must NOT bypass validation (it previously did, so a bad bulk
  // transform had no rollback path).
  const dataTouching = planData.plan.actions.filter(a => a.type === 'data-edit' || a.type === 'batch-transform' || a.type === 'add-show' || a.type === 'retire-show' || a.type === 'retitle-show' || a.type === 'add-commercial-entry' || a.type === 'drop-orphan-key' || a.type === 'outlet-registry-flag' || a.type === 'coverage-expectation-redecide' || a.type === 'outlet-registry-alias');
  const hasDataEdits = dataTouching.length > 0;
  if (hasDataEdits) {
    // add-show / retire-show / retitle-show / add-commercial-entry carry no `file`.
    const IMPLIED_FILE = { 'add-show': 'shows.json', 'retire-show': 'shows.json', 'retitle-show': 'shows.json', 'add-commercial-entry': 'commercial.json', 'outlet-registry-flag': 'outlet-registry.json', 'coverage-expectation-redecide': 'outlet-registry.json', 'outlet-registry-alias': 'outlet-registry.json' };
    const changedFiles = [...new Set(dataTouching.map(a => IMPLIED_FILE[a.type] || a.file || null).filter(Boolean))];
    // retire-show also drops or moves the id's audience-buzz.json key (BRO-3248).
    if (dataTouching.some(a => a.type === 'retire-show') && !changedFiles.includes('audience-buzz.json')) changedFiles.push('audience-buzz.json');
    console.log('\nRunning validation...');
    const touchedCommercialKeys = dataTouching
      .filter(a => a.type === 'add-commercial-entry' || a.file === 'commercial.json')
      .map(a => a.slug || a.showSlug || a.showId)
      .filter(Boolean);
    if (!runValidation(changedFiles, touchedCommercialKeys, priorCommercialShows(coreSnapshot))) {
      console.error('Validation failed — rolling back');
      rollbackDataFiles(coreSnapshot);

      // Update plan status
      planData.status = 'validation-failed';
      planData.executedAt = new Date().toISOString();
      planData.results = results;
      planData.executedIn = planRunOrigin();
      fs.writeFileSync(planFile, JSON.stringify(planData, null, 2) + '\n');

      output('result', 'validation-failed');
      // No email — GitHub issue gets labeled 'needs-manual-review' by the workflow.
      // Sending failure emails on every attempt was spammy during debugging.
      return;
    }
    console.log('Validation passed');
  }

  // 5. Success — update plan. 'partial' (not 'applied') when any action
  // failed, so the record doesn't claim the whole plan landed.
  planData.status = failed.length > 0 ? 'partial' : 'applied';
  planData.executedAt = new Date().toISOString();
  planData.results = results;
  planData.executedIn = planRunOrigin();
  fs.writeFileSync(planFile, JSON.stringify(planData, null, 2) + '\n');

  console.log(`\nPlan executed: ${applied.length} applied, ${failed.length} failed`);
  output('result', applied.length > 0 ? 'fixed' : 'no-changes');
  output('failed', String(failed.length));
  output('gather_show_ids', gatherableAddedShowIds(addedShows).join(','));

  // Persisted plans are PII-redacted (submitter.email is null by construction,
  // see generate-remediation-plan.js), so the reader's contact details and
  // message come from the issue's DIAGNOSIS_JSON at execute time. Recovery
  // MUST stay below the plan-file write above so none of it re-enters the
  // committed JSON. Fetched at most once for steps 6 and 7.
  let readerPromise = null;
  const getReader = () => (readerPromise ||= fetchDiagnosisFromIssue(issueNumber).then((diagnosis) => {
    if (!diagnosis) console.log(`No DIAGNOSIS_JSON recovered for #${issueNumber} (issue fetch failed, no token, or no block); reader details unknown`);
    return readerFromDiagnosis(diagnosis);
  }));

  // 6. Tell Tom a reader's report was fixed, with who sent it and what they
  // wrote (BRO-4452). Reader-feedback ids only: session-authored bro-* plans
  // already report in chat + Linear.
  const ownerEmail = process.env.OWNER_EMAIL;
  if (shouldEmailOwnerOnFix({ issueNumber, ownerEmail, appliedCount: applied.length })) {
    const reader = await getReader();
    await sendReaderFixOwnerEmail({
      issueNumber,
      reader: { ...reader, show: reader.show || planData.submitter.show || null },
      summary: planData.plan.summary,
      changes: applied,
      skipped: failed,
      how: planData.isSystematic ? 'systematic' : 'approved',
      partial: failed.length > 0,
    });
  }

  // 7. Send thank-you to submitter. Systematic plans skip it: the parent spot
  // fix already sent one for the same report.
  if (planData.isSystematic) {
    console.log('Systematic plan — skipping submitter thank-you (parent plan covers it)');
    return;
  }
  if (!planData.submitter.email && applied.length > 0) {
    const recovered = await getReader();
    if (recovered.email) {
      planData.submitter = {
        ...planData.submitter,
        name: recovered.name || 'Anonymous',
        email: recovered.email,
        show: recovered.show || planData.submitter.show,
      };
      console.log('Submitter recovered from issue DIAGNOSIS_JSON');
    }
  }
  if (planData.submitter.email && applied.length > 0) {
    try {
      const { subject, html } = buildFeedbackThankYouEmail(
        'fixed',
        planData.submitter.name,
        planData.submitter.show
      );
      await sendEmail(
        planData.submitter.email,
        'Tom at Broadway Scorecard <updates@broadwayscorecard.com>',
        subject,
        html
      );
      console.log('Thank-you sent to submitter');
    } catch { /* best effort */ }
  }
}

// Read the GitHub issue's embedded DIAGNOSIS_JSON, with the reader's name,
// email and message filled from the private store
// (data/feedback-submitters.json). The persisted plan file is PII-redacted,
// so this is the only source of them at execute time. "504-systematic" style ids resolve to
// their parent issue via parseInt. Returns null when unavailable.
async function fetchDiagnosisFromIssue(issueNumber) {
  const ghIssue = parseInt(issueNumber);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (isNaN(ghIssue) || !token) return null;

  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
  const body = await new Promise((resolve) => {
    const req = https.request(`https://api.github.com/repos/${repo}/issues/${ghIssue}`, {
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'BroadwayScorecard-Executor',
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode === 200 ? data : null));
    });
    req.setTimeout(60000, () => req.destroy(new Error('request timed out after 60s idle')));
    req.on('error', () => resolve(null));
    req.end();
  });
  if (!body) return null;

  try {
    // New issues carry only a submissionId; the reader's details come from
    // the private store (BRO-4453). Old issues still carry them inline.
    return loadIssueDiagnosis(JSON.parse(body).body || '');
  } catch {
    return null;
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  output('result', 'error');
});
