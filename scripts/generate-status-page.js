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
const { checkReadiness, getMissingT1T2Outlets, getThresholds } = require('./opening-night-poller');
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
  }).sort((a, b) => new Date(b.openingDate) - new Date(a.openingDate));

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
    const thresholds = getThresholds(market);

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

    // Fix contradictory text: if readiness gates pass but broadcast hasn't sent, say "awaiting send"
    if (readiness.ready && broadcastState === 'waiting') {
      broadcastDetail = 'Ready — awaiting send';
    }

    return {
      id: show.id, title: show.title, market, category: show.category || market, type: show.type || 'show',
      openingDate: show.openingDate, status: show.status,
      siteScore, liveScore, scoreDrift: (siteScore != null && liveScore != null) ? liveScore - siteScore : null,
      total: showRevs.length, t1, t2, t3, positive, mixed, negative,
      readiness: {
        ready: readiness.ready, reasons: readiness.reasons, highConfidence: readiness.highConfidence,
        thresholds: { minReviews: thresholds.MIN_REVIEWS, minT1: thresholds.MIN_T1_REVIEWS, minT2: thresholds.MIN_T2_REVIEWS, minHiConf: thresholds.MIN_HIGH_CONFIDENCE },
      },
      broadcast: { state: broadcastState, detail: broadcastDetail },
      missingT1: missing.filter(m => m.tier === 1).map(m => ({ name: m.name, isDualMarket: m.isDualMarket })),
      missingT2: missing.filter(m => m.tier === 2).map(m => ({ name: m.name, isDualMarket: m.isDualMarket })),
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
<meta name="theme-color" content="#0f172a">
<style>
  :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #e2e8f0; --dim: #94a3b8; --green: #22c55e; --yellow: #eab308; --red: #ef4444; --blue: #3b82f6; --cyan: #06b6d4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 12px; max-width: 640px; margin: 0 auto; -webkit-text-size-adjust: 100%; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .meta { color: var(--dim); font-size: 13px; margin-bottom: 12px; }
  .filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .filter-btn { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; font-size: 13px; color: var(--dim); cursor: pointer; font-family: inherit; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
  .filter-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
  .show-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
  .show-title { font-size: 17px; font-weight: 700; flex: 1; min-width: 0; }
  .market-pill { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0; white-space: nowrap; margin-top: 3px; }
  .market-broadway { background: #2563eb; color: #fff; }
  .market-off-broadway { background: #7c3aed; color: #fff; }
  .market-west-end { background: #059669; color: #fff; }
  .market-off-west-end { background: #0d9488; color: #fff; }
  .show-meta { font-size: 12px; color: var(--dim); margin-bottom: 12px; }
  .score-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .score { font-size: 32px; font-weight: 800; line-height: 1; }
  .score.positive { color: var(--green); }
  .score.mixed { color: var(--yellow); }
  .score.negative { color: var(--red); }
  .score.none { color: var(--dim); }
  .score-label { font-size: 12px; color: var(--dim); }
  .drift { font-size: 12px; color: var(--yellow); margin-bottom: 8px; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin-bottom: 6px; }
  .bar-pos { background: var(--green); }
  .bar-mix { background: var(--yellow); }
  .bar-neg { background: var(--red); }
  .bar-legend { font-size: 11px; color: var(--dim); margin-bottom: 10px; }
  .tiers { font-size: 13px; margin-bottom: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
  .tier-badge { background: #0f172a; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .gates { margin-bottom: 10px; }
  .gate { font-size: 13px; display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
  .gate-icon { width: 16px; text-align: center; flex-shrink: 0; }
  .gate-pass { color: var(--green); }
  .gate-fail { color: var(--red); }
  .ready-badge { display: inline-block; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 6px; margin-bottom: 10px; max-width: 100%; }
  .ready-yes { background: var(--green); color: #000; }
  .ready-no { background: #422006; color: var(--yellow); border: 1px solid var(--yellow); }
  .ready-reasons { font-size: 12px; color: var(--yellow); margin-bottom: 10px; }
  .broadcast { font-size: 13px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .bc-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; flex-shrink: 0; }
  .bc-complete { background: var(--green); color: #000; }
  .bc-preview { background: var(--yellow); color: #000; }
  .bc-overdue { background: var(--red); color: #fff; }
  .bc-waiting { background: var(--border); color: var(--dim); }
  .missing-section { margin-top: 8px; }
  .missing-toggle { font-size: 12px; color: var(--dim); cursor: pointer; -webkit-tap-highlight-color: transparent; display: flex; align-items: center; gap: 4px; padding: 4px 0; }
  .missing-toggle .chevron { transition: transform 0.2s; display: inline-block; font-size: 10px; }
  .missing-toggle .chevron.open { transform: rotate(90deg); }
  .missing-body { overflow: hidden; transition: max-height 0.25s ease; }
  .missing-body.collapsed { max-height: 0 !important; }
  .missing-group { font-size: 12px; padding: 4px 0 2px 0; }
  .missing-label { font-weight: 600; }
  .missing-t1 { color: var(--red); }
  .missing-t2 { color: var(--yellow); }
  .missing-cross { color: var(--dim); font-style: italic; }
  .all-found { font-size: 12px; color: var(--green); margin-top: 6px; }
  .empty { text-align: center; color: var(--dim); padding: 40px 0; }
  .refresh { font-size: 11px; color: var(--dim); text-align: center; margin-top: 8px; }
  .footer { text-align: center; margin-top: 16px; }
  .footer a { color: var(--blue); text-decoration: none; font-size: 13px; }
  @media (max-width: 400px) {
    .score { font-size: 28px; }
    .show-title { font-size: 16px; }
    .filter-btn { padding: 8px 10px; font-size: 12px; }
  }
</style>
</head>
<body>
<h1>Opening Night Status</h1>
<div class="meta" id="updated" role="status" aria-live="polite"></div>
<div class="filters" id="filters" role="group" aria-label="Market filters"></div>
<div id="shows" role="main"></div>
<div class="refresh" id="refresh" role="status" aria-live="polite"></div>
<div class="footer"><a href="https://broadwayscorecard.com">broadwayscorecard.com</a></div>
<script>
function scoreClass(s) { return s == null ? 'none' : s >= 75 ? 'positive' : s >= 55 ? 'mixed' : 'negative'; }
function bcClass(s) { return { complete:'bc-complete', 'preview-sent':'bc-preview', 'preview-sent-earlier':'bc-preview', overdue:'bc-overdue' }[s] || 'bc-waiting'; }
function bcLabel(s) { return { complete:'SENT', 'preview-sent':'PREVIEW', 'preview-sent-earlier':'PREVIEW', overdue:'OVERDUE' }[s] || 'WAITING'; }
function marketLabel(c) { return { broadway:'Broadway', 'off-broadway':'Off-Broadway', 'west-end':'West End', 'off-west-end':'Off-West End' }[c] || c; }
function marketClass(c) { return 'market-' + (c || 'broadway'); }
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

let activeFilters = new Set(['broadway', 'off-broadway', 'west-end', 'off-west-end']);
function loadFilters() {
  const h = location.hash.replace('#','');
  if (h) activeFilters = new Set(h.split(','));
}
function saveFilters() { location.hash = [...activeFilters].join(','); }
loadFilters();

let _data = null;

function renderFilters(data) {
  const cats = [...new Set(data.shows.map(s => s.category))];
  const el = document.getElementById('filters');
  if (!cats.length) { el.innerHTML = ''; return; }
  el.innerHTML = cats.map(c =>
    '<button class="filter-btn ' + (activeFilters.has(c) ? 'active' : '') + '" data-cat="' + c + '" aria-pressed="' + activeFilters.has(c) + '">' + marketLabel(c) + '</button>'
  ).join('');
  el.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => {
      const c = btn.dataset.cat;
      if (activeFilters.has(c)) activeFilters.delete(c); else activeFilters.add(c);
      saveFilters();
      renderShows(data);
      renderFilters(data);
    };
  });
}

function renderMissing(missingT1, missingT2, showIdx) {
  const coreT1 = missingT1.filter(m => !m.isDualMarket);
  const coreT2 = missingT2.filter(m => !m.isDualMarket);
  const cross = missingT1.filter(m => m.isDualMarket).concat(missingT2.filter(m => m.isDualMarket));
  const totalMissing = missingT1.length + missingT2.length;
  const coreMissing = coreT1.length + coreT2.length;

  if (totalMissing === 0) return '<div class="all-found">All T1/T2 outlets found</div>';

  const id = 'missing-' + showIdx;
  let html = '<div class="missing-section">';
  html += '<div class="missing-toggle" onclick="toggleMissing(\\'' + id + '\\')" role="button" tabindex="0" aria-expanded="false" aria-controls="' + id + '">';
  html += '<span class="chevron" id="chev-' + id + '">&#9654;</span> ';
  html += coreMissing + ' missing outlet' + (coreMissing !== 1 ? 's' : '');
  if (cross.length > 0) html += ' + ' + cross.length + ' cross-market';
  html += '</div>';
  html += '<div class="missing-body collapsed" id="' + id + '">';

  if (coreT1.length > 0) {
    html += '<div class="missing-group"><span class="missing-label missing-t1">T1:</span> ' + coreT1.map(m => esc(m.name)).join(', ') + '</div>';
  }
  if (coreT2.length > 0) {
    html += '<div class="missing-group"><span class="missing-label missing-t2">T2:</span> ' + coreT2.map(m => esc(m.name)).join(', ') + '</div>';
  }
  if (cross.length > 0) {
    html += '<div class="missing-group missing-cross"><span class="missing-label">Cross-market:</span> ' + cross.map(m => esc(m.name)).join(', ') + '</div>';
  }

  html += '</div></div>';
  return html;
}

function toggleMissing(id) {
  const el = document.getElementById(id);
  const chev = document.getElementById('chev-' + id);
  const header = el.previousElementSibling;
  if (el.classList.contains('collapsed')) {
    el.classList.remove('collapsed');
    el.style.maxHeight = el.scrollHeight + 'px';
    chev.classList.add('open');
    header.setAttribute('aria-expanded', 'true');
  } else {
    el.classList.add('collapsed');
    chev.classList.remove('open');
    header.setAttribute('aria-expanded', 'false');
  }
}

function renderShows(data) {
  document.getElementById('updated').textContent = 'Updated: ' + new Date(data.generatedAt).toLocaleString();
  const el = document.getElementById('shows');
  const filtered = data.shows.filter(s => activeFilters.has(s.category));
  if (!filtered.length) { el.innerHTML = '<div class="empty">No shows match current filters.</div>'; return; }
  el.innerHTML = filtered.map((s, idx) => {
    const score = s.siteScore != null ? s.siteScore : s.liveScore;
    const th = s.readiness.thresholds || {};
    const minR = th.minReviews || 12, minT1 = th.minT1 || 3, minT2 = th.minT2 || 3, minH = th.minHiConf || 8;
    function gate(v, req, label) {
      const ok = v >= req;
      return '<div class="gate"><span class="gate-icon ' + (ok?'gate-pass':'gate-fail') + '">' + (ok?'\\u2713':'\\u2717') + '</span>' + label + ': <b>' + v + '</b>/' + req + '</div>';
    }
    const drift = (s.scoreDrift != null && s.scoreDrift !== 0)
      ? '<div class="drift">Live score: ' + s.liveScore + ' (' + (s.scoreDrift>0?'+':'') + s.scoreDrift + ' drift \\u2014 rebuild needed)</div>'
      : (s.siteScore == null && s.liveScore != null ? '<div class="drift">Not yet on site \\u2014 rebuild needed</div>' : '');

    return '<div class="card">' +
      '<div class="show-header"><span class="show-title">' + esc(s.title) + '</span><span class="market-pill ' + marketClass(s.category) + '">' + marketLabel(s.category) + '</span></div>' +
      '<div class="show-meta">' + esc(s.type) + ' \\u00b7 ' + s.openingDate + ' \\u00b7 ' + s.status + '</div>' +
      '<div class="score-row"><span class="score ' + scoreClass(score) + '">' + (score != null ? score : '--') + '</span><span class="score-label">' + (s.siteScore != null ? 'site' : 'live') + ' score \\u00b7 ' + s.total + ' reviews</span></div>' +
      drift +
      '<div class="bar">' + (s.positive + s.mixed + s.negative > 0 ? '<div class="bar-pos" style="flex:' + s.positive + '"></div><div class="bar-mix" style="flex:' + s.mixed + '"></div><div class="bar-neg" style="flex:' + s.negative + '"></div>' : '') + '</div>' +
      '<div class="bar-legend">' + s.positive + ' positive \\u00b7 ' + s.mixed + ' mixed \\u00b7 ' + s.negative + ' negative</div>' +
      '<div class="tiers"><span class="tier-badge">T1: ' + s.t1 + '</span><span class="tier-badge">T2: ' + s.t2 + '</span><span class="tier-badge">T3: ' + s.t3 + '</span></div>' +
      '<div class="gates">' + gate(s.total, minR, 'Total') + gate(s.t1, minT1, 'T1') + gate(s.t2, minT2, 'T2') + gate(s.readiness.highConfidence, minH, 'Hi-Conf') + '</div>' +
      '<span class="ready-badge ' + (s.readiness.ready ? 'ready-yes' : 'ready-no') + '">' + (s.readiness.ready ? 'BROADCAST READY' : 'Not ready') + '</span>' +
      (!s.readiness.ready && s.readiness.reasons.length ? '<div class="ready-reasons">' + esc(s.readiness.reasons.join(', ')) + '</div>' : '') +
      '<div class="broadcast"><span class="bc-badge ' + bcClass(s.broadcast.state) + '">' + bcLabel(s.broadcast.state) + '</span><span>' + esc(s.broadcast.detail) + '</span></div>' +
      renderMissing(s.missingT1, s.missingT2, idx) +
    '</div>';
  }).join('');
}

async function fetchAndRender() {
  try {
    const r = await fetch('/opening-night-status.json?t=' + Date.now());
    if (r.ok) { _data = await r.json(); renderFilters(_data); renderShows(_data); }
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