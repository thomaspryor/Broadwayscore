/**
 * email-templates.js
 *
 * Shared email template builders for both per-show follow notifications
 * and opening-night broadcast emails.
 *
 * Extracted from send-follow-notifications.js (Sprint 2, S2-T1).
 */

const https = require('https');
const { isLondonMarket } = require('./venue-classification');
const BRAND = require('./brand-colors');

// Canonical brand values — see scripts/lib/brand-colors.js for full palette.
// The hardcoded hex throughout this file (#d4a574, #0f0f14, etc.) must match
// BRAND. When adding new templates, use BRAND.* constants instead of hex literals.
const FONT = BRAND.font.family;

function postJSON(url, body, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(responseBody)); } catch { resolve(responseBody); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getScoreColor(score) {
  if (score == null) return { bg: '#6b7280', text: '#ffffff', label: 'TBD' };
  if (score >= 83) return { bg: '#FFD700', bgGradient: 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)', text: '#1a1a1a', label: 'Critical Gold' };
  if (score >= 75) return { bg: '#22c55e', text: '#ffffff', label: 'Recommended' };
  if (score >= 65) return { bg: '#14b8a6', text: '#ffffff', label: 'Worth Seeing' };
  if (score >= 55) return { bg: '#d97706', text: '#1a1a1a', label: 'Skippable' };
  return { bg: '#ef4444', text: '#ffffff', label: 'Critical Miss' };
}

// Single source of truth for the 4-tier breakdown bar + label row.
// Both buildOpeningNightHtml and buildBroadcastOpeningNightHtml call this so
// the two templates can never silently diverge (as happened in Apr 2026).
function buildBreakdownHtml(rave, positive, mixed, negative) {
  const total = rave + positive + mixed + negative;
  if (total === 0) return '';

  // Hamilton largest-remainder method with min-1px guarantee for non-zero buckets.
  // Simple residual math (100 - a - b - c) can produce a 0-width bar segment for
  // a small bucket when larger ones round up — making the label row inconsistent
  // with the visual bar (e.g. "1 Positive" label but no green segment visible).
  const slots = [
    { key: 'raveW', n: rave },
    { key: 'posW',  n: positive },
    { key: 'mixW',  n: mixed },
    { key: 'negW',  n: negative },
  ];
  const active = slots.filter(s => s.n > 0);
  active.forEach(s => { s.exact = s.n / total * 100; s.w = Math.max(1, Math.floor(s.exact)); });
  let spare = 100 - active.reduce((sum, s) => sum + s.w, 0);
  if (spare > 0) {
    active.slice().sort((a, b) => (b.exact % 1) - (a.exact % 1))
      .forEach((s, i) => { if (i < spare) s.w++; });
  } else if (spare < 0) {
    // min-1 over-allocated (very skewed distributions); trim from the largest buckets
    active.slice().sort((a, b) => b.w - a.w)
      .forEach(s => { if (spare < 0 && s.w > 1) { s.w--; spare++; } });
  }
  const widths = Object.fromEntries(slots.map(s => [s.key, active.find(a => a.key === s.key)?.w ?? 0]));
  const { raveW, posW, mixW, negW } = widths;

  return `
  <tr><td style="padding:16px 24px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
      <tr>
        ${raveW > 0 ? `<td style="width:${raveW}%;height:8px;background-color:#FFD700;"></td>` : ''}
        ${posW > 0 ? `<td style="width:${posW}%;height:8px;background-color:#22c55e;"></td>` : ''}
        ${mixW > 0 ? `<td style="width:${mixW}%;height:8px;background-color:#d97706;"></td>` : ''}
        ${negW > 0 ? `<td style="width:${negW}%;height:8px;background-color:#ef4444;"></td>` : ''}
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 24px 0;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${[
          rave > 0     ? { color: '#FFD700', count: rave,     label: 'Rave'     } : null,
          positive > 0 ? { color: '#22c55e', count: positive, label: 'Positive' } : null,
          mixed > 0    ? { color: '#d97706', count: mixed,    label: 'Mixed'    } : null,
          negative > 0 ? { color: '#ef4444', count: negative, label: 'Negative' } : null,
        ].filter(Boolean).map((seg, i, arr) => {
          const align = i === 0 ? 'left' : i === arr.length - 1 ? 'right' : 'center';
          return `<td align="${align}" style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
            <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background-color:${seg.color};vertical-align:middle;margin-right:4px;"></span><span style="font-weight:600;color:${seg.color};">${seg.count}</span> ${seg.label}
          </td>`;
        }).join('')}
      </tr>
    </table>
  </td></tr>`;
}

// Map change types to show page section anchors for deep linking
function getChangeAnchor(changeType) {
  switch (changeType) {
    case 'lottery-added': return '#discount-tickets';
    case 'cast-change': return '#cast-updates-heading';
    case 'new-reviews':
    case 'score-change': return '#critic-reviews';
    default: return '';
  }
}

function buildUnfollowUrl(showId, showTitle, email) {
  return `https://broadwayscorecard.com/unfollow?email=${encodeURIComponent(email)}&show=${encodeURIComponent(showId)}&title=${encodeURIComponent(showTitle)}`;
}

function buildUnsubscribeUrl(email, market) {
  const base = `https://broadwayscorecard.com/unsubscribe?email=${encodeURIComponent(email)}`;
  return isLondonMarket(market) ? `${base}&market=west-end` : base;
}

function buildFooterHtml(showTitle, showId, email, market) {
  const unfollowUrl = buildUnfollowUrl(showId, showTitle, email);
  const isWE = isLondonMarket(market);
  const siteName = isWE ? 'West End Scorecard' : 'Broadway Scorecard';
  const siteUrl = isWE ? 'https://broadwayscorecard.com/west-end' : 'https://broadwayscorecard.com';
  return `<tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;font-family:${FONT};">
      You're receiving this because you followed ${escapeHtml(showTitle)} on <a href="${siteUrl}" style="color:#d4a574;">${siteName}</a>.<br>
      <a href="${escapeHtml(unfollowUrl)}" style="color:rgba(255,255,255,0.35);">Unfollow this show</a>
    </p>
  </td></tr>`;
}

/**
 * Follow-us row for the opening-night broadcast (Option C: above unsubscribe footer).
 * Text-only by design: SVG renders inconsistently in Outlook Desktop / Gmail; PNG hotlinks
 * add a dependency we don't need here. Upgrade to PNG icons later if CTR warrants it.
 */
const SOCIAL_ACCOUNTS_EMAIL = [
  { label: 'Instagram', url: 'https://instagram.com/bwayscorecard' },
  { label: 'Threads', url: 'https://threads.net/@bwayscorecard' },
  { label: 'Bluesky', url: 'https://bsky.app/profile/bwayscorecard.bsky.social' },
  { label: 'X', url: 'https://x.com/BwayScorecard' },
  { label: 'Facebook', url: 'https://facebook.com/BroadwayScorecard' },
];

function buildSocialRowHtml(market) {
  const isWE = isLondonMarket(market);
  const brandColor = isWE ? '#f472b6' : '#d4a574';
  const links = SOCIAL_ACCOUNTS_EMAIL.map(
    (a) => `<a href="${escapeHtml(a.url)}" style="color:${brandColor};text-decoration:none;font-weight:600;" target="_blank" rel="noopener">${escapeHtml(a.label)}</a>`
  ).join(`<span style="color:rgba(255,255,255,0.2);padding:0 8px;">&middot;</span>`);
  return `<tr><td align="center" style="padding:16px 0 24px;">
    <p style="margin:0 0 10px;font-size:11px;font-weight:600;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:1.2px;font-family:${FONT};">Follow Broadway Scorecard</p>
    <p style="margin:0;font-size:13px;line-height:1.6;font-family:${FONT};">${links}</p>
  </td></tr>`;
}

function buildBroadcastFooterHtml(email, market) {
  // When email is null, use Resend's unsubscribe template variable (for drafts/broadcasts).
  // When email is provided, use our custom unsubscribe URL (for transactional/preview sends).
  // NOTE: Resend uses {{{RESEND_UNSUBSCRIBE_URL}}} (triple braces). The script targets
  // Resend; if we ever switch back to Buttondown, this becomes {{ unsubscribe_url }}.
  const unsubscribeUrl = email ? buildUnsubscribeUrl(email, market) : '{{{RESEND_UNSUBSCRIBE_URL}}}';
  const isWE = isLondonMarket(market);
  const siteName = isWE ? 'West End Scorecard' : 'Broadway Scorecard';
  const siteUrl = isWE ? 'https://broadwayscorecard.com/west-end' : 'https://broadwayscorecard.com';
  return `<tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;font-family:${FONT};">
      You're receiving this because you subscribed to <a href="${siteUrl}" style="color:#d4a574;">${siteName}</a>.<br>
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:rgba(255,255,255,0.35);">Unsubscribe from opening night alerts</a>
    </p>
  </td></tr>`;
}

function buildEmailHtml(showTitle, changes, showUrl, showId, email, market) {
  market = market || 'broadway';
  const isWE = isLondonMarket(market);
  const siteNameFirst = isWE ? 'West End' : 'Broadway';
  const brandColor = isWE ? '#f472b6' : '#d4a574';
  const changesHtml = changes.map(c => {
    const anchor = getChangeAnchor(c.type);
    const linkUrl = `${showUrl}${anchor}`;
    return `<tr><td style="padding:8px 20px;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.5;font-family:${FONT};border-left:2px solid #d4a574;">&#8226;&nbsp; <a href="${escapeHtml(linkUrl)}" style="color:rgba(255,255,255,0.85);text-decoration:underline;text-decoration-color:rgba(255,255,255,0.2);text-underline-offset:2px;">${escapeHtml(c.message)}</a></td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body bgcolor="#0f0f14" style="margin:0;padding:0;background-color:#0f0f14;background:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f0f14" style="background-color:#0f0f14;background:#0f0f14;padding:32px 16px;">
<tr><td align="center" bgcolor="#0f0f14">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">${siteNameFirst}</span><span style="font-size:22px;font-weight:800;color:${brandColor};letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">Updates for ${escapeHtml(showTitle)}</h1>
  </td></tr>
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#1a1a24" style="background-color:#1a1a24;background:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:16px 20px 4px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">What's new</p>
      </td></tr>
      ${changesHtml}
      <tr><td style="padding-bottom:12px;"></td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="${escapeHtml(showUrl)}" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">View Full Details</a>
  </td></tr>
  ${buildFooterHtml(showTitle, showId, email, market)}
</table>
</td></tr></table>
</body></html>`;
}

function buildOpeningNightHtml(showTitle, openingChange, otherChanges, showUrl, showId, email, imageUrl, market) {
  market = market || 'broadway';
  const isWE = isLondonMarket(market);
  const siteNameFirst = isWE ? 'West End' : 'Broadway';
  const brandColor = isWE ? '#f472b6' : '#d4a574';
  const sc = getScoreColor(openingChange.score);
  const scoreDisplay = openingChange.score != null ? Math.round(openingChange.score) : '?';
  const reviewCount = openingChange.reviewCount || 0;
  const rave = openingChange.rave || 0;
  const positive = openingChange.positive || 0;
  const mixed = openingChange.mixed || 0;
  const negative = openingChange.negative || 0;
  const total = rave + positive + mixed + negative;

  // Review subtitle
  const reviewSubtitle = reviewCount > 0
    ? `Based on ${reviewCount} Critic Review${reviewCount !== 1 ? 's' : ''}`
    : 'Reviews pending';

  const breakdownHtml = buildBreakdownHtml(rave, positive, mixed, negative);

  // Consensus block (only show if available)
  const consensusHtml = openingChange.consensusText ? `
  <tr><td style="padding:20px 24px 0;">
    <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Critics' Take</p>
    <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.75);line-height:1.6;font-family:${FONT};">${escapeHtml(openingChange.consensusText)}</p>
  </td></tr>` : '';

  // Show type + venue line
  const metaParts = [];
  if (openingChange.showType) metaParts.push(openingChange.showType);
  if (openingChange.venue) metaParts.push(openingChange.venue);
  const metaHtml = metaParts.length > 0 ? `
  <tr><td style="padding:16px 24px 0;">
    <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.35);font-family:${FONT};">${escapeHtml(metaParts.join(' \u00B7 '))}</p>
  </td></tr>` : '';

  // Other changes (lottery added, etc.) as bullet items below the card
  const otherHtml = otherChanges.length > 0 ? `
  <tr><td style="padding:20px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:16px 20px 4px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Also new</p>
      </td></tr>
      ${otherChanges.map(c => {
        const anchor = getChangeAnchor(c.type);
        const linkUrl = `${showUrl}${anchor}`;
        return `<tr><td style="padding:8px 20px;font-size:15px;color:rgba(255,255,255,0.85);line-height:1.5;font-family:${FONT};border-left:2px solid #d4a574;">&#8226;&nbsp; <a href="${escapeHtml(linkUrl)}" style="color:rgba(255,255,255,0.85);text-decoration:underline;text-decoration-color:rgba(255,255,255,0.2);text-underline-offset:2px;">${escapeHtml(c.message)}</a></td></tr>`;
      }).join('')}
      <tr><td style="padding-bottom:12px;"></td></tr>
    </table>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body bgcolor="#0f0f14" style="margin:0;padding:0;background-color:#0f0f14;background:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f0f14" style="background-color:#0f0f14;background:#0f0f14;padding:32px 16px;">
<tr><td align="center" bgcolor="#0f0f14">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">${siteNameFirst}</span><span style="font-size:22px;font-weight:800;color:${brandColor};letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">${escapeHtml(showTitle)} Critic Reviews Are In${openingChange.score != null ? ` \u2014 Critic Score: ${Math.round(openingChange.score)}` : ''}</h1>
  </td></tr>${imageUrl ? `
  <tr><td style="padding:16px 0 0;">
    <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(showTitle)}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;" />
  </td></tr>` : ''}
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#1a1a24" style="background-color:#1a1a24;background:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:24px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td width="72" height="72" bgcolor="${sc.bg}" style="width:72px;height:72px;background-color:${sc.bg};background:${sc.bgGradient || sc.bg};border-radius:12px;text-align:center;vertical-align:middle;">
              <font color="${sc.text}"><span style="font-size:32px;font-weight:800;color:${sc.text};font-family:${FONT};line-height:72px;">${scoreDisplay}</span></font>
            </td>
            <td style="padding-left:16px;vertical-align:middle;">
              <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:${sc.bg};font-family:${FONT};">${sc.label}</p>
              <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.5);font-family:${FONT};">${reviewSubtitle}</p>
            </td>
          </tr>
        </table>
      </td></tr>
      ${breakdownHtml}
      ${consensusHtml}
      ${metaHtml}
      ${reviewCount > 0 ? `<tr><td style="padding:20px 24px 0;" align="center">
        <a href="${escapeHtml(showUrl)}#critic-reviews" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">See The Reviews</a>
      </td></tr>` : ''}
      <tr><td style="padding-bottom:20px;"></td></tr>
    </table>
  </td></tr>
  ${otherHtml}
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="${escapeHtml(showUrl)}" style="display:inline-block;padding:10px 24px;background-color:rgba(255,255,255,0.08);color:#d4a574;font-size:13px;font-weight:600;text-decoration:none;border-radius:6px;border:1px solid rgba(212,165,116,0.2);font-family:${FONT};">View Full Details</a>
  </td></tr>
  ${buildFooterHtml(showTitle, showId, email, market)}
</table>
</td></tr></table>
</body></html>`;
}

/**
 * Subject line for opening night broadcast emails.
 * Extracted so it can be tested independently of the send script.
 * @param {Array<{showTitle: string}>} shows
 * @param {string} [market='broadway']
 * @returns {string}
 */
function buildBroadcastSubjectLine(shows, market) {
  market = market || 'broadway';
  if (shows.length === 1) {
    return `${shows[0].showTitle} is now open, and the critic reviews are in`;
  }
  const location = isLondonMarket(market) ? 'in the West End' : 'on Broadway';
  return `${shows.length} shows opened ${location} \u2014 the reviews are in`;
}

/**
 * Build opening-night broadcast email for general subscribers.
 * Supports single or multiple shows in one email.
 *
 * @param {Array<{showTitle, score, reviewCount, rave, positive, mixed, negative, consensusText, showType, venue, showUrl, imageUrl}>} shows
 * @param {string} email - Subscriber email (for unsubscribe link)
 * @param {string} [market='broadway'] - 'broadway' or 'west-end'
 * @returns {string} HTML email
 */
function buildBroadcastOpeningNightHtml(shows, email, market) {
  market = market || 'broadway';
  const isWE = isLondonMarket(market);
  const siteNameFirst = isWE ? 'West End' : 'Broadway';
  const brandColor = isWE ? '#f472b6' : '#d4a574';
  const brandFaint = isWE ? 'rgba(244,114,182,0.12)' : 'rgba(212,165,116,0.12)';
  const brandMuted = isWE ? 'rgba(244,114,182,0.6)' : 'rgba(212,165,116,0.6)';
  const brandSubtle = isWE ? 'rgba(244,114,182,0.2)' : 'rgba(212,165,116,0.2)';
  const browseUrl = isWE ? 'https://broadwayscorecard.com/west-end' : 'https://broadwayscorecard.com';
  // Build a score card for each show
  const showCards = shows.map(show => {
    const sc = getScoreColor(show.score);
    const scoreDisplay = show.score != null ? Math.round(show.score) : '?';
    const reviewCount = show.reviewCount || 0;
    const rave = show.rave || 0;
    const positive = show.positive || 0;
    const mixed = show.mixed || 0;
    const negative = show.negative || 0;
    const total = rave + positive + mixed + negative;

    const reviewSubtitle = reviewCount > 0
      ? `Based on ${reviewCount} Critic Review${reviewCount !== 1 ? 's' : ''}`
      : 'Reviews pending';

    const breakdownHtml = buildBreakdownHtml(rave, positive, mixed, negative);

    const consensusHtml = show.consensusText ? `
      <tr><td style="padding:20px 24px 0;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:${brandMuted};text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Critics' Take</p>
        <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.75);line-height:1.6;font-family:${FONT};">${escapeHtml(show.consensusText)}</p>
      </td></tr>` : '';

    const metaParts = [];
    if (show.showType) metaParts.push(show.showType);
    if (show.venue) metaParts.push(show.venue);
    const metaHtml = metaParts.length > 0 ? `
      <tr><td style="padding:16px 24px 0;">
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.35);font-family:${FONT};">${escapeHtml(metaParts.join(' \u00B7 '))}</p>
      </td></tr>` : '';

    const reviewsHref = `${escapeHtml(show.showUrl)}#critic-reviews`;
    return `
  ${shows.length > 1 ? `<tr><td style="padding:24px 0 8px;">
    <h2 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">${escapeHtml(show.showTitle)}</h2>
  </td></tr>` : ''}${show.imageUrl ? `
  <tr><td style="padding:${shows.length > 1 ? '8' : '16'}px 0 0;">
    <a href="${reviewsHref}" style="display:block;text-decoration:none;"><img src="${escapeHtml(show.imageUrl)}" alt="${escapeHtml(show.showTitle)}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;border:0;" /></a>
  </td></tr>` : ''}
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#1a1a24" style="background-color:#1a1a24;background:#1a1a24;border-radius:12px;border:1px solid ${brandFaint};">
      <tr><td style="padding:24px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td width="72" height="72" bgcolor="${sc.bg}" style="width:72px;height:72px;background-color:${sc.bg};background:${sc.bgGradient || sc.bg};border-radius:12px;text-align:center;vertical-align:middle;">
              <a href="${reviewsHref}" style="text-decoration:none;display:block;line-height:72px;"><font color="${sc.text}"><span style="font-size:32px;font-weight:800;color:${sc.text};font-family:${FONT};line-height:72px;">${scoreDisplay}</span></font></a>
            </td>
            <td style="padding-left:16px;vertical-align:middle;">
              <a href="${reviewsHref}" style="text-decoration:none;color:inherit;"><p style="margin:0 0 4px;font-size:18px;font-weight:700;color:${sc.bg};font-family:${FONT};">${sc.label}</p>
              <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.5);font-family:${FONT};">${reviewSubtitle}</p></a>
            </td>
          </tr>
        </table>
      </td></tr>
      ${breakdownHtml}
      ${consensusHtml}
      ${metaHtml}
      ${reviewCount > 0 ? `<tr><td style="padding:20px 24px 0;" align="center">
        <a href="${escapeHtml(show.showUrl)}#critic-reviews" style="display:inline-block;padding:12px 32px;background-color:${brandColor};color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">See The Reviews</a>
      </td></tr>` : ''}
      <tr><td style="padding-bottom:20px;"></td></tr>
    </table>
  </td></tr>`;
  });

  // H1: single show or multi-show
  const h1 = shows.length === 1
    ? `${escapeHtml(shows[0].showTitle)} Critic Reviews Are In${shows[0].score != null ? ` \u2014 Critic Score: ${Math.round(shows[0].score)}` : ''}`
    : `${shows.length} Shows Opened Tonight \u2014 The Reviews Are In`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body bgcolor="#0f0f14" style="margin:0;padding:0;background-color:#0f0f14;background:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f0f14" style="background-color:#0f0f14;background:#0f0f14;padding:32px 16px;">
<tr><td align="center" bgcolor="#0f0f14">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid ${brandSubtle};">
    <a href="${browseUrl}" style="text-decoration:none;"><span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">${siteNameFirst}</span><span style="font-size:22px;font-weight:800;color:${brandColor};letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span></a>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">${h1}</h1>
  </td></tr>
  ${showCards.join('')}
  <tr><td style="padding:8px 0 8px;" align="center">
    <a href="${browseUrl}" style="display:inline-block;padding:10px 24px;background-color:rgba(255,255,255,0.08);color:${brandColor};font-size:13px;font-weight:600;text-decoration:none;border-radius:6px;border:1px solid ${brandColor}33;font-family:${FONT};">Browse All Shows</a>
  </td></tr>
  ${buildSocialRowHtml(market)}
  ${buildBroadcastFooterHtml(email, market)}
</table>
</td></tr></table>
</body></html>`;
}

/**
 * Build a feedback thank-you email — plain text style, personal, from Tom.
 *
 * @param {'fixed'|'acknowledged'|'praise'|'feature'} type
 * @param {string} name - Submitter's first name (or falsy if unknown)
 * @param {string} [showTitle] - Show name if applicable
 * @returns {{ subject: string, html: string }}
 */
function buildFeedbackThankYouEmail(type, name, showTitle) {
  const greeting = name && name !== 'Anonymous' ? name : null;
  const showRef = showTitle ? escapeHtml(showTitle) : null;

  let subject, body;

  switch (type) {
    case 'fixed':
      subject = showRef ? `Re: ${showTitle}` : 'Re: your feedback';
      body = greeting
        ? `Hi ${escapeHtml(greeting)},\n\nI really appreciate you taking the time to write in${showRef ? ` about ${showRef}` : ''}. You were absolutely right \u2014 we looked into it and just pushed a fix. It should be live now.\n\nThanks again for helping us get this right. Feedback like yours genuinely makes the site better.\n\nTom\nBroadway Scorecard™`
        : `Hi there,\n\nThank you so much for writing in${showRef ? ` about ${showRef}` : ''}. You were absolutely right \u2014 we looked into it and just pushed a fix. It should be live now.\n\nReally appreciate you taking the time. Feedback like yours genuinely makes the site better.\n\nTom\nBroadway Scorecard™`;
      break;

    case 'praise':
      subject = greeting ? `Thanks ${greeting}!` : 'Thank you!';
      body = greeting
        ? `Hi ${escapeHtml(greeting)},\n\nJust wanted to say thank you \u2014 your kind words really made my day. I\u2019m so glad the site is useful to you.\n\nTom\nBroadway Scorecard™`
        : `Hi there,\n\nJust wanted to say thank you \u2014 your kind words really made my day. I\u2019m so glad the site is useful to you.\n\nTom\nBroadway Scorecard™`;
      break;

    case 'feature':
      subject = greeting ? `Thanks ${greeting}!` : 'Thanks for the idea!';
      body = greeting
        ? `Hi ${escapeHtml(greeting)},\n\nReally appreciate you taking the time to share that idea. I\u2019ve added it to our list \u2014 it\u2019s genuinely helpful to hear what people want to see.\n\nTom\nBroadway Scorecard™`
        : `Hi there,\n\nReally appreciate you taking the time to share that idea. I\u2019ve added it to our list \u2014 it\u2019s genuinely helpful to hear what people want to see.\n\nTom\nBroadway Scorecard™`;
      break;

    default: // 'acknowledged'
      subject = showRef ? `Re: ${showTitle}` : 'Re: your feedback';
      body = greeting
        ? `Hi ${escapeHtml(greeting)},\n\nThank you so much for writing in${showRef ? ` about ${showRef}` : ''}. I really appreciate you taking the time \u2014 it means a lot that you\u2019d flag this for us.\n\nWe\u2019ve noted it and will keep it in mind as we keep improving the site.\n\nTom\nBroadway Scorecard™`
        : `Hi there,\n\nThank you so much for writing in${showRef ? ` about ${showRef}` : ''}. I really appreciate you taking the time \u2014 it means a lot that someone would flag this for us.\n\nWe\u2019ve noted it and will keep it in mind as we keep improving the site.\n\nTom\nBroadway Scorecard™`;
      break;
  }

  // Plain text email — minimal HTML, just styled like a normal email
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#333;">
${body.split('\n').map(line => line === '' ? '<br>' : `<p style="margin:0;">${line}</p>`).join('\n')}
</body></html>`;

  return { subject, html };
}

/**
 * Build a fix-approval email — plain text style, personal, from Tom's system.
 * Includes Approve/Reject buttons as simple links.
 *
 * @param {object} opts
 * @param {string} opts.submitterName - Who reported the bug
 * @param {string} opts.showTitle - Show name if applicable
 * @param {string} opts.originalMessage - What the user wrote
 * @param {string} opts.planSummary - Plain-English summary of what Claude will do
 * @param {Array<string>} opts.planSteps - List of concrete steps
 * @param {string} opts.riskLevel - "Low" | "Medium" | "High"
 * @param {string} opts.approveUrl - HMAC-signed approval URL
 * @param {string} opts.rejectUrl - HMAC-signed rejection URL
 * @param {number} opts.issueNumber - GitHub issue number
 * @returns {{ subject: string, html: string }}
 */
function buildFixApprovalEmail(opts) {
  const {
    submitterName, showTitle, originalMessage,
    planSummary, planSteps, riskLevel,
    currentState, verification,
    approveUrl, rejectUrl, issueNumber,
  } = opts;

  const who = submitterName && submitterName !== 'Anonymous' ? submitterName : 'Someone';
  const showRef = showTitle ? ` about ${escapeHtml(showTitle)}` : '';
  const subject = showTitle
    ? `Bug Fix Plan: ${showTitle} (#${issueNumber})`
    : `Bug Fix Plan (#${issueNumber})`;

  const stepsHtml = planSteps
    .map((s, i) => `<p style="margin:0 0 6px;padding-left:20px;">${i + 1}. ${escapeHtml(s)}</p>`)
    .join('\n');

  // Build "current state" section so reviewer can verify the fix makes sense
  let currentStateHtml = '';
  if (currentState && currentState.length > 0) {
    const rows = currentState.map(s => {
      const verifyLink = s.ibdbUrl
        ? ` <a href="${escapeHtml(s.ibdbUrl)}" style="color:#0066cc;font-size:12px;">[verify on IBDB]</a>`
        : '';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">
          <strong>${escapeHtml(s.showTitle)}</strong>${verifyLink}<br>
          <span style="color:#555;font-size:13px;">${escapeHtml(s.field)}: currently ${escapeHtml(s.currentValue)}</span><br>
          <span style="color:#0066cc;font-size:13px;">Change: ${escapeHtml(s.proposedChange)}</span>
        </td>
      </tr>`;
    }).join('\n');

    currentStateHtml = `
<p style="margin:0;font-weight:600;">What the data looks like now:</p>
<br>
<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #ddd;border-radius:6px;margin:0;">
${rows}
</table>
<br>`;
  }

  const messageHtml = originalMessage
    ? `<p style="margin:0;padding-left:16px;border-left:3px solid #ddd;color:#555;font-style:italic;">${escapeHtml(originalMessage)}</p>`
    : `<p style="margin:0;color:#999;font-style:italic;">(no message text available)</p>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#333;">
<p style="margin:0;">${escapeHtml(who)} wrote in${showRef}:</p>
<br>
${messageHtml}
<br>
${currentStateHtml}<p style="margin:0;font-weight:600;">Proposed fix:</p>
<br>
${stepsHtml}
<br>
<p style="margin:0;color:#555;">Risk: ${escapeHtml(riskLevel)} &mdash; ${escapeHtml(planSummary)}</p>
<br>
${verification && !verification.skipped ? (
  verification.passed
    ? `<p style="margin:0 0 12px;padding:8px 12px;background-color:#f0fdf4;border:1px solid #86efac;border-radius:6px;color:#166534;font-size:13px;">&#9989; <strong>Verified by second AI</strong> &mdash; Facts checked, no issues found</p>`
    : `<p style="margin:0 0 12px;padding:8px 12px;background-color:#fef2f2;border:1px solid #fca5a5;border-radius:6px;color:#991b1b;font-size:13px;">&#9888;&#65039; <strong>Verification flagged issues:</strong> ${verification.issues.map(i => escapeHtml(i)).join('; ')}</p>`
) : ''}
<table cellpadding="0" cellspacing="0" border="0" style="margin:0;"><tr>
  <td align="center" bgcolor="#22c55e" style="border-radius:6px;padding:0;"><a href="${escapeHtml(approveUrl)}" style="display:block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">Approve Fix</a></td>
  <td style="width:12px;"></td>
  <td align="center" bgcolor="#ef4444" style="border-radius:6px;padding:0;"><a href="${escapeHtml(rejectUrl)}" style="display:block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">Reject</a></td>
</tr></table>
<br>
<p style="margin:0;color:#999;font-size:13px;">This link expires in 7 days. If you do nothing, no changes are made.</p>
<p style="margin:0;color:#999;font-size:13px;">Issue: <a href="https://github.com/thomaspryor/Broadwayscore/issues/${issueNumber}" style="color:#999;">#${issueNumber}</a></p>
</body></html>`;

  return { subject, html };
}

/**
 * Approval email for broadcast — sent to owner after preview, with "Approve & Send" button.
 */
function buildBroadcastApprovalHtml(shows, approvalUrl, market) {
  market = market || 'broadway';
  const isWE = isLondonMarket(market);
  const marketLabel = isWE ? 'West End' : 'Broadway';
  const brandColor = isWE ? '#f472b6' : '#d4a574';

  const showRows = shows.map(show => {
    const sc = getScoreColor(show.score);
    const scoreDisplay = show.score != null ? Math.round(show.score) : '?';
    return `
      <tr>
        <td style="padding:8px 0;font-family:${FONT};font-size:15px;color:#fff;border-bottom:1px solid rgba(255,255,255,0.1);">
          ${escapeHtml(show.showTitle)}
        </td>
        <td align="right" style="padding:8px 0;font-family:${FONT};font-size:15px;font-weight:700;color:${sc.bg};border-bottom:1px solid rgba(255,255,255,0.1);">
          ${scoreDisplay}
        </td>
        <td align="right" style="padding:8px 0;font-family:${FONT};font-size:13px;color:rgba(255,255,255,0.5);border-bottom:1px solid rgba(255,255,255,0.1);">
          ${show.reviewCount} reviews
        </td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f0f14;">
<tr><td align="center" style="padding:32px 16px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:500px;">

    <!-- Header -->
    <tr><td style="padding:0 0 24px;text-align:center;">
      <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.5);font-family:${FONT};text-transform:uppercase;letter-spacing:1px;">
        ${marketLabel} Broadcast Approval
      </p>
    </td></tr>

    <!-- Title -->
    <tr><td style="padding:0 0 8px;">
      <h1 style="margin:0;font-size:22px;color:#fff;font-family:${FONT};text-align:center;">
        Ready to send opening night ${shows.length === 1 ? 'email' : 'emails'}?
      </h1>
    </td></tr>

    <tr><td style="padding:0 0 24px;">
      <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.6);font-family:${FONT};text-align:center;">
        The following ${shows.length === 1 ? 'show is' : 'shows are'} ready for broadcast:
      </p>
    </td></tr>

    <!-- Show list -->
    <tr><td style="padding:0 0 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.05);border-radius:8px;padding:12px 16px;">
        ${showRows}
      </table>
    </td></tr>

    <!-- CTA Button -->
    <tr><td align="center" style="padding:0 0 24px;">
      <a href="${approvalUrl}" style="display:inline-block;padding:16px 40px;background:${brandColor};color:#1a1a1a;font-size:16px;font-weight:700;font-family:${FONT};text-decoration:none;border-radius:8px;">
        Approve &amp; Send to All Subscribers
      </a>
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:16px 0 0;text-align:center;border-top:1px solid rgba(255,255,255,0.1);">
      <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.35);font-family:${FONT};">
        This link is valid until end of day tomorrow (UTC). If you do nothing, no emails are sent.
      </p>
    </td></tr>

  </table>
</td></tr>
</table>
</body></html>`;
}

function buildDailyDigestHtml(changes, date) {
  const brandColor = '#d4a574';
  const siteUrl = 'https://broadwayscorecard.com';

  function sectionHeader(title) {
    return `<tr><td style="padding:20px 20px 8px;">
      <p style="margin:0;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">${escapeHtml(title)}</p>
    </td></tr>`;
  }

  function extractYear(id) {
    const m = id && id.match(/-(\d{4})$/);
    return m ? m[1] : null;
  }

  function displayTitle(title, item) {
    let label = title;
    const isWE = item && item.market === 'west-end';
    const year = item && extractYear(item.id);
    const suffix = [isWE ? 'WE' : null, year].filter(Boolean).join(' ');
    if (suffix) label += ` (${suffix})`;
    return label;
  }

  function showLink(title, slug, item) {
    return `<a href="${siteUrl}/show/${slug}" style="color:rgba(255,255,255,0.85);text-decoration:underline;text-decoration-color:rgba(255,255,255,0.2);text-underline-offset:2px;">${escapeHtml(displayTitle(title, item))}</a>`;
  }

  function row(content) {
    return `<tr><td style="padding:4px 20px;font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5;font-family:${FONT};border-left:2px solid ${brandColor};">&#8226;&nbsp; ${content}</td></tr>`;
  }

  const sections = [];

  // Suspicious Changes (shown first as a warning)
  if (changes.suspiciousChanges && changes.suspiciousChanges.length > 0) {
    let html = `<tr><td style="padding:20px 20px 8px;">
      <p style="margin:0;font-size:11px;font-weight:600;color:#ef4444;text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">&#9888;&#65039; Suspicious Changes (${changes.suspiciousChanges.length})</p>
    </td></tr>`;
    html += `<tr><td style="padding:4px 20px;font-size:13px;color:#f97316;line-height:1.5;font-family:${FONT};">Shows with &gt;24 new reviews in a single day &mdash; likely a data ingestion issue or wrong-production batch.</td></tr>`;
    for (const r of changes.suspiciousChanges) {
      html += `<tr><td style="padding:4px 20px;font-size:14px;color:#f97316;line-height:1.5;font-family:${FONT};border-left:2px solid #ef4444;">&#8226;&nbsp; ${showLink(r.title, r.slug, r)} &mdash; <strong>+${r.added}</strong> reviews (${r.prevCount || '?'} &rarr; ${r.total})</td></tr>`;
    }
    sections.push(html);
  }

  // Review Spikes (>10 new reviews — possible tour contamination)
  if (changes.reviewSpikes && changes.reviewSpikes.length > 0) {
    let html = `<tr><td style="padding:20px 20px 8px;">
      <p style="margin:0;font-size:11px;font-weight:600;color:#d97706;text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">&#9888; Review Spikes (${changes.reviewSpikes.length})</p>
    </td></tr>`;
    html += `<tr><td style="padding:4px 20px;font-size:13px;color:#d97706;line-height:1.5;font-family:${FONT};">Shows with &gt;10 new reviews in a single day &mdash; check for tour or wrong-production reviews.</td></tr>`;
    for (const r of changes.reviewSpikes) {
      html += `<tr><td style="padding:4px 20px;font-size:14px;color:#d97706;line-height:1.5;font-family:${FONT};border-left:2px solid #d97706;">&#8226;&nbsp; ${showLink(r.title, r.slug, r)} &mdash; <strong>+${r.added}</strong> reviews (${r.prevCount || '?'} &rarr; ${r.total})</td></tr>`;
    }
    sections.push(html);
  }

  // New Shows
  if (changes.newShows.length > 0) {
    let html = sectionHeader(`New Shows (${changes.newShows.length})`);
    for (const s of changes.newShows) {
      const typeLabel = s.type === 'musical' ? 'Musical' : 'Play';
      const statusLabel = s.status === 'previews' ? ' &middot; In Previews' : s.status === 'upcoming' ? ' &middot; Upcoming' : '';
      html += row(`${showLink(s.title, s.slug, s)} &mdash; ${typeLabel}${statusLabel}${s.venue ? ` &middot; ${escapeHtml(s.venue)}` : ''}`);
    }
    sections.push(html);
  }

  // Score Changes — only round-number flips (e.g. 82 → 83). Each line carries
  // the review delta that drove the move + the new total, so we don't repeat
  // the show list in a separate New Reviews section. Sub-integer wobble is
  // filtered out upstream in diffSnapshots.
  if (changes.scoreChanges.length > 0) {
    const sorted = [...changes.scoreChanges].sort((a, b) =>
      Math.abs((b.to ?? 0) - (b.from ?? b.to ?? 0)) - Math.abs((a.to ?? 0) - (a.from ?? a.to ?? 0)));
    let html = sectionHeader(`Score Changes (${changes.scoreChanges.length})`);
    for (const s of sorted) {
      const { bg: fromBg } = s.from != null ? getScoreColor(s.from) : { bg: '#6b7280' };
      const { bg: toBg } = getScoreColor(s.to);
      const arrow = s.direction === 'up' ? '&#9650;' : s.direction === 'down' ? '&#9660;' : '&#9733;';
      const arrowColor = s.direction === 'up' ? '#22c55e' : s.direction === 'down' ? '#ef4444' : brandColor;
      const fromLabel = s.from != null ? `<span style="color:${fromBg};font-weight:700;">${s.from}</span>` : '<span style="color:#6b7280;">—</span>';
      const added = s.reviewsAdded || 0;
      let reviewNote = '';
      if (added !== 0) {
        const n = Math.abs(added);
        const sign = added > 0 ? '+' : '&minus;';
        reviewNote = ` <span style="color:rgba(255,255,255,0.45);">(${sign}${n} review${n !== 1 ? 's' : ''}, ${s.reviewTotal} total)</span>`;
      } else if (s.reviewTotal != null) {
        reviewNote = ` <span style="color:rgba(255,255,255,0.45);">(${s.reviewTotal} review${s.reviewTotal !== 1 ? 's' : ''} total)</span>`;
      }
      html += row(`${showLink(s.title, s.slug, s)} &mdash; ${fromLabel} <span style="color:${arrowColor};font-size:10px;">${arrow}</span> <span style="color:${toBg};font-weight:700;">${s.to}</span>${reviewNote}`);
    }
    sections.push(html);
  }

  // Audience Grade Changes
  if (changes.audienceChanges.length > 0) {
    let html = sectionHeader(`Audience Grade Changes (${changes.audienceChanges.length})`);
    for (const a of changes.audienceChanges) {
      const fromLabel = a.from || '—';
      html += row(`${showLink(a.title, a.slug, a)} &mdash; ${fromLabel} &rarr; <span style="font-weight:700;">${a.to}</span>`);
    }
    sections.push(html);
  }

  // Exclusion-trend section (Balusters follow-through). Surfaces silent-drop spikes
  // and never-before-seen exclusion reasons so regressions don't accumulate unnoticed.
  const trend = changes.exclusionTrend;
  if (trend && (trend.spikes.length > 0 || trend.novelReasons.length > 0 || trend.todayTotal > 0)) {
    let html = sectionHeader(`Pipeline Exclusions (today: ${trend.todayTotal})`);
    if (trend.spikes.length > 0) {
      html += row(`<strong style="color:#ef4444;">⚠️ Spike above 7-day baseline:</strong>`);
      for (const s of trend.spikes.slice(0, 5)) {
        html += row(`&nbsp;&nbsp;${escapeHtml(s.reason)} — <strong>${s.todayCount}</strong> today vs <span style="color:rgba(255,255,255,0.5);">7-day avg ${s.mean} ± ${s.stdev}</span>`);
      }
    }
    if (trend.novelReasons.length > 0) {
      html += row(`<strong style="color:${brandColor};">🆕 Novel reason (first seen within 7 days):</strong>`);
      for (const n of trend.novelReasons.slice(0, 5)) {
        html += row(`&nbsp;&nbsp;${escapeHtml(n.reason)} — <strong>${n.todayCount}</strong> today (first seen ${n.firstSeen})`);
      }
    }
    if (trend.topToday.length > 0 && trend.spikes.length === 0 && trend.novelReasons.length === 0) {
      html += row(`<span style="color:rgba(255,255,255,0.5);">Top reasons today:</span>`);
      for (const t of trend.topToday.slice(0, 5)) {
        html += row(`&nbsp;&nbsp;${escapeHtml(t.reason)}: ${t.todayCount}`);
      }
    }
    sections.push(html);
  }

  const totalChanges = changes.newShows.length + changes.newReviews.length +
    changes.scoreChanges.length + changes.audienceChanges.length;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body bgcolor="#0f0f14" style="margin:0;padding:0;background-color:#0f0f14;background:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f0f14" style="background-color:#0f0f14;background:#0f0f14;padding:32px 16px;">
<tr><td align="center" bgcolor="#0f0f14">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">Broadway</span><span style="font-size:22px;font-weight:800;color:${brandColor};letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
  </td></tr>

  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">Daily Digest &mdash; ${escapeHtml(date)}</h1>
    <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.5);font-family:${FONT};">${totalChanges} change${totalChanges !== 1 ? 's' : ''} detected</p>
  </td></tr>

  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#1a1a24" style="background-color:#1a1a24;background:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      ${sections.join('<tr><td style="padding:8px 0;"><hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:0 20px;"></td></tr>')}
      <tr><td style="padding-bottom:12px;"></td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:12px 0;">
    <a href="${siteUrl}" style="display:inline-block;padding:10px 24px;background:${brandColor};color:#1a1a1a;font-size:14px;font-weight:600;border-radius:8px;text-decoration:none;font-family:${FONT};">View Live Site</a>
  </td></tr>

  <tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;font-family:${FONT};">
      Daily digest from <a href="${siteUrl}" style="color:${brandColor};">Broadway Scorecard</a>. Sent automatically each morning.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

module.exports = {
  FONT,
  postJSON,
  sleep,
  escapeHtml,
  getScoreColor,
  getChangeAnchor,
  buildUnfollowUrl,
  buildUnsubscribeUrl,
  buildFooterHtml,
  buildBroadcastFooterHtml,
  buildSocialRowHtml,
  buildEmailHtml,
  buildOpeningNightHtml,
  buildBroadcastSubjectLine,
  buildBroadcastOpeningNightHtml,
  buildFeedbackThankYouEmail,
  buildFixApprovalEmail,
  buildBroadcastApprovalHtml,
  buildDailyDigestHtml,
};
