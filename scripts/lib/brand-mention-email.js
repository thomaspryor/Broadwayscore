/**
 * brand-mention-email.js
 *
 * Builds and sends a digest email summarizing new brand mentions from
 * a single monitor run. One email per run if there's anything new;
 * never sends an empty email.
 *
 * Reuses scripts/lib/email-templates.js for the postJSON helper +
 * styling primitives so this digest looks consistent with the
 * Reddit engagement digest and the daily digest emails.
 *
 * Usage:
 *   const { sendBrandMentionDigest } = require('./lib/brand-mention-email');
 *   await sendBrandMentionDigest({ pairs, totalFetched, dropped });
 *
 * Where `pairs` is the [{ mention, verdict }] array from the drafter.
 *
 * Requires env: RESEND_API_KEY, OWNER_EMAIL
 */

const { postJSON, escapeHtml, FONT } = require('./email-templates');

const FROM_EMAIL = 'updates@broadwayscorecard.com';
const FROM_NAME = 'BWSC Brand Monitor';

const SENTIMENT_BADGE = {
  positive: { color: '#15803d', bg: '#dcfce7', emoji: '👍', label: 'POSITIVE' },
  neutral:  { color: '#1f2937', bg: '#e5e7eb', emoji: '💬', label: 'NEUTRAL'  },
  negative: { color: '#b45309', bg: '#fef3c7', emoji: '⚠️', label: 'NEGATIVE' },
  hostile:  { color: '#991b1b', bg: '#fee2e2', emoji: '🚨', label: 'HOSTILE'  },
};

const SOURCE_BADGE = {
  reddit:  { bg: '#ff4500', label: 'Reddit'   },
  hn:      { bg: '#ff6600', label: 'HN'       },
  bluesky: { bg: '#0a7ea4', label: 'Bluesky'  },
  x:       { bg: '#000000', label: 'X'        },
  google:  { bg: '#4285f4', label: 'Google'   },
  news:    { bg: '#374151', label: 'News'     },
  forum:   { bg: '#6366f1', label: 'Forum'    },
};

function sourceBadgeHtml(source) {
  const b = SOURCE_BADGE[source] || { bg: '#6b7280', label: source };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${b.bg};color:white;font-size:11px;font-weight:600;">${escapeHtml(b.label)}</span>`;
}

function sentimentBadgeHtml(sentiment) {
  const b = SENTIMENT_BADGE[sentiment] || SENTIMENT_BADGE.neutral;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${b.bg};color:${b.color};font-size:11px;font-weight:600;">${b.emoji} ${b.label}</span>`;
}

function buildMentionCardHtml({ mention: m, verdict }) {
  const isRespondable = verdict && verdict.shouldRespond;
  const bg = isRespondable ? '#fffbeb' : '#ffffff';
  const borderColor = isRespondable ? '#f59e0b' : '#e5e7eb';
  const sentiment = (verdict && verdict.sentiment) || 'neutral';

  const author = m.author ? `@${escapeHtml(m.author)}` : '';
  const subreddit = m.subreddit ? ` in r/${escapeHtml(m.subreddit)}` : '';
  const title = escapeHtml(m.title || '(no title)');
  const excerpt = m.excerpt ? escapeHtml(m.excerpt.slice(0, 400)) + (m.excerpt.length > 400 ? '…' : '') : '';
  const reason = verdict && verdict.reason ? escapeHtml(verdict.reason) : '';
  const draft = verdict && verdict.draftResponse ? escapeHtml(verdict.draftResponse) : '';
  const confidence = verdict && verdict.confidence ? escapeHtml(verdict.confidence) : '';
  const respondLabel = isRespondable
    ? `<span style="color:#b45309;font-weight:600;">✏️ Respond?</span>`
    : `<span style="color:#9ca3af;">No reply needed</span>`;

  return `
<div style="border:1.5px solid ${borderColor};background:${bg};border-radius:8px;padding:16px;margin-bottom:12px;">
  <div style="margin-bottom:8px;">
    ${sourceBadgeHtml(m.source)}
    ${sentimentBadgeHtml(sentiment)}
    ${confidence ? `<span style="color:#6b7280;font-size:11px;margin-left:6px;">confidence: ${confidence}</span>` : ''}
  </div>
  <div style="font-weight:600;font-size:15px;margin-bottom:4px;">
    <a href="${escapeHtml(m.url)}" style="color:#1e40af;text-decoration:none;">${title}</a>
  </div>
  <div style="color:#6b7280;font-size:12px;margin-bottom:8px;">
    ${author}${subreddit}${m.publishedAt ? ` · ${escapeHtml(m.publishedAt.slice(0, 10))}` : ''}
  </div>
  ${excerpt ? `<div style="color:#374151;font-size:13px;line-height:1.5;background:#f9fafb;padding:8px;border-radius:4px;margin-bottom:8px;border-left:3px solid #d1d5db;">${excerpt}</div>` : ''}
  ${reason ? `<div style="color:#6b7280;font-size:12px;margin-bottom:6px;"><strong>Verdict:</strong> ${reason}</div>` : ''}
  ${draft ? `<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:4px;padding:10px;margin-top:8px;"><div style="font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:4px;">Draft response</div><div style="color:#1f2937;font-size:13px;line-height:1.5;font-style:italic;">${draft}</div></div>` : ''}
  <div style="margin-top:10px;font-size:11px;">
    ${respondLabel}
    <a href="${escapeHtml(m.url)}" style="color:#1e40af;margin-left:12px;">→ open</a>
  </div>
</div>`;
}

function buildDigestHtml({ pairs, totalFetched, dropped, runStartedAt }) {
  const respondable = pairs.filter((p) => p.verdict && p.verdict.shouldRespond);
  const noise = pairs.filter((p) => !p.verdict || !p.verdict.shouldRespond);

  const respondableHtml = respondable.length
    ? `
      <h2 style="font-size:18px;color:#92400e;margin:24px 0 12px;border-bottom:2px solid #f59e0b;padding-bottom:6px;">
        ✏️ Respondable mentions (${respondable.length})
      </h2>
      <p style="color:#6b7280;font-size:13px;margin:0 0 12px;">High-confidence, on-voice draft replies you can copy/paste or edit.</p>
      ${respondable.map(buildMentionCardHtml).join('')}
    `
    : '';

  const noiseHtml = noise.length
    ? `
      <h2 style="font-size:16px;color:#374151;margin:24px 0 12px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        💬 Other mentions (${noise.length})
      </h2>
      <p style="color:#6b7280;font-size:12px;margin:0 0 12px;">Detected but no reply needed (no human author, no-reply source, or low signal).</p>
      ${noise.map(buildMentionCardHtml).join('')}
    `
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Brand Mention Digest</title></head>
<body style="font-family:${FONT};margin:0;padding:0;background:#f3f4f6;color:#1f2937;">
  <div style="max-width:680px;margin:0 auto;padding:20px;">
    <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <div style="border-bottom:1px solid #e5e7eb;padding-bottom:16px;margin-bottom:20px;">
        <h1 style="font-size:22px;margin:0 0 4px;color:#111827;">Brand Mention Digest</h1>
        <div style="color:#6b7280;font-size:13px;">
          ${pairs.length} new mention${pairs.length === 1 ? '' : 's'} of <strong>broadwayscorecard</strong> ·
          ${totalFetched} fetched · ${dropped} owner self-posts filtered
        </div>
        <div style="color:#9ca3af;font-size:11px;margin-top:4px;">
          Run started ${escapeHtml(runStartedAt)}
        </div>
      </div>
      ${respondableHtml}
      ${noiseHtml}
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;line-height:1.5;">
        Generated by <code>scripts/monitor-brand-mentions.js</code> via the
        <a href="https://github.com/thomaspryor/Broadwayscore/actions/workflows/brand-mention-monitor.yml" style="color:#6b7280;">Brand Mention Monitor</a> workflow.
        Runs every 2 hours. F5Bot + Talkwalker Alerts run in parallel as independent calibration sources.
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildSubject({ pairs }) {
  const respondable = pairs.filter((p) => p.verdict && p.verdict.shouldRespond).length;
  if (respondable > 0) {
    return `[BWSC] ${respondable} respondable brand mention${respondable === 1 ? '' : 's'} (${pairs.length} total)`;
  }
  return `[BWSC] ${pairs.length} new brand mention${pairs.length === 1 ? '' : 's'}`;
}

/**
 * Send the digest email.
 *
 * @param {object} opts
 * @param {Array<{mention, verdict}>} opts.pairs - drafter output
 * @param {number} opts.totalFetched
 * @param {number} opts.dropped
 * @param {boolean} [opts.dryRun] - if true, log subject + skip send
 * @returns {Promise<{sent: boolean, reason?: string, subject?: string}>}
 */
async function sendBrandMentionDigest({ pairs, totalFetched, dropped, dryRun = false }) {
  if (!pairs || pairs.length === 0) {
    return { sent: false, reason: 'no new mentions — skipping email' };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const OWNER_EMAIL = process.env.OWNER_EMAIL;

  if (!RESEND_API_KEY || !OWNER_EMAIL) {
    return { sent: false, reason: 'RESEND_API_KEY or OWNER_EMAIL not set' };
  }

  const runStartedAt = new Date().toISOString();
  const subject = buildSubject({ pairs });
  const html = buildDigestHtml({ pairs, totalFetched, dropped, runStartedAt });

  if (dryRun) {
    console.log(`[email] DRY RUN — would send "${subject}" to ${OWNER_EMAIL} (${html.length} bytes HTML)`);
    return { sent: false, reason: 'dry-run', subject };
  }

  try {
    await postJSON(
      'https://api.resend.com/emails',
      {
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [OWNER_EMAIL],
        subject,
        html,
      },
      { Authorization: `Bearer ${RESEND_API_KEY}` }
    );
    return { sent: true, subject };
  } catch (e) {
    return { sent: false, reason: `Resend API error: ${e.message}` };
  }
}

module.exports = {
  sendBrandMentionDigest,
  // exported for tests
  _internal: { buildDigestHtml, buildSubject, buildMentionCardHtml },
};
