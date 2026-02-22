/**
 * email-templates.js
 *
 * Shared email template builders for both per-show follow notifications
 * and opening-night broadcast emails.
 *
 * Extracted from send-follow-notifications.js (Sprint 2, S2-T1).
 */

const https = require('https');

const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

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
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getScoreColor(score) {
  if (score == null) return { bg: '#6b7280', text: '#ffffff', label: 'TBD' };
  if (score >= 83) return { bg: '#FFD700', text: '#1a1a1a', label: 'Critical Gold' };
  if (score >= 75) return { bg: '#22c55e', text: '#ffffff', label: 'Recommended' };
  if (score >= 65) return { bg: '#14b8a6', text: '#ffffff', label: 'Worth Seeing' };
  if (score >= 55) return { bg: '#f59e0b', text: '#1a1a1a', label: 'Skippable' };
  return { bg: '#ef4444', text: '#ffffff', label: 'Stay Away' };
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

function buildUnsubscribeUrl(email) {
  return `https://broadwayscorecard.com/unsubscribe?email=${encodeURIComponent(email)}`;
}

function buildFooterHtml(showTitle, showId, email) {
  const unfollowUrl = buildUnfollowUrl(showId, showTitle, email);
  return `<tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;font-family:${FONT};">
      You're receiving this because you followed ${escapeHtml(showTitle)} on <a href="https://broadwayscorecard.com" style="color:#d4a574;">Broadway Scorecard</a>.<br>
      <a href="${escapeHtml(unfollowUrl)}" style="color:rgba(255,255,255,0.35);">Unfollow this show</a>
    </p>
  </td></tr>`;
}

function buildBroadcastFooterHtml(email) {
  const unsubscribeUrl = buildUnsubscribeUrl(email);
  return `<tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6;font-family:${FONT};">
      You're receiving this because you subscribed to <a href="https://broadwayscorecard.com" style="color:#d4a574;">Broadway Scorecard</a>.<br>
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:rgba(255,255,255,0.35);">Unsubscribe from opening night alerts</a>
    </p>
  </td></tr>`;
}

function buildEmailHtml(showTitle, changes, showUrl, showId, email) {
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
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">Broadway</span><span style="font-size:22px;font-weight:800;color:#d4a574;letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
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
  ${buildFooterHtml(showTitle, showId, email)}
</table>
</td></tr></table>
</body></html>`;
}

function buildOpeningNightHtml(showTitle, openingChange, otherChanges, showUrl, showId, email, imageUrl) {
  const sc = getScoreColor(openingChange.score);
  const scoreDisplay = openingChange.score != null ? Math.round(openingChange.score) : '?';
  const reviewCount = openingChange.reviewCount || 0;
  const positive = openingChange.positive || 0;
  const mixed = openingChange.mixed || 0;
  const negative = openingChange.negative || 0;
  const total = positive + mixed + negative;

  // Review subtitle
  const reviewSubtitle = reviewCount > 0
    ? `Based on ${reviewCount} Critic Review${reviewCount !== 1 ? 's' : ''}`
    : 'Reviews pending';

  // Breakdown bar widths (percentage, min 1% if nonzero to stay visible)
  let posW = 0, mixW = 0, negW = 0;
  if (total > 0) {
    posW = Math.max(Math.round(positive / total * 100), positive > 0 ? 1 : 0);
    negW = Math.max(Math.round(negative / total * 100), negative > 0 ? 1 : 0);
    mixW = 100 - posW - negW;
    if (mixW < 0) mixW = 0;
    if (mixed > 0 && mixW === 0) { mixW = 1; posW = Math.max(posW - 1, 0); }
  }

  // Breakdown bar HTML (only show if we have reviews)
  const breakdownHtml = total > 0 ? `
  <tr><td style="padding:16px 24px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
      <tr>
        ${posW > 0 ? `<td style="width:${posW}%;height:8px;background-color:#22c55e;"></td>` : ''}
        ${mixW > 0 ? `<td style="width:${mixW}%;height:8px;background-color:#f59e0b;"></td>` : ''}
        ${negW > 0 ? `<td style="width:${negW}%;height:8px;background-color:#ef4444;"></td>` : ''}
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:8px 24px 0;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
          <span style="color:#22c55e;font-weight:600;">${positive}</span> Positive
        </td>
        <td align="center" style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
          <span style="color:#f59e0b;font-weight:600;">${mixed}</span> Mixed
        </td>
        <td align="right" style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
          <span style="color:#ef4444;font-weight:600;">${negative}</span> Negative
        </td>
      </tr>
    </table>
  </td></tr>` : '';

  // Consensus block (only show if available)
  const consensusHtml = openingChange.consensusText ? `
  <tr><td style="padding:20px 24px 0;">
    <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Critics' Take</p>
    <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.75);line-height:1.6;font-style:italic;font-family:${FONT};">"${escapeHtml(openingChange.consensusText)}"</p>
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
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">Broadway</span><span style="font-size:22px;font-weight:800;color:#d4a574;letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
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
            <td width="72" height="72" bgcolor="${sc.bg}" style="width:72px;height:72px;background-color:${sc.bg};background:${sc.bg};border-radius:12px;text-align:center;vertical-align:middle;">
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
        <a href="${escapeHtml(showUrl)}#critic-reviews" style="display:inline-block;padding:10px 24px;background-color:rgba(255,255,255,0.08);color:#d4a574;font-size:13px;font-weight:600;text-decoration:none;border-radius:6px;border:1px solid rgba(212,165,116,0.2);font-family:${FONT};">Scan All ${reviewCount} Reviews</a>
      </td></tr>` : ''}
      <tr><td style="padding-bottom:20px;"></td></tr>
    </table>
  </td></tr>
  ${otherHtml}
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="${escapeHtml(showUrl)}" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">View Full Details</a>
  </td></tr>
  ${buildFooterHtml(showTitle, showId, email)}
</table>
</td></tr></table>
</body></html>`;
}

/**
 * Build opening-night broadcast email for general subscribers.
 * Supports single or multiple shows in one email.
 *
 * @param {Array<{showTitle, score, reviewCount, positive, mixed, negative, consensusText, showType, venue, showUrl, imageUrl}>} shows
 * @param {string} email - Subscriber email (for unsubscribe link)
 * @returns {string} HTML email
 */
function buildBroadcastOpeningNightHtml(shows, email) {
  // Build a score card for each show
  const showCards = shows.map(show => {
    const sc = getScoreColor(show.score);
    const scoreDisplay = show.score != null ? Math.round(show.score) : '?';
    const reviewCount = show.reviewCount || 0;
    const positive = show.positive || 0;
    const mixed = show.mixed || 0;
    const negative = show.negative || 0;
    const total = positive + mixed + negative;

    const reviewSubtitle = reviewCount > 0
      ? `Based on ${reviewCount} Critic Review${reviewCount !== 1 ? 's' : ''}`
      : 'Reviews pending';

    let posW = 0, mixW = 0, negW = 0;
    if (total > 0) {
      posW = Math.max(Math.round(positive / total * 100), positive > 0 ? 1 : 0);
      negW = Math.max(Math.round(negative / total * 100), negative > 0 ? 1 : 0);
      mixW = 100 - posW - negW;
      if (mixW < 0) mixW = 0;
      if (mixed > 0 && mixW === 0) { mixW = 1; posW = Math.max(posW - 1, 0); }
    }

    const breakdownHtml = total > 0 ? `
      <tr><td style="padding:16px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;">
          <tr>
            ${posW > 0 ? `<td style="width:${posW}%;height:8px;background-color:#22c55e;"></td>` : ''}
            ${mixW > 0 ? `<td style="width:${mixW}%;height:8px;background-color:#f59e0b;"></td>` : ''}
            ${negW > 0 ? `<td style="width:${negW}%;height:8px;background-color:#ef4444;"></td>` : ''}
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:8px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
              <span style="color:#22c55e;font-weight:600;">${positive}</span> Positive
            </td>
            <td align="center" style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
              <span style="color:#f59e0b;font-weight:600;">${mixed}</span> Mixed
            </td>
            <td align="right" style="font-size:12px;color:rgba(255,255,255,0.5);font-family:${FONT};">
              <span style="color:#ef4444;font-weight:600;">${negative}</span> Negative
            </td>
          </tr>
        </table>
      </td></tr>` : '';

    const consensusHtml = show.consensusText ? `
      <tr><td style="padding:20px 24px 0;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:rgba(212,165,116,0.6);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">Critics' Take</p>
        <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.75);line-height:1.6;font-style:italic;font-family:${FONT};">"${escapeHtml(show.consensusText)}"</p>
      </td></tr>` : '';

    const metaParts = [];
    if (show.showType) metaParts.push(show.showType);
    if (show.venue) metaParts.push(show.venue);
    const metaHtml = metaParts.length > 0 ? `
      <tr><td style="padding:16px 24px 0;">
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.35);font-family:${FONT};">${escapeHtml(metaParts.join(' \u00B7 '))}</p>
      </td></tr>` : '';

    return `
  ${shows.length > 1 ? `<tr><td style="padding:24px 0 8px;">
    <h2 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">${escapeHtml(show.showTitle)}</h2>
  </td></tr>` : ''}${show.imageUrl ? `
  <tr><td style="padding:${shows.length > 1 ? '8' : '16'}px 0 0;">
    <img src="${escapeHtml(show.imageUrl)}" alt="${escapeHtml(show.showTitle)}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;" />
  </td></tr>` : ''}
  <tr><td style="padding:16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#1a1a24" style="background-color:#1a1a24;background:#1a1a24;border-radius:12px;border:1px solid rgba(212,165,116,0.12);">
      <tr><td style="padding:24px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td width="72" height="72" bgcolor="${sc.bg}" style="width:72px;height:72px;background-color:${sc.bg};background:${sc.bg};border-radius:12px;text-align:center;vertical-align:middle;">
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
        <a href="${escapeHtml(show.showUrl)}#critic-reviews" style="display:inline-block;padding:10px 24px;background-color:rgba(255,255,255,0.08);color:#d4a574;font-size:13px;font-weight:600;text-decoration:none;border-radius:6px;border:1px solid rgba(212,165,116,0.2);font-family:${FONT};">Scan All ${reviewCount} Reviews</a>
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
  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">Broadway</span><span style="font-size:22px;font-weight:800;color:#d4a574;letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">${h1}</h1>
  </td></tr>
  ${showCards.join('')}
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="https://broadwayscorecard.com" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">Browse All Shows</a>
  </td></tr>
  ${buildBroadcastFooterHtml(email)}
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
  buildEmailHtml,
  buildOpeningNightHtml,
  buildBroadcastOpeningNightHtml,
  buildFeedbackThankYouEmail,
  buildFixApprovalEmail,
};
