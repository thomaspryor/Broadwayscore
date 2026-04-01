#!/usr/bin/env node
/**
 * Opening Night Status Dashboard
 *
 * Real-time observability for opening nights. Shows at a glance:
 *   - Review count + score per opening show
 *   - T1/T2/T3 breakdown + which outlets are missing
 *   - Pipeline status: orchestrator, poller, scoring, rebuild, deploy
 *   - Broadcast status: readiness, preview sent, broadcast complete
 *   - Last error from any pipeline step
 *
 * Usage:
 *   node scripts/opening-night-status.js                    # All recent openings
 *   node scripts/opening-night-status.js --show=giant-2026  # Single show
 *   node scripts/opening-night-status.js --watch            # Refresh every 30s
 *   node scripts/opening-night-status.js --watch=60         # Refresh every 60s
 *   node scripts/opening-night-status.js --lookback=4       # 4-day lookback (default: 3)
 *   node scripts/opening-night-status.js --json             # Machine-readable output
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Reuse existing infrastructure
const { checkReadiness, getMissingT1T2Outlets } = require('./opening-night-poller');
const { getTier, getTierWeight, TIER_WEIGHTS } = require('./lib/outlet-tiers');
const { computeCriticScore } = require('./lib/compute-critic-score');
const { isLondonMarket } = require('./lib/venue-classification');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const SENT_PATH = path.join(DATA_DIR, 'opening-night-sent.json');
const SCORING_PROGRESS_PATH = path.join(DATA_DIR, 'collection-state', 'scoring-progress.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');

// CLI args
const SHOW_ID = (process.argv.find(a => a.startsWith('--show=')) || '').replace('--show=', '');
const LOOKBACK_ARG = process.argv.find(a => a.startsWith('--lookback='));
const LOOKBACK_DAYS = LOOKBACK_ARG ? parseInt(LOOKBACK_ARG.split('=')[1], 10) : 3;
const WATCH_ARG = process.argv.find(a => a.startsWith('--watch'));
const WATCH_INTERVAL = WATCH_ARG
  ? (WATCH_ARG.includes('=') ? parseInt(WATCH_ARG.split('=')[1], 10) : 30)
  : 0;
const JSON_OUTPUT = process.argv.includes('--json');

// ── Helpers ──

function loadJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function ghJSON(cmd) {
  try {
    const out = execSync(`gh ${cmd}`, { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch { return null; }
}

/**
 * Find shows that opened within the lookback window (includes previews with passed openingDate)
 */
function findOpeningShows(shows, lookbackDays, showIdFilter) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  cutoff.setHours(0, 0, 0, 0);

  return shows.filter(s => {
    if (showIdFilter && s.id !== showIdFilter) return false;
    if (!s.openingDate) return false;
    const d = new Date(s.openingDate);
    d.setHours(0, 0, 0, 0);
    // Include: open shows within lookback, or previews whose opening date has passed
    if (d < cutoff) return false;
    if (d > now && s.status !== 'previews') return false;
    if (s.status === 'closed') return false;
    return true;
  }).sort((a, b) => new Date(a.openingDate) - new Date(b.openingDate));
}

/**
 * Get review stats for a show from reviews.json
 */
function getShowReviewStats(reviewsArr, showId, outletRegistry) {
  const showRevs = reviewsArr.filter(r => r.showId === showId && r.assignedScore != null);
  const outlets = outletRegistry.outlets || outletRegistry;

  let t1 = 0, t2 = 0, t3 = 0;
  let positive = 0, mixed = 0, negative = 0;
  const outletsSeen = new Set();

  for (const r of showRevs) {
    const tier = getTier(r.outletId);
    if (tier === 1) t1++;
    else if (tier === 2) t2++;
    else t3++;

    if (r.assignedScore >= 75) positive++;
    else if (r.assignedScore >= 55) mixed++;
    else negative++;

    outletsSeen.add(r.outletId);
  }

  // Compute the live critic score using the shared formula
  const scoreResult = computeCriticScore(showRevs, outlets);

  return {
    total: showRevs.length,
    t1, t2, t3,
    positive, mixed, negative,
    score: scoreResult ? Math.round(scoreResult.s) : null,
    outletsSeen: [...outletsSeen],
  };
}

/**
 * Get broadcast status from opening-night-sent.json
 */
function getBroadcastStatus(sentData, showId, market) {
  if (!sentData?.shows) return { state: 'waiting', detail: 'No broadcast data' };

  const broadcastKey = `${market}:${showId}`;
  const completed = sentData.shows[showId] || sentData.shows[broadcastKey];
  if (completed?.completed) {
    return {
      state: 'complete',
      detail: `Broadcast sent at ${new Date(completed.sentAt).toLocaleString()}`,
      reviewCount: completed.reviewCount,
      sentAt: completed.sentAt,
    };
  }

  // Check for preview sent today
  const today = new Date().toISOString().slice(0, 10);
  const previewKey = `preview:${market}:${showId}:${today}`;
  const preview = sentData.shows[previewKey];
  if (preview) {
    return {
      state: 'preview-sent',
      detail: `Preview sent to ${preview.previewTo || 'owner'} at ${new Date(preview.sentAt).toLocaleTimeString()}`,
      reviewCount: preview.reviewCount,
    };
  }

  // Check for any previous preview
  const prevPreviews = Object.keys(sentData.shows).filter(k => k.startsWith(`preview:`) && k.includes(showId));
  if (prevPreviews.length > 0) {
    const lastKey = prevPreviews.sort().pop();
    const last = sentData.shows[lastKey];
    return {
      state: 'preview-sent-earlier',
      detail: `Last preview: ${lastKey.split(':').pop()} (${last.reviewCount} reviews)`,
    };
  }

  // Check for overdue alert
  const overdueKey = `overdue-alert:${showId}`;
  if (sentData.shows[overdueKey]) {
    return {
      state: 'overdue',
      detail: `Overdue alert sent at ${new Date(sentData.shows[overdueKey].sentAt).toLocaleString()}`,
    };
  }

  return { state: 'waiting', detail: 'Not yet broadcast-ready' };
}

/**
 * Get workflow run status from GitHub Actions
 */
function getWorkflowStatus() {
  const workflows = {};

  const orchestratorRuns = ghJSON('run list --workflow=opening-night-orchestrator.yml --limit=3 --json databaseId,status,conclusion,createdAt,updatedAt');
  if (orchestratorRuns?.length) {
    const latest = orchestratorRuns[0];
    workflows.orchestrator = {
      status: latest.status === 'completed' ? latest.conclusion : latest.status,
      runId: latest.databaseId,
      startedAt: latest.createdAt,
      updatedAt: latest.updatedAt,
    };
  }

  const pollerRuns = ghJSON('run list --workflow=opening-night-poller.yml --limit=5 --json databaseId,status,conclusion,createdAt');
  if (pollerRuns?.length) {
    const active = pollerRuns.filter(r => r.status !== 'completed');
    const lastComplete = pollerRuns.find(r => r.status === 'completed');
    workflows.poller = {
      active: active.length,
      activeStatuses: active.map(r => r.status),
      lastCompleted: lastComplete ? {
        conclusion: lastComplete.conclusion,
        at: lastComplete.createdAt,
        runId: lastComplete.databaseId,
      } : null,
    };
  }

  // Check for recent rebuild/deploy
  const deployRuns = ghJSON('run list --workflow=vercel-deploy.yml --limit=2 --json databaseId,status,conclusion,createdAt');
  if (deployRuns?.length) {
    const latest = deployRuns[0];
    workflows.deploy = {
      status: latest.status === 'completed' ? latest.conclusion : latest.status,
      runId: latest.databaseId,
      at: latest.createdAt,
    };
  }

  const rebuildRuns = ghJSON('run list --workflow=rebuild-reviews.yml --limit=2 --json databaseId,status,conclusion,createdAt');
  if (rebuildRuns?.length) {
    const latest = rebuildRuns[0];
    workflows.rebuild = {
      status: latest.status === 'completed' ? latest.conclusion : latest.status,
      runId: latest.databaseId,
      at: latest.createdAt,
    };
  }

  // Check scoring progress
  const scoring = loadJSON(SCORING_PROGRESS_PATH);
  if (scoring) {
    workflows.scoring = {
      pipeline: scoring.pipeline,
      processed: scoring.processed,
      total: scoring.total,
      pct: scoring.pct,
      errors: scoring.errors,
      lastUpdated: scoring.lastUpdated,
      runId: scoring.runId,
    };
  }

  return workflows;
}

/**
 * Check if orchestrator is paused
 */
function isOrchestratorPaused() {
  try {
    execSync('gh variable get ORCHESTRATOR_PAUSED', { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// ── Formatting ──

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const BG_RED = '\x1b[41m';
const BG_GREEN = '\x1b[42m';
const BG_YELLOW = '\x1b[43m';

function colorStatus(status) {
  const map = {
    'in_progress': `${YELLOW}running${RESET}`,
    'queued': `${CYAN}queued${RESET}`,
    'pending': `${CYAN}pending${RESET}`,
    'success': `${GREEN}success${RESET}`,
    'failure': `${RED}FAILURE${RESET}`,
    'cancelled': `${DIM}cancelled${RESET}`,
  };
  return map[status] || status;
}

function scoreColor(score) {
  if (score == null) return `${DIM}--${RESET}`;
  if (score >= 75) return `${GREEN}${BOLD}${score}${RESET}`;
  if (score >= 55) return `${YELLOW}${score}${RESET}`;
  return `${RED}${score}${RESET}`;
}

function readinessBar(current, required, label) {
  const met = current >= required;
  const color = met ? GREEN : RED;
  const icon = met ? '✓' : '✗';
  return `${color}${icon}${RESET} ${label}: ${BOLD}${current}${RESET}/${required}`;
}

function broadcastBadge(state) {
  const map = {
    'complete': `${BG_GREEN}${BOLD} SENT ${RESET}`,
    'preview-sent': `${BG_YELLOW}${BOLD} PREVIEW ${RESET}`,
    'preview-sent-earlier': `${YELLOW}preview (earlier)${RESET}`,
    'overdue': `${BG_RED}${BOLD} OVERDUE ${RESET}`,
    'waiting': `${DIM}waiting${RESET}`,
  };
  return map[state] || state;
}

function timeSince(isoDate) {
  if (!isoDate) return '';
  const mins = Math.round((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sentimentBar(pos, mix, neg) {
  const total = pos + mix + neg;
  if (total === 0) return '';
  // Simple inline bar
  const posChars = Math.max(1, Math.round((pos / total) * 20));
  const mixChars = Math.max(mix > 0 ? 1 : 0, Math.round((mix / total) * 20));
  const negChars = Math.max(neg > 0 ? 1 : 0, Math.round((neg / total) * 20));
  return `${GREEN}${'█'.repeat(posChars)}${RESET}${YELLOW}${'█'.repeat(mixChars)}${RESET}${RED}${'█'.repeat(negChars)}${RESET} ${GREEN}${pos}P${RESET} ${YELLOW}${mix}M${RESET} ${RED}${neg}N${RESET}`;
}

// ── Main ──

function renderDashboard() {
  const showsData = loadJSON(SHOWS_PATH);
  if (!showsData) { console.error('Cannot load shows.json'); process.exit(1); }
  const showsList = Array.isArray(showsData.shows || showsData) ? (showsData.shows || showsData) : Object.values(showsData.shows || showsData);

  const reviewsData = loadJSON(REVIEWS_PATH);
  const reviews = reviewsData ? (reviewsData.reviews || reviewsData) : [];
  const reviewsArr = Array.isArray(reviews) ? reviews : Object.values(reviews);

  const outletRegistry = loadJSON(OUTLET_REGISTRY_PATH) || {};
  const sentData = loadJSON(SENT_PATH);

  // Find opening shows
  const openingShows = findOpeningShows(showsList, LOOKBACK_DAYS, SHOW_ID);

  if (openingShows.length === 0) {
    console.log(`${DIM}No opening nights in the last ${LOOKBACK_DAYS} days.${RESET}`);
    if (SHOW_ID) console.log(`${DIM}Show "${SHOW_ID}" not found or outside lookback window.${RESET}`);
    return { shows: [] };
  }

  // Get workflow status (one call, shared across all shows)
  const workflows = getWorkflowStatus();
  const paused = isOrchestratorPaused();

  // ── Header ──
  const now = new Date();
  console.log(`\n${BOLD}Opening Night Status Dashboard${RESET}  ${DIM}${now.toLocaleString()}${RESET}`);
  console.log(`${DIM}${'─'.repeat(60)}${RESET}`);

  // ── Pipeline Status ──
  console.log(`\n${BOLD}Pipeline${RESET}`);
  if (paused) console.log(`  ${BG_RED}${BOLD} PAUSED ${RESET} Orchestrator is paused (ORCHESTRATOR_PAUSED set)`);

  if (workflows.orchestrator) {
    const o = workflows.orchestrator;
    console.log(`  Orchestrator: ${colorStatus(o.status)}  ${DIM}run ${o.runId} — started ${timeSince(o.startedAt)}${RESET}`);
  } else {
    console.log(`  Orchestrator: ${DIM}no recent runs${RESET}`);
  }

  if (workflows.poller) {
    const p = workflows.poller;
    if (p.active > 0) {
      console.log(`  Poller:       ${YELLOW}${p.active} active${RESET} (${p.activeStatuses.join(', ')})`);
    }
    if (p.lastCompleted) {
      console.log(`  Poller last:  ${colorStatus(p.lastCompleted.conclusion)}  ${DIM}${timeSince(p.lastCompleted.at)}${RESET}`);
    }
  }

  if (workflows.scoring) {
    const sc = workflows.scoring;
    if (sc.total > 0 && sc.processed < sc.total) {
      console.log(`  Scoring:      ${CYAN}${sc.processed}/${sc.total}${RESET} (${sc.pct}%)  ${DIM}updated ${timeSince(sc.lastUpdated)}${RESET}`);
    } else {
      console.log(`  Scoring:      ${DIM}idle${RESET}  ${DIM}updated ${timeSince(sc.lastUpdated)}${RESET}`);
    }
  }

  if (workflows.rebuild) {
    console.log(`  Rebuild:      ${colorStatus(workflows.rebuild.status)}  ${DIM}${timeSince(workflows.rebuild.at)}${RESET}`);
  }
  if (workflows.deploy) {
    console.log(`  Deploy:       ${colorStatus(workflows.deploy.status)}  ${DIM}${timeSince(workflows.deploy.at)}${RESET}`);
  }

  // ── Per-Show Status ──
  const showResults = [];

  for (const show of openingShows) {
    const market = isLondonMarket(show.category) ? 'west-end' : 'broadway';
    const stats = getShowReviewStats(reviewsArr, show.id, outletRegistry);
    const readiness = checkReadiness(show.id, market);
    const missing = getMissingT1T2Outlets(show.id, market);
    const broadcast = getBroadcastStatus(sentData, show.id, market);

    const missingT1 = missing.filter(m => m.tier === 1);
    const missingT2 = missing.filter(m => m.tier === 2);

    const thresholds = show.id; // just used to trigger getThresholds in readiness
    const isWE = isLondonMarket(market);
    const minReviews = isWE ? 8 : 12;
    const minT1 = 3;
    const minT2 = isWE ? 2 : 3;
    const minHiConf = isWE ? 6 : 8;

    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`${BOLD}${show.title}${RESET}  ${DIM}${show.id}${RESET}`);
    console.log(`  ${DIM}${market} · ${show.type || 'show'} · opened ${show.openingDate} · status: ${show.status}${RESET}`);

    // Score + review count
    console.log(`\n  Score: ${scoreColor(stats.score)}  ${DIM}(${stats.total} reviews)${RESET}`);
    console.log(`  ${sentimentBar(stats.positive, stats.mixed, stats.negative)}`);

    // Tier breakdown
    console.log(`\n  Tiers:  T1: ${BOLD}${stats.t1}${RESET}  T2: ${BOLD}${stats.t2}${RESET}  T3: ${BOLD}${stats.t3}${RESET}`);

    // Readiness gates
    console.log(`\n  Readiness:`);
    console.log(`    ${readinessBar(stats.total, minReviews, 'Total')}`);
    console.log(`    ${readinessBar(stats.t1, minT1, 'T1   ')}`);
    console.log(`    ${readinessBar(stats.t2, minT2, 'T2   ')}`);
    console.log(`    ${readinessBar(readiness.highConfidence, minHiConf, 'HiCnf')}`);

    if (readiness.ready) {
      console.log(`    ${GREEN}${BOLD}→ BROADCAST READY${RESET}`);
    } else {
      console.log(`    ${YELLOW}→ Not ready: ${readiness.reasons.join(', ')}${RESET}`);
    }

    // Broadcast status
    console.log(`\n  Broadcast: ${broadcastBadge(broadcast.state)}  ${DIM}${broadcast.detail}${RESET}`);

    // Missing T1/T2 outlets
    if (missingT1.length > 0 || missingT2.length > 0) {
      console.log(`\n  Missing outlets:`);
      if (missingT1.length > 0) {
        console.log(`    ${RED}T1:${RESET} ${missingT1.map(m => m.name).join(', ')}`);
      }
      if (missingT2.length > 0) {
        console.log(`    ${YELLOW}T2:${RESET} ${missingT2.map(m => m.name).join(', ')}`);
      }
    } else {
      console.log(`\n  ${GREEN}All T1/T2 outlets found${RESET}`);
    }

    showResults.push({
      showId: show.id,
      title: show.title,
      market,
      openingDate: show.openingDate,
      score: stats.score,
      reviews: stats,
      readiness,
      broadcast,
      missingT1: missingT1.map(m => m.name),
      missingT2: missingT2.map(m => m.name),
    });
  }

  console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
  console.log(`${DIM}${openingShows.length} show(s) · lookback ${LOOKBACK_DAYS}d · ${reviewsArr.length} total reviews in system${RESET}\n`);

  return { shows: showResults, workflows, paused };
}

// ── Entry ──

function main() {
  if (JSON_OUTPUT) {
    // Suppress console.log during render, capture data
    const origLog = console.log;
    const origError = console.error;
    console.log = () => {};
    console.error = () => {};
    const data = renderDashboard();
    console.log = origLog;
    console.error = origError;
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }

  if (WATCH_INTERVAL > 0) {
    const clearScreen = () => process.stdout.write('\x1b[2J\x1b[H');
    const tick = () => {
      clearScreen();
      renderDashboard();
      console.log(`${DIM}Refreshing every ${WATCH_INTERVAL}s · Ctrl+C to quit${RESET}`);
    };
    tick();
    setInterval(tick, WATCH_INTERVAL * 1000);
  } else {
    renderDashboard();
  }
}

main();
