/**
 * autonomous-email-render.js — pure HTML rendering for the autonomous loop's
 * morning email (S2-T6). No network, no filesystem: the sender script
 * (scripts/autonomous-email.js) gathers data, this renders it, tests assert
 * on the output.
 *
 * Layout (owner UX verdicts, 2026-07-12 mock tests):
 *   - ≤3 approve items. Each: card name + PASS badge + small grey cost tag,
 *     a "why this card existed" line ABOVE the what-was-done line,
 *     check results, Approve/Reject buttons.
 *   - one-line failed count (only when nonzero)
 *   - usage block: mini 3-row table (Tonight / This week / Monthly pace),
 *     model split demoted to one small grey line. NO invented budget:
 *     % appears only when weeklyUSD is configured or the Admin API exposes
 *     a real spend limit. Admin-API actuals replace ledger estimates when
 *     available, with a separate line isolating the loop's own share.
 *   - footer (moved OUT of the usage box): last run + awaiting count.
 */

'use strict';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// First sentence-ish of the card's ## Problem section — the "why this card
// existed" line the owner asked for above the what-was-done line.
function extractWhy(notes) {
  const m = /##\s*Problem\s*\n+([\s\S]*?)(?=\n##|$)/i.exec(String(notes || ''));
  const text = (m ? m[1] : String(notes || '')).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence;
}

function renderItem(item) {
  const badge = `<span style="display:inline-block;background:#16a34a;color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;vertical-align:middle;">PASS</span>`;
  const cost = `<span style="color:#999;font-size:12px;margin-left:6px;">~${money(item.usd)}</span>`;
  const checks = (item.checks || []).map(esc).join(' · ');
  const btn = (label, url, bg) =>
    `<a href="${esc(url)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 22px;border-radius:8px;margin-right:10px;">${label}</a>`;
  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin:0 0 14px;">
    <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${esc(item.name)} ${badge}${cost}</div>
    ${item.why ? `<div style="font-size:13px;color:#666;margin-bottom:4px;"><b>Why:</b> ${esc(item.why)}</div>` : ''}
    <div style="font-size:13px;color:#333;margin-bottom:6px;"><b>Done:</b> ${esc(item.summary || 'change implemented and verified')} <span style="color:#999;">(${esc(item.branch)})</span></div>
    ${checks ? `<div style="font-size:12px;color:#16a34a;margin-bottom:10px;">${checks}</div>` : ''}
    <div>${btn('Approve', item.approveUrl, '#16a34a')}${btn('Reject', item.rejectUrl, '#6b7280')}</div>
  </div>`;
}

// stats = usageStats() from autonomous-ledger; admin = fetchAdminUsage()
// result or null; config = { weeklyUSD } (never defaulted).
function renderUsageBlock(stats, admin, config = {}) {
  const rows = [];
  const row = (label, value) =>
    `<tr><td style="padding:4px 24px 4px 0;color:#666;font-size:13px;">${label}</td><td style="padding:4px 0;font-size:14px;font-weight:700;">${value}</td></tr>`;

  const weekUSD = admin && admin.actualUSD7d != null ? admin.actualUSD7d : stats.week.usd;
  const weekSuffix = (() => {
    if (Number.isFinite(config.weeklyUSD) && config.weeklyUSD > 0) {
      return ` <span style="color:#999;font-weight:400;">(${Math.round((weekUSD / config.weeklyUSD) * 100)}% of $${config.weeklyUSD}/wk budget)</span>`;
    }
    if (admin && Number.isFinite(admin.spendLimitUSD) && admin.spendLimitUSD > 0) {
      return ` <span style="color:#999;font-weight:400;">(${Math.round((weekUSD / admin.spendLimitUSD) * 100)}% of $${admin.spendLimitUSD} account limit)</span>`;
    }
    return ''; // no configured budget → spend + pace only, never invented
  })();

  rows.push(row('Tonight', money(stats.tonight.usd)));
  rows.push(row(admin ? 'This week (account)' : 'This week', money(weekUSD) + weekSuffix));
  const pace = admin && admin.actualUSD7d != null ? Math.round((admin.actualUSD7d / 7) * 30 * 100) / 100 : stats.paceMonthlyUSD;
  rows.push(row('Monthly pace', pace == null ? '—' : `~${money(pace)}`));

  const modelBits = Object.entries(stats.tonight.byModel || {})
    .filter(([, v]) => v.usd > 0 || v.tokensIn > 0 || v.tokensOut > 0)
    .map(([m, v]) => `${m.replace(/^claude-/, '')} ${money(v.usd)} (${Math.round(v.tokensIn / 1000)}k in / ${Math.round(v.tokensOut / 1000)}k out)`);
  const loopShare = admin ? `<div style="font-size:11px;color:#999;margin-top:2px;">autonomous loop's share this week: ${money(stats.week.usd)} (ledger)</div>` : '';

  return `<div style="border:1px solid #e5e5e5;border-radius:10px;padding:14px 16px;margin:18px 0 6px;">
    <table style="border-collapse:collapse;">${rows.join('')}</table>
    ${modelBits.length ? `<div style="font-size:11px;color:#999;margin-top:6px;">${esc(modelBits.join(' · '))}</div>` : ''}
    ${loopShare}
  </div>`;
}

/**
 * @param {object} data
 *   items: [{ name, why, summary, branch, usd, checks[], approveUrl, rejectUrl }]
 *   moreAwaiting: number (needs-approval beyond the ≤3 shown)
 *   failedCount: number, skippedCount: number, throttled: string|null
 *   stats: usageStats() result · admin: fetchAdminUsage() result|null
 *   config: { weeklyUSD } · lastRunNote: string|null · awaitingTotal: number
 */
function renderEmail(data) {
  const { items = [], moreAwaiting = 0, failedCount = 0, throttled = null, stats, admin = null, config = {}, lastRunNote = null, awaitingTotal = 0 } = data;

  const parts = [];
  parts.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:18px 14px;color:#111;">`);
  parts.push(`<h2 style="font-size:18px;margin:0 0 14px;">Overnight work — ${items.length ? `${items.length} item${items.length > 1 ? 's' : ''} awaiting your tap` : 'nothing to approve'}</h2>`);

  if (throttled) {
    // `throttled` is a generic banner string — it may carry an actual
    // throttle, a Notion listing failure, or a missing-evidence notice, each
    // self-describing, so use a neutral marker not a hardcoded "Throttled:".
    parts.push(`<p style="font-size:13px;color:#b45309;margin:0 0 12px;">⚠️ ${esc(throttled)}</p>`);
  }
  for (const item of items) parts.push(renderItem(item));
  if (moreAwaiting > 0) {
    parts.push(`<p style="font-size:13px;color:#666;">+${moreAwaiting} more item${moreAwaiting > 1 ? 's' : ''} awaiting approval (shown over the next mornings).</p>`);
  }
  if (failedCount > 0) {
    parts.push(`<p style="font-size:13px;color:#666;margin:6px 0;">${failedCount} card${failedCount > 1 ? 's' : ''} failed overnight (details on the cards; nothing was pushed for them).</p>`);
  }

  parts.push(renderUsageBlock(stats, admin, config));

  const footerBits = [];
  if (lastRunNote) footerBits.push(esc(lastRunNote));
  footerBits.push(`${awaitingTotal} awaiting approval`);
  parts.push(`<p style="color:#999;font-size:11px;margin-top:18px;text-align:center;">${footerBits.join(' · ')} · Broadway Scorecard autonomous loop</p>`);
  parts.push(`</div>`);
  return parts.join('\n');
}

module.exports = { renderEmail, renderItem, renderUsageBlock, extractWhy, esc };
