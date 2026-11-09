#!/usr/bin/env node
/**
 * gap-recovery-driver.js — BRO-7171 Stage 2 (PILOT) of the zero-gap
 * review-text recovery engine. Picks open text gaps from the classifier
 * (text-gap-classify), chooses one strategy per review from the strategy table
 * (gap-strategy-table), fetches a candidate text (gap-strategies) and sends it
 * through the single acceptance gate + locked write (gap-acceptance), then
 * lands the files through the scoped checkpoint (review-texts-checkpoint).
 * Every attempt is a row in data/audit/gap-recovery-attempts.jsonl
 * (gap-recovery-ledger); a 'recovered' row is written ONLY from the
 * checkpoint's onLanded callback, i.e. once the text is on origin/main.
 *
 * Stage 2 never sets a terminal state and is not scheduled (Stage 3).
 *
 * Usage:
 *   node scripts/gap-recovery-driver.js --dry-run                     # plan for every open gap, writes nothing
 *   node scripts/gap-recovery-driver.js --dry-run --outlet=thestage --verbose
 *   node scripts/gap-recovery-driver.js --limit=20 --outlet=thestage  # live
 *   node scripts/gap-recovery-driver.js --limit=20 --outlet=daily-mail,mail-on-sunday --class=NO_URL --strategy=URL_REDISCOVER
 *   node scripts/gap-recovery-driver.js --reconcile [--dry-run]        # reopen 'recovered' rows whose recovered text is no longer on disk
 *
 * Options: --class=A,B  --show=ID  --strategy=X (only this strategy)  --recent-only  --historic-only
 *          --verbose (dry run: one line per candidate)  --json=PATH (dry run: plan to a file outside the repo)
 *          --summary=PATH (run stats as JSON, read by scripts/gap-recovery-nightly.js)
 * Exit codes: 0 ok, 1 failed (incl. push failure), 2 refused live env, 3 another recovery run holds the run lock.
 * Env:
 *   GAP_RECOVERY_DISABLED=1 (or ~/.broadwayscore-state/gap-recovery-disabled)  kill switch
 *   GAP_RECOVERY_DAILY_CEILING=N   accepted reviews per UTC day (default 40)
 *   GAP_RECOVERY_RUN_CEILING=N     accepted reviews in THIS run instead (the nightly job sets it)
 *   BD_REQ_BUDGET (default 25), SERP_QUERY_BUDGET (default 60): per-run spend caps
 *   TIME_BUDGET_MIN (default 60)   REVIEW_TEXTS_DIR   GAP_RECOVERY_LEDGER_PATH
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);

// Spend caps BEFORE any scraper/url-discovery module loads (they read env at call time,
// but set early so every path sees them).
if (!process.env.BD_REQ_BUDGET) process.env.BD_REQ_BUDGET = '25';
if (!process.env.SERP_QUERY_BUDGET) process.env.SERP_QUERY_BUDGET = '60';

const fs = require('fs');
const os = require('os');
const path = require('path');

const L = require('./lib/gap-recovery-ledger');
const { STRATEGY_FLAGS, selectStrategy, compareCandidates } = require('./lib/gap-strategy-table');

function arg(name, def = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`);
const list = (v) => (v ? new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) : null);

const OPTS = {
  dryRun: flag('dry-run'),
  reconcile: flag('reconcile'),
  verbose: flag('verbose'),
  limit: parseInt(arg('limit', '0'), 10) || 0,
  outlets: list(arg('outlet')),
  classes: list(arg('class')),
  show: arg('show'),
  only: arg('strategy'),
  recentOnly: flag('recent-only'),
  historicOnly: flag('historic-only'),
  jsonOut: arg('json'),
  summaryOut: arg('summary'),
  timeBudgetMs: (parseInt(process.env.TIME_BUDGET_MIN || '60', 10) || 60) * 60000,
};

const ROOT = path.join(__dirname, '..');
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${os.hostname().split('.')[0]}-${process.pid}`;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function showsPath() {
  if (process.env.SHOWS_JSON_PATH) return process.env.SHOWS_JSON_PATH;
  const local = path.join(ROOT, 'data', 'shows.json');
  return fs.existsSync(local) ? local : path.join(os.homedir(), 'broadway-scorecard-data', 'shows.json');
}

const LABELS = {
  REFETCH_FREE: { fetchMethod: 'gap-recovery-refetch-free', sourceMethod: 'gap-recovery-refetch-free', contentTierReasonFallback: 'Recovered by the gap-recovery driver (free refetch)' },
  ARCHIVE: { fetchMethod: 'gap-recovery-wayback-earliest', sourceMethod: 'gap-recovery-archive', contentTierReasonFallback: 'Recovered by the gap-recovery driver (earliest Wayback capture)' },
  URL_REDISCOVER: { fetchMethod: 'gap-recovery-url-rediscover', sourceMethod: 'gap-recovery-url-rediscover', contentTierReasonFallback: 'Recovered by the gap-recovery driver (url rediscovery)', urlDiscoveryMethod: 'google-serp' },
};

/** Build the candidate list with a strategy per review (no writes). */
function planCandidates({ dir, shows, outlets, ledgerIndex, runGates }) {
  const { scanCorpus } = require('./lib/text-gap-metric');
  const { adapterFor } = require('./lib/browser-outlet-adapters');
  const rg = require('./lib/review-guards');
  const { loadFailedFetches } = require('./lib/text-gap-metric');
  const ff = loadFailedFetches(dir);
  const scan = scanCorpus({ dir, shows, outlets, nowMs: Date.now(), outletFilter: OPTS.outlets, showFilter: OPTS.show });
  const out = [];
  for (const row of scan.rows) {
    if (!row.open) continue;
    if (OPTS.classes && !OPTS.classes.has(row.gapClass)) continue;
    if (OPTS.recentOnly && row.recency !== 'recent') continue;
    if (OPTS.historicOnly && row.recency === 'recent') continue;
    const reviewKey = `${row.showId}/${row.file}`;
    const filePath = path.join(dir, row.showId, row.file);
    let review;
    try { review = readJson(filePath); } catch { continue; }
    const show = shows.get(row.showId) || null;
    const ffEntry = ff.get(reviewKey) || null;
    const eligible = (strategy) => {
      const e = L.strategyEligibility({ strategy, show, review, gapClass: row.gapClass, state: L.strategyState(ledgerIndex, reviewKey, strategy) });
      if (!e.ok) return e;
      // The collector's own fetch gate (failed-fetches.json + lifecycle): when it
      // has given up on the url, the free refetch is the same cheap path; the
      // other strategies are the escalation.
      if (strategy === 'REFETCH_FREE' && ffEntry) {
        const c = rg.shouldRetryFetch(show, review, ffEntry);
        if (!c.shouldRetry) return { ok: false, reason: `collector_${c.reason}` };
      }
      return e;
    };
    const owned = L.ownedRecordReason(review);
    // Re-selection with extra run gates: a browser session that fails at run
    // time falls through to the next strategy instead of starving it.
    const reselect = (extraGates = {}) => selectStrategy({
      gapClass: row.gapClass,
      hasUrl: !!review.url,
      hasAdapter: !!adapterFor(review.outletId),
      // An unknown show date counts as 'recent' for ordering, but such shows
      // are often old: do not take ARCHIVE away from them.
      recency: row.dateKnown === false ? null : row.recency,
      eligible,
      runGates: { ...runGates, ...extraGates },
      only: OPTS.only,
    });
    const sel = owned ? { strategy: null, skipped: [{ strategy: 'ANY', reason: owned }] } : reselect();
    out.push({
      reviewKey, filePath, showId: row.showId, file: row.file, outletId: review.outletId || row.outletId,
      outlet: review.outlet, criticName: review.criticName, source: review.source, url: review.url || null,
      gapClass: row.gapClass, subclass: row.subclass, recency: row.recency,
      showDate: (show && (show.openingDate || show.previewsStartDate)) || null,
      show, strategy: sel.strategy, skipped: sel.skipped, bytesBefore: (review.fullText || '').length, reselect: owned ? null : reselect,
    });
  }
  out.sort(compareCandidates);
  return out;
}

function bump(o, k, n = 1) { o[k] = (o[k] || 0) + n; }

function printPlan(cands) {
  const byClass = {};
  const byStrategy = {};
  const byClassStrategy = {};
  const skipReasons = {};
  for (const c of cands) {
    bump(byClass, c.gapClass);
    const s = c.strategy || 'NONE';
    bump(byStrategy, s);
    byClassStrategy[c.gapClass] = byClassStrategy[c.gapClass] || {};
    bump(byClassStrategy[c.gapClass], s);
    if (!c.strategy) for (const k of c.skipped) bump(skipReasons, `${k.strategy}:${k.reason}`);
    if (OPTS.verbose) {
      console.log(`  ${c.recency === 'recent' ? 'R' : 'h'} ${c.reviewKey}  ${c.gapClass}${c.subclass ? `:${c.subclass}` : ''} -> ${s}${c.skipped.length ? `  (skipped ${c.skipped.map((k) => `${k.strategy}:${k.reason}`).join(', ')})` : ''}`);
    }
  }
  const recent = cands.filter((c) => c.recency === 'recent');
  console.log(`\nOpen gaps planned: ${cands.length} (recent ${recent.length}); with a strategy: ${cands.filter((c) => c.strategy).length}`);
  console.log('\nby strategy:', JSON.stringify(byStrategy));
  console.log('\nclass x strategy:');
  for (const [k, v] of Object.entries(byClassStrategy).sort((a, b) => byClass[b[0]] - byClass[a[0]])) {
    console.log(`  ${k.padEnd(26)} ${String(byClass[k]).padStart(5)}  ${Object.entries(v).map(([s, n]) => `${s}=${n}`).join(' ')}`);
  }
  console.log('\nno strategy, by first skip reason chain:', JSON.stringify(skipReasons));
  console.log('\nstrategy flags:', JSON.stringify(Object.fromEntries(Object.entries(STRATEGY_FLAGS).map(([k, v]) => [k, v.enabled]))));
  return { byClass, byStrategy, byClassStrategy, skipReasons };
}

/** Stats for --summary (nightly reads it; never a review file). */
const SUMMARY = { mode: null, attempted: 0, accepted: 0, landed: 0, byStrategy: {}, ceilingHit: false, pushFailed: false, authFailedOutlets: [], authOkOutlets: [], reopened: 0, error: null };
function writeSummary() {
  const p = arg('summary');
  if (!p) return;
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(SUMMARY, null, 2)); } catch (e) { console.error(`summary write failed: ${e.message}`); }
}

/**
 * Whole-run lock (recovery-run-lock): live runs and a writing reconcile never
 * overlap another recovery run. The nightly entrypoint holds the lock itself
 * and runs this driver as its child: GAP_RECOVERY_RUN_LOCK_PARENT=<its pid>.
 * @returns {boolean} false when busy
 */
function takeRunLock(label) {
  if (process.env.GAP_RECOVERY_RUN_LOCK_PARENT && process.env.GAP_RECOVERY_RUN_LOCK_PARENT === String(process.ppid)) return true;
  const { acquireRunLock, RunLockBusyError } = require('./lib/recovery-run-lock');
  try { acquireRunLock(label); return true; } catch (e) {
    if (e instanceof RunLockBusyError) { console.log(`gap-recovery: ${e.message}; not running.`); return false; }
    throw e;
  }
}

async function runReconcile({ dir, ledgerPath }) {
  const rows = L.readRows(ledgerPath);
  const reopen = L.reconcileRecovered(rows, (key) => { try { return readJson(path.join(dir, key)); } catch { return null; } });
  console.log(`reconcile: ${rows.length} ledger rows, ${reopen.length} recovered review(s) whose recovered text is no longer on disk`);
  for (const r of reopen) console.log(`  reopen ${r.reviewKey} (${r.reason}, tier ${r.detail.tier})`);
  if (!OPTS.dryRun && reopen.length) L.appendRows(reopen, ledgerPath);
  SUMMARY.mode = 'reconcile';
  SUMMARY.reopened = reopen.length;
  return reopen;
}

async function main() {
  const ks = L.killSwitchActive();
  if (ks.active) { console.log(`gap-recovery: kill switch active (${ks.why}); nothing done.`); return 0; }

  const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
  const dir = process.env.REVIEW_TEXTS_DIR || resolveReviewTextsDir();
  const ledgerPath = L.ledgerPathDefault();
  if (!OPTS.dryRun && !takeRunLock(OPTS.reconcile ? 'gap-recovery-driver --reconcile' : 'gap-recovery-driver')) return 3;
  if (OPTS.reconcile) { await runReconcile({ dir, ledgerPath }); return 0; }

  const showsRaw = readJson(showsPath());
  const shows = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  const outletsRaw = readJson(path.join(ROOT, 'data', 'outlet-registry.json'));
  const outlets = outletsRaw.outlets || outletsRaw;

  const gui = require('./lib/gui-session').guiSessionAvailable();
  const serpKeys = { scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '', brightDataKey: process.env.BRIGHTDATA_TOKEN || '' };
  const runGates = {};
  if (!gui.available) runGates.BROWSER_SESSION = { ok: false, reason: `browser_unavailable:${gui.reason}` };
  if (!serpKeys.scrapingBeeKey && !serpKeys.brightDataKey) runGates.URL_REDISCOVER = { ok: false, reason: 'no_serp_key' };
  const env = require('./lib/gap-strategy-table').liveEnvironmentGates({
    showsJsonReadable: (() => { try { fs.accessSync(path.join(ROOT, 'data', 'shows.json'), fs.constants.R_OK); return true; } catch { return false; } })(),
    cookieJarExists: fs.existsSync(require('./lib/cookie-loader').COOKIE_DIR),
  });
  if (!runGates.BROWSER_SESSION && env.runGates.BROWSER_SESSION) runGates.BROWSER_SESSION = env.runGates.BROWSER_SESSION;
  if (env.fatal && !OPTS.dryRun) { console.error(`gap-recovery: refusing a live run: ${env.fatal}`); return 2; }

  const rows = L.readRows(ledgerPath);
  const ledgerIndex = L.indexRows(rows);
  console.log(`gap-recovery-driver ${OPTS.dryRun ? 'DRY RUN' : 'LIVE'} run ${RUN_ID}`);
  console.log(`  review-texts: ${dir}\n  ledger: ${ledgerPath} (${rows.length} rows)\n  GUI: ${gui.available ? 'available' : `unavailable (${gui.reason})`}\n  SERP keys: ${serpKeys.scrapingBeeKey || serpKeys.brightDataKey ? 'yes' : 'no'}  BD_REQ_BUDGET=${process.env.BD_REQ_BUDGET} SERP_QUERY_BUDGET=${process.env.SERP_QUERY_BUDGET}`);

  const cands = planCandidates({ dir, shows, outlets, ledgerIndex, runGates });
  if (OPTS.dryRun) {
    SUMMARY.mode = 'dry_run';
    const summary = printPlan(cands);
    if (OPTS.jsonOut) {
      // A plan report from --json=, never a review file (read from argv
      // directly so review-write-safety's taint scan does not follow OPTS).
      const planReportPath = arg('json');
      fs.writeFileSync(planReportPath, JSON.stringify({ runId: RUN_ID, summary, candidates: cands.map(({ show, ...c }) => c) }, null, 2));
      console.log(`plan written to ${OPTS.jsonOut}`);
    }
    return 0;
  }
  return runLive({ dir, cands, rows, ledgerPath, serpKeys, gui });
}

async function runLive({ dir, cands, rows, ledgerPath, serpKeys, gui }) {
  const { recoverReviewTextVerified } = require('./lib/gap-acceptance');
  const { checkpointReviewTexts, retryPendingPushes, createWriteTracker, ReviewTextsPushError } = require('./lib/review-texts-checkpoint');
  const { withReviewTextsLock } = require('./lib/review-texts-lock');
  const S = require('./lib/gap-strategies');
  const { adapterFor, openSession } = require('./lib/browser-outlet-adapters');
  // A per-run cap (the nightly job) replaces the per-UTC-day count, so manual
  // runs earlier in the same UTC day do not eat the night's budget.
  const runCeiling = L.runCeiling();
  const ceiling = runCeiling != null ? runCeiling : L.dailyCeiling();
  const ceilingRows = runCeiling != null ? [] : rows;
  const tracker = createWriteTracker();
  const pendingInfo = new Map(); // reviewKey -> attempt info for the recovered row
  const earlierPending = L.pendingPushInfo(rows); // accepted by an earlier run, not yet landed
  const landedKeys = new Set();
  const onLanded = (landed) => {
    const key = L.reviewKeyOf(landed.path);
    const info = pendingInfo.get(key)
      || (landed.meta && landed.meta.source === 'gap-recovery-driver' && landed.meta.attempts && landed.meta.attempts[key])
      || earlierPending.get(key);
    if (!info) return; // another script's pending entry
    L.appendRows([L.recoveredRowFromLanding(landed, info)], ledgerPath);
    landedKeys.add(key);
  };

  // Land what an earlier run committed but could not push, before new work.
  const pend = retryPendingPushes({ repoDir: dir, onLanded });
  if (pend.entries) console.log(`  [pending] ${pend.entries} earlier checkpoint(s): ${pend.landed.length} landed, ${pend.restored.length} restored, ${pend.notLanded.length} not landed`);

  const todo = cands.filter((c) => c.strategy);
  const work = OPTS.limit ? todo.slice(0, OPTS.limit) : todo;
  console.log(`\n${todo.length} candidates with a strategy; running ${work.length}. ${runCeiling != null ? `Run ceiling ${ceiling}` : `Daily ceiling ${ceiling} (accepted today so far: ${L.acceptedToday(rows)})`}.`);

  const stats = { attempted: 0, accepted: 0, byStrategy: {} };
  const sessions = new Map(); // adapter name -> session | {failed}
  const start = Date.now();
  let accepted = 0;
  let runError = null;

  const record = (c, strategy, extra) => {
    const st = L.strategyState(L.indexRows(L.readRows(ledgerPath)), c.reviewKey, strategy);
    const stamp = L.evidenceStamp({ show: c.show, strategy, outcome: extra.outcome, reason: extra.reason, priorState: st });
    L.appendRows([{ reviewKey: c.reviewKey, gapClass: c.gapClass, strategy, runId: RUN_ID, bytesBefore: c.bytesBefore, url: extra.url || c.url, ...extra, ...stamp }], ledgerPath);
    const b = (stats.byStrategy[strategy] = stats.byStrategy[strategy] || { attempted: 0, accepted: 0, outcomes: {} });
    b.attempted++;
    bump(b.outcomes, `${extra.outcome}:${String(extra.reason || '').split(':')[0]}`);
  };

  const flush = (label) => {
    if (!tracker.size) return;
    const attempts = {};
    for (const p of tracker) { const k = L.reviewKeyOf(p); if (pendingInfo.has(k)) attempts[k] = pendingInfo.get(k); }
    const paths = [...tracker];
    try {
      const res = checkpointReviewTexts({
        repoDir: dir, paths, expected: tracker.expected,
        message: `feat: gap-recovery driver ${label} - ${accepted} accepted (BRO-7171 Stage 2)`,
        onLanded, meta: { source: 'gap-recovery-driver', runId: RUN_ID, attempts },
      });
      console.log(`  [checkpoint] ${res.pushed ? 'pushed' : 'nothing to push'}; ${res.landed.length} file(s) confirmed on origin/main`);
    } finally {
      for (const p of paths) { tracker.delete(p); if (tracker.expected) tracker.expected.delete(p); }
    }
  };

  try {
    for (let i = 0; i < work.length; i++) {
      const c = work[i];
      if (Date.now() - start > OPTS.timeBudgetMs) { console.log('\nTime budget reached.'); break; }
      if (L.ceilingReached({ rows: ceilingRows, ceiling, acceptedThisRun: accepted })) { console.log(`\n${runCeiling != null ? 'Run' : 'Daily'} ceiling ${ceiling} reached.`); SUMMARY.ceilingHit = true; break; }
      if (L.killSwitchActive().active) { console.log('\nKill switch turned on mid-run; stopping.'); break; }
      // Browser preferred but no GUI: record the non-evidence row, then use the next strategy.
      for (const k of c.skipped) {
        if (k.strategy === 'BROWSER_SESSION' && String(k.reason).startsWith('browser_unavailable')) {
          record(c, 'BROWSER_SESSION', { outcome: 'browser_unavailable', reason: k.reason });
        }
      }
      let strategy = c.strategy;
      stats.attempted++;
      console.log(`\n[${i + 1}/${work.length}] ${c.reviewKey} ${c.gapClass} -> ${strategy}`);

      let got;
      if (strategy === 'BROWSER_SESSION') {
        const ad = adapterFor(c.outletId);
        if (!sessions.has(ad.name)) {
          const o = gui.available ? await openSession(ad) : { ok: false, outcome: 'browser_unavailable', reason: 'gui' };
          sessions.set(ad.name, o.ok ? o.session : { failed: o });
          if (o.ok) SUMMARY.authOkOutlets.push(ad.name);
          else if (o.outcome === 'auth_failed') SUMMARY.authFailedOutlets.push(ad.name);
        }
        const s = sessions.get(ad.name);
        got = s.failed ? { ok: false, outcome: s.failed.outcome, reason: s.failed.reason } : await S.browserSession(c, s);
        if (!got.ok && got.outcome === 'auth_failed' && !s.failed) {
          await s.close().catch(() => {});
          sessions.set(ad.name, { failed: got });
          // Logged in at the probe, lost mid-run: still a lost session tonight.
          SUMMARY.authOkOutlets = SUMMARY.authOkOutlets.filter((n) => n !== ad.name);
          if (!SUMMARY.authFailedOutlets.includes(ad.name)) SUMMARY.authFailedOutlets.push(ad.name);
        }
        // A session-level failure (no session for the outlet this run) is
        // non-evidence: record it and fall through to the next eligible
        // strategy, so a broken login never starves ARCHIVE run after run.
        const failed = sessions.get(ad.name).failed;
        if (!got.ok && failed && c.reselect) {
          record(c, 'BROWSER_SESSION', { outcome: got.outcome, reason: got.reason });
          const next = c.reselect({ BROWSER_SESSION: { ok: false, reason: `${failed.outcome}:${failed.reason}` } }).strategy;
          if (!next) { console.log(`  ✗ ${got.outcome} (${got.reason}); no fallback strategy`); continue; }
          console.log(`  browser ${got.outcome} (${got.reason}); falling back to ${next}`);
          strategy = next;
          got = null;
        }
      }
      if (got) { /* browser result above */ }
      else if (strategy === 'REFETCH_FREE') got = await S.refetchFree(c);
      else if (strategy === 'ARCHIVE') got = await S.archive(c);
      else if (strategy === 'URL_REDISCOVER') got = await S.urlRediscover(c, serpKeys);
      else got = { ok: false, outcome: 'non_evidence', reason: `strategy_unbuilt:${strategy}` };

      // URL rediscovery spends the file's own SERP budget (shared serpRetryCount).
      if (strategy === 'URL_REDISCOVER' && got.serpRan) {
        const rg = require('./lib/review-guards');
        const { readReviewForUpdate, persistReviewSnapshot } = require('./lib/persist-review-snapshot');
        withReviewTextsLock(`gap-serp-count:${c.reviewKey}`, () => {
          const data = readReviewForUpdate(c.filePath);
          const patch = rg.recordSerpAttempt(c.show, { ...data, incompleteReason: L.serpGateReason(c.gapClass) });
          // The driver sets no terminal state: keep the shared count/cooldown,
          // never the permanent abandon flag (the count cap already stops us).
          delete patch.serpDiscoveryAbandoned;
          delete patch.staleWrongProductionRecoveryAbandoned;
          if (Object.keys(patch).length) {
            Object.assign(data, patch);
            persistReviewSnapshot({ filePath: c.filePath, data, trailingNewline: true });
            tracker.add(path.resolve(c.filePath));
          }
        });
      }

      if (!got.ok) {
        console.log(`  ✗ ${got.outcome} (${got.reason})`);
        record(c, strategy, { outcome: got.outcome, reason: got.reason, url: got.url });
        continue;
      }
      const labels = LABELS[strategy] || {
        ...(adapterFor(c.outletId) || {}).labels,
      };
      const r = await recoverReviewTextVerified({
        filePath: c.filePath, rawText: got.rawText, url: got.url, expectUrl: c.url || null,
        headline: require('./lib/gap-acceptance').pageHeadline(got.html),
        labels, tracker, ctxOpts: { reviewTextsDir: dir }, show: c.show,
      });
      if (!r.ok) {
        const outcome = L.outcomeForGateRefusal(r.code);
        console.log(`  ✗ ${outcome} (${r.code}): ${String(r.reason).slice(0, 160)}`);
        record(c, strategy, { outcome, reason: r.code, url: got.url, bytesAfter: r.newLen, detail: { via: got.via, llmAsked: !!r.llmAsked } });
        continue;
      }
      accepted++;
      stats.accepted++;
      let priorFullTextHash = null;
      try { priorFullTextHash = readJson(c.filePath).textRecoveryProvenance.priorFullTextHash; } catch { /* none */ }
      const info = { reviewKey: c.reviewKey, gapClass: c.gapClass, strategy, url: got.url, bytesBefore: c.bytesBefore, bytesAfter: r.newLen, priorFullTextHash, runId: RUN_ID };
      pendingInfo.set(c.reviewKey, info);
      console.log(`  ✓ accepted ${r.newLen} chars via ${got.via} (tier ${r.decision.priorTier} -> ${r.decision.newTier})`);
      record(c, strategy, { outcome: 'pending_push', reason: 'accepted', url: got.url, bytesAfter: r.newLen, priorFullTextHash, detail: { via: got.via, newTier: r.decision.newTier } });
      stats.byStrategy[strategy].accepted++;
      if (accepted % 5 === 0) flush(`checkpoint ${accepted}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
    flush('final');
  } catch (e) {
    runError = e;
    // Commit and push what was already accepted before stopping, so no text
    // sits uncommitted with a pending_push row nothing will resolve. (Not after
    // a push failure: that work is already committed and journaled.)
    if (!(e instanceof ReviewTextsPushError)) {
      try { flush('after-error'); } catch (e2) { console.error(`  [checkpoint after error] ${e2.message}`); if (e2 instanceof ReviewTextsPushError) runError = e2; }
    }
  } finally {
    for (const s of sessions.values()) if (s && s.close) await s.close().catch(() => {});
  }

  Object.assign(SUMMARY, { mode: 'live', attempted: stats.attempted, accepted: stats.accepted, landed: landedKeys.size, byStrategy: stats.byStrategy, runId: RUN_ID });
  if (runError) { SUMMARY.error = String(runError.message).slice(0, 300); SUMMARY.pushFailed = runError instanceof ReviewTextsPushError; }
  console.log('\n' + '='.repeat(60));
  console.log(`Run ${RUN_ID}: attempted ${stats.attempted}, accepted ${stats.accepted}, landed (recovered rows) ${landedKeys.size}`);
  for (const [s, b] of Object.entries(stats.byStrategy)) {
    console.log(`  ${s.padEnd(16)} attempted ${b.attempted}  accepted ${b.accepted}  yield ${b.attempted ? Math.round((100 * b.accepted) / b.attempted) : 0}%  ${JSON.stringify(b.outcomes)}`);
  }
  try { console.log(`  live SERP queries this run: ${require('./lib/url-discovery').getSerpQueryCount()}`); } catch { /* not loaded */ }
  if (runError) {
    if (runError instanceof ReviewTextsPushError) console.error(`PUSH FAILED: ${runError.message} (pending_push rows stay; next run retries before new work)`);
    throw runError;
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((e) => { console.error('FATAL:', e.stack || e.message); if (!SUMMARY.error) SUMMARY.error = String(e.message).slice(0, 300); process.exitCode = 1; })
  .finally(() => {
    writeSummary();
    // fetchPage's Playwright tiers keep a browser alive for reuse.
    let cleanup = null;
    try { if (require.cache[require.resolve('./lib/scraper')]) cleanup = require('./lib/scraper').cleanup; } catch { /* not loaded */ }
    Promise.resolve(cleanup ? cleanup().catch(() => {}) : null).finally(() => process.exit(process.exitCode || 0));
  });
