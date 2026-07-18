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

const { classifySilentGap, shouldAlertGap } = require('./lib/t1-silent-gap');
const { wouldBeIncludedInRebuild } = require('./lib/review-text-scoreable');
const { getTier } = require('./lib/outlet-tiers');
const { AGGREGATOR_OUTLET_IDS } = require('./lib/aggregator-domains');
const { decideEmptyBodyRecovery, nextRecoveryCount } = require('./lib/flagged-recovery');
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
function fileCountsAsScored(d, show) {
  return wouldBeIncludedInRebuild(d, show);
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
      let gap = classifySilentGap({ file: d, show, tier, outletScored: scoredOutlets.has(outletId), now: new Date() });
      if (!gap) continue;

      let recovery = null;
      if (gap.type === 'empty-body' && gap.recoverable && DO_RECOVER && !DRY_RUN
          && fetches < FETCH_CAP && d.url && !attemptedUrls.has(d.url)) {
        attemptedUrls.add(d.url);
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
    }, null, 2) + '\n');
  }
  console.log(`\n${gaps.length} silent gap(s) across ${shows.length} in-window show(s).`);

  if (DO_ALERT && gaps.length > 0 && !DRY_RUN) {
    const state = loadJson(ALERT_STATE_PATH, {});
    const now = new Date();
    const due = gaps.filter((g) => shouldAlertGap(state[`${g.showId}/${g.file}`], now));
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
      const fields = dueDeduped.slice(0, 15).map((g) => ({
        name: `${g.title} — ${g.outletId} (T${g.tier}, ${g.type})`,
        value: `${g.url || 'no url'}\nFix: ${g.fix}`,
      }));
      const delivered = await sendAlert({
        title: `T1/T2 review silent gap: ${dueDeduped.length} major-outlet review(s) missing from scores`,
        description: 'Discovered review files that will not reach the composite score and are not legitimately excluded. Each needs the listed fix command.',
        severity: 'error',
        email: true,
        fields,
      });
      if (delivered) {
        // Only mark gaps whose show+outlet actually made it into the emailed
        // fields (the slice(0,15) cap). Marking ALL due gaps suppressed the
        // 16th+ outlet for REALERT_DAYS without it ever being emailed
        // (ship-check finding 2026-07-18).
        const emailedKeys = new Set(dueDeduped.slice(0, 15).map((g) => `${g.showId}/${g.outletId}`));
        for (const g of due) {
          if (emailedKeys.has(`${g.showId}/${g.outletId}`)) state[`${g.showId}/${g.file}`] = now.toISOString();
        }
        fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
      }
    } else {
      console.log('All current gaps already alerted within the re-alert window.');
    }
  }

  if (has('fail-on-gap') && gaps.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
