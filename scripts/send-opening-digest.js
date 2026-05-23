#!/usr/bin/env node
/**
 * send-opening-digest.js
 *
 * Daily transactional digest email sent to the site owner. Covers:
 *
 *   UPCOMING — shows opening today, tomorrow, rest of the week
 *     Per show: market, date, poster, revival/original, importance,
 *     expected review count (from predict-review-count.js cohort medians)
 *
 *   RECENT — shows opened in the last 7 days
 *     Per show: review count so far, critic score, qualifies-for-published flag,
 *     audience grade + count, Resend broadcast sent status
 *
 * Sends as a single transactional email via Resend — never broadcast.
 *
 * Usage:
 *   node scripts/send-opening-digest.js                       # Send to default recipient
 *   node scripts/send-opening-digest.js --send-to=EMAIL       # Override recipient
 *   node scripts/send-opening-digest.js --dry-run             # Print HTML to stdout, don't send
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { predictReviewCount } = require('./predict-review-count');
const { getTier } = require('./lib/outlet-tiers');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_RECIPIENT = 'thomas.pryor@gmail.com';
const FROM_EMAIL = 'updates@broadwayscorecard.com';
const FROM_NAME = 'Broadway Scorecard Digest';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const AUDIENCE_PATH = path.join(DATA_DIR, 'audience-buzz.json');
const SENT_PATH = path.join(DATA_DIR, 'opening-night-sent.json');

const SITE_URL = 'https://broadwayscorecard.com';

// Publish-score thresholds (mirror send-opening-night-broadcast.js)
function publishThresholds(market) {
  const isLondon = market === 'west-end' || market === 'off-west-end';
  return {
    minReviews: isLondon ? 8 : 12,
    minT1: 3,
    minT2: isLondon ? 2 : 3,
    minHighConf: isLondon ? 6 : 8,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const SEND_TO = (args.find(a => a.startsWith('--send-to=')) || '').split('=')[1] || DEFAULT_RECIPIENT;
const DRY_RUN = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJSON(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDays(d, n) {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function formatHumanDate(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function getMarket(show) {
  return show.category || show.market || 'broadway';
}

function isImportantMarket(market) {
  return market === 'broadway' || market === 'west-end';
}

function marketLabel(market) {
  return {
    'broadway': 'Broadway',
    'west-end': 'West End',
    'off-broadway': 'Off-Broadway',
    'off-west-end': 'Off-West-End',
    'opera': 'Opera',
  }[market] || market;
}

function showUrl(show) {
  return `${SITE_URL}/show/${show.slug || show.id}`;
}

function posterUrl(show) {
  const img = show.images && (show.images.poster || show.images.thumbnail || show.images.hero);
  if (!img) return null;
  return img.startsWith('http') ? img : `${SITE_URL}${img}`;
}

function isBroadcastSent(sentData, market, showId) {
  const sent = sentData?.shows || {};
  return !!(sent[showId]?.completed || sent[`${market}:${showId}`]?.completed);
}

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------

function buildShowReviewMap(reviews) {
  const map = new Map();
  for (const r of reviews) {
    if (!r.showId) continue;
    if (!map.has(r.showId)) map.set(r.showId, []);
    map.get(r.showId).push(r);
  }
  return map;
}

function computeCriticScore(showReviews, market) {
  // Tier-weighted average using outlet-tiers
  let weightedSum = 0;
  let weightSum = 0;
  const weights = { 1: 1.0, 2: 0.75, 3: 0.35 };
  for (const r of showReviews) {
    if (typeof r.assignedScore !== 'number') continue;
    const tier = getTier(r.outletId, { showCategory: market }) || 3;
    const w = weights[tier] || 0.35;
    weightedSum += r.assignedScore * w;
    weightSum += w;
  }
  if (weightSum === 0) return null;
  return Math.round(weightedSum / weightSum);
}

function scoreQualifies(showReviews, market) {
  const t = publishThresholds(market);
  let t1 = 0, t2 = 0, highConf = 0;
  for (const r of showReviews) {
    const tier = getTier(r.outletId, { showCategory: market });
    if (tier === 1) t1++;
    else if (tier === 2) t2++;
    if (r.scoreConfidence === 'high' || r.scoreConfidence === 'medium') highConf++;
  }
  const ok =
    showReviews.length >= t.minReviews &&
    t1 >= t.minT1 &&
    t2 >= t.minT2 &&
    highConf >= t.minHighConf;
  return {
    ok,
    breakdown: { total: showReviews.length, t1, t2, highConf },
    thresholds: t,
  };
}

function getAudience(audienceBuzz, showId) {
  const row = audienceBuzz?.shows?.[showId];
  if (!row) return null;
  // Sum review counts across sources
  let totalReviews = 0;
  for (const src of Object.values(row.sources || {})) {
    if (src && typeof src.reviewCount === 'number') totalReviews += src.reviewCount;
  }
  return {
    designation: row.designation || null,
    score: typeof row.combinedScore === 'number' ? Math.round(row.combinedScore) : null,
    reviewCount: totalReviews,
  };
}

// ---------------------------------------------------------------------------
// Build sections
// ---------------------------------------------------------------------------

function buildUpcoming(shows) {
  const today = todayUTC();
  const sevenDaysOut = addDays(today, 7);

  const upcoming = shows.filter(s => {
    if (!s.openingDate) return false;
    const d = new Date(s.openingDate + 'T00:00:00Z');
    return d >= today && d <= sevenDaysOut;
  });

  upcoming.sort((a, b) => a.openingDate.localeCompare(b.openingDate));

  const groups = { today: [], tomorrow: [], restOfWeek: [] };
  const todayStr = ymd(today);
  const tomorrowStr = ymd(addDays(today, 1));

  for (const s of upcoming) {
    const market = getMarket(s);
    const prediction = predictReviewCount({ market, isRevival: s.isRevival === true });
    const row = {
      id: s.id,
      title: s.title,
      slug: s.slug,
      date: s.openingDate,
      market,
      marketLabel: marketLabel(market),
      isRevival: s.isRevival === true,
      important: isImportantMarket(market),
      poster: posterUrl(s),
      url: showUrl(s),
      expected: prediction.expected,
      expectedRange: prediction.expected ? `${prediction.p25}–${prediction.p75}` : null,
    };
    if (s.openingDate === todayStr) groups.today.push(row);
    else if (s.openingDate === tomorrowStr) groups.tomorrow.push(row);
    else groups.restOfWeek.push(row);
  }

  return groups;
}

function buildRecent(shows, reviewMap, audienceBuzz, sentData) {
  const today = todayUTC();
  const sevenDaysAgo = addDays(today, -7);

  const recent = shows.filter(s => {
    if (!s.openingDate) return false;
    const d = new Date(s.openingDate + 'T00:00:00Z');
    return d >= sevenDaysAgo && d <= today;
  });

  recent.sort((a, b) => b.openingDate.localeCompare(a.openingDate));

  return recent.map(s => {
    const market = getMarket(s);
    const reviews = reviewMap.get(s.id) || [];
    const score = computeCriticScore(reviews, market);
    const q = scoreQualifies(reviews, market);
    const audience = getAudience(audienceBuzz, s.id);
    const prediction = predictReviewCount({ market, isRevival: s.isRevival === true });
    return {
      id: s.id,
      title: s.title,
      slug: s.slug,
      date: s.openingDate,
      market,
      marketLabel: marketLabel(market),
      isRevival: s.isRevival === true,
      important: isImportantMarket(market),
      poster: posterUrl(s),
      url: showUrl(s),
      reviewCount: reviews.length,
      expected: prediction.expected,
      criticScore: score,
      qualifies: q.ok,
      qualifyReason: q.ok ? null : describeQualifyGaps(q),
      audience,
      broadcastSent: isImportantMarket(market) ? isBroadcastSent(sentData, market, s.id) : null,
    };
  });
}

function describeQualifyGaps(q) {
  const gaps = [];
  if (q.breakdown.total < q.thresholds.minReviews) gaps.push(`${q.breakdown.total}/${q.thresholds.minReviews} reviews`);
  if (q.breakdown.t1 < q.thresholds.minT1) gaps.push(`T1 ${q.breakdown.t1}/${q.thresholds.minT1}`);
  if (q.breakdown.t2 < q.thresholds.minT2) gaps.push(`T2 ${q.breakdown.t2}/${q.thresholds.minT2}`);
  if (q.breakdown.highConf < q.thresholds.minHighConf) gaps.push(`hi-conf ${q.breakdown.highConf}/${q.thresholds.minHighConf}`);
  return gaps.join(', ');
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chip(text, bg = '#eef2ff', color = '#3730a3') {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${color};font-size:11px;font-weight:600;margin-right:4px;">${esc(text)}</span>`;
}

function renderUpcomingRow(row) {
  const chips = [
    chip(row.marketLabel, row.important ? '#fef3c7' : '#e5e7eb', row.important ? '#92400e' : '#374151'),
    chip(row.isRevival ? 'Revival' : 'Original', '#dbeafe', '#1e40af'),
  ];
  if (row.important) chips.unshift(chip('★ Important', '#fde68a', '#78350f'));

  const expected = row.expected
    ? `<div style="color:#475569;font-size:13px;">Expected reviews: <strong>${row.expected}</strong> <span style="color:#94a3b8;">(${row.expectedRange})</span></div>`
    : `<div style="color:#94a3b8;font-size:13px;">Expected reviews: TBD (no cohort history)</div>`;

  const poster = row.poster
    ? `<img src="${esc(row.poster)}" alt="" width="56" height="80" style="border-radius:6px;object-fit:cover;display:block;">`
    : `<div style="width:56px;height:80px;background:#e5e7eb;border-radius:6px;"></div>`;

  return `
  <tr>
    <td style="padding:10px 0;vertical-align:top;width:64px;">${poster}</td>
    <td style="padding:10px 0 10px 12px;vertical-align:top;">
      <div style="font-size:15px;font-weight:600;"><a href="${esc(row.url)}" style="color:#0f172a;text-decoration:none;">${esc(row.title)}</a></div>
      <div style="margin:4px 0;">${chips.join('')}</div>
      <div style="color:#64748b;font-size:13px;">Opens ${esc(formatHumanDate(row.date))}</div>
      ${expected}
    </td>
  </tr>`;
}

function renderRecentRow(row) {
  const chips = [
    chip(row.marketLabel, row.important ? '#fef3c7' : '#e5e7eb', row.important ? '#92400e' : '#374151'),
    chip(row.isRevival ? 'Revival' : 'Original', '#dbeafe', '#1e40af'),
  ];
  if (row.important) chips.unshift(chip('★ Important', '#fde68a', '#78350f'));

  const scoreCell = row.criticScore != null
    ? `<strong style="font-size:18px;color:#0f172a;">${row.criticScore}</strong>`
    : `<span style="color:#94a3b8;">—</span>`;

  const reviewProgress = row.expected
    ? `${row.reviewCount} / ${row.expected} expected`
    : `${row.reviewCount}`;

  const qualifies = row.qualifies
    ? chip('✓ Qualifies', '#dcfce7', '#166534')
    : chip(`Not yet${row.qualifyReason ? ' — ' + row.qualifyReason : ''}`, '#fee2e2', '#991b1b');

  const audience = row.audience && row.audience.score != null
    ? `<div style="color:#475569;font-size:13px;">Audience: <strong>${row.audience.score}</strong> <span style="color:#64748b;">(${row.audience.designation || '—'}, ${row.audience.reviewCount.toLocaleString()} reviews)</span></div>`
    : `<div style="color:#94a3b8;font-size:13px;">Audience: no data yet</div>`;

  const broadcast = row.broadcastSent === null
    ? ''
    : row.broadcastSent
      ? `<div>${chip('✉ Broadcast sent', '#dcfce7', '#166534')}</div>`
      : `<div>${chip('✉ Broadcast pending', '#fef3c7', '#92400e')}</div>`;

  const poster = row.poster
    ? `<img src="${esc(row.poster)}" alt="" width="56" height="80" style="border-radius:6px;object-fit:cover;display:block;">`
    : `<div style="width:56px;height:80px;background:#e5e7eb;border-radius:6px;"></div>`;

  return `
  <tr>
    <td style="padding:12px 0;vertical-align:top;width:64px;">${poster}</td>
    <td style="padding:12px 0 12px 12px;vertical-align:top;">
      <div style="font-size:15px;font-weight:600;"><a href="${esc(row.url)}" style="color:#0f172a;text-decoration:none;">${esc(row.title)}</a></div>
      <div style="margin:4px 0;">${chips.join('')}</div>
      <div style="color:#64748b;font-size:13px;">Opened ${esc(formatHumanDate(row.date))}</div>
      <div style="margin-top:6px;font-size:13px;color:#475569;">Critic score ${scoreCell} <span style="color:#64748b;">· ${reviewProgress} reviews</span></div>
      <div style="margin:4px 0;">${qualifies}</div>
      ${audience}
      ${broadcast}
    </td>
  </tr>`;
}

function renderSectionGroup(title, rows, renderRow, emptyText) {
  if (!rows || rows.length === 0) {
    return `<h3 style="margin:24px 0 8px 0;color:#0f172a;font-size:16px;">${esc(title)}</h3>
      <div style="color:#94a3b8;font-size:14px;font-style:italic;">${esc(emptyText)}</div>`;
  }
  const rowsHtml = rows.map(renderRow).join('');
  return `<h3 style="margin:24px 0 8px 0;color:#0f172a;font-size:16px;">${esc(title)} (${rows.length})</h3>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0;">${rowsHtml}</table>`;
}

function buildHtml({ upcoming, recent, today }) {
  const upcomingTotal = upcoming.today.length + upcoming.tomorrow.length + upcoming.restOfWeek.length;

  const upcomingSection =
    renderSectionGroup('Opening today', upcoming.today, renderUpcomingRow, 'Nothing opens today.') +
    renderSectionGroup('Opening tomorrow', upcoming.tomorrow, renderUpcomingRow, 'Nothing opens tomorrow.') +
    renderSectionGroup('Rest of the week', upcoming.restOfWeek, renderUpcomingRow, 'No more openings this week.');

  const recentSection = recent.length === 0
    ? `<div style="color:#94a3b8;font-size:14px;font-style:italic;">No shows opened in the last 7 days.</div>`
    : `<table style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0;">${recent.map(renderRecentRow).join('')}</table>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px;background:#ffffff;">
    <div style="font-size:13px;color:#64748b;">${esc(today)}</div>
    <h1 style="margin:4px 0 4px 0;font-size:22px;color:#0f172a;">Opening Digest</h1>
    <div style="color:#475569;font-size:14px;">${upcomingTotal} upcoming · ${recent.length} opened in the last 7 days</div>

    <h2 style="margin:28px 0 4px 0;font-size:18px;color:#0f172a;border-bottom:2px solid #0f172a;padding-bottom:6px;">Upcoming</h2>
    ${upcomingSection}

    <h2 style="margin:36px 0 4px 0;font-size:18px;color:#0f172a;border-bottom:2px solid #0f172a;padding-bottom:6px;">Opened in the last 7 days</h2>
    ${recentSection}

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px 0;">
    <div style="color:#94a3b8;font-size:11px;">
      Predictions use historical median review count by (market, revival) cohort over the last 24 months.
      Importance heuristic: Broadway + West End openings are flagged as important.
    </div>
  </div></body></html>`;
}

// ---------------------------------------------------------------------------
// Resend send
// ---------------------------------------------------------------------------

function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const shows = loadJSON(SHOWS_PATH);
  const reviews = loadJSON(REVIEWS_PATH);
  const audience = loadJSON(AUDIENCE_PATH);
  const sent = loadJSON(SENT_PATH);

  if (!shows) {
    console.error(`shows.json not found at ${SHOWS_PATH}`);
    process.exit(1);
  }
  const showList = shows.shows || shows;
  const reviewList = (reviews && (reviews.reviews || reviews)) || [];

  const reviewMap = buildShowReviewMap(reviewList);

  const upcoming = buildUpcoming(showList);
  const recent = buildRecent(showList, reviewMap, audience, sent);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const subject = `Opening Digest · ${today}`;
  const html = buildHtml({ upcoming, recent, today });

  if (DRY_RUN) {
    console.log(`Subject: ${subject}`);
    console.log(`Recipient: ${SEND_TO}`);
    console.log(`Upcoming: today=${upcoming.today.length}, tomorrow=${upcoming.tomorrow.length}, restOfWeek=${upcoming.restOfWeek.length}`);
    console.log(`Recent: ${recent.length}`);
    console.log('---HTML---');
    console.log(html);
    return;
  }

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set. Add to .env or pass via env.');
    process.exit(1);
  }

  console.log(`Sending opening digest to ${SEND_TO}...`);
  await postJSON('https://api.resend.com/emails', {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [SEND_TO],
    subject,
    html,
  }, {
    'Authorization': `Bearer ${RESEND_API_KEY}`,
  });
  console.log(`Sent. Upcoming: ${upcoming.today.length + upcoming.tomorrow.length + upcoming.restOfWeek.length}, recent: ${recent.length}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
