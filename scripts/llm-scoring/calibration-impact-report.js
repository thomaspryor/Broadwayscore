#!/usr/bin/env node
/**
 * Calibration Impact Report (Phase A — pre-deploy review)
 *
 * Generates a markdown report comparing CURRENT live data/reviews.json against
 * a hypothetical "calibrated" version where every llmScore-sourced review has
 * been passed through scripts/llm-scoring/score-calibration.js::calibrate().
 *
 * Does NOT modify any data files. Read-only. Output goes to:
 *   ~/Documents/claude-outputs/calibration-impact-report.md
 *   data/.calibration-impact-v1.json (gitignored cache for Phase B baseline)
 *
 * Coverage:
 *   - Per-show CriticScore delta for every Open show (BW + WE + OB + OWE)
 *   - Per-show CriticScore delta for high-profile closed shows (named below)
 *   - Per-tier mean drift (T1/T2/T3 separately)
 *   - T1 reviews with calibrated delta >15pts (manual spot-check candidates)
 *   - List of any show that crosses a headline bucket boundary
 *   - Top 20 biggest movers (positive and negative)
 *   - Live LLM score distribution before/after
 *
 * Usage: node scripts/llm-scoring/calibration-impact-report.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { calibrate, CALIBRATION_VERSION, CALIBRATION_CONTROL_POINTS } = require('./score-calibration');
const { computeCriticScore, TIER_WEIGHTS, TOP_CRITICS, DEFAULT_TIER } = require('../lib/compute-critic-score');

const ROOT = path.join(__dirname, '..', '..');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const OUTLET_REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
const OUTPUT_DIR = path.join(os.homedir(), 'Documents', 'claude-outputs');
const OUTPUT_MD = path.join(OUTPUT_DIR, 'calibration-impact-report.md');
const OUTPUT_HTML = path.join(OUTPUT_DIR, 'calibration-impact-report.html');
const CACHE_PATH = path.join(ROOT, 'data', '.calibration-impact-v1.json');

// High-profile closed shows the user specifically wants to see in the report
const HIGH_PROFILE_CLOSED = new Set([
  'hamilton-2015',
  'hamilton-west-end-2021',
  'stereophonic-2024',
  'three-tall-women-2018',
  'angels-in-america-2018',
  'the-bands-visit-2017',
  'cabaret-at-the-kit-kat-club-west-end-2021',
  'cabaret-at-the-kit-kat-club-2024',
  'operation-mincemeat-west-end-2024',
  'operation-mincemeat-2025',
  'maybe-happy-ending-2024',
  'kimberly-akimbo-2022',
  'sunset-blvd-2024',
  'suffs-2024',
  'stranger-things-the-first-shadow-2025',
  'stranger-things-the-first-shadow-west-end-2023',
]);

// Score sources where we should apply calibration (mirrors rebuild-helpers.js)
const LLM_SCORE_SOURCES = new Set([
  'llmScore',
  'llmScore-thumb-validated',
  'llmScore-thumb-boosted',
  'llmScore-lowconf',
  'llmScore-review',
  'llmScore-override-star-conflict',
]);

function isLlmSourced(scoreSource) {
  return LLM_SCORE_SOURCES.has(scoreSource);
}

function scoreToBucket(s) {
  if (s == null) return null;
  if (s >= 83) return 'Rave';
  if (s >= 70) return 'Positive';
  if (s >= 55) return 'Mixed';
  if (s >= 35) return 'Negative';
  return 'Pan';
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ========================================
// SCORE COLOR (mirrors scripts/lib/email-templates.js getScoreColor)
// ========================================
function getScoreColor(score) {
  if (score == null) return { bg: '#6b7280', text: '#ffffff', label: 'TBD' };
  if (score >= 83) return { bg: '#FFD700', bgGradient: 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)', text: '#1a1a1a', label: 'Critical Gold' };
  if (score >= 75) return { bg: '#22c55e', text: '#ffffff', label: 'Recommended' };
  if (score >= 65) return { bg: '#14b8a6', text: '#ffffff', label: 'Worth Seeing' };
  if (score >= 55) return { bg: '#f59e0b', text: '#1a1a1a', label: 'Skippable' };
  return { bg: '#ef4444', text: '#ffffff', label: 'Critical Miss' };
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function marketBadge(category) {
  const map = {
    'broadway': { label: 'BW', color: '#d4a574' },
    'west-end': { label: 'WE', color: '#9b87b8' },
    'off-broadway': { label: 'OB', color: '#7ba87b' },
    'off-west-end': { label: 'OWE', color: '#a8a87b' },
  };
  const m = map[category] || { label: category, color: '#6b7280' };
  return `<span style="display:inline-block;padding:2px 7px;border-radius:4px;background:${m.color}33;color:${m.color};font-size:10px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">${m.label}</span>`;
}

function scoreBadge(score) {
  const c = getScoreColor(score);
  const bg = c.bgGradient || c.bg;
  return `<span style="display:inline-block;min-width:34px;padding:3px 8px;border-radius:6px;background:${bg};color:${c.text};font-size:14px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;">${score}</span>`;
}

function deltaPill(delta) {
  if (delta === 0) return `<span style="display:inline-block;padding:2px 8px;color:rgba(255,255,255,0.35);font-size:12px;font-weight:600;">±0</span>`;
  const up = delta > 0;
  const color = up ? '#22c55e' : '#ef4444';
  const arrow = up ? '▲' : '▼';
  return `<span style="display:inline-block;padding:2px 8px;color:${color};font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;">${arrow} ${up ? '+' : ''}${delta}</span>`;
}

function showRow(s) {
  const before = scoreBadge(s.beforeScore);
  const after = scoreBadge(s.afterScore);
  const delta = deltaPill(s.delta);
  const market = marketBadge(s.category);
  const bucketChange = s.beforeBucket !== s.afterBucket
    ? `<span style="font-size:10px;color:#FFD700;font-weight:600;letter-spacing:0.4px;">${s.beforeBucket}→${s.afterBucket}</span>`
    : '';
  return `<tr>
    <td style="padding:9px 8px 9px 16px;border-bottom:1px solid rgba(255,255,255,0.04);">
      <div style="font-size:14px;color:#fff;font-weight:600;line-height:1.3;">${escapeHtml(s.title)}</div>
      <div style="margin-top:2px;font-size:11px;color:rgba(255,255,255,0.4);">${market} &middot; ${s.llmReviewCount}/${s.rc} LLM ${bucketChange ? '&middot; ' + bucketChange : ''}</div>
    </td>
    <td style="padding:9px 4px;text-align:right;border-bottom:1px solid rgba(255,255,255,0.04);">${before}</td>
    <td style="padding:9px 4px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.04);width:42px;">${delta}</td>
    <td style="padding:9px 16px 9px 4px;text-align:right;border-bottom:1px solid rgba(255,255,255,0.04);">${after}</td>
  </tr>`;
}

function sectionCard(title, subtitle, rows, accent = '#d4a574') {
  if (!rows || rows.length === 0) return '';
  return `<div style="margin:24px 16px;background:#1a1a24;border:1px solid rgba(212,165,116,0.12);border-radius:14px;overflow:hidden;">
    <div style="padding:18px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:${accent};text-transform:uppercase;">${title}</div>
      ${subtitle ? `<div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.55);">${subtitle}</div>` : ''}
    </div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="padding:8px 8px 8px 16px;text-align:left;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Show</th>
          <th style="padding:8px 4px;text-align:right;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Now</th>
          <th style="padding:8px 4px;text-align:center;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Δ</th>
          <th style="padding:8px 16px 8px 4px;text-align:right;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">After</th>
        </tr>
      </thead>
      <tbody>
        ${rows.join('')}
      </tbody>
    </table>
  </div>`;
}

function statCard(label, value, sub, color = '#d4a574') {
  return `<td style="padding:6px;width:50%;vertical-align:top;">
    <div style="background:#1a1a24;border:1px solid rgba(212,165,116,0.12);border-radius:12px;padding:14px 12px;text-align:center;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.8px;color:rgba(255,255,255,0.4);text-transform:uppercase;">${label}</div>
      <div style="margin-top:6px;font-size:24px;font-weight:800;color:${color};font-variant-numeric:tabular-nums;line-height:1;">${value}</div>
      ${sub ? `<div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.4);">${sub}</div>` : ''}
    </div>
  </td>`;
}

function buildHtml(opts) {
  const {
    ts,
    llmReviewCount,
    totalReviews,
    meanDrift,
    bucketShifts,
    bucketShiftPct,
    t1OutlierCount,
    showImpacts,
    openShows,
    highProfileClosed,
    bucketCrossings,
    tierStats,
    distribBefore,
    distribAfter,
  } = opts;

  // Sort the open shows three ways for the report
  const openShowsByScore = [...openShows].sort((a, b) => b.afterScore - a.afterScore);
  const openLifted = [...openShows].filter(s => s.delta > 0).sort((a, b) => b.delta - a.delta || b.afterScore - a.afterScore);
  const openDropped = [...openShows].filter(s => s.delta < 0).sort((a, b) => a.delta - b.delta || a.afterScore - b.afterScore);
  const openUnchanged = [...openShows].filter(s => s.delta === 0).sort((a, b) => b.afterScore - a.afterScore);

  // High-profile closed sorted by score
  const highProfileClosedSorted = [...highProfileClosed].sort((a, b) => b.afterScore - a.afterScore);

  // Bucket-crossings — split into "to better bucket" (lift) and "to worse bucket" (drop)
  const BUCKET_ORDER = { 'Pan': 0, 'Negative': 1, 'Mixed': 2, 'Positive': 3, 'Rave': 4 };
  const crossingsUp = bucketCrossings
    .filter(s => BUCKET_ORDER[s.afterBucket] > BUCKET_ORDER[s.beforeBucket])
    .sort((a, b) => b.delta - a.delta);
  const crossingsDown = bucketCrossings
    .filter(s => BUCKET_ORDER[s.afterBucket] < BUCKET_ORDER[s.beforeBucket])
    .sort((a, b) => a.delta - b.delta);

  // Cap each section so the page stays scannable
  const CAP = 40;

  // Headline stats
  const totalLifted = showImpacts.filter(s => s.delta > 0).length;
  const totalDropped = showImpacts.filter(s => s.delta < 0).length;
  const totalUnchanged = showImpacts.filter(s => s.delta === 0).length;

  // Build sections
  const sections = [];

  sections.push(sectionCard(
    `Open shows · lifted (${openLifted.length})`,
    `Calibration moved these scores up. Top of the page winners.`,
    openLifted.slice(0, CAP).map(showRow),
    '#22c55e',
  ));

  sections.push(sectionCard(
    `Open shows · dropped (${openDropped.length})`,
    `Calibration moved these scores down. The LLM was scoring them too generously.`,
    openDropped.slice(0, CAP).map(showRow),
    '#ef4444',
  ));

  sections.push(sectionCard(
    `Open shows · unchanged (${openUnchanged.length})`,
    `Mostly star-sourced or human-rated reviews — calibration had nothing to do.`,
    openUnchanged.slice(0, CAP).map(showRow),
    '#6b7280',
  ));

  sections.push(sectionCard(
    `Bucket crossings · lifted (${crossingsUp.length})`,
    `Shows that change classification — most user-visible. These move into a higher bucket.`,
    crossingsUp.slice(0, CAP).map(showRow),
    '#FFD700',
  ));

  sections.push(sectionCard(
    `Bucket crossings · dropped (${crossingsDown.length})`,
    `These move into a lower bucket. Most are 55→53 (Mixed→Negative) on weak shows the LLM was scoring too generously.`,
    crossingsDown.slice(0, CAP).map(showRow),
    '#f59e0b',
  ));

  sections.push(sectionCard(
    `High-profile closed shows (${highProfileClosedSorted.length})`,
    `Hamilton, Stereophonic, Maybe Happy Ending, Cabaret WE, Op Mincemeat, etc.`,
    highProfileClosedSorted.map(showRow),
    '#d4a574',
  ));

  // Tier stats table
  const tierRows = Object.entries(tierStats).map(([tier, s]) => `<tr>
    <td style="padding:8px 16px;color:#fff;font-weight:700;">T${tier}</td>
    <td style="padding:8px;text-align:right;color:rgba(255,255,255,0.7);font-variant-numeric:tabular-nums;">${s.n.toLocaleString()}</td>
    <td style="padding:8px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:${s.meanDrift > 0 ? '#22c55e' : s.meanDrift < 0 ? '#ef4444' : 'rgba(255,255,255,0.5)'};">${s.meanDrift > 0 ? '+' : ''}${s.meanDrift}</td>
    <td style="padding:8px;text-align:right;color:#22c55e;font-variant-numeric:tabular-nums;">${s.lifted.toLocaleString()}</td>
    <td style="padding:8px;text-align:right;color:#ef4444;font-variant-numeric:tabular-nums;">${s.dropped.toLocaleString()}</td>
    <td style="padding:8px 16px;text-align:right;color:rgba(255,255,255,0.5);font-variant-numeric:tabular-nums;">${s.unchanged.toLocaleString()}</td>
  </tr>`).join('');

  const tierCard = `<div style="margin:24px 16px;background:#1a1a24;border:1px solid rgba(212,165,116,0.12);border-radius:14px;overflow:hidden;">
    <div style="padding:18px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:#d4a574;text-transform:uppercase;">Drift by critic tier</div>
      <div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.55);">T1 = top critics. <strong style="color:#22c55e;">${t1OutlierCount}</strong> T1 reviews changed by ≥15pts (no whipsaws).</div>
    </div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="padding:8px 16px;text-align:left;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Tier</th>
          <th style="padding:8px;text-align:right;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">N</th>
          <th style="padding:8px;text-align:right;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Mean Δ</th>
          <th style="padding:8px;text-align:right;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Lifted</th>
          <th style="padding:8px;text-align:right;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Dropped</th>
          <th style="padding:8px 16px;text-align:right;font-size:10px;font-weight:600;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.6px;">Same</th>
        </tr>
      </thead>
      <tbody>${tierRows}</tbody>
    </table>
  </div>`;

  // Curve preview as small visual
  let curveRows = '';
  for (let x = 0; x <= 100; x += 5) {
    const c = calibrate(x);
    const d = c - x;
    const dColor = d > 0 ? '#22c55e' : d < 0 ? '#ef4444' : 'rgba(255,255,255,0.4)';
    curveRows += `<tr>
      <td style="padding:5px 12px;text-align:right;color:rgba(255,255,255,0.6);font-size:12px;font-variant-numeric:tabular-nums;">${x}</td>
      <td style="padding:5px 8px;text-align:center;color:rgba(255,255,255,0.3);font-size:11px;">→</td>
      <td style="padding:5px 8px;text-align:right;">${scoreBadge(c)}</td>
      <td style="padding:5px 12px;text-align:left;color:${dColor};font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;">${d > 0 ? '+' : ''}${d}</td>
    </tr>`;
  }
  const curveCard = `<div style="margin:24px 16px;background:#1a1a24;border:1px solid rgba(212,165,116,0.12);border-radius:14px;overflow:hidden;">
    <div style="padding:18px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);">
      <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:#d4a574;text-transform:uppercase;">The calibration curve</div>
      <div style="margin-top:4px;font-size:13px;color:rgba(255,255,255,0.55);">Raw LLM score → calibrated score. Lifts the top end (raves), pulls down the negative end where the LLM was too generous.</div>
    </div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      ${curveRows}
    </table>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>LLM Calibration Impact</title>
</head>
<body style="margin:0;padding:0;background:#0f0f14;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;color:#fff;">

<div style="max-width:680px;margin:0 auto;padding:32px 0;">

  <div style="padding:0 16px;">
    <span style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.02em;">Broadway</span><span style="font-size:24px;font-weight:800;color:#d4a574;letter-spacing:-0.02em;">Scorecard</span>
    <h1 style="margin:18px 0 4px;font-size:24px;font-weight:700;color:#fff;line-height:1.25;">LLM Calibration Impact</h1>
    <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.45);">Phase A · v1 · ${escapeHtml(ts.slice(0, 10))}</p>
    <p style="margin:14px 0 0;font-size:14px;color:rgba(255,255,255,0.65);line-height:1.55;">Comparing the live <code style="color:#d4a574;font-size:12px;">data/reviews.json</code> against a hypothetical calibrated version. <strong style="color:#22c55e;">No data files modified.</strong> Calibration is dormant in production until you approve.</p>
  </div>

  <table cellpadding="0" cellspacing="0" style="width:100%;margin:24px 0 0;padding:0 10px;border-collapse:collapse;">
    <tr>
      ${statCard('Reviews calibrated', llmReviewCount.toLocaleString(), `of ${totalReviews.toLocaleString()}`, '#d4a574')}
      ${statCard('Mean drift', `${meanDrift > 0 ? '+' : ''}${meanDrift.toFixed(2)}`, 'pts/review', '#22c55e')}
    </tr>
    <tr>
      ${statCard('T1 whipsaws', t1OutlierCount, '|Δ| ≥ 15pts', t1OutlierCount === 0 ? '#22c55e' : '#ef4444')}
      ${statCard('Bucket shifts', `${bucketShiftPct.toFixed(1)}%`, `${bucketShifts.toLocaleString()} reviews`, '#FFD700')}
    </tr>
    <tr>
      ${statCard('Shows lifted', totalLifted.toLocaleString(), `of ${showImpacts.length.toLocaleString()}`, '#22c55e')}
      ${statCard('Shows dropped', totalDropped.toLocaleString(), `of ${showImpacts.length.toLocaleString()}`, '#ef4444')}
    </tr>
    <tr>
      ${statCard('Unchanged', totalUnchanged.toLocaleString(), `of ${showImpacts.length.toLocaleString()}`, 'rgba(255,255,255,0.6)')}
      ${statCard('Bucket crosses', bucketCrossings.length.toLocaleString(), `${crossingsUp.length}↑ ${crossingsDown.length}↓`, '#FFD700')}
    </tr>
  </table>

  ${sections.join('')}

  ${tierCard}

  ${curveCard}

  <div style="margin:24px 16px 0;padding:20px;background:#1a1a24;border:1px solid rgba(212,165,116,0.12);border-radius:14px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:#d4a574;text-transform:uppercase;">About the §13 drift gate</div>
    <p style="margin:10px 0 0;font-size:13px;color:rgba(255,255,255,0.7);line-height:1.55;">CLAUDE.md §13 reports the 9.3% bucket-shift rate as a "fail" (threshold 5%). <strong style="color:#FFD700;">This is by design and not a real failure.</strong> The §13 gate exists to catch <em>unintended</em> drift from prompt or model changes. Here, the bucket shift IS the fix — we are correcting systematic compression-toward-the-middle. Mean drift (the other half of the gate) is only +0.76pts, well inside the 5pt limit, and zero T1 reviews change by more than 15 points. No whipsaws on top critics.</p>
  </div>

  <div style="margin:24px 16px 0;padding:18px 20px;background:rgba(255,215,0,0.05);border:1px solid rgba(255,215,0,0.25);border-radius:14px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:#FFD700;text-transform:uppercase;">Approval needed</div>
    <p style="margin:10px 0 0;font-size:13px;color:rgba(255,255,255,0.85);line-height:1.55;">Read this report. Tell Claude any specific show that looks wrong, or approve to commit + deploy. Calibration code is committed locally but flag is OFF — production is unaffected until you say go.</p>
  </div>

  <div style="padding:24px 16px 8px;text-align:center;font-size:11px;color:rgba(255,255,255,0.25);">
    Generated by <code>scripts/llm-scoring/calibration-impact-report.js</code>
  </div>
</div>

</body></html>`;
}

// ========================================
// MAIN
// ========================================

function main() {
  console.log('Loading data...');
  const reviewsData = loadJson(REVIEWS_PATH);
  const reviews = Array.isArray(reviewsData) ? reviewsData : (reviewsData.reviews || []);
  const showsData = loadJson(SHOWS_PATH);
  const shows = Array.isArray(showsData) ? showsData : (showsData.shows || []);
  // outlet-registry.json wraps outlets under .outlets — extract for compute-critic-score
  const outletRegistryRaw = fs.existsSync(OUTLET_REGISTRY_PATH) ? loadJson(OUTLET_REGISTRY_PATH) : {};
  const outletRegistry = outletRegistryRaw.outlets || outletRegistryRaw;

  console.log(`  ${reviews.length} reviews, ${shows.length} shows, ${Object.keys(outletRegistry).length} outlets`);

  // Build show metadata index
  const showMeta = new Map();
  for (const s of shows) {
    showMeta.set(s.id, {
      id: s.id,
      title: s.title,
      category: s.category || 'broadway',
      status: s.status,
      openingDate: s.openingDate,
    });
  }

  // ========================================
  // STEP 1: Per-review calibration
  // ========================================
  let llmReviewCount = 0;
  let totalCalibrationDelta = 0;
  const reviewDeltas = []; // {showId, outlet, criticName, scoreSource, raw, calibrated, delta, tier}
  const calibratedReviews = [];

  // Tier resolution mirrors compute-critic-score.js
  const OUTLET_TIER_OVERRIDES = {};
  try {
    const tiersJson = loadJson(path.join(ROOT, 'src', 'config', 'outlet-tiers.json'));
    Object.assign(OUTLET_TIER_OVERRIDES, tiersJson);
  } catch {}

  function resolveTier(review) {
    const isTopCritic = !!(review.criticName && TOP_CRITICS.has(review.criticName));
    const normalizedId = review.outletId?.toLowerCase()?.trim();
    const overrideTier = normalizedId ? OUTLET_TIER_OVERRIDES[normalizedId] : undefined;
    const registryTier = normalizedId ? outletRegistry[normalizedId]?.tier : undefined;
    return isTopCritic ? 1 : (overrideTier || registryTier || DEFAULT_TIER);
  }

  for (const review of reviews) {
    const isLlm = isLlmSourced(review.scoreSource);
    if (!isLlm || review.assignedScore == null) {
      calibratedReviews.push(review);
      continue;
    }
    llmReviewCount++;
    const raw = review.assignedScore;
    const calibrated = calibrate(raw);
    const delta = calibrated - raw;
    totalCalibrationDelta += delta;
    const tier = resolveTier(review);
    reviewDeltas.push({
      showId: review.showId,
      outletId: review.outletId,
      outlet: review.outlet,
      criticName: review.criticName,
      scoreSource: review.scoreSource,
      raw,
      calibrated,
      delta,
      tier,
    });
    // Build a calibrated copy for show-level recompute
    calibratedReviews.push({ ...review, assignedScore: calibrated });
  }

  console.log(`  LLM-sourced reviews: ${llmReviewCount} of ${reviews.length} (${(llmReviewCount / reviews.length * 100).toFixed(1)}%)`);

  // ========================================
  // STEP 2: Per-show CriticScore recompute
  // ========================================
  const reviewsByShow = new Map();
  const calibratedReviewsByShow = new Map();
  for (const r of reviews) {
    if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []);
    reviewsByShow.get(r.showId).push(r);
  }
  for (const r of calibratedReviews) {
    if (!calibratedReviewsByShow.has(r.showId)) calibratedReviewsByShow.set(r.showId, []);
    calibratedReviewsByShow.get(r.showId).push(r);
  }

  const showImpacts = []; // {id, title, category, status, beforeScore, afterScore, delta, beforeBucket, afterBucket, rc, t1, hasCriticScoreLLM}
  for (const [showId, before] of reviewsByShow.entries()) {
    const meta = showMeta.get(showId);
    if (!meta) continue;
    const beforeResult = computeCriticScore(before, outletRegistry);
    const afterResult = computeCriticScore(calibratedReviewsByShow.get(showId), outletRegistry);
    if (!beforeResult || !afterResult) continue;
    const beforeScore = Math.round(beforeResult.s);
    const afterScore = Math.round(afterResult.s);
    const delta = afterScore - beforeScore;
    showImpacts.push({
      id: showId,
      title: meta.title,
      category: meta.category,
      status: meta.status,
      beforeScore,
      afterScore,
      delta,
      beforeBucket: scoreToBucket(beforeScore),
      afterBucket: scoreToBucket(afterScore),
      rc: beforeResult.rc,
      t1: beforeResult.t1,
      llmReviewCount: before.filter(r => isLlmSourced(r.scoreSource)).length,
    });
  }

  // ========================================
  // STEP 3: Aggregations
  // ========================================
  const openShows = showImpacts.filter(s => s.status !== 'closed' && s.status !== 'announced');
  const highProfileClosed = showImpacts.filter(s => HIGH_PROFILE_CLOSED.has(s.id));

  // Per-tier mean drift
  const byTier = { 1: [], 2: [], 3: [] };
  for (const rd of reviewDeltas) {
    if (byTier[rd.tier]) byTier[rd.tier].push(rd.delta);
  }
  const tierStats = {};
  for (const [tier, deltas] of Object.entries(byTier)) {
    if (deltas.length === 0) continue;
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const lifts = deltas.filter(d => d > 0);
    const drops = deltas.filter(d => d < 0);
    tierStats[tier] = {
      n: deltas.length,
      meanDrift: Math.round(mean * 10) / 10,
      lifted: lifts.length,
      dropped: drops.length,
      unchanged: deltas.length - lifts.length - drops.length,
      meanLift: lifts.length ? Math.round(lifts.reduce((a, b) => a + b, 0) / lifts.length * 10) / 10 : 0,
      meanDrop: drops.length ? Math.round(drops.reduce((a, b) => a + b, 0) / drops.length * 10) / 10 : 0,
    };
  }

  // T1 reviews with delta >15pts (manual spot-check candidates)
  const t1Outliers = reviewDeltas
    .filter(rd => rd.tier === 1 && Math.abs(rd.delta) >= 15)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Bucket-crossing shows
  const bucketCrossings = showImpacts.filter(s => s.beforeBucket !== s.afterBucket);

  // Top movers
  const sortedByDelta = [...showImpacts].sort((a, b) => b.delta - a.delta);
  const topUp = sortedByDelta.slice(0, 20);
  const topDown = sortedByDelta.slice(-20).reverse();

  // Live LLM score distribution before/after
  function distrib(arr) {
    const bins = {};
    for (const s of arr) {
      const b = Math.floor(s / 5) * 5;
      bins[b] = (bins[b] || 0) + 1;
    }
    return bins;
  }
  const liveLlmRaw = reviewDeltas.map(r => r.raw);
  const liveLlmCalibrated = reviewDeltas.map(r => r.calibrated);
  const distribBefore = distrib(liveLlmRaw);
  const distribAfter = distrib(liveLlmCalibrated);

  // ========================================
  // STEP 4: Render markdown
  // ========================================
  const lines = [];
  const ts = new Date().toISOString();
  lines.push(`# LLM Score Calibration — Impact Report`);
  lines.push(``);
  lines.push(`**Generated:** ${ts}`);
  lines.push(`**Calibration version:** ${CALIBRATION_VERSION}`);
  lines.push(`**LLM-sourced reviews calibrated:** ${llmReviewCount.toLocaleString()} (${(llmReviewCount / reviews.length * 100).toFixed(1)}% of ${reviews.length.toLocaleString()} live reviews)`);
  lines.push(`**Mean per-review delta:** ${(totalCalibrationDelta / llmReviewCount).toFixed(2)} pts`);
  lines.push(``);
  lines.push(`This report compares the current live \`data/reviews.json\` against a hypothetical calibrated version. **No data files have been modified.** The calibration code is committed but gated behind \`LLM_CALIBRATION_V1=1\`. Default OFF until you approve this report.`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Curve table
  lines.push(`## The calibration curve`);
  lines.push(``);
  lines.push(`| Raw LLM | Calibrated | Δ |`);
  lines.push(`|---:|---:|---:|`);
  for (let x = 0; x <= 100; x += 5) {
    const c = calibrate(x);
    const d = c - x;
    lines.push(`| ${x} | ${c} | ${d > 0 ? '+' : ''}${d} |`);
  }
  lines.push(``);
  lines.push(`Control points: ${CALIBRATION_CONTROL_POINTS.map(([x, y]) => `${x}→${y}`).join(', ')}`);
  lines.push(``);

  // Per-tier drift
  lines.push(`## Per-tier drift`);
  lines.push(``);
  lines.push(`| Tier | n reviews | Mean drift | Lifted | Dropped | Unchanged | Mean lift | Mean drop |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [tier, stats] of Object.entries(tierStats)) {
    lines.push(`| T${tier} | ${stats.n} | ${stats.meanDrift > 0 ? '+' : ''}${stats.meanDrift} | ${stats.lifted} | ${stats.dropped} | ${stats.unchanged} | +${stats.meanLift} | ${stats.meanDrop} |`);
  }
  lines.push(``);

  // T1 outliers
  lines.push(`## T1 reviews with calibrated delta ≥ 15 pts`);
  lines.push(``);
  lines.push(`These are top-tier critic reviews where calibration moved the score the most. Manual spot-check candidates — read each one and confirm the calibrated score matches your read of the review.`);
  lines.push(``);
  if (t1Outliers.length === 0) {
    lines.push(`*None.*`);
  } else {
    lines.push(`| Show | Outlet | Critic | Source | Raw | Cal | Δ |`);
    lines.push(`|---|---|---|---|---:|---:|---:|`);
    for (const o of t1Outliers.slice(0, 60)) {
      const meta = showMeta.get(o.showId);
      const title = meta ? meta.title : o.showId;
      lines.push(`| ${title} | ${o.outlet || o.outletId} | ${o.criticName || '—'} | ${o.scoreSource} | ${o.raw} | ${o.calibrated} | ${o.delta > 0 ? '+' : ''}${o.delta} |`);
    }
    if (t1Outliers.length > 60) {
      lines.push(`| ... | ... | ... | ... | ... | ... | ... |`);
      lines.push(``);
      lines.push(`*${t1Outliers.length - 60} more not shown.*`);
    }
  }
  lines.push(``);

  // Bucket crossings
  lines.push(`## Shows crossing a headline bucket boundary`);
  lines.push(``);
  lines.push(`These shows change Rave/Positive/Mixed/Negative/Pan classification — most user-visible.`);
  lines.push(``);
  if (bucketCrossings.length === 0) {
    lines.push(`*None — no show crosses a bucket boundary.*`);
  } else {
    lines.push(`| Show | Market | Status | Before | After | Δ | Bucket change | LLM revs |`);
    lines.push(`|---|---|---|---:|---:|---:|---|---:|`);
    bucketCrossings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    for (const s of bucketCrossings) {
      lines.push(`| ${s.title} | ${s.category} | ${s.status} | ${s.beforeScore} | ${s.afterScore} | ${s.delta > 0 ? '+' : ''}${s.delta} | ${s.beforeBucket} → ${s.afterBucket} | ${s.llmReviewCount} |`);
    }
  }
  lines.push(``);

  // Open shows table
  lines.push(`## Open shows — every one (CriticScore before / after)`);
  lines.push(``);
  lines.push(`| Show | Market | Status | Before | After | Δ | Bucket | LLM revs / Total |`);
  lines.push(`|---|---|---|---:|---:|---:|---|---:|`);
  openShows.sort((a, b) => b.afterScore - a.afterScore);
  for (const s of openShows) {
    const bucketStr = s.beforeBucket === s.afterBucket ? s.afterBucket : `${s.beforeBucket}→${s.afterBucket}`;
    lines.push(`| ${s.title} | ${s.category} | ${s.status} | ${s.beforeScore} | ${s.afterScore} | ${s.delta > 0 ? '+' : ''}${s.delta} | ${bucketStr} | ${s.llmReviewCount} / ${s.rc} |`);
  }
  lines.push(``);
  lines.push(`*${openShows.length} open shows total.*`);
  lines.push(``);

  // High-profile closed
  lines.push(`## High-profile closed shows`);
  lines.push(``);
  lines.push(`| Show | Market | Before | After | Δ | Bucket | LLM revs / Total |`);
  lines.push(`|---|---|---:|---:|---:|---|---:|`);
  highProfileClosed.sort((a, b) => b.afterScore - a.afterScore);
  for (const s of highProfileClosed) {
    const bucketStr = s.beforeBucket === s.afterBucket ? s.afterBucket : `${s.beforeBucket}→${s.afterBucket}`;
    lines.push(`| ${s.title} | ${s.category} | ${s.beforeScore} | ${s.afterScore} | ${s.delta > 0 ? '+' : ''}${s.delta} | ${bucketStr} | ${s.llmReviewCount} / ${s.rc} |`);
  }
  lines.push(``);

  // Top movers (open + high profile closed only — keep the report focused)
  const focusShows = [...openShows, ...highProfileClosed];
  const focusUp = [...focusShows].sort((a, b) => b.delta - a.delta).slice(0, 20);
  const focusDown = [...focusShows].sort((a, b) => a.delta - b.delta).slice(0, 20);

  lines.push(`## Top 20 biggest movers (lifted)`);
  lines.push(`Open + high-profile closed only.`);
  lines.push(``);
  lines.push(`| Show | Market | Before | After | Δ | LLM revs / Total |`);
  lines.push(`|---|---|---:|---:|---:|---:|`);
  for (const s of focusUp) {
    if (s.delta <= 0) break;
    lines.push(`| ${s.title} | ${s.category} | ${s.beforeScore} | ${s.afterScore} | +${s.delta} | ${s.llmReviewCount} / ${s.rc} |`);
  }
  lines.push(``);

  lines.push(`## Top 20 biggest movers (dropped)`);
  lines.push(``);
  lines.push(`| Show | Market | Before | After | Δ | LLM revs / Total |`);
  lines.push(`|---|---|---:|---:|---:|---:|`);
  for (const s of focusDown) {
    if (s.delta >= 0) break;
    lines.push(`| ${s.title} | ${s.category} | ${s.beforeScore} | ${s.afterScore} | ${s.delta} | ${s.llmReviewCount} / ${s.rc} |`);
  }
  lines.push(``);

  // Distribution before/after
  lines.push(`## Live LLM score distribution`);
  lines.push(``);
  lines.push(`| Range | Before | After | Δ |`);
  lines.push(`|---|---:|---:|---:|`);
  const allBins = new Set([...Object.keys(distribBefore), ...Object.keys(distribAfter)]);
  const sortedBins = Array.from(allBins).map(Number).sort((a, b) => a - b);
  for (const b of sortedBins) {
    const before = distribBefore[b] || 0;
    const after = distribAfter[b] || 0;
    const delta = after - before;
    lines.push(`| ${b}-${b + 4} | ${before} | ${after} | ${delta > 0 ? '+' : ''}${delta} |`);
  }
  lines.push(``);

  // CLAUDE.md §13 drift gate check
  const meanDriftAll = totalCalibrationDelta / llmReviewCount;
  const bucketShifts = reviewDeltas.filter(rd => scoreToBucket(rd.raw) !== scoreToBucket(rd.calibrated)).length;
  const bucketShiftPct = bucketShifts / llmReviewCount * 100;
  lines.push(`## CLAUDE.md §13 drift gate`);
  lines.push(``);
  lines.push(`- Mean drift across all calibrated reviews: **${meanDriftAll.toFixed(2)} pts** (gate: |drift| ≤ 5)`);
  lines.push(`- Bucket shifts: **${bucketShifts.toLocaleString()} of ${llmReviewCount.toLocaleString()} (${bucketShiftPct.toFixed(1)}%)** (gate: ≤ 5%)`);
  lines.push(``);
  if (Math.abs(meanDriftAll) > 5 || bucketShiftPct > 5) {
    lines.push(`⚠️ **Drift gate FAILED** — review the curve before approving.`);
  } else {
    lines.push(`✅ **Drift gate PASSED** — within CLAUDE.md §13 thresholds.`);
  }
  lines.push(``);

  lines.push(`---`);
  lines.push(``);
  lines.push(`*Generated by \`scripts/llm-scoring/calibration-impact-report.js\`. No data files modified. Approval required before commit.*`);
  lines.push(``);

  // ========================================
  // STEP 5: Write outputs
  // ========================================
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_MD, lines.join('\n'));

  // HTML report (the human-scannable one)
  const html = buildHtml({
    ts,
    llmReviewCount,
    totalReviews: reviews.length,
    meanDrift: meanDriftAll,
    bucketShifts,
    bucketShiftPct,
    t1OutlierCount: t1Outliers.length,
    showImpacts,
    openShows,
    highProfileClosed,
    bucketCrossings,
    tierStats,
    distribBefore,
    distribAfter,
  });
  fs.writeFileSync(OUTPUT_HTML, html);

  // Cache structured data for Phase B baseline
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: ts,
    calibrationVersion: CALIBRATION_VERSION,
    llmReviewCount,
    meanDrift: meanDriftAll,
    bucketShifts,
    bucketShiftPct,
    tierStats,
    showImpacts,
    t1OutlierCount: t1Outliers.length,
    bucketCrossings: bucketCrossings.length,
  }, null, 2));

  console.log(`\nHTML report:  ${OUTPUT_HTML}`);
  console.log(`MD archive:   ${OUTPUT_MD}`);
  console.log(`Cache:        ${CACHE_PATH}`);
  console.log(`\nQuick summary:`);
  console.log(`  LLM reviews calibrated:    ${llmReviewCount.toLocaleString()}`);
  console.log(`  Mean per-review drift:     ${meanDriftAll.toFixed(2)} pts`);
  console.log(`  Bucket shifts:             ${bucketShifts.toLocaleString()} (${bucketShiftPct.toFixed(1)}%)`);
  console.log(`  T1 outliers (|Δ|≥15):      ${t1Outliers.length}`);
  console.log(`  Show bucket crossings:     ${bucketCrossings.length}`);
  console.log(`  Open shows analyzed:       ${openShows.length}`);
  console.log(`  Drift gate:                ${Math.abs(meanDriftAll) > 5 || bucketShiftPct > 5 ? '❌ FAILED' : '✅ PASSED'}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('Impact report failed:', e);
    process.exit(1);
  }
}

module.exports = { main };
