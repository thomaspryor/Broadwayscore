#!/usr/bin/env node
/**
 * audit-t1-silent-gaps.js
 *
 * Dir-driven sweep for major-outlet (tier 1/2) reviews that were DISCOVERED
 * (a review-texts file exists) but will not reach the composite score and are
 * not legitimately excluded — the "we cannot miss those publications" class
 * (2026-07-18 incident: The Times/Oresteia empty paywall stub + NYT/Potluck
 * DataDome bot-stub, both silent for days).
 *
 * Why this exists when audit-show-review-gap.js already self-heals:
 *   1. That audit is aggregator-driven — it only recovers files whose URL an
 *      aggregator article cites. Both incident files were cited by no
 *      aggregator article the audit consults (Playbill matched a 2022
 *      prior production for The Oresteia), so they were invisible.
 *   2. Its 3-year back-catalogue rotation means a freshly-opened show may not
 *      be re-audited for many hours. This sweep is cheap (dir scan, at most
 *      --fetch-cap re-ingests) so it covers EVERY recent show EVERY run.
 *   3. Nothing anywhere escalated a terminal unscoreable state. This script
 *      emails an ACTION alert (deduped, 7-day re-alert) with the exact fix
 *      command per gap.
 *
 * _pending/ is out of scope (no-byline strand has its own drain flow).
 *
 * Usage:
 *   node scripts/audit-t1-silent-gaps.js                     # report only
 *   node scripts/audit-t1-silent-gaps.js --show=ID           # one show
 *   node scripts/audit-t1-silent-gaps.js --recover --alert   # CI mode
 *   --window=45 --min-age-days=2 --fetch-cap=10 --dry-run
 *
 * Output: data/audit/t1-silent-gaps.json (+ alert state in
 *         data/audit/t1-silent-gap-alerts.json)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { classifySilentGap, shouldAlertGap, shouldDispatchScoring, shouldEmailUnscoredGap, MAJOR_TIER_MAX } = require('./lib/t1-silent-gap');
const { detectFlagContradiction, contradictionFixCommand, shouldAlertContradiction } = require('./lib/flag-contradiction');
const { wouldAutoClear, shadowObservation } = require('./lib/autoclear-shadow');
const { isIncludableForRebuild, hasValidScore } = require('./lib/review-guards');
const { getTier } = require('./lib/outlet-tiers');
const { AGGREGATOR_OUTLET_IDS } = require('./lib/aggregator-domains');
const { decideEmptyBodyRecovery, nextRecoveryCount, FLAGGED_RECOVERY_CAP } = require('./lib/flagged-recovery');
const {
  loadRecoveryState, saveRecoveryState, decideRefetch, recordRefetch,
  DEFAULT_REFETCH_CONFIG,
} = require('./lib/refetch-circuit-breaker');
const { dispatchRescore } = require('./lib/dispatch-rescore');
const { safeWriteReview } = require('./lib/review-write-guard');
const { sendAlert } = require('./lib/discord-notify');
const { execErrorDetail } = require('./lib/exec-error-detail');

// BSC_DATA_ROOT: worktree sessions point at the main checkout's data/ (the
// private review-texts clone only exists there).
const ROOT = process.env.BSC_DATA_ROOT || path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const REPORT_PATH = path.join(AUDIT_DIR, 't1-silent-gaps.json');
const ALERT_STATE_PATH = path.join(AUDIT_DIR, 't1-silent-gap-alerts.json');
// Auto-clear shadow log (S3-T4): append-only record of live would-auto-clear
// candidates so a real 48h window can be measured before auto-clear is ever
// enabled (S3-T5). This job is the single writer.
const SHADOW_LOG_PATH = path.join(AUDIT_DIR, 'autoclear-shadow.jsonl');
// Circuit-breaker state for the self-heal refetch (S3-T1/T2). Global 10/day
// budget + audit-side per-file attempt history — NEVER stored in per-review
// JSON. Single writer = this hourly job.
const RECOVERY_STATE_PATH = path.join(AUDIT_DIR, 't1-recovery-state.json');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};
const has = (name) => args.includes(`--${name}`);

const WINDOW_DAYS = parseInt(opt('window', '45'), 10);
const MIN_AGE_DAYS = parseInt(opt('min-age-days', '2'), 10);
const FETCH_CAP = parseInt(opt('fetch-cap', '10'), 10);
const ONLY_SHOW = opt('show', null);
const DO_RECOVER = has('recover');
const DO_ALERT = has('alert');
const DRY_RUN = has('dry-run');

function loadJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}

function windowShows() {
  const raw = loadJson(path.join(ROOT, 'data', 'shows.json'), {});
  const shows = Array.isArray(raw) ? raw : raw.shows || [];
  if (ONLY_SHOW) return shows.filter((s) => s.id === ONLY_SHOW);
  const now = Date.now();
  return shows.filter((s) => {
    if (!s.openingDate) return false;
    const t = Date.parse(s.openingDate);
    if (Number.isNaN(t)) return false;
    const ageDays = (now - t) / 86400000;
    return ageDays >= MIN_AGE_DAYS && ageDays <= WINDOW_DAYS;
  });
}

// showId → Set(outletId) present in reviews.json (presence = scored + included).
function scoredOutletsByShow() {
  const raw = loadJson(path.join(ROOT, 'data', 'reviews.json'), []);
  const reviews = Array.isArray(raw) ? raw : raw.reviews || [];
  const map = new Map();
  for (const r of reviews) {
    if (!r.showId || !r.outletId) continue;
    if (!map.has(r.showId)) map.set(r.showId, new Set());
    map.get(r.showId).add(r.outletId);
  }
  return map;
}

// A sibling file for the same outlet that WILL reach reviews.json (canonical
// predicate) — covers the scoring→rebuild window where reviews.json is stale.
// SCORED axis = isIncludableForRebuild (flag/context filters) AND hasValidScore.
function fileCountsAsScored(d, show) {
  return isIncludableForRebuild(d, show) && hasValidScore(d);
}

function recoverFromOwnUrl(showId, fileName, d, show) {
  const outletId = fileName.split('--')[0];
  const decision = decideEmptyBodyRecovery({
    file: d,
    outletId,
    critic: d.criticName && d.criticName !== 'Unknown' ? d.criticName : null,
    url: d.url || null,
  });
  if (decision.action !== 'recover') return { attempted: false, reason: decision.reason };

  const iargs = [path.join(ROOT, 'scripts', 'ingest-review-from-url.js'),
    `--show=${showId}`, `--url=${decision.url}`, `--outlet=${outletId}`];
  if (decision.critic) iargs.push(`--critic=${decision.critic}`);

  let ok = true; let reason = null;
  try {
    execFileSync('node', iargs, { stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    ok = false; reason = execErrorDetail(e, 100);
  }
  // Persist the shared retry counter on EVERY attempt (same cap +
  // safeWriteReview routing as audit-show-review-gap's bumpRecoveryCount)
  // so a permanently-blocked URL stops burning credits after the cap.
  try {
    const fp = path.join(REVIEW_TEXTS_DIR, showId, fileName);
    const fresh = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!(fresh.fullText && fresh.fullText.length >= 400) && !fileCountsAsScored(fresh, show)) {
      fresh.aggUrlRecoveryCount = nextRecoveryCount(fresh);
      fresh.aggUrlRecoveryAt = new Date().toISOString();
      safeWriteReview(fp, fresh);
    }
  } catch { /* best-effort */ }
  return { attempted: true, ok, reason };
}

function fixCommand(showId, fileName, d, type) {
  if (type === 'unscored') {
    return `gh workflow run "LLM Ensemble Score Reviews" -f show_id=${showId}`;
  }
  const outletId = fileName.split('--')[0];
  const critic = d.criticName && d.criticName !== 'Unknown' ? ` --critic="${d.criticName}"` : '';
  if (!d.url) {
    // No URL on file — an ingest command would be unrunnable (--url=null).
    // The operator must locate the review first (or flag the file if it's a
    // cross-production/aggregator artifact).
    return `# no URL on file — find the ${outletId} review for ${showId} first, then: ` +
      `node scripts/ingest-review-from-url.js --show=${showId} --url=<URL> --outlet=${outletId}${critic}`;
  }
  return `node scripts/ingest-review-from-url.js --show=${showId} --url=${d.url}` +
    ` --outlet=${outletId}${critic}   # run LOCALLY (cookie jar lives on the Mac)`;
}

async function main() {
  const shows = windowShows();
  const scoredMap = scoredOutletsByShow();
  const gaps = [];
  let fetches = 0;
  // Byline-explosion clusters share one URL across many files — never spend
  // more than one fetch slot per URL per run (QA finding: 6 identical
  // whatsonstage stubs would starve the cap).
  const attemptedUrls = new Set();

  // Circuit-breaker state (S3-T2): the GLOBAL daily refetch budget lives here,
  // spanning all hourly runs — the per-run --fetch-cap alone can't bound a day.
  // Loaded once; mutated + persisted after EVERY attempt so a crash preserves
  // the budget already spent (single-writer, commit-on-change discipline).
  let recoveryState = loadRecoveryState(RECOVERY_STATE_PATH, new Date());
  const persistRecoveryState = () => {
    if (DRY_RUN) return;
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    saveRecoveryState(RECOVERY_STATE_PATH, recoveryState);
  };
  // Dry-run visibility: candidates that WOULD refetch and where the breaker
  // stands. Printed at the end so a --dry-run shows the budget math (S3-T2 VERIFY).
  let dryRunCandidates = 0;
  const breakerDenied = [];

  // Stale-flag contradictions (S3-T3), ESCALATE-ONLY. A file-level flag that a
  // NEWER contentVerification verdict contradicts — collected independently of
  // the gap classification (a wrongProduction file is a "correct absence" for
  // the gap classifier, so it never appears as a gap, yet its flag may be
  // stale). Emitted as a deduped ACTION alert with the exact clear command.
  const contradictions = [];

  // S3-T4 shadow observations (would-auto-clear candidates) appended to the
  // shadow log this run. Auto-clear itself stays OFF (escalate-only).
  const shadowObservations = [];

  for (const show of shows) {
    const dir = path.join(REVIEW_TEXTS_DIR, show.id);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }

    const parsed = new Map();
    for (const f of files) parsed.set(f, loadJson(path.join(dir, f), null));

    const scoredOutlets = new Set(scoredMap.get(show.id) || []);
    for (const [f, d] of parsed) {
      if (fileCountsAsScored(d, show)) scoredOutlets.add(f.split('--')[0]);
    }

    for (const [f, d] of parsed) {
      if (!d) continue;
      const outletId = f.split('--')[0];
      if (AGGREGATOR_OUTLET_IDS.has(outletId)) continue;
      const tier = getTier(outletId, { showCategory: show.category });

      // Stale-flag contradiction (S3-T3, escalate-only): runs on EVERY T1/T2
      // file BEFORE the `if (!gap) continue` below — a wrongProduction file is
      // a "correct absence" for the gap classifier (returns null), so this is
      // the only place its stale flag would ever surface.
      if (tier != null && tier <= MAJOR_TIER_MAX) {
        const contra = detectFlagContradiction(d);
        if (contra) {
          contradictions.push({
            showId: show.id, title: show.title, openingDate: show.openingDate,
            file: f, outletId, tier, ...contra,
            fix: contradictionFixCommand(show.id, f, contra.flag),
          });
          console.log(`  ⚠️  ${show.id} — ${outletId} (T${tier}) stale ${contra.flag} flag contradicted by newer CV (${contra.verifiedAt})`);

          // S3-T4 shadow: record what an auto-clearer WOULD do (append-only).
          // Escalate-only stays the behavior; this only observes.
          const decision = wouldAutoClear(d);
          if (decision.clear) {
            shadowObservations.push(shadowObservation({
              showId: show.id, file: f, outletId, tier,
              decision, observedAt: new Date().toISOString(),
            }));
          }
        }
      }

      let gap = classifySilentGap({ file: d, show, tier, outletScored: scoredOutlets.has(outletId), now: new Date() });
      if (!gap) continue;

      let recovery = null;
      // A file is a refetch candidate when it's a recoverable empty-body gap
      // with a usable URL we haven't already spent a slot on this run.
      const isRefetchCandidate = gap.type === 'empty-body' && gap.recoverable
        && d.url && !attemptedUrls.has(d.url);

      if (isRefetchCandidate && DO_RECOVER && DRY_RUN) {
        // Dry-run: count what WOULD refetch (consult the breaker read-only so
        // the count reflects the real budget, but never mutate/persist state).
        const dec = decideRefetch(recoveryState, { showId: show.id, fileName: f, now: new Date() });
        attemptedUrls.add(d.url);
        if (dec.allowed) dryRunCandidates++;
        else breakerDenied.push({ showId: show.id, file: f, reason: dec.reason });
      } else if (isRefetchCandidate && DO_RECOVER && !DRY_RUN && fetches < FETCH_CAP) {
        attemptedUrls.add(d.url);
        // GLOBAL daily budget + per-file cap (audit-side state), checked BEFORE
        // the per-run --fetch-cap fires. A denied refetch is logged (never a
        // silent no-op) and the file still reports as a gap below.
        const dec = decideRefetch(recoveryState, { showId: show.id, fileName: f, now: new Date() });
        if (!dec.allowed) {
          recovery = { attempted: false, reason: `circuit-breaker:${dec.reason}` };
          breakerDenied.push({ showId: show.id, file: f, reason: dec.reason });
        } else {
          // Record the attempt (bump global + per-file) and PERSIST before the
          // fetch — a crash mid-fetch must still count the spend.
          recoveryState = recordRefetch(dec.state, { showId: show.id, fileName: f, now: new Date() });
          persistRecoveryState();
          recovery = recoverFromOwnUrl(show.id, f, d, show);
          if (recovery.attempted) fetches++;
        // Healed only if a re-classification agrees — a re-ingest that lands
        // another bot stub must NOT suppress the gap (Codex review finding).
        const fresh = loadJson(path.join(dir, f), null);
        // (A just-refilled file classifies null via the unscored grace window —
        // the scoring cron gets UNSCORED_GRACE_HOURS before later runs flag it.)
        const freshGap = fresh && classifySilentGap({
          file: fresh, show, tier,
          outletScored: scoredOutlets.has(outletId),
          now: new Date(),
        });
          if (fresh && freshGap == null) {
            console.log(`  ♻️  recovered ${show.id}/${f} from its own URL`);
            continue;
          }
        }
      }

      gaps.push({
        showId: show.id,
        title: show.title,
        openingDate: show.openingDate,
        file: f,
        outletId,
        tier,
        type: gap.type,
        url: d.url || null,
        recovery,
        recoveryCount: d.aggUrlRecoveryCount || 0,
        fix: fixCommand(show.id, f, d, gap.type),
      });
      console.log(`  🕳  ${show.id} — ${outletId} (T${tier}) ${gap.type}${recovery && recovery.attempted ? ` [recovery failed: ${recovery.reason || 'still empty'}]` : ''}`);
    }
  }

  if (!DRY_RUN) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      showsScanned: shows.length,
      gaps,
      contradictions,
    }, null, 2) + '\n');
  }
  if (contradictions.length > 0) {
    console.log(`⚠️  ${contradictions.length} stale-flag contradiction(s) (escalate-only).`);
  }
  // Append this run's would-auto-clear observations to the shadow log (S3-T4).
  // Append-only so a real 48h window accumulates; the report CLI reads it.
  if (!DRY_RUN && shadowObservations.length > 0) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(SHADOW_LOG_PATH,
      shadowObservations.map((o) => JSON.stringify(o)).join('\n') + '\n');
    console.log(`🕶️  logged ${shadowObservations.length} auto-clear shadow observation(s).`);
  }
  console.log(`\n${gaps.length} silent gap(s) across ${shows.length} in-window show(s).`);

  // Refetch circuit-breaker budget math (S3-T2). Printed every run; on a
  // --dry-run this is the primary output (candidates that WOULD refetch +
  // remaining budget), on a live --recover run it's a post-hoc summary.
  {
    const rolled = require('./lib/refetch-circuit-breaker').rolloverDay(recoveryState, new Date());
    const spentToday = rolled.globalCount || 0;
    const remaining = Math.max(0, DEFAULT_REFETCH_CONFIG.dailyGlobalCap - spentToday);
    if (DRY_RUN && DO_RECOVER) {
      console.log(`\n💧 refetch budget (dry-run): ${dryRunCandidates} candidate(s) would refetch; ` +
        `${spentToday}/${DEFAULT_REFETCH_CONFIG.dailyGlobalCap} used today, ${remaining} remaining. ` +
        `${breakerDenied.length} candidate(s) would be denied by the breaker.`);
      for (const b of breakerDenied.slice(0, 10)) {
        console.log(`   ⛔ ${b.showId}/${b.file} — ${b.reason}`);
      }
    } else if (DO_RECOVER) {
      console.log(`💧 refetch budget: ${fetches} fetch(es) this run; ` +
        `${spentToday}/${DEFAULT_REFETCH_CONFIG.dailyGlobalCap} used today (global), ${remaining} remaining. ` +
        `${breakerDenied.length} skipped by the breaker.`);
    }
  }

  const state = loadJson(ALERT_STATE_PATH, {});
  const now = new Date();

  // Self-heal 'unscored' gaps: dispatch the scoring workflow ourselves instead
  // of emailing the operator the dispatch command (2026-07-21 Midnight at the
  // Never Get CRITICAL email). One dispatch per show per DISPATCH_RETRY_HOURS,
  // stamped in the alert-state file (committed by the workflow) so consecutive
  // hourly runs don't re-dispatch while scoring is still in flight.
  let stateDirty = false;
  if (DO_RECOVER && !DRY_RUN) {
    const unscoredShowIds = [...new Set(gaps.filter((g) => g.type === 'unscored').map((g) => g.showId))];
    for (const showId of unscoredShowIds) {
      const key = `dispatch:${showId}`;
      if (!shouldDispatchScoring(state[key] || null, now)) continue;
      const res = await dispatchRescore(showId, { reason: 't1-silent-gap' });
      if (res.ok) {
        state[key] = now.toISOString();
        stateDirty = true;
        console.log(`  🚀 dispatched LLM Ensemble scoring for ${showId}`);
      } else {
        console.warn(`  ⚠️  scoring dispatch failed for ${showId}: ${res.error}`);
      }
    }
  }

  // Email eligibility per gap type — the report file always carries everything:
  //  - unscored: only after a self-heal dispatch DISPATCH_RETRY_HOURS+ ago
  //    failed to heal it (never-dispatched gaps get dispatched, not emailed)
  //  - empty-body with a URL: only once the shared auto-recovery retry cap is
  //    exhausted (while retries remain, the hourly recover pass owns it)
  //  - empty-body without a URL / rejected-unscoreable: page immediately —
  //    there is no automated path
  const emailEligible = (g) => {
    if (g.type === 'unscored') return shouldEmailUnscoredGap(state[`dispatch:${g.showId}`] || null, now);
    if (g.type === 'empty-body' && g.url) return (g.recoveryCount || 0) >= FLAGGED_RECOVERY_CAP;
    return true;
  };

  // Persist dispatch stamps even when no email flows this run — without this,
  // every hourly run re-dispatches the same show until an email happens to fire.
  if (stateDirty) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  }

  if (DO_ALERT && gaps.length > 0 && !DRY_RUN) {
    const due = gaps.filter(emailEligible)
      .filter((g) => shouldAlertGap(state[`${g.showId}/${g.file}`], now));
    // One alert field per show+outlet (byline-explosion clusters produce many
    // files for the same missing outlet — the ACTION is the same fix command).
    const seen = new Set();
    const dueDeduped = due.filter((g) => {
      const k = `${g.showId}/${g.outletId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (due.length > 0) {
      // Email routing (2026-07-19, after 6 CRITICAL emails in 36h): only gaps
      // on shows NEAR OPENING (score actively forming, user can still act
      // before the broadcast) page in real time. Back-catalogue strandings go
      // to the daily digest via health-check.js silentGapBacklogResults —
      // they are still recorded in the report + alert-state below, so they
      // surface once a day instead of one CRITICAL email per discovery.
      const URGENT_OPENING_DAYS = 10;
      const now2 = Date.now();
      const isUrgent = (g) => {
        const t = Date.parse(g.openingDate || '');
        return !Number.isNaN(t) && Math.abs(now2 - t) <= URGENT_OPENING_DAYS * 24 * 60 * 60 * 1000;
      };
      const urgent = dueDeduped.filter(isUrgent);
      const emailBatch = urgent.slice(0, 15);
      const fields = emailBatch.map((g) => ({
        name: `${g.title} — ${g.outletId} (T${g.tier}, ${g.type})`,
        value: `${g.url || 'no url'}\nFix: ${g.fix}`,
      }));
      const delivered = urgent.length > 0
        ? await sendAlert({
          title: `T1/T2 review silent gap: ${urgent.length} review(s) missing on near-opening show(s)`,
          description: `Discovered review files that will not reach the composite score and are not legitimately excluded. Each needs the listed fix command. (${dueDeduped.length - urgent.length} additional back-catalogue gap(s) routed to the daily digest.)`,
          severity: 'error',
          email: true,
          fields,
        })
        // No urgent gaps: nothing pages. Backlog gaps are marked below so
        // they stop re-evaluating as due, and the daily digest carries them.
        : true;
      if (delivered) {
        // Mark: (a) urgent gaps that actually made the emailed fields — an
        // urgent gap past the 15-cap stays unmarked so it emails next run
        // (ship-check finding 2026-07-18); (b) ALL non-urgent backlog gaps —
        // they route to the daily digest (health-check silentGapBacklogResults
        // reads the report file), so marking stops the hourly re-evaluation
        // without losing visibility.
        const handledKeys = new Set([
          ...emailBatch.map((g) => `${g.showId}/${g.outletId}`),
          ...dueDeduped.filter((g) => !isUrgent(g)).map((g) => `${g.showId}/${g.outletId}`),
        ]);
        for (const g of due) {
          if (handledKeys.has(`${g.showId}/${g.outletId}`)) state[`${g.showId}/${g.file}`] = now.toISOString();
        }
        fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
      }
    } else {
      console.log('No gaps due to email (already alerted, self-heal dispatch pending, or auto-recovery retries remaining).');
    }
  }

  // Stale-flag contradiction ACTION alert (S3-T3), ESCALATE-ONLY. Deduped per
  // show+file on a 7-day window using the same alert-state file (namespaced
  // `contradiction:`). A contradiction is a live suppressed review — it always
  // pages (no near-opening gate): a newer CV already ruled the flag stale, so
  // the fix is a one-command clear the operator can run immediately.
  if (DO_ALERT && contradictions.length > 0 && !DRY_RUN) {
    const dueC = contradictions.filter((c) =>
      shouldAlertContradiction(state[`contradiction:${c.showId}/${c.file}`], now));
    if (dueC.length > 0) {
      const fields = dueC.slice(0, 15).map((c) => ({
        name: `${c.title || c.showId} — ${c.outletId} (T${c.tier}, stale ${c.flag})`,
        value: `Newer CV (${c.verifiedAt}) contradicts the flag set ${c.flaggedAt}.\nFix: ${c.fix}`,
      }));
      const delivered = await sendAlert({
        title: `Stale exclusion flag contradicted by newer CV: ${dueC.length} suppressed review(s)`,
        description: 'A file-level wrongProduction/wrongShow flag is contradicted by a NEWER contentVerification verdict — the review is being suppressed from the score by a stale flag. Each needs the listed clear command (run locally). Escalate-only: nothing is auto-cleared.',
        severity: 'error',
        email: true,
        fields,
      });
      if (delivered) {
        for (const c of dueC.slice(0, 15)) {
          state[`contradiction:${c.showId}/${c.file}`] = now.toISOString();
        }
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
      }
    } else {
      console.log('No stale-flag contradictions due to alert (already alerted within the window).');
    }
  }

  if (has('fail-on-gap') && gaps.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
