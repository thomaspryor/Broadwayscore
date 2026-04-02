#!/usr/bin/env node
/**
 * Generate Opening Night Status Page
 *
 * Produces two files:
 *   1. public/opening-night-status.json — machine-readable status data
 *   2. public/status.html — self-contained status dashboard (mobile-friendly)
 *
 * Designed to be called by CI after each poller cycle, or manually.
 * The HTML page auto-refreshes by re-fetching the JSON every 30s.
 *
 * Usage:
 *   node scripts/generate-status-page.js
 *   node scripts/generate-status-page.js --lookback=4
 */

const fs = require('fs');
const path = require('path');
const { checkReadiness, getMissingT1T2Outlets } = require('./opening-night-poller');
const { getTier, TIER_WEIGHTS } = require('./lib/outlet-tiers');
const { computeCriticScore } = require('./lib/compute-critic-score');
const { isLondonMarket } = require('./lib/venue-classification');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SITE_SHOWS_DIR = path.join(PUBLIC_DIR, 'data', 'shows');

const LOOKBACK_ARG = process.argv.find(a => a.startsWith('--lookback='));
const LOOKBACK_DAYS = LOOKBACK_ARG ? parseInt(LOOKBACK_ARG.split('=')[1], 10) : 3;

function loadJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function getSiteScore(showId) {
  const data = loadJSON(path.join(SITE_SHOWS_DIR, `${showId}.json`));
  if (!data || data.cs == null) return null;
  return { score: data.cs, reviewCount: data.rc, positive: data.bd?.positive || 0, mixed: data.bd?.mixed || 0, negative: data.bd?.negative || 0 };
}

function main() {
  const showsData = loadJSON(path.join(DATA_DIR, 'shows.json'));
  if (!showsData) { console.error('Cannot load shows.json'); process.exit(1); }
  const showsList = Array.isArray(showsData.shows || showsData) ? (showsData.shows || showsData) : Object.values(showsData.shows || showsData);

  const reviewsData = loadJSON(path.join(DATA_DIR, 'reviews.json'));
  const reviews = reviewsData ? (reviewsData.reviews || reviewsData) : [];
  const reviewsArr = Array.isArray(reviews) ? reviews : Object.values(reviews);

  const outletRegistry = loadJSON(path.join(DATA_DIR, 'outlet-registry.json')) || {};
  const outlets = outletRegistry.outlets || outletRegistry;
  const sentData = loadJSON(path.join(DATA_DIR, 'opening-night-sent.json'));

  // Find opening shows
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  // Only include shows with openingDate within the lookback window
  // (not future previews — those haven't opened yet)
  const openingShows = showsList.filter(s => {
    if (!s.openingDate) return false;
    const d = new Date(s.openingDate);
    d.setHours(0, 0, 0, 0);
    if (d < cutoff) return false;
    if (d > now) return false; // Only shows that have actually opened
    if (s.status === 'closed') return false;
    return true;
  }).sort((a, b) => new Date(a.openingDate) - new Date(b.openingDate));

  const shows = openingShows.map(show => {
    const market = isLondonMarket(show.category) ? 'west-end' : 'broadway';
    const showRevs = reviewsArr.filter(r => r.showId === show.id && r.assignedScore > 0);

    let t1 = 0, t2 = 0, t3 = 0, positive = 0, mixed = 0, negative = 0;
    for (const r of showRevs) {
      const tier = getTier(r.outletId);
      if (tier === 1) t1++;
      else if (tier === 2) t2++;
      else t3++;
      if (r.assignedScore >= 75) positive++;
      else if (r.assignedScore >= 55) mixed++;
      else negative++;
    }

    const scoreResult = computeCriticScore(showRevs, outlets);
    const siteData = getSiteScore(show.id);
    const liveScore = scoreResult ? Math.round(scoreResult.s) : null;
    const siteScore = siteData?.score ?? null;

    const readiness = checkReadiness(show.id, market);
    const missing = getMissingT1T2Outlets(show.id, market);

    // Broadcast status
    let broadcastState = 'waiting';
    let broadcastDetail = 'Not yet broadcast-ready';
    if (sentData?.shows) {
      const bk = `${market}:${show.id}`;
      const completed = sentData.shows[show.id] || sentData.shows[bk];
      if (completed?.completed) {
        broadcastState = 'complete';
        broadcastDetail = `Sent ${new Date(completed.sentAt).toLocaleString()}`;
      } else {
        const today = now.toISOString().slice(0, 10);
        const pk = `preview:${market}:${show.id}:${today}`;
        if (sentData.shows[pk]) {
          broadcastState = 'preview-sent';
          broadcastDetail = `Preview sent (${sentData.shows[pk].reviewCount} reviews)`;
        } else if (sentData.shows[`overdue-alert:${show.id}`]) {
          broadcastState = 'overdue';
          broadcastDetail = 'Overdue alert sent';
        }
      }
    }

    return {
      id: show.id, title: show.title, market, type: show.type || 'show',
      openingDate: show.openingDate, status: show.status,
      siteScore, liveScore, scoreDrift: (siteScore != null && liveScore != null) ? liveScore - siteScore : null,
      total: showRevs.length, t1, t2, t3, positive, mixed, negative,
      readiness: { ready: readiness.ready, reasons: readiness.reasons, highConfidence: readiness.highConfidence },
      broadcast: { state: broadcastState, detail: broadcastDetail },
      missingT1: missing.filter(m => m.tier === 1).map(m => m.name),
      missingT2: missing.filter(m => m.tier === 2).map(m => m.name),
    };
  });

  const statusData = { generatedAt: now.toISOString(), lookbackDays: LOOKBACK_DAYS, shows };

  // Write JSON
  fs.writeFileSync(path.join(PUBLIC_DIR, 'opening-night-status.json'), JSON.stringify(statusData, null, 2));
  console.log(`Wrote opening-night-status.json (${shows.length} shows)`);

  // Write HTML
  fs.writeFileSync(path.join(PUBLIC_DIR, 'status.html'), generateHTML());
  console.log('Wrote status.html');
}

function generateHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening Night Status — Broadway Scorecard</title>
<meta name="robots" content="noindex">
<style>
  :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #e2e8f0; --dim: #94a3b8; --green: #22c55e; --yellow: #eab308; --red: #ef4444; --blue: #3b82f6; --cyan: #06b6d4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 16px; max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .meta { color: var(--dim); font-size: 13px; margin-bottom: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  .show-title { font-size: 17px; font-weight: 700; margin-bottom: 2px; }
  .show-meta { font-size: 12px; color: var(--dim); margin-bottom: 12px; }
  .score-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .score { font-size: 32px; font-weight: 800; line-height: 1; }
  .score.positive { color: var(--green); }
  .score.mixed { color: var(--yellow); }
  .score.negative { color: var(--red); }
  .score.none { color: var(--dim); }
  .score-label { font-size: 12px; color: var(--dim); }
  .drift { font-size: 12px; color: var(--yellow); margin-bottom: 8px; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
  .bar-pos { background: var(--green); }
  .bar-mix { background: var(--yellow); }
  .bar-neg { background: var(--red); }
  .bar-legend { font-size: 11px; color: var(--dim); margin-bottom: 12px; }
  .tiers { font-size: 13px; margin-bottom: 12px; display: flex; gap: 12px; }
  .tier-badge { background: #0f172a; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .gates { margin-bottom: 12px; }
  .gate { font-size: 13px; display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
  .gate-icon { width: 16px; text-align: center; }
  .gate-pass { color: var(--green); }
  .gate-fail { color: var(--red); }
  .ready-badge { display: inline-block; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 6px; margin-bottom: 12px; }
  .ready-yes { background: var(--green); color: #000; }
  .ready-no { background: var(--yellow); color: #000; }
  .broadcast { font-size: 13px; margin-bottom: 12px; }
  .bc-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-right: 6px; }
  .bc-complete { background: var(--green); color: #000; }
  .bc-preview { background: var(--yellow); color: #000; }
  .bc-overdue { background: var(--red); color: #fff; }
  .bc-waiting { background: var(--border); color: var(--dim); }
  .missing { font-size: 12px; color: var(--dim); margin-top: 8px; }
  .missing-t1 { color: var(--red); }
  .missing-t2 { color: var(--yellow); }
  .empty { text-align: center; color: var(--dim); padding: 40px 0; }
  .refresh { font-size: 11px; color: var(--dim); text-align: center; margin-top: 8px; }
  .footer { text-align: center; margin-top: 16px; }
  .footer a { color: var(--blue); text-decoration: none; font-size: 13px; }
</style>
</head>
<body>
<h1>Opening Night Status</h1>
<div class="meta" id="updated"></div>
<div id="shows"></div>
<div class="refresh" id="refresh"></div>
<div class="footer"><a href="https://broadwayscorecard.com">broadwayscorecard.com</a></div>
<script>
function scoreClass(s) { return s == null ? 'none' : s >= 75 ? 'positive' : s >= 55 ? 'mixed' : 'negative'; }
function bcClass(s) { return { complete:'bc-complete', 'preview-sent':'bc-preview', overdue:'bc-overdue' }[s] || 'bc-waiting'; }
function bcLabel(s) { return { complete:'SENT', 'preview-sent':'PREVIEW', overdue:'OVERDUE' }[s] || 'WAITING'; }

function render(data) {
  document.getElementById('updated').textContent = 'Updated: ' + new Date(data.generatedAt).toLocaleString();
  const el = document.getElementById('shows');
  if (!data.shows.length) { el.innerHTML = '<div class="empty">No opening nights in the last ' + data.lookbackDays + ' days.</div>'; return; }
  el.innerHTML = data.shows.map(s => {
    const score = s.siteScore ?? s.liveScore;
    const total = s.positive + s.mixed + s.negative || 1;
    const isWE = s.market === 'west-end' || s.market === 'off-west-end';
    const minR = isWE ? 8 : 12, minT1 = 3, minT2 = isWE ? 2 : 3, minH = isWE ? 6 : 8;
    function gate(v, req, label) {
      const ok = v >= req;
      return '<div class="gate"><span class="gate-icon ' + (ok?'gate-pass':'gate-fail') + '">' + (ok?'\\u2713':'\\u2717') + '</span>' + label + ': <b>' + v + '</b>/' + req + '</div>';
    }
    const drift = (s.scoreDrift != null && s.scoreDrift !== 0)
      ? '<div class="drift">Live score: ' + s.liveScore + ' (' + (s.scoreDrift>0?'+':'') + s.scoreDrift + ' drift — rebuild needed)</div>'
      : (s.siteScore == null && s.liveScore != null ? '<div class="drift">Not yet on site — rebuild needed</div>' : '');
    const missingT1 = s.missingT1.length ? '<div class="missing"><span class="missing-t1">Missing T1:</span> ' + s.missingT1.join(', ') + '</div>' : '';
    const missingT2 = s.missingT2.length ? '<div class="missing"><span class="missing-t2">Missing T2:</span> ' + s.missingT2.join(', ') + '</div>' : '';
    return '<div class="card">' +
      '<div class="show-title">' + s.title + '</div>' +
      '<div class="show-meta">' + s.market + ' \\u00b7 ' + s.type + ' \\u00b7 ' + s.openingDate + ' \\u00b7 ' + s.status + '</div>' +
      '<div class="score-row"><span class="score ' + scoreClass(score) + '">' + (score ?? '--') + '</span><span class="score-label">' + (s.siteScore != null ? 'site' : 'live') + ' score \\u00b7 ' + s.total + ' reviews</span></div>' +
      drift +
      '<div class="bar"><div class="bar-pos" style="flex:' + s.positive + '"></div><div class="bar-mix" style="flex:' + s.mixed + '"></div><div class="bar-neg" style="flex:' + s.negative + '"></div></div>' +
      '<div class="bar-legend">' + s.positive + ' positive \\u00b7 ' + s.mixed + ' mixed \\u00b7 ' + s.negative + ' negative</div>' +
      '<div class="tiers"><span class="tier-badge">T1: ' + s.t1 + '</span><span class="tier-badge">T2: ' + s.t2 + '</span><span class="tier-badge">T3: ' + s.t3 + '</span></div>' +
      '<div class="gates">' + gate(s.total, minR, 'Total') + gate(s.t1, minT1, 'T1') + gate(s.t2, minT2, 'T2') + gate(s.readiness.highConfidence, minH, 'Hi-Conf') + '</div>' +
      '<span class="ready-badge ' + (s.readiness.ready ? 'ready-yes' : 'ready-no') + '">' + (s.readiness.ready ? 'BROADCAST READY' : 'Not ready: ' + s.readiness.reasons.join(', ')) + '</span>' +
      '<div class="broadcast"><span class="bc-badge ' + bcClass(s.broadcast.state) + '">' + bcLabel(s.broadcast.state) + '</span>' + s.broadcast.detail + '</div>' +
      missingT1 + missingT2 +
    '</div>';
  }).join('');
}

async function fetchAndRender() {
  try {
    const r = await fetch('/opening-night-status.json?t=' + Date.now());
    if (r.ok) render(await r.json());
  } catch(e) { console.error('Failed to fetch status:', e); }
  document.getElementById('refresh').textContent = 'Auto-refresh every 30s \\u00b7 Last check: ' + new Date().toLocaleTimeString();
}
fetchAndRender();
setInterval(fetchAndRender, 30000);
</script>
</body>
</html>`;
}

main();
