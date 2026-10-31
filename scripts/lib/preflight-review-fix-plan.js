#!/usr/bin/env node
'use strict';
/**
 * preflight-review-fix-plan.js (BRO-4849): replay a data/pending-fixes plan's review-field-edit actions, in order, on a
 * throwaway copy of each touched show directory, through the same executor and write guard execute-approved-fix.yml
 * uses. Proves the plan applies cleanly BEFORE it lands: a compare-and-set mismatch, a value check, or a write-guard
 * side effect (a url-collision duplicate stamp, a restored protected field) shows here instead of failing the apply run.
 *
 * Usage: node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/<plan>.json [...more plans]
 *   Plans are replayed in the order given, on one shared copy, so later plans see earlier plans' writes.
 *   Exit 0 when every action applies cleanly, 1 otherwise. data/review-texts is never written.
 *   A review-file-op delete/move whose source is not in the tree FAILs here (BRO-5386: eight of seventeen actions
 *   were refused at apply time as "Source not found" because they were planned against a two-day-old local copy
 *   of review-texts). The tree checked is the live review-texts clone when the session has one.
 *   add-commercial-entry is replayed through applyAddCommercialEntry and the touched commercial.json records are then
 *   checked with the executor's own record rules (touchedRecordProblems, BRO-5528).
 *   data-edit actions are replayed too (BRO-5892), through the executor's own applyDataEdit, on in-memory copies of
 *   shows.json / commercial.json / audience-buzz.json from the core-data clone (else data/). After an action this
 *   script does not replay has changed the same file (add-show, retitle-show, run-script, ...) a data-edit failure
 *   is a WARN: the real data at apply time may differ from the copy.
 */
const fs = require('fs');
const { orphanFilesAfterNulling } = require('./image-null-orphan-files');
const os = require('os');
const path = require('path');
const { executeReviewFieldEditIn } = require('./review-field-edit');
const { MAX_PLAN_ACTIONS } = require('./pending-fix-limits');
const { planStatusAction } = require('./plan-status');
const { resolveReviewTextsDir, isReviewTextsCheckout } = require('./review-texts-dir');
const { runScriptArgs } = require('./run-script-args');
const { applyDataEdit, dataEditAllowProblem } = require('./data-edit-action');
const { applyAddCommercialEntry, ALLOWED_ENTRY_FIELDS } = require('./commercial-entry-action');
const { touchedRecordProblems } = require('./commercial-record-checks');
const htmlHandoff = require('./html-handoff');
const { handoffPlanProblems } = require('./pending-fix-plan-checks');
const { movePlanWarnings } = require('./move-plan-checks');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Does a review-file-op delete/move have a source to act on, given what earlier actions in the plan removed or created?
 * Pure: `exists` is injected. Mutates `removed`/`created`. Returns null when fine, else the failure reason.
 */
function fileOpSourceProblem(a, exists, removed, created) {
  if (!a || a.type !== 'review-file-op') return null;
  // A restore brings the file back (at destPath when given), so a later delete/move of it has a source.
  if (a.operation === 'restore') {
    const back = a.destPath || a.sourcePath;
    if (back) { const b = path.posix.normalize(back); created.add(b); removed.delete(b); }
    return null;
  }
  // execute-approved-fix.js treats 'rename' exactly like 'move'.
  if (a.operation !== 'delete' && a.operation !== 'move' && a.operation !== 'rename') return null;
  const src = path.posix.normalize(String(a.sourcePath || ''));
  if (!src || src === '.' || src.startsWith('../') || path.posix.isAbsolute(src)) return `Source path escapes the review-texts tree: ${a.sourcePath}`;
  const present = created.has(src) || (exists(src) && !removed.has(src));
  if (!present) return `Source not found: ${src} (already moved or deleted? check the live review-texts clone)`;
  removed.add(src); created.delete(src);
  if ((a.operation === 'move' || a.operation === 'rename') && a.destPath) { const d = path.posix.normalize(a.destPath); created.add(d); removed.delete(d); }
  return null;
}

/** A directory that exists and holds at least one non-dot entry (not a bare or missing mount). */
function hasShows(dir) {
  try { return fs.readdirSync(dir).some((e) => !e.startsWith('.')); } catch { return false; }
}

/**
 * The review-texts tree to check against: the canonical resolver's answer when it exists, else the cloud session's
 * clone of the private repo (HOME can differ from the clone's /home/user, so resolveReviewTextsDir() may name a folder
 * that does not exist: BRO-5386), else the data/review-texts snapshot. Never a missing directory, which would FAIL
 * every action. Pure over `candidates` so tests can inject.
 */
function pickReviewTextsTree(candidates = [
  resolveReviewTextsDir(),
  path.join(os.homedir(), 'broadway-review-texts'),
  '/home/user/broadway-review-texts',
  path.join(ROOT, 'data', 'review-texts'),
], { warn = (m) => console.error(m), env = process.env } = {}) {
  // An operator naming the directory explicitly is never overridden.
  if (env.REVIEW_TEXTS_DIR && hasShows(env.REVIEW_TEXTS_DIR)) return env.REVIEW_TEXTS_DIR;
  // BRO-6047: a live git checkout beats a copied snapshot even when the snapshot is listed first.
  for (const dir of candidates) if (dir && isReviewTextsCheckout(dir)) return dir;
  for (const dir of candidates) {
    if (dir && hasShows(dir)) {
      let age = 'unknown age';
      try { age = `${Math.round((Date.now() - fs.statSync(dir).mtimeMs) / 3600000)}h old`; } catch {}
      warn(`WARN review-texts tree ${dir} is a plain snapshot (not a git checkout, ${age}); oldValues may be stale`);
      return dir;
    }
  }
  return path.join(ROOT, 'data', 'review-texts');
}

/** Where the core data files live: the cloud/Mac core-data clone when present (what CI applies against), else data/. */
function pickCoreDataDir(candidates = [
  path.join(os.homedir(), 'broadway-scorecard-data'),
  '/home/user/broadway-scorecard-data',
  path.join(ROOT, 'data'),
]) {
  for (const dir of candidates) if (dir && fs.existsSync(path.join(dir, 'shows.json'))) return dir;
  return path.join(ROOT, 'data');
}

// Action types this script does not replay, and the core data files each may change.
const DATA_FILES = ['shows.json', 'commercial.json', 'audience-buzz.json'];
function filesChangedByUnreplayed(a) {
  switch (a && a.type) {
    case 'add-show': case 'retitle-show': return ['shows.json'];
    case 'retire-show': return ['shows.json', 'audience-buzz.json'];
    case 'drop-orphan-key': case 'batch-transform': return a.file ? [path.basename(String(a.file))] : DATA_FILES;
    case 'run-script': return DATA_FILES;
    default: return [];
  }
}

function preflight(planPaths, { reviewTextsDir = pickReviewTextsTree(), coreDataDir = pickCoreDataDir(), log = console.log, htmlHandoffPublicKeyPath = htmlHandoff.PUBLIC_KEY_PATH } = {}) {
  log(`  review-texts tree: ${reviewTextsDir}`);
  // Loaded lazily, once, and shared across plans so later plans see earlier plans' edits.
  const dataCopies = {};
  const loadData = (file) => {
    if (!(file in dataCopies)) dataCopies[file] = JSON.parse(fs.readFileSync(path.join(coreDataDir, file), 'utf8'));
    return dataCopies[file];
  };
  // shows.json's list, or null when the core dir has none (a commercial-only plan used not to need it).
  const showsList = () => { try { const sd = loadData('shows.json'); return sd.shows || sd; } catch { return null; } };
  const stale = new Set();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-fix-'));
  const copied = new Set();
  const removed = new Set();
  const created = new Set();
  let failed = 0;
  const readReviewJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(reviewTextsDir, rel), 'utf8')); } catch { return null; } };
  const listReviewFolder = (folder) => { try { return fs.readdirSync(path.join(reviewTextsDir, folder)); } catch { return []; } };
  try {
    for (const planPath of planPaths) {
      const planData = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      const id = planData.issueNumber || path.basename(planPath, '.json');
      const actions = (planData.plan && planData.plan.actions) || [];
      // The executor only runs a "pending" plan; any other new status is refused
      // at apply time after a ~45 min land (BRO-5015, again in BRO-5254 plan G
      // typed "approved"). Same predicate the executor uses.
      if (planStatusAction(planData.status) !== 'run') {
        failed++;
        log(`  FAIL ${id}: status "${planData.status}" will not run; a new plan must be "pending"`);
      }
      // execute-approved-fix refuses a plan over the cap; say so here, not at land (BRO-3414).
      if (actions.length > MAX_PLAN_ACTIONS) {
        failed++;
        log(`  FAIL ${id}: ${actions.length} actions (max ${MAX_PLAN_ACTIONS}); split it into more plans`);
      }
      // BRO-5886: a handoff envelope the executor will refuse (bad shape, stale key, too big).
      for (const p of handoffPlanProblems(id, actions, { publicKeyPath: htmlHandoffPublicKeyPath })) { failed++; log(`  FAIL ${p}`); }
      let ok = 0;
      // commercial.json records this plan wrote, and their state before the plan (the executor's priorRecord is
      // per plan, BRO-5528): both are reset for each plan, the data copy is shared.
      const touchedCommercial = new Set();
      let priorCommercial = null;
      const notePriorCommercial = () => {
        if (!priorCommercial) priorCommercial = structuredClone(loadData('commercial.json').shows || {});
      };
      for (const a of actions) {
        const problem = fileOpSourceProblem(a, (rel) => fs.existsSync(path.join(reviewTextsDir, rel)), removed, created);
        if (problem) { failed++; log(`  FAIL ${id} ${a.operation} ${a.sourcePath}: ${problem}`); continue; }
        // Advisory (BRO-6488): a move that applies cleanly but leaves the review excluded, or a same-url twin behind.
        for (const w of movePlanWarnings(a, actions, { readJson: readReviewJson, listFolder: listReviewFolder })) log(`  WARN ${id}: ${w}`);
        // Advisory (BRO-5739): nulling images while the files stay on disk is undone by pre-deploy-check.
        for (const f of orphanFilesAfterNulling(a)) log(`  WARN ${id}: ${f} is still on disk; pre-deploy-check re-attaches it, so git rm it in the same land`);
        // The executor refuses an arg shape it cannot run (BRO-5866); say so before the land.
        if (a.type === 'run-script') {
          const parsed = runScriptArgs(a);
          if (!parsed.ok) { failed++; log(`  FAIL ${id} run-script ${a.script}: ${parsed.reason}`); continue; }
        }
        if (a.type === 'add-commercial-entry') {
          notePriorCommercial();
          const list = showsList();
          const res = list ? applyAddCommercialEntry(loadData('commercial.json'), list, a) : { ok: false, reason: `shows.json not found in ${coreDataDir}` };
          touchedCommercial.add(a.slug);
          if (res.ok) { ok++; continue; }
          const label = `${id} add-commercial-entry ${a.slug}: ${res.reason}`;
          // The field allowlist needs no core data, so an unreplayed add-show must not hide it (BRO-6182: humanReviewedDesignation got through as a WARN and CI refused the entry).
          const badField = Object.keys(a.entry || {}).find((k) => !ALLOWED_ENTRY_FIELDS.has(k));
          if (badField) { failed++; log(`  FAIL ${id} add-commercial-entry ${a.slug}: field "${badField}" not allowed`); continue; }
          if (stale.has('commercial.json') || stale.has('shows.json')) log(`  WARN ${label} (an earlier unreplayed action changes the core data; re-check after it applies)`);
          else { failed++; log(`  FAIL ${label}`); }
          continue;
        }
        if (a.type === 'data-edit') {
          if (a.file === 'commercial.json') { notePriorCommercial(); touchedCommercial.add(a.showSlug || a.showId); }
          const notAllowed = dataEditAllowProblem(a);
          const res = notAllowed ? { ok: false, reason: notAllowed } : applyDataEdit(loadData(a.file), a);
          if (res.ok) { ok++; continue; }
          if (stale.has(a.file)) log(`  WARN ${id} ${a.file} ${a.showSlug || a.showId}.${a.field}: ${res.reason} (an earlier unreplayed action changes ${a.file}; re-check after it applies)`);
          else { failed++; log(`  FAIL ${id} ${a.file} ${a.showSlug || a.showId}.${a.field}: ${res.reason}`); }
          continue;
        }
        if (a.type !== 'review-field-edit') {
          for (const f of filesChangedByUnreplayed(a)) stale.add(f);
          log(`  skip ${a.type} (not replayed)`);
          continue;
        }
        const showId = String(a.file || '').split('/')[0];
        if (showId && !copied.has(showId) && fs.existsSync(path.join(reviewTextsDir, showId))) {
          fs.cpSync(path.join(reviewTextsDir, showId), path.join(tmp, showId), { recursive: true });
          copied.add(showId);
        }
        // A url repair may rest on another show's folder holding the current url
        // (urlOwnedByOtherShow, BRO-3065); copy that folder too, or the replay
        // cannot see the proof the real executor sees.
        if (a.field === 'url') copyUrlOwnerFolder(reviewTextsDir, tmp, a.file, copied);
        const res = executeReviewFieldEditIn(tmp, a, { fixId: id, at: new Date().toISOString() });
        if (res.ok) ok++;
        else { failed++; log(`  FAIL ${id} ${a.file} ${a.field}: ${res.reason}`); }
      }
      // The record rules execute-approved-fix.js runs after the plan and rolls the WHOLE plan back on (BRO-5528).
      if (touchedCommercial.size) {
        const problems = touchedRecordProblems(loadData('commercial.json'), showsList() || [], [...touchedCommercial], priorCommercial);
        for (const p of problems) {
          if (stale.has('commercial.json') || stale.has('shows.json')) log(`  WARN ${id} commercial rules: ${p} (an earlier unreplayed action changes the core data; re-check after it applies)`);
          else { failed++; log(`  FAIL ${id} commercial rules: ${p} (apply-time validation would roll back the whole plan)`); }
        }
      }
      log(`${id}: ${ok}/${actions.length} applied cleanly`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { failed };
}

function copyUrlOwnerFolder(reviewTextsDir, tmp, file, copied, { detect } = {}) {
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(reviewTextsDir, file), 'utf8')); } catch { return; }
  const { urlOwnedByOtherShow } = require('./review-slot-guards');
  const owner = urlOwnedByOtherShow({
    reviewTextsDir, folder: String(file).split('/')[0], url: record && record.url, publishDate: record && record.publishDate, detect,
  });
  if (owner && !copied.has(owner.showId)) {
    fs.cpSync(path.join(reviewTextsDir, owner.showId), path.join(tmp, owner.showId), { recursive: true });
    copied.add(owner.showId);
  }
}

module.exports = { preflight, copyUrlOwnerFolder, fileOpSourceProblem, pickReviewTextsTree, pickCoreDataDir, filesChangedByUnreplayed };

const USAGE = 'Usage: node scripts/lib/preflight-review-fix-plan.js <plan.json> [...]';

if (require.main === module) {
  if (require('./cli-help').hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  const plans = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!plans.length) { console.error(USAGE); process.exit(2); }
  const { failed } = preflight(plans);
  process.exit(failed ? 1 : 0);
}
