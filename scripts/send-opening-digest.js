#!/usr/bin/env node
/**
 * send-opening-digest.js
 *
 * Action-first daily digest emailed to the owner. Surfaces shows that
 * need intervention TODAY, not just a flat status list.
 *
 * Sections, in order:
 *   1. Needs help — opened, underperforming cohort, T1 missing, etc.
 *      (candidates for Reddit posts / manual review hunts)
 *   2. Broadcast ready — qualifies for a Resend broadcast, not yet sent.
 *   3. Coming up — opens today / tomorrow / rest of week (important markets).
 *   4. Other recent — opened in last 7 days, no action needed.
 *   5. Other upcoming — opens this week, OB/OWE (not in important list).
 *
 * Sent transactionally via Resend — never a broadcast.
 *
 * Importance:
 *   - Broadway + West End: always important
 *   - Off-Broadway / Off-West-End: only when listed in
 *     data/digest-important-shows.json (curated allow-list for big OB
 *     shows like New Born / Kenrex)
 *
 * Usage:
 *   node scripts/send-opening-digest.js                       # send
 *   node scripts/send-opening-digest.js --send-to=EMAIL       # override recipient
 *   node scripts/send-opening-digest.js --dry-run             # print HTML, no send
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
const IMPORTANT_PATH = path.join(DATA_DIR, 'digest-important-shows.json');
const EXCLUDED_PATH = path.join(DATA_DIR, 'digest-excluded-shows.json');

const SITE_URL = 'https://broadwayscorecard.com';

// Tokens — these are NOT invented. Hex values come straight from
//   - src/app/globals.css (.score-must-see, .score-great, .score-good, .score-tepid, .score-skip)
//   - src/components/show-cards/ShowPills.tsx (FormatPill, ProductionPill, CategoryBadge, StatusBadge)
//   - src/lib/audience-grade-utils.ts (getAudienceGrade)
//   - memory/design-system.md (surfaces, brand gold)
// If you change any of these, change the source file, not these constants.
const TOKENS = {
  surface: '#0f0f14',
  surfaceRaised: '#1a1a24',
  surfaceOverlay: '#2a2a38',
  border: 'rgba(255,255,255,0.10)',
  borderSubtle: 'rgba(255,255,255,0.06)',
  text: '#f5e6d3',          // accent cream — primary text on dark
  textMuted: '#a3a3b8',
  textDim: '#6b6b80',
  brand: '#d4a574',         // gold
  brandMuted: 'rgba(212,165,116,0.18)',
  open: '#10b981',
  warn: '#d97706',
};

// Critic score tiers — mirror globals.css .score-{must-see,great,good,tepid,skip}
function criticTier(score, market) {
  if (score == null) return { bg: null, fg: '#9ca3af', label: 'TBD', glow: false };
  const goldThreshold = (market === 'west-end' || market === 'off-west-end') ? 85 : 83;
  if (score >= goldThreshold) return { bg: 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)', fg: '#1a1a1a', label: 'Critical Gold', glow: true };
  if (score >= 75) return { bg: '#22c55e', fg: '#ffffff', label: 'Recommended', glow: false };
  if (score >= 65) return { bg: '#14b8a6', fg: '#ffffff', label: 'Worth Seeing', glow: false };
  if (score >= 55) return { bg: '#d97706', fg: '#1a1a1a', label: 'Skippable', glow: false };
  return { bg: '#ef4444', fg: '#ffffff', label: 'Critical Miss', glow: false };
}

// Audience grade — exact copy of src/lib/audience-grade-utils.ts getAudienceGrade()
function audienceGrade(score) {
  if (score == null) return { grade: '—', label: 'No Data', color: '#6b7280', textColor: '#ffffff' };
  if (score >= 90) return { grade: 'A+', label: 'Loving It', color: '#22c55e', textColor: '#ffffff' };
  if (score >= 88) return { grade: 'A',  label: 'Loving It', color: '#16a34a', textColor: '#ffffff' };
  if (score >= 83) return { grade: 'A-', label: 'Liking It', color: '#14b8a6', textColor: '#ffffff' };
  if (score >= 78) return { grade: 'B+', label: 'Liking It', color: '#0ea5e9', textColor: '#ffffff' };
  if (score >= 73) return { grade: 'B',  label: 'Shrugging', color: '#f59e0b', textColor: '#1a1a1a' };
  if (score >= 68) return { grade: 'B-', label: 'Shrugging', color: '#f97316', textColor: '#1a1a1a' };
  if (score >= 63) return { grade: 'C+', label: 'Disliking It', color: '#ef4444', textColor: '#ffffff' };
  if (score >= 58) return { grade: 'C',  label: 'Disliking It', color: '#dc2626', textColor: '#ffffff' };
  if (score >= 53) return { grade: 'C-', label: 'Disliking It', color: '#b91c1c', textColor: '#ffffff' };
  if (score >= 48) return { grade: 'D',  label: 'Loathing It', color: '#991b1b', textColor: '#ffffff' };
  return { grade: 'F', label: 'Loathing It', color: '#6b7280', textColor: '#ffffff' };
}

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

function daysBetween(yyyymmdd, anchor = todayUTC()) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  return Math.round((d.getTime() - anchor.getTime()) / 86400000);
}

function formatHumanDate(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function getMarket(show) {
  return show.category || show.market || 'broadway';
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
// Site component replicas — see src/components/show-cards/ for the originals
// ---------------------------------------------------------------------------

// ScoreBadge (md size) — square 56px box, big score number, colored bg.
// Source: src/components/show-cards/ScoreBadge.tsx + globals.css .score-* classes.
function scoreBadgeHtml(score, market) {
  if (score == null) {
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:12px;background:rgba(255,255,255,0.04);border:1px solid ${TOKENS.border};color:#9ca3af;font-weight:700;font-size:14px;">TBD</span>`;
  }
  const t = criticTier(score, market);
  const extra = t.glow
    ? 'box-shadow:0 0 16px rgba(218,165,32,0.45),0 2px 8px rgba(0,0,0,0.25);border:2px solid #C8960E;'
    : 'box-shadow:0 2px 8px rgba(0,0,0,0.25);';
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:12px;background:${t.bg};color:${t.fg};font-weight:800;font-size:22px;letter-spacing:-0.02em;line-height:1;${extra}">${score}</span>`;
}

// AudienceChip — tiny pill, color from grade table, alpha 0.20 bg.
// Source: src/components/show-cards/ShowPills.tsx AudienceChip.
function audienceChipHtml(audience) {
  if (!audience || audience.score == null) {
    return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:9999px;background:rgba(107,114,128,0.20);color:#9ca3af;font-size:10px;font-weight:700;line-height:1;letter-spacing:0.02em;"><span style="opacity:0.6;font-weight:600;">Audience:</span><span>—</span></span>`;
  }
  const g = audienceGrade(audience.score);
  return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:9999px;background:${g.color}33;color:${g.color};font-size:10px;font-weight:700;line-height:1;letter-spacing:0.02em;"><span style="opacity:0.6;font-weight:600;">Audience:</span><span>${esc(g.grade)} · ${audience.score}</span></span>`;
}

// FormatPill — outline pill (musical/play/opera). src/components/show-cards/ShowPills.tsx
function formatPillHtml(type) {
  const cfg = {
    musical: { label: 'MUSICAL', color: '#a78bfa' },     // purple-400
    play:    { label: 'PLAY',    color: '#60a5fa' },     // blue-400
    opera:   { label: 'OPERA',   color: '#818cf8' },     // indigo-400
  }[type] || { label: 'PLAY', color: '#60a5fa' };
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;border:1px solid ${cfg.color}80;color:${cfg.color};background:transparent;">${esc(cfg.label)}</span>`;
}

// ProductionPill — solid muted fill (revival vs original). ShowPills.tsx
function productionPillHtml(isRevival) {
  const cfg = isRevival
    ? { label: 'REVIVAL', color: '#9ca3af', bg: 'rgba(107,114,128,0.20)' }    // gray-400
    : { label: 'ORIGINAL', color: '#fbbf24', bg: 'rgba(245,158,11,0.20)' };   // amber-400
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${cfg.color};background:${cfg.bg};">${esc(cfg.label)}</span>`;
}

// CategoryBadge — solid muted fill + border (off-broadway / west-end / off-WE).
// Returns '' for Broadway (no badge). ShowPills.tsx
function categoryBadgeHtml(market) {
  const cfg = {
    'off-broadway': { label: 'OFF-BROADWAY', color: '#818cf8', border: 'rgba(99,102,241,0.30)', bg: 'rgba(99,102,241,0.15)' },
    'west-end':     { label: 'WEST END',     color: '#2dd4bf', border: 'rgba(20,184,166,0.30)', bg: 'rgba(20,184,166,0.15)' },
    'off-west-end': { label: 'Off-WE',       color: '#9ca3af', border: 'rgba(255,255,255,0.10)', bg: 'rgba(255,255,255,0.05)' },
  }[market];
  if (!cfg) return '';
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${cfg.color};background:${cfg.bg};border:1px solid ${cfg.border};">${esc(cfg.label)}</span>`;
}

// Generic small uppercase pill in the site's style (used for tier labels
// like "Critical Gold" and action chips like "Needs help"). Same rounding,
// padding, and typography as ShowPills.
function sitePillHtml(label, { color = TOKENS.textMuted, bg = TOKENS.surfaceOverlay, border = null } = {}) {
  const borderStyle = border ? `border:1px solid ${border};` : '';
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${color};background:${bg};${borderStyle}">${esc(label)}</span>`;
}

// ---------------------------------------------------------------------------
// Importance / broadcast eligibility
// ---------------------------------------------------------------------------

function loadImportantList() {
  const data = loadJSON(IMPORTANT_PATH);
  return new Set((data && data.showIds) || []);
}

function loadExcludedMap() {
  const data = loadJSON(EXCLUDED_PATH);
  return new Map(Object.entries((data && data.shows) || {}));
}

function regionOf(market) {
  if (market === 'broadway' || market === 'off-broadway') return 'nyc';
  if (market === 'west-end' || market === 'off-west-end') return 'london';
  return 'other';
}

function isImportant(show, importantSet) {
  const m = getMarket(show);
  if (m === 'broadway' || m === 'west-end') return true;
  return importantSet.has(show.id);
}

// Whether we'd consider sending a broadcast for this show.
// Mirrors importance: BW + WE by default; OB only via the curated allow-list.
function isBroadcastEligible(show, importantSet) {
  return isImportant(show, importantSet);
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
  return {
    ok: showReviews.length >= t.minReviews && t1 >= t.minT1 && t2 >= t.minT2 && highConf >= t.minHighConf,
    breakdown: { total: showReviews.length, t1, t2, highConf },
    thresholds: t,
  };
}

function describeQualifyGaps(q) {
  const gaps = [];
  if (q.breakdown.total < q.thresholds.minReviews) gaps.push(`${q.breakdown.total}/${q.thresholds.minReviews} reviews`);
  if (q.breakdown.t1 < q.thresholds.minT1) gaps.push(`T1 ${q.breakdown.t1}/${q.thresholds.minT1}`);
  if (q.breakdown.t2 < q.thresholds.minT2) gaps.push(`T2 ${q.breakdown.t2}/${q.thresholds.minT2}`);
  if (q.breakdown.highConf < q.thresholds.minHighConf) gaps.push(`hi-conf ${q.breakdown.highConf}/${q.thresholds.minHighConf}`);
  return gaps.join(', ');
}

function getAudience(audienceBuzz, showId) {
  const row = audienceBuzz?.shows?.[showId];
  if (!row) return null;
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
// Build the full row dataset, then classify into action sections
// ---------------------------------------------------------------------------

function buildRows(shows, reviewMap, audienceBuzz, sentData, importantSet, excludedMap) {
  const today = todayUTC();
  return shows
    .filter(s => s.openingDate)
    .map(s => {
      const market = getMarket(s);
      const reviews = reviewMap.get(s.id) || [];
      const score = computeCriticScore(reviews, market);
      const q = scoreQualifies(reviews, market);
      const audience = getAudience(audienceBuzz, s.id);
      const excluded = excludedMap.has(s.id);
      const prediction = excluded
        ? { expected: null, p25: null, p75: null, cohort: null, n: 0 }
        : predictReviewCount({ market, type: s.type, isRevival: s.isRevival === true });
      const important = !excluded && isImportant(s, importantSet);
      const broadcastEligible = !excluded && isBroadcastEligible(s, importantSet);
      const broadcastSent = broadcastEligible ? isBroadcastSent(sentData, market, s.id) : null;
      const daysFromToday = daysBetween(s.openingDate, today);
      return {
        id: s.id,
        title: s.title,
        slug: s.slug,
        date: s.openingDate,
        market,
        type: s.type || 'play',
        region: regionOf(market),
        marketLabel: marketLabel(market),
        isRevival: s.isRevival === true,
        excluded,
        excludedReason: excluded ? excludedMap.get(s.id) : null,
        important,
        broadcastEligible,
        poster: posterUrl(s),
        url: showUrl(s),
        daysFromToday,
        reviewCount: reviews.length,
        t1Count: q.breakdown.t1,
        criticScore: score,
        qualifies: q.ok,
        qualifyGap: q.ok ? null : describeQualifyGaps(q),
        audience,
        broadcastSent,
        expected: prediction.expected,
        expectedRange: prediction.expected ? `${prediction.p25}–${prediction.p75}` : null,
      };
    });
}

function classifyRows(rows) {
  const needsHelp = [];
  const broadcastReady = [];
  const comingUp = [];
  const otherRecent = [];
  const otherUpcoming = [];

  for (const r of rows) {
    if (r.daysFromToday >= 0 && r.daysFromToday <= 7) {
      // Upcoming window
      if (r.important) comingUp.push(r);
      else otherUpcoming.push(r);
      continue;
    }
    if (r.daysFromToday >= -7 && r.daysFromToday < 0) {
      const daysSinceOpen = -r.daysFromToday;

      // Excluded shows: just appear in "other recent" without action signals
      if (r.excluded) {
        otherRecent.push(r);
        continue;
      }

      // Needs help (only important shows we'd actively intervene on)
      if (r.important) {
        const underCohort = r.expected && r.reviewCount < r.expected * 0.5;
        const t1Stalled = r.t1Count < 2;
        const helpReasons = [];
        if (daysSinceOpen >= 2 && underCohort) helpReasons.push(`${r.reviewCount}/${r.expected} reviews`);
        if (daysSinceOpen >= 3 && t1Stalled) helpReasons.push(`only ${r.t1Count} T1`);
        if (helpReasons.length > 0) {
          r.helpReasons = helpReasons;
          needsHelp.push(r);
          continue;
        }
      }

      // Broadcast-ready
      if (r.broadcastEligible && r.qualifies && !r.broadcastSent) {
        broadcastReady.push(r);
        continue;
      }

      otherRecent.push(r);
    }
  }

  // Sort each section sensibly
  needsHelp.sort((a, b) => a.daysFromToday - b.daysFromToday); // oldest first
  broadcastReady.sort((a, b) => a.daysFromToday - b.daysFromToday);
  comingUp.sort((a, b) => a.daysFromToday - b.daysFromToday);
  otherRecent.sort((a, b) => b.daysFromToday - a.daysFromToday); // newest first
  otherUpcoming.sort((a, b) => a.daysFromToday - b.daysFromToday);

  return { needsHelp, broadcastReady, comingUp, otherRecent, otherUpcoming };
}

// Split any list of rows into NYC + London (+ other) by region.
function splitRegion(rows) {
  return {
    nyc: rows.filter(r => r.region === 'nyc'),
    london: rows.filter(r => r.region === 'london'),
    other: rows.filter(r => r.region !== 'nyc' && r.region !== 'london'),
  };
}

// ---------------------------------------------------------------------------
// HTML rendering — dark mode, brand-aligned
// ---------------------------------------------------------------------------

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chip(text, opts) {
  // Back-compat helper — defers to sitePillHtml so chips match site pills.
  return sitePillHtml(text, opts);
}

// Tiny spacer between inline-flex pills (email clients drop CSS gap on inline-flex)
const PILL_SEP = '<span style="display:inline-block;width:6px;">&nbsp;</span>';

function whenLabel(daysFromToday) {
  if (daysFromToday === 0) return 'Today';
  if (daysFromToday === 1) return 'Tomorrow';
  if (daysFromToday > 0) return `In ${daysFromToday}d`;
  if (daysFromToday === -1) return 'Yesterday';
  return `${-daysFromToday}d ago`;
}

function poster(row) {
  if (row.poster) {
    return `<img src="${esc(row.poster)}" alt="${esc(row.title)} poster" width="72" height="100" style="border-radius:8px;object-fit:cover;display:block;background:${TOKENS.surfaceOverlay};">`;
  }
  return `<div style="width:72px;height:100px;background:${TOKENS.surfaceOverlay};border-radius:8px;"></div>`;
}

// Common metadata pills used on every row — same set/order the site uses on cards.
function metadataPills(row) {
  const pills = [];
  pills.push(formatPillHtml(row.type || 'play'));
  pills.push(productionPillHtml(row.isRevival));
  const cat = categoryBadgeHtml(row.market);
  if (cat) pills.push(cat);
  if (row.important && row.market !== 'broadway' && row.market !== 'west-end') {
    pills.push(sitePillHtml('★ Important', { color: TOKENS.brand, bg: TOKENS.brandMuted }));
  }
  return pills.join(PILL_SEP);
}

function renderActionRow(row, actionPills) {
  const criticBadge = scoreBadgeHtml(row.criticScore, row.market);
  const audienceChip = audienceChipHtml(row.audience);
  const tier = criticTier(row.criticScore, row.market);
  const tierLabel = row.criticScore != null
    ? `<div style="font-size:11px;color:${TOKENS.textMuted};margin-top:6px;letter-spacing:0.04em;text-transform:uppercase;font-weight:600;">${esc(tier.label)}</div>`
    : '';

  const reviewProgress = row.expected
    ? `<span style="color:${TOKENS.textMuted};font-size:12px;">${row.reviewCount} of ~${row.expected} expected reviews</span>`
    : `<span style="color:${TOKENS.textMuted};font-size:12px;">${row.reviewCount} reviews</span>`;

  const broadcastPill = row.broadcastSent === null
    ? ''
    : row.broadcastSent
      ? sitePillHtml('✓ Broadcast sent', { color: TOKENS.open, bg: 'rgba(16,185,129,0.18)' })
      : '';

  return `
  <tr style="border-top:1px solid ${TOKENS.borderSubtle};">
    <td style="padding:16px 0;vertical-align:top;width:88px;">${poster(row)}</td>
    <td style="padding:16px 0 16px 16px;vertical-align:top;">
      <div style="font-size:16px;font-weight:700;line-height:1.3;"><a href="${esc(row.url)}" style="color:${TOKENS.text};text-decoration:none;">${esc(row.title)}</a></div>
      <div style="margin:6px 0;font-size:12px;color:${TOKENS.textDim};">${esc(whenLabel(row.daysFromToday))} · ${esc(formatHumanDate(row.date))}</div>
      <div style="margin:8px 0;">${metadataPills(row)}</div>
      ${actionPills ? `<div style="margin:10px 0;">${actionPills}</div>` : ''}
      <table cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 4px 0;"><tr>
        <td style="vertical-align:middle;padding-right:14px;">${criticBadge}${tierLabel}</td>
        <td style="vertical-align:middle;">${audienceChip}</td>
      </tr></table>
      <div>${reviewProgress}</div>
      ${broadcastPill ? `<div style="margin-top:8px;">${broadcastPill}</div>` : ''}
    </td>
  </tr>`;
}

function renderUpcomingRow(row) {
  const expected = row.expected
    ? `<span style="color:${TOKENS.textMuted};">Expects <strong style="color:${TOKENS.text};">${row.expected}</strong> reviews <span style="color:${TOKENS.textDim};">(typical ${row.expectedRange})</span></span>`
    : row.excluded
      ? `<span style="color:${TOKENS.textDim};">Excluded from predictions — ${esc(row.excludedReason)}</span>`
      : `<span style="color:${TOKENS.textDim};">Expected reviews: TBD (no cohort data)</span>`;

  return `
  <tr style="border-top:1px solid ${TOKENS.borderSubtle};">
    <td style="padding:14px 0;vertical-align:top;width:88px;">${poster(row)}</td>
    <td style="padding:14px 0 14px 16px;vertical-align:top;">
      <div style="font-size:16px;font-weight:700;line-height:1.3;"><a href="${esc(row.url)}" style="color:${TOKENS.text};text-decoration:none;">${esc(row.title)}</a></div>
      <div style="margin:6px 0;font-size:12px;color:${TOKENS.textDim};">${esc(whenLabel(row.daysFromToday))} · ${esc(formatHumanDate(row.date))}</div>
      <div style="margin:8px 0;">${metadataPills(row)}</div>
      <div style="font-size:13px;line-height:1.6;margin-top:8px;">${expected}</div>
    </td>
  </tr>`;
}

function renderNeedsHelpRow(row) {
  const reasons = (row.helpReasons || []).join(' · ');
  const action = [
    sitePillHtml('⚠ Needs help', { color: TOKENS.warn, bg: 'rgba(217,119,6,0.20)' }),
    PILL_SEP,
    sitePillHtml(reasons, { color: TOKENS.textMuted, bg: TOKENS.surfaceOverlay }),
  ].join('');
  return renderActionRow(row, action);
}

function renderBroadcastReadyRow(row) {
  return renderActionRow(row, sitePillHtml('✉ Broadcast ready', { color: TOKENS.brand, bg: TOKENS.brandMuted }));
}

function renderOtherRecentRow(row) {
  let action = '';
  if (row.excluded) {
    action = sitePillHtml('Excluded from predictions', { color: TOKENS.textMuted, bg: TOKENS.surfaceOverlay });
  } else if (row.important) {
    action = row.qualifies
      ? sitePillHtml('Qualifies', { color: TOKENS.open, bg: 'rgba(16,185,129,0.18)' })
      : sitePillHtml(`Building${row.qualifyGap ? ' — ' + row.qualifyGap : ''}`, { color: TOKENS.textMuted, bg: TOKENS.surfaceOverlay });
  }
  return renderActionRow(row, action);
}

function renderSection(title, count, bodyHtml) {
  return `
    <h2 style="margin:32px 0 4px 0;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:${TOKENS.brand};">${esc(title)} <span style="color:${TOKENS.textDim};font-weight:500;">· ${count}</span></h2>
    ${bodyHtml}`;
}

function renderTable(rows, renderRow) {
  if (!rows || rows.length === 0) return '';
  return `<table style="width:100%;border-collapse:collapse;">${rows.map(renderRow).join('')}</table>`;
}

function buildSubject({ needsHelp, broadcastReady, comingUp }) {
  const todayHuman = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const parts = [];
  if (needsHelp.length) parts.push(`${needsHelp.length} need${needsHelp.length === 1 ? 's' : ''} help`);
  if (broadcastReady.length) parts.push(`${broadcastReady.length} broadcast-ready`);
  const openingToday = comingUp.filter(r => r.daysFromToday === 0).length;
  if (openingToday) parts.push(`${openingToday} opening today`);
  const openingTomorrow = comingUp.filter(r => r.daysFromToday === 1).length;
  if (openingTomorrow && !openingToday) parts.push(`${openingTomorrow} tomorrow`);
  const lead = parts.length ? parts.join(' · ') : (comingUp.length ? `${comingUp.length} upcoming this week` : 'Quiet week');
  return `${lead} · ${todayHuman}`;
}

function renderRegionBlock(label, sections) {
  const { needsHelp, broadcastReady, comingUp, otherRecent, otherUpcoming } = sections;
  const total = needsHelp.length + broadcastReady.length + comingUp.length + otherRecent.length + otherUpcoming.length;
  if (total === 0) {
    return `
      <div style="margin:36px 0 16px 0;">
        <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${TOKENS.brand};font-weight:700;border-bottom:2px solid ${TOKENS.brand}33;padding-bottom:8px;">${esc(label)}</div>
        <div style="margin:18px 0;color:${TOKENS.textDim};font-size:13px;font-style:italic;">No activity in the last 7 days or next 7 days.</div>
      </div>`;
  }
  let inner = '';
  if (needsHelp.length) inner += renderSection('Needs help', needsHelp.length, renderTable(needsHelp, renderNeedsHelpRow));
  if (broadcastReady.length) inner += renderSection('Broadcast ready', broadcastReady.length, renderTable(broadcastReady, renderBroadcastReadyRow));
  if (comingUp.length) inner += renderSection('Coming up', comingUp.length, renderTable(comingUp, renderUpcomingRow));
  if (otherRecent.length) inner += renderSection('Other recent (last 7 days)', otherRecent.length, renderTable(otherRecent, renderOtherRecentRow));
  if (otherUpcoming.length) inner += renderSection('Other upcoming (next 7 days)', otherUpcoming.length, renderTable(otherUpcoming, renderUpcomingRow));
  return `
    <div style="margin:36px 0 16px 0;">
      <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${TOKENS.brand};font-weight:700;border-bottom:2px solid ${TOKENS.brand}33;padding-bottom:8px;">${esc(label)} <span style="color:${TOKENS.textDim};font-weight:500;">· ${total}</span></div>
      ${inner}
    </div>`;
}

function buildHtml({ needsHelp, broadcastReady, comingUp, otherRecent, otherUpcoming, todayHuman }) {
  const summaryBits = [
    `${needsHelp.length} needs help`,
    `${broadcastReady.length} broadcast ready`,
    `${comingUp.length} important upcoming`,
    `${otherRecent.length + otherUpcoming.length} other`,
  ];

  // Split every section into NYC vs London
  const nycSections = {
    needsHelp: splitRegion(needsHelp).nyc,
    broadcastReady: splitRegion(broadcastReady).nyc,
    comingUp: splitRegion(comingUp).nyc,
    otherRecent: splitRegion(otherRecent).nyc,
    otherUpcoming: splitRegion(otherUpcoming).nyc,
  };
  const londonSections = {
    needsHelp: splitRegion(needsHelp).london,
    broadcastReady: splitRegion(broadcastReady).london,
    comingUp: splitRegion(comingUp).london,
    otherRecent: splitRegion(otherRecent).london,
    otherUpcoming: splitRegion(otherUpcoming).london,
  };

  let body = renderRegionBlock('NYC', nycSections) + renderRegionBlock('London', londonSections);
  if (!body) {
    body = `<div style="margin:48px 0;text-align:center;color:${TOKENS.textMuted};font-size:14px;">Nothing to report — no openings in the last or next 7 days.</div>`;
  }

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${TOKENS.surface};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TOKENS.text};">
  <div style="max-width:640px;margin:0 auto;padding:28px 22px;background:${TOKENS.surfaceRaised};border:1px solid ${TOKENS.border};">
    <div style="font-size:11px;letter-spacing:0.10em;text-transform:uppercase;color:${TOKENS.brand};font-weight:600;">Broadway Scorecard</div>
    <h1 style="margin:4px 0 6px 0;font-size:24px;color:${TOKENS.text};letter-spacing:-0.01em;">Opening Digest</h1>
    <div style="color:${TOKENS.textMuted};font-size:13px;">${esc(todayHuman)} · ${esc(summaryBits.join(' · '))}</div>
    ${body}
    <hr style="border:none;border-top:1px solid ${TOKENS.border};margin:36px 0 14px 0;">
    <div style="color:${TOKENS.textDim};font-size:11px;line-height:1.6;">
      Importance: Broadway + West End by default, plus shows in <code style="color:${TOKENS.textMuted};">data/digest-important-shows.json</code>.
      Predictions: cohort median by (market, type, revival) over the last 24 months — not a trained model. Variety/revue shows that share a cohort with real openings are excluded via <code style="color:${TOKENS.textMuted};">data/digest-excluded-shows.json</code>.
      Needs-help triggers: opened ≥2 days with &lt;50% of expected reviews, or opened ≥3 days with &lt;2 T1.
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
  if (!shows) {
    console.error(`shows.json not found at ${SHOWS_PATH}`);
    process.exit(1);
  }
  const reviews = loadJSON(REVIEWS_PATH);
  const audience = loadJSON(AUDIENCE_PATH);
  const sent = loadJSON(SENT_PATH);
  const importantSet = loadImportantList();
  const excludedMap = loadExcludedMap();

  const showList = shows.shows || shows;
  const reviewList = (reviews && (reviews.reviews || reviews)) || [];
  const reviewMap = buildShowReviewMap(reviewList);

  const rows = buildRows(showList, reviewMap, audience, sent, importantSet, excludedMap);
  const sections = classifyRows(rows);

  const todayHuman = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const subject = buildSubject(sections);
  const html = buildHtml({ ...sections, todayHuman });

  if (DRY_RUN) {
    console.log(`Subject: ${subject}`);
    console.log(`Recipient: ${SEND_TO}`);
    console.log(`Needs help: ${sections.needsHelp.length}`);
    console.log(`Broadcast ready: ${sections.broadcastReady.length}`);
    console.log(`Coming up (important): ${sections.comingUp.length}`);
    console.log(`Other recent: ${sections.otherRecent.length}`);
    console.log(`Other upcoming: ${sections.otherUpcoming.length}`);
    console.log('---HTML---');
    console.log(html);
    return;
  }

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set.');
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
  console.log(`Sent. ${subject}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
