#!/usr/bin/env node
/**
 * send-opening-digest.js
 *
 * Action-first daily digest of shows that need intervention TODAY, not just
 * a flat status list.
 *
 * Sections, in order:
 *   1. Needs help — opened, underperforming cohort, T1 missing, etc.
 *      (candidates for Reddit posts / manual review hunts)
 *   2. Broadcast ready — qualifies for a Resend broadcast, not yet sent.
 *   3. Coming up — opens today / tomorrow / rest of week (important markets).
 *   4. Other recent — opened in last 7 days, no action needed.
 *   5. Other upcoming — opens this week, OB/OWE (not in important list).
 *
 * Standalone daily email, restored 2026-07-30 (owner ask): card #497 folded
 * this into the merged morning email, but the owner missed the standalone
 * version ("my fave email") and asked for it back. It sends directly again
 * and no longer writes the morning-email snapshot — the opening radar's home
 * is THIS email, not a folded block.
 *
 * Importance:
 *   - Broadway + West End: always important
 *   - Off-Broadway / Off-West-End: only when listed in
 *     data/digest-important-shows.json (curated allow-list for big OB
 *     shows like New Born / Kenrex)
 *
 * Usage:
 *   node scripts/send-opening-digest.js                       # send to owner
 *   node scripts/send-opening-digest.js --send-to=EMAIL       # override recipient
 *   node scripts/send-opening-digest.js --dry-run             # print HTML, don't send
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { predictReviewCount } = require('./predict-review-count');
const { getTier } = require('./lib/outlet-tiers');
const { getMarketMinReviews } = require('./lib/min-reviews');
const {
  TOKENS,
  esc,
  criticTier,
  audienceGrade,
  scoreBadge,
  audienceChip,
  formatPill,
  productionPill,
  categoryBadge,
  sitePill,
} = require('./lib/email-components');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const AUDIENCE_PATH = path.join(DATA_DIR, 'audience-buzz.json');
const SENT_PATH = path.join(DATA_DIR, 'opening-night-sent.json');
const IMPORTANT_PATH = path.join(DATA_DIR, 'digest-important-shows.json');
const EXCLUDED_PATH = path.join(DATA_DIR, 'digest-excluded-shows.json');
const SITE_URL = 'https://broadwayscorecard.com';

// RULE 17 (email broadcast safety): transactional send to ONE explicit
// recipient — never a broadcast, never an audience.
const FROM_EMAIL = 'updates@broadwayscorecard.com';
const FROM_NAME = 'Broadway Scorecard Digest';
const DEFAULT_RECIPIENT = 'thomas.pryor@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

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

// Score/grade DISPLAY gates — keep in parity with the live site so the digest
// never surfaces a number the public show page would itself suppress. A digest
// that shows "Recommended 81" off 2 reviews while also flagging "Needs help —
// 2/15 reviews" reads as contradictory and untrustworthy.
//   Critic score: scripts/lib/min-reviews.js getMarketMinReviews() — the single
//                 source of truth (mirror of src/config/score-buckets.ts):
//                 West End / Broadway = 5, Off-West End / Off-Broadway = 3.
//   Audience grade: src/lib/audience-grade-utils.ts MIN_AUDIENCE_REVIEWS = 15.
// Below these, the digest shows "TBD" / "Audience: —" rather than a firm verdict.
function minReviewsToShowScore(market) {
  return getMarketMinReviews(market);
}
const MIN_AUDIENCE_REVIEWS = 15;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SEND_TO = (args.find(a => a.startsWith('--send-to=')) || '').split('=')[1] || DEFAULT_RECIPIENT;

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

// The site's ShowListCard uses the square thumbnail (96×96 / 112×112), not the
// portrait poster. Stay aligned.
function thumbnailUrl(show) {
  const img = show.images && (show.images.thumbnail || show.images.hero || show.images.poster);
  if (!img) return null;
  return img.startsWith('http') ? img : `${SITE_URL}${img}`;
}

function isBroadcastSent(sentData, market, showId) {
  const sent = sentData?.shows || {};
  return !!(sent[showId]?.completed || sent[`${market}:${showId}`]?.completed);
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
  // Parity with the live site: no audience letter grade below MIN_AUDIENCE_REVIEWS.
  const enoughForGrade = totalReviews >= MIN_AUDIENCE_REVIEWS;
  return {
    designation: enoughForGrade ? (row.designation || null) : null,
    score: enoughForGrade && typeof row.combinedScore === 'number' ? Math.round(row.combinedScore) : null,
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
      // Only show a firm critic score once we clear the live-site minimum.
      // Below it the row renders "TBD" — the review-progress line still shows
      // the running count, so the owner sees momentum without a premature verdict.
      const score = reviews.length >= minReviewsToShowScore(market)
        ? computeCriticScore(reviews, market)
        : null;
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
        thumbnail: thumbnailUrl(s),
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
// HTML rendering — all visual primitives come from ./lib/email-components.
// Do NOT add inline hex colors or hand-rolled pills here. The CI grep gate
// in .github/workflows/test.yml will fail the build.
// ---------------------------------------------------------------------------

// Tiny spacer between inline-flex pills (email clients drop CSS gap on inline-flex)
const PILL_SEP = '<span style="display:inline-block;width:6px;">&nbsp;</span>';

function whenLabel(daysFromToday) {
  if (daysFromToday === 0) return 'Today';
  if (daysFromToday === 1) return 'Tomorrow';
  if (daysFromToday > 0) return `In ${daysFromToday}d`;
  if (daysFromToday === -1) return 'Yesterday';
  return `${-daysFromToday}d ago`;
}

// Square thumbnail, 96×96. Matches ShowListCard exactly.
function thumbnailHtml(row) {
  if (row.thumbnail) {
    return `<img src="${esc(row.thumbnail)}" alt="${esc(row.title)}" width="96" height="96" style="display:block;width:96px;height:96px;border-radius:8px;object-fit:cover;background:${TOKENS.surfaceOverlay};">`;
  }
  return `<div style="width:96px;height:96px;background:${TOKENS.surfaceOverlay};border-radius:8px;"></div>`;
}

// Score column: tier label above, 80×80 badge in the middle, audience chip below.
// Matches ShowListCard's right column (flex-col items-center gap-1.5 w-24).
//
// IMPORTANT for email rendering: Gmail strips/ignores `display:inline-flex` +
// `align-items:center` on inline elements, which pushes the score number to
// the top of the badge. The only reliable cross-client way to vertically
// center a single line of text in a fixed-height box is `line-height:HEIGHTpx`
// on a block-level div. That's what we do here.
function scoreColumnHtml(row) {
  const score = row.criticScore;
  const tier = criticTier(score, row.market);

  let badgeBg, badgeFg, badgeShadow, labelColor;
  if (score == null) {
    // Site's .score-none: bg-surface-overlay, gray-500 text, subtle border.
    badgeBg = TOKENS.surfaceOverlay;
    badgeFg = '#6b7280';
    badgeShadow = `border:1px solid ${TOKENS.border};`;
    labelColor = TOKENS.textDim;
  } else if (tier.glow) {
    badgeBg = tier.bg;
    badgeFg = tier.fg;
    badgeShadow = 'border:2px solid #C8960E;box-shadow:0 0 16px rgba(218,165,32,0.45),0 2px 8px rgba(0,0,0,0.25);';
    labelColor = '#fbbf24'; // amber-400 — gold tier label color on site
  } else {
    badgeBg = tier.bg;
    badgeFg = tier.fg;
    // Match site's per-tier box-shadow color: same hue at 30% alpha.
    const shadowRgb = {
      '#22c55e': '34,197,94',     // recommended
      '#14b8a6': '20,184,166',    // worth seeing
      '#d97706': '217,119,6',     // skippable
      '#ef4444': '239,68,68',     // critical miss
    }[tier.bg] || '0,0,0';
    badgeShadow = `box-shadow:0 2px 8px rgba(${shadowRgb},0.3);`;
    labelColor = tier.bg; // tier label inherits tier color
  }

  const badgeNumber = score == null ? 'TBD' : score;
  const badgeFontSize = score == null ? '14px' : '30px';

  const tierLabelText = score == null ? ' ' : tier.label; // nbsp keeps height
  const tierLabelHtml = `<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${labelColor};white-space:nowrap;line-height:1.4;">${esc(tierLabelText)}</div>`;

  // Badge: block-level div with line-height = height for vertical centering.
  // This is the canonical email-safe centering pattern.
  const badgeHtml = `<div style="display:block;width:80px;height:80px;margin:0 auto;border-radius:12px;background:${badgeBg};color:${badgeFg};font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:${badgeFontSize};font-weight:800;line-height:80px;text-align:center;letter-spacing:-0.02em;${badgeShadow}">${badgeNumber}</div>`;

  // Audience chip — site copies the grade color into bg (12.5% alpha) and text.
  let audienceChipHtml;
  if (row.audience && row.audience.score != null) {
    const g = audienceGrade(row.audience.score);
    audienceChipHtml = `<span style="display:inline-block;padding:3px 9px;border-radius:9999px;background-color:${g.color}20;color:${g.color};font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:10px;line-height:1;font-weight:700;letter-spacing:0.02em;"><span style="opacity:0.6;font-weight:600;">Audience:</span> ${esc(g.grade)}</span>`;
  } else {
    audienceChipHtml = `<span style="display:inline-block;padding:3px 9px;border-radius:9999px;background-color:rgba(107,114,128,0.20);color:#9ca3af;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:10px;line-height:1;font-weight:700;letter-spacing:0.02em;"><span style="opacity:0.6;font-weight:600;">Audience:</span> —</span>`;
  }

  // Vertical stack via 3-row table (most reliable email layout).
  return `<table cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;margin:0 auto;">
    <tr><td style="text-align:center;padding-bottom:6px;">${tierLabelHtml}</td></tr>
    <tr><td style="text-align:center;">${badgeHtml}</td></tr>
    <tr><td style="text-align:center;padding-top:6px;">${audienceChipHtml}</td></tr>
  </table>`;
}

// Common metadata pills used on every row — same set/order the site uses on cards.
function metadataPills(row) {
  const pills = [];
  pills.push(formatPill(row.type || 'play'));
  pills.push(productionPill(row.isRevival));
  const cat = categoryBadge(row.market);
  if (cat) pills.push(cat);
  if (row.important && row.market !== 'broadway' && row.market !== 'west-end') {
    pills.push(sitePill('★ Important', { color: TOKENS.brand, bg: TOKENS.brandMuted }));
  }
  return pills.join(PILL_SEP);
}

// Site-faithful row: 3-column table — thumbnail | content | score column.
// Matches src/components/show-cards/ShowListCard.tsx exactly: thumb on left,
// title + pills + secondary line in the middle, score stack on right.
function renderShowCardRow(row, { actionPills = '', secondaryLine = '' } = {}) {
  return `
  <tr style="border-top:1px solid ${TOKENS.borderSubtle};">
    <td style="padding:14px 0 14px 0;vertical-align:middle;width:96px;">${thumbnailHtml(row)}</td>
    <td style="padding:14px 16px;vertical-align:middle;">
      <div style="font-size:17px;font-weight:700;line-height:1.25;color:${TOKENS.text};"><a href="${esc(row.url)}" style="color:${TOKENS.text};text-decoration:none;">${esc(row.title)}</a></div>
      <div style="margin-top:6px;">${metadataPills(row)}</div>
      ${secondaryLine ? `<div style="margin-top:10px;font-size:13px;color:${TOKENS.textMuted};line-height:1.5;">${secondaryLine}</div>` : ''}
      ${actionPills ? `<div style="margin-top:10px;">${actionPills}</div>` : ''}
    </td>
    <td style="padding:14px 0 14px 0;vertical-align:middle;width:104px;text-align:center;">${scoreColumnHtml(row)}</td>
  </tr>`;
}

// Recent: secondary line shows when opened + review progress
function renderRecentSecondary(row) {
  const when = `<span style="color:${TOKENS.textDim};">${esc(whenLabel(row.daysFromToday))} · ${esc(formatHumanDate(row.date))}</span>`;
  let progress;
  if (row.expected && row.reviewCount < row.expected) {
    progress = `<span style="color:${TOKENS.textMuted};">${row.reviewCount} reviews (expected ~${row.expected})</span>`;
  } else if (row.expected && row.reviewCount >= row.expected) {
    progress = `<span style="color:${TOKENS.textMuted};">${row.reviewCount} reviews <span style="color:${TOKENS.open};">✓ on track</span></span>`;
  } else {
    progress = `<span style="color:${TOKENS.textMuted};">${row.reviewCount} reviews</span>`;
  }
  const broadcastNote = row.broadcastSent === true
    ? `<br><span style="color:${TOKENS.open};font-weight:600;">✓ Broadcast sent</span>`
    : '';
  return `${when}<br>${progress}${broadcastNote}`;
}

// Upcoming: secondary line shows when opening + expected count
function renderUpcomingSecondary(row) {
  const when = `<span style="color:${TOKENS.textDim};">${esc(whenLabel(row.daysFromToday))} · ${esc(formatHumanDate(row.date))}</span>`;
  let expected;
  if (row.expected) {
    expected = `<span style="color:${TOKENS.textMuted};">Expects <strong style="color:${TOKENS.text};">${row.expected}</strong> reviews <span style="color:${TOKENS.textDim};">(typical ${row.expectedRange})</span></span>`;
  } else if (row.excluded) {
    expected = `<span style="color:${TOKENS.textDim};">Excluded from predictions</span>`;
  } else {
    expected = `<span style="color:${TOKENS.textDim};">Expected reviews: TBD</span>`;
  }
  return `${when}<br>${expected}`;
}

function renderUpcomingRow(row) {
  return renderShowCardRow(row, { secondaryLine: renderUpcomingSecondary(row) });
}

function renderNeedsHelpRow(row) {
  const reasons = (row.helpReasons || []).join(' · ');
  const action = [
    sitePill('⚠ Needs help', { color: TOKENS.warn, bg: 'rgba(217,119,6,0.20)' }),
    PILL_SEP,
    sitePill(reasons, { color: TOKENS.textMuted, bg: TOKENS.surfaceOverlay }),
  ].join('');
  return renderShowCardRow(row, { actionPills: action, secondaryLine: renderRecentSecondary(row) });
}

function renderBroadcastReadyRow(row) {
  return renderShowCardRow(row, {
    actionPills: sitePill('✉ Broadcast ready', { color: TOKENS.brand, bg: TOKENS.brandMuted }),
    secondaryLine: renderRecentSecondary(row),
  });
}

// Small score badge for the compact "other" rows — number only, no tier label
// or audience chip. A fixed SQUARE (a mini version of the card's 80×80 badge),
// not a wide capsule: padding-based pills render ~60×32 (ratio ~1.9) and read
// as squished next to the square card badges above them. Uses the same
// email-safe centering as scoreColumnHtml (line-height = height; Gmail ignores
// inline-flex). The glow border adds to both axes equally, so it stays square.
function smallScorePill(row) {
  const score = row.criticScore;
  const square = `display:inline-block;width:40px;height:40px;line-height:40px;border-radius:8px;text-align:center;font-weight:800;letter-spacing:-0.02em;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;`;
  if (score == null) {
    return `<span style="${square}background:${TOKENS.surfaceOverlay};border:1px solid ${TOKENS.border};color:#9ca3af;font-size:13px;">TBD</span>`;
  }
  const tier = criticTier(score, row.market);
  const glow = tier.glow ? 'border:2px solid #C8960E;' : '';
  return `<span style="${square}background:${tier.bg};color:${tier.fg};font-size:18px;${glow}">${score}</span>`;
}

// Small 48×48 square thumbnail for the compact rows — same poster as the full
// card, scaled down. Keeps low-signal sections visually consistent with the
// action sections (a region that is all "other" shouldn't read as broken/bare)
// while staying lighter than the full card (no metadata pills, no score column).
function compactThumbnailHtml(row) {
  if (row.thumbnail) {
    return `<img src="${esc(row.thumbnail)}" alt="${esc(row.title)}" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:6px;object-fit:cover;background:${TOKENS.surfaceOverlay};">`;
  }
  return `<div style="width:48px;height:48px;background:${TOKENS.surfaceOverlay};border-radius:6px;"></div>`;
}

// Compact one-line row for low-signal sections. Small poster, no metadata pills,
// no score column — just title · market, a status line, and a small score pill
// on the right. Keeps "Other recent/upcoming" from drowning the action items
// above them while still reading as a real card, not a stripped-down list.
function renderCompactRow(row, kind) {
  const when = `${esc(whenLabel(row.daysFromToday))} · ${esc(formatHumanDate(row.date))}`;
  let status;
  if (kind === 'upcoming') {
    if (row.expected) status = `expects ~${row.expected} reviews`;
    else if (row.excluded) status = 'excluded from predictions';
    else status = 'expected reviews TBD';
  } else {
    const n = `${row.reviewCount} review${row.reviewCount === 1 ? '' : 's'}`;
    if (row.broadcastSent === true) status = `${n} · ✓ broadcast sent`;
    else if (row.expected && row.reviewCount >= row.expected) status = `${n} · ✓ on track`;
    else if (row.expected) status = `${n} (expected ~${row.expected})`;
    else status = n;
  }
  return `
  <tr style="border-top:1px solid ${TOKENS.borderSubtle};">
    <td style="padding:10px 10px 10px 0;vertical-align:middle;width:48px;">${compactThumbnailHtml(row)}</td>
    <td style="padding:10px 12px 10px 0;vertical-align:middle;">
      <a href="${esc(row.url)}" style="color:${TOKENS.text};text-decoration:none;font-size:14px;font-weight:600;">${esc(row.title)}</a>
      <span style="color:${TOKENS.textDim};font-size:12px;font-weight:500;"> · ${esc(row.marketLabel)}</span>
      <div style="margin-top:3px;color:${TOKENS.textMuted};font-size:12px;line-height:1.4;">${when} · ${status}</div>
    </td>
    <td style="padding:10px 0;vertical-align:middle;width:56px;text-align:right;">${smallScorePill(row)}</td>
  </tr>`;
}

function renderCompactRecentRow(row) { return renderCompactRow(row, 'recent'); }
function renderCompactUpcomingRow(row) { return renderCompactRow(row, 'upcoming'); }

function renderSection(title, count, bodyHtml) {
  return `
    <h2 style="margin:32px 0 4px 0;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:${TOKENS.brand};">${esc(title)} <span style="color:${TOKENS.textDim};font-weight:500;">· ${count}</span></h2>
    ${bodyHtml}`;
}

function renderTable(rows, renderRow) {
  if (!rows || rows.length === 0) return '';
  return `<table style="width:100%;border-collapse:collapse;">${rows.map(renderRow).join('')}</table>`;
}

// The lead clause (no date) doubles as the folded-in morning email's
// bannerText (card #497) — buildSubject appends the date on top of it.
function buildDigestLead({ needsHelp, broadcastReady, comingUp }) {
  const parts = [];
  if (needsHelp.length) parts.push(`${needsHelp.length} need${needsHelp.length === 1 ? 's' : ''} help`);
  if (broadcastReady.length) parts.push(`${broadcastReady.length} broadcast-ready`);
  const openingToday = comingUp.filter(r => r.daysFromToday === 0).length;
  if (openingToday) parts.push(`${openingToday} opening today`);
  const openingTomorrow = comingUp.filter(r => r.daysFromToday === 1).length;
  if (openingTomorrow && !openingToday) parts.push(`${openingTomorrow} tomorrow`);
  return parts.length ? parts.join(' · ') : (comingUp.length ? `${comingUp.length} upcoming this week` : 'Quiet week');
}

function buildSubject(sections) {
  const todayHuman = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${buildDigestLead(sections)} · ${todayHuman}`;
}

// Per-region brand: NYC = Broadway gold (#d4a574), London = West End pink
// (#f472b6). Source of truth: src/config/branding.ts MARKET_BRAND.
const REGION_BRAND = {
  nyc:    { label: '🗽 NYC',    color: '#d4a574', subtitle: 'Broadway · Off-Broadway' },
  london: { label: '🇬🇧 London', color: '#f472b6', subtitle: 'West End · Off-West-End' },
};

function renderRegionBlock(regionKey, sections) {
  const brand = REGION_BRAND[regionKey];
  const { needsHelp, broadcastReady, comingUp, otherRecent, otherUpcoming } = sections;
  const total = needsHelp.length + broadcastReady.length + comingUp.length + otherRecent.length + otherUpcoming.length;

  // Header band: pill-style chip with the market's brand color as a solid
  // background. Big enough to read at a glance — this is the "which market
  // am I looking at" anchor for the whole section.
  const headerHtml = `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 14px 0;border-collapse:collapse;">
      <tr>
        <td style="background:${brand.color};border-radius:10px 10px 0 0;padding:14px 18px;">
          <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;color:#1a1a1a;letter-spacing:-0.01em;line-height:1.1;">${esc(brand.label)}<span style="color:#1a1a1a;opacity:0.55;font-weight:600;font-size:14px;margin-left:10px;letter-spacing:0;">${esc(brand.subtitle)}</span><span style="color:#1a1a1a;opacity:0.55;font-weight:600;font-size:14px;float:right;">${total} show${total === 1 ? '' : 's'}</span></div>
        </td>
      </tr>
    </table>`;

  if (total === 0) {
    return `
      <div style="margin:40px 0 16px 0;">
        ${headerHtml}
        <div style="margin:18px 0;color:${TOKENS.textDim};font-size:13px;font-style:italic;">No activity in the last 7 days or next 7 days.</div>
      </div>`;
  }

  let inner = '';
  if (needsHelp.length) inner += renderSection('Needs help', needsHelp.length, renderTable(needsHelp, renderNeedsHelpRow));
  if (broadcastReady.length) inner += renderSection('Broadcast ready', broadcastReady.length, renderTable(broadcastReady, renderBroadcastReadyRow));
  if (comingUp.length) inner += renderSection('Coming up', comingUp.length, renderTable(comingUp, renderUpcomingRow));
  if (otherRecent.length) inner += renderSection('Other recent (last 7 days)', otherRecent.length, renderTable(otherRecent, renderCompactRecentRow));
  if (otherUpcoming.length) inner += renderSection('Other upcoming (next 7 days)', otherUpcoming.length, renderTable(otherUpcoming, renderCompactUpcomingRow));
  return `
    <div style="margin:40px 0 16px 0;">
      ${headerHtml}
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

  let body = renderRegionBlock('nyc', nycSections) + renderRegionBlock('london', londonSections);
  if (!body) {
    body = `<div style="margin:48px 0;text-align:center;color:${TOKENS.textMuted};font-size:14px;">Nothing to report — no openings in the last or next 7 days.</div>`;
  }

  return `<!DOCTYPE html><html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <!-- Inter is the site's body font. Apple Mail loads this; Gmail web sanitizes
       it out and falls back to the SF Pro / Segoe UI stack below — those render
       close enough that headings/badges still look like the site. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap">
  <style>
    body, table, td, span, div, a, h1, h2, h3, p {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
    }
  </style>
  </head><body style="margin:0;padding:0;background:${TOKENS.surface};font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TOKENS.text};">
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
// Resend send (restored 2026-07-30 — owner asked for the standalone email back)
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
      // Same success contract as send-morning-digest.js (ship-check codex
      // finding): only 2xx is a send, and a hung socket must fail the run
      // (which alerts via notify-failure) rather than hang the job.
      timeout: 15000,
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Resend request timed out after 15s')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `send-opening-digest.js — daily standalone opening-night radar email (rule 17: one explicit recipient).

Usage:
  node scripts/send-opening-digest.js                   send to the owner
  node scripts/send-opening-digest.js --send-to=EMAIL   override recipient
  node scripts/send-opening-digest.js --dry-run         print subject + HTML, send nothing
  --help, -h   show this message, do nothing else`;

async function main() {
  // --help must never fall through to a real send (bug class #498/#260).
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

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
  const res = await postJSON('https://api.resend.com/emails', {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [SEND_TO],
    subject,
    html,
  }, {
    'Authorization': `Bearer ${RESEND_API_KEY}`,
  });
  console.log(`Sent. ${subject} (id ${res?.id || '?'})`);
}

// Exported for unit tests (tests/unit/opening-digest-gates.test.mjs + the
// subject↔classifier parity test in scheduled-email-count-rules.test.mjs).
// The display gates are the load-bearing trust logic — test the real fns.
module.exports = { minReviewsToShowScore, getAudience, MIN_AUDIENCE_REVIEWS, buildSubject, buildDigestLead };

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
