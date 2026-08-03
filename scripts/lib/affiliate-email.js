/**
 * affiliate-email.js
 *
 * HTML email template for the weekly affiliate performance report.
 * Matches the dark-theme design system from email-templates.js and the
 * card/table layout from the admin/affiliate Dashboard.tsx.
 */

const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
const DASHBOARD_URL = 'https://broadwayscorecard.com/admin/affiliate';

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function htmlMoney(n) { return typeof n === 'number' ? `$${n.toFixed(2)}` : '\u2014'; }
function htmlInt(n) { return typeof n === 'number' ? n.toLocaleString() : '\u2014'; }
function htmlPct(n) { return typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : '\u2014'; }

function buildAffiliateReportHtml(stats) {
  const { window: win, funnel, unitEconomics, perPlatform, impact, errors, wowDelta, context } = stats;

  // Small green/red ▲▼ delta chip for week-over-week movement.
  // null pct (no prior-window activity) renders an em dash so the row stays aligned.
  const wowChip = (pct) => {
    if (pct == null) return `<span style="color:rgba(255,255,255,0.3);">—</span>`;
    const up = pct >= 0;
    const color = up ? '#22c55e' : '#f87171';
    const sym = up ? '▲' : '▼';
    const val = `${up ? '+' : ''}${pct.toFixed(1)}%`;
    return `<span style="color:${color};font-weight:700;">${sym} ${esc(val)}</span>`;
  };

  const card = (title, body) => `
  <tr><td style="padding-bottom:16px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1a24;border-radius:12px;border:1px solid rgba(255,255,255,0.06);">
      <tr><td style="padding:20px 24px 4px;">
        <p style="margin:0;font-size:11px;font-weight:600;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.8px;font-family:${FONT};">${esc(title)}</p>
      </td></tr>
      <tr><td style="padding:12px 24px 20px;">${body}</td></tr>
    </table>
  </td></tr>`;

  const funnelCell = (label, value, rate, accent) => `
  <td style="padding:8px;vertical-align:top;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">
      <tr><td style="padding:12px;">
        <p style="margin:0;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:rgba(255,255,255,0.35);font-family:${FONT};">${esc(label)}</p>
        <p style="margin:4px 0 0;font-size:22px;font-weight:800;color:${accent ? '#22c55e' : '#ffffff'};font-family:${FONT};line-height:1.2;">${esc(value)}</p>
        <p style="margin:4px 0 0;font-size:11px;color:rgba(255,255,255,0.35);font-family:${FONT};min-height:14px;">${rate ? esc(rate) : ''}</p>
      </td></tr>
    </table>
  </td>`;

  const unitCell = (label, value, hint) => `
  <td style="padding:8px;vertical-align:top;">
    <p style="margin:0;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:rgba(255,255,255,0.35);font-family:${FONT};">${esc(label)}</p>
    <p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#ffffff;font-family:${FONT};">${esc(value)}</p>
    <p style="margin:2px 0 0;font-size:10px;color:rgba(255,255,255,0.35);font-family:${FONT};">${esc(hint)}</p>
  </td>`;

  // Commission hero
  const wowLine = wowDelta ? `
    <p style="margin:12px 0 0;font-size:12px;color:rgba(255,255,255,0.45);font-family:${FONT};line-height:1.6;">
      <span style="display:inline-block;margin-right:14px;">Commission ${wowChip(wowDelta.commissionPct)}</span>
      <span style="display:inline-block;margin-right:14px;">Conversions ${wowChip(wowDelta.conversionsPct)}</span>
      <span style="display:inline-block;">Sales ${wowChip(wowDelta.revenuePct)}</span>
      <br><span style="font-size:11px;color:rgba(255,255,255,0.3);">vs prior ${win.days}d (${esc(wowDelta.priorStartDate)} \u2013 ${esc(wowDelta.priorEndDate)}) \u00b7 Impact only</span>
    </p>` : '';
  // Baseline line: WoW vs a single (possibly outlier-inflated) prior week is
  // panic-prone \u2014 the trailing-baseline per-day average is the stable anchor.
  let baselineLine = '';
  if (context && context.baseline && context.baseline.payoutVsBaselinePct != null) {
    const b = context.baseline;
    baselineLine = `
    <p style="margin:8px 0 0;font-size:11px;color:rgba(255,255,255,0.35);font-family:${FONT};">
      vs trailing ${b.baseline.days}d baseline: ${wowChip(context.baseline.payoutVsBaselinePct)}
      &nbsp;(${esc(htmlMoney(b.windowPerDay ? b.windowPerDay.payout : null))}/day now &middot; ${esc(htmlMoney(b.baselinePerDay ? b.baselinePerDay.payout : null))}/day baseline)
    </p>`;
  }
  const partialBanner = context && context.partial ? `
    <p style="margin:10px 0 0;font-size:11px;font-weight:700;color:#f87171;font-family:${FONT};">PARTIAL DATA \u2014 baseline/outlier context unavailable this week; treat deltas with caution.</p>` : '';
  const commissionHtml = card(`Our earnings \u2014 last ${win.days} days`, `
    <p style="margin:0;font-size:42px;font-weight:800;color:#ffffff;font-family:${FONT};line-height:1;">${esc(htmlMoney(stats.totals.commission))}</p>
    <p style="margin:8px 0 0;font-size:13px;color:rgba(255,255,255,0.5);font-family:${FONT};">${esc(htmlInt(stats.totals.conversions))} conversion${stats.totals.conversions !== 1 ? 's' : ''} &middot; ${esc(htmlMoney(stats.totals.revenue))} attributed sales</p>
    ${wowLine}
    ${baselineLine}
    ${partialBanner}
  `);

  // Context notes: outlier days, multi-order buyers, bot-click divergence \u2014
  // the three annotations that would have made the 2026-08-03 "-77.6%" email
  // explain itself instead of causing a fire drill.
  let contextHtml = '';
  if (context && !context.partial) {
    const notes = [];
    for (const d of context.outlierDays || []) {
      notes.push(`Single day ${esc(d.day)} contributed ${Math.round(d.shareOfWindow * 100)}% of this window's commission (${esc(htmlMoney(d.payout))}).`);
    }
    for (const b of context.repeatBuyers || []) {
      notes.push(`One buyer placed ${b.conversions} of this window's orders (${esc(htmlMoney(b.sales))} in sales, ${esc(htmlMoney(b.payout))} commission).`);
    }
    if (context.clickDivergenceRatio != null && context.clickDivergenceRatio > 2) {
      notes.push(`Impact recorded ${esc(htmlInt(context.impactClicks))} clicks vs ${esc(htmlInt(funnel ? funnel.ticketClicks : null))} on-site ticket clicks (${context.clickDivergenceRatio.toFixed(1)}x) \u2014 likely bot hits on tracking links diluting EPC.`);
    }
    if (notes.length) {
      contextHtml = card('Context \u2014 read before reacting to the deltas', `
        <ul style="margin:0;padding-left:18px;font-size:13px;color:rgba(255,255,255,0.7);font-family:${FONT};line-height:1.7;">
          ${notes.map((n) => `<li style="margin:4px 0;">${n}</li>`).join('')}
        </ul>`);
    }
  }

  // Funnel
  const funnelHtml = funnel ? card('Conversion funnel', `
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${funnelCell('Show views', htmlInt(funnel.showPageviews), null, false)}
        ${funnelCell('Ticket clicks', htmlInt(funnel.ticketClicks),
          funnel.rates.clicksPerShowView != null ? `${(funnel.rates.clicksPerShowView * 100).toFixed(2)}% of views` : null, false)}
      </tr><tr>
        ${funnelCell('Conversions', htmlInt(funnel.conversions),
          funnel.rates.convsPerClick != null ? `${(funnel.rates.convsPerClick * 100).toFixed(2)}% of clicks` : null, false)}
        ${funnelCell('Commission', htmlMoney(funnel.commission),
          funnel.rates.epc != null ? `$${funnel.rates.epc.toFixed(3)} / click` : null, true)}
      </tr>
    </table>
  `) : '';

  // Unit economics
  const unitHtml = unitEconomics && unitEconomics.avgOrderValue != null ? card('Unit economics', `
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${unitCell('Avg order', htmlMoney(unitEconomics.avgOrderValue), 'ticket sale value')}
        ${unitCell('Avg commission', htmlMoney(unitEconomics.avgCommissionPerConv), 'we earn')}
      </tr><tr>
        ${unitCell('Take rate', unitEconomics.takeRate != null ? `${(unitEconomics.takeRate * 100).toFixed(2)}%` : '\u2014', 'commission \u00F7 sale')}
        ${unitCell('EPC', unitEconomics.earningsPerClick != null ? `$${unitEconomics.earningsPerClick.toFixed(3)}` : '\u2014', 'commission \u00F7 click')}
      </tr>
    </table>
  `) : '';

  // Per-platform table
  let platformHtml = '';
  if (perPlatform && perPlatform.length > 0) {
    const hs = 'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:rgba(255,255,255,0.35);font-weight:600;padding:0 8px 8px;font-family:' + FONT;
    const cs = 'font-size:14px;color:rgba(255,255,255,0.85);padding:10px 8px;font-family:' + FONT + ';border-top:1px solid rgba(255,255,255,0.06)';
    const dash = '<span style="color:rgba(255,255,255,0.25)">\u2014</span>';
    const rows = perPlatform.map(r => {
      const dot = r.affiliate ? '' : '<span style="color:rgba(255,255,255,0.25);"> \u00B7</span>';
      return `<tr>
        <td style="${cs};font-weight:600;color:#ffffff;">${esc(r.platform)}${dot}</td>
        <td align="right" style="${cs};font-variant-numeric:tabular-nums;">${htmlInt(r.clicks)}</td>
        <td align="right" style="${cs};font-variant-numeric:tabular-nums;">${r.conversions != null ? htmlInt(r.conversions) : dash}</td>
        <td align="right" style="${cs};font-variant-numeric:tabular-nums;">${r.conversionRate != null ? htmlPct(r.conversionRate) : dash}</td>
        <td align="right" style="${cs};font-weight:600;font-variant-numeric:tabular-nums;">${r.commission != null ? htmlMoney(r.commission) : dash}</td>
        <td align="right" style="${cs};font-variant-numeric:tabular-nums;">${r.epc != null ? '$' + r.epc.toFixed(3) : dash}</td>
      </tr>`;
    }).join('');
    platformHtml = card('By platform', `
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <th align="left" style="${hs}">Platform</th>
          <th align="right" style="${hs}">Clicks</th>
          <th align="right" style="${hs}">Conv</th>
          <th align="right" style="${hs}">CR</th>
          <th align="right" style="${hs}">Comm</th>
          <th align="right" style="${hs}">EPC</th>
        </tr>
        ${rows}
      </table>
      <p style="margin:12px 0 0;font-size:11px;color:rgba(255,255,255,0.25);font-family:${FONT};">\u00B7 = no affiliate program. CR = conversion rate. EPC = earnings per click.</p>
    `);
  }

  // TodayTix customer mix
  let todaytixMixHtml = '';
  if (impact && !impact.skipped && impact.todaytixMix) {
    const m = impact.todaytixMix;
    const total = m.newCount + m.existingCount;
    if (total > 0) {
      const newPct = Math.round((m.newCount / total) * 100);
      const sr = (label, value, accent) => `
        <tr>
          <td style="padding:6px 0;font-size:14px;color:rgba(255,255,255,0.5);font-family:${FONT};">${esc(label)}</td>
          <td align="right" style="padding:6px 0;font-size:14px;font-weight:600;color:${accent === 'pos' ? '#22c55e' : '#ffffff'};font-family:${FONT};font-variant-numeric:tabular-nums;">${esc(value)}</td>
        </tr>`;
      todaytixMixHtml = card('TodayTix customer mix', `
        <p style="margin:0 0 12px;font-size:11px;color:rgba(255,255,255,0.35);font-family:${FONT};">Inferred from payout rate (5% = new, 1% = existing)</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${sr(`New (${newPct}%)`, `${m.newCount} \u00B7 ${htmlMoney(m.newPayout)} commission`)}
          ${sr(`Existing (${100 - newPct}%)`, `${m.existingCount} \u00B7 ${htmlMoney(m.existingPayout)} commission`)}
          ${m.rateBumpUplift > 0 ? sr('Rate-bump uplift vs old 2%', `+${htmlMoney(m.rateBumpUplift)}`, 'pos') : ''}
        </table>
      `);
    }
  }

  // Provider errors
  let errorsHtml = '';
  if (errors.length > 0) {
    const items = errors.map(e => `<li style="margin:4px 0;"><strong>${esc(e.provider)}:</strong> ${esc(e.message)}</li>`).join('');
    errorsHtml = card('Provider errors', `<ul style="margin:0;padding-left:18px;font-size:13px;color:#f87171;font-family:${FONT};">${items}</ul>`);
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body bgcolor="#0f0f14" style="margin:0;padding:0;background-color:#0f0f14;background:#0f0f14;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0f0f14" style="background-color:#0f0f14;background:#0f0f14;padding:32px 16px;">
<tr><td align="center" bgcolor="#0f0f14">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
  <tr><td style="padding-bottom:20px;border-bottom:1px solid rgba(212,165,116,0.2);">
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;font-family:${FONT};">Broadway</span><span style="font-size:22px;font-weight:800;color:#d4a574;letter-spacing:-0.02em;font-family:${FONT};">Scorecard</span>
  </td></tr>
  <tr><td style="padding:28px 0 8px;">
    <h1 style="margin:0;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;font-family:${FONT};">Affiliate Report</h1>
    <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.4);font-family:${FONT};">${esc(win.startDate)} \u2014 ${esc(win.endDate)}</p>
  </td></tr>
  <tr><td style="padding:20px 0 0;">
    ${commissionHtml}
    ${contextHtml}
    ${funnelHtml}
    ${unitHtml}
    ${platformHtml}
    ${todaytixMixHtml}
    ${errorsHtml}
  </td></tr>
  <tr><td style="padding:8px 0 32px;" align="center">
    <a href="${DASHBOARD_URL}" style="display:inline-block;padding:12px 32px;background-color:#d4a574;color:#0f0f14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;font-family:${FONT};">View Live Dashboard</a>
  </td></tr>
  <tr><td style="padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.2);line-height:1.6;font-family:${FONT};">
      This report was auto-generated from <a href="https://broadwayscorecard.com" style="color:#d4a574;">Broadway Scorecard</a> affiliate data.<br>
      <a href="${DASHBOARD_URL}" style="color:rgba(255,255,255,0.3);">Open the live dashboard</a> for real-time stats and 30-day views.
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { buildAffiliateReportHtml };
