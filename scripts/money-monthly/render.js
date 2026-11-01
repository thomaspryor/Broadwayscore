'use strict';
// BRO-6773: HTML for the monthly Profitability Scorecard email. Same dark look
// as the Sunday newsletter (TOKENS from email-components). Copy follows
// ~/.claude/anti-slop-rules.md: no em dashes, no filler openers.
const { TOKENS, esc, sitePill } = require('../lib/email-components');
const { applyUtm } = require('../lib/email-utm');
const { usd, fmtDay } = require('./lib');

const SITE = 'https://broadwayscorecard.com';
const T = TOKENS;

const section = (title, body) => `<tr><td style="padding:0 24px 24px 24px">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${T.brand};padding-bottom:8px;border-bottom:1px solid ${T.border};margin-bottom:12px">${esc(title)}</div>${body}</td></tr>`;
const row = (url, title, detail) => `<div style="padding:8px 0;border-bottom:1px solid ${T.borderSubtle}"><a href="${esc(url)}" style="color:${T.text};text-decoration:none;font-weight:600;font-size:16px">${esc(title)}</a><div style="color:${T.textMuted};font-size:14px;line-height:1.5;margin-top:2px">${detail}</div></div>`;

const MN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthName = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym || ''); return m ? `${MN[Number(m[2]) - 1]} ${m[1]}` : String(ym || ''); };

function intro(issue) {
  const w = issue.window;
  if (issue.quiet) return `Nothing crossed our bar ${w.catchup ? w.label : `in ${w.label}`}: no new recoupments, no closings with a final label, and no big estimate moves.`;
  return w.catchup ? `Here is what moved in the money data ${w.label}.` : `Here is what moved in the money data in ${w.label}.`;
}

function renderHtml(issue, { unsubscribeUrl = '{{{RESEND_UNSUBSCRIBE_URL}}}', campaign } = {}) {
  const s = issue.sections;
  const parts = [];
  if (s.recoupments.length) {
    parts.push(section('Recouped', s.recoupments.map((r) => row(r.url, r.title, `Recouped in ${esc(monthName(r.date))}${r.designation ? `, labeled ${esc(r.designation)}` : ''}.`)).join('')));
  }
  if (s.closings.length) {
    parts.push(section('Closed, with a final label', s.closings.map((c) => row(c.url, c.title, `Closed ${esc(fmtDay(c.closed))}. Final label: ${sitePill(c.designation)}${c.capitalization ? ` Capitalization ${esc(usd(c.capitalization))}.` : ''}`)).join('')));
  }
  if (s.moves.length) {
    parts.push(section('Biggest estimate moves', s.moves.map((m) => row(m.url, m.title, `Our recoupment estimate went from ${m.from}% to ${m.to}% of capitalization (${m.delta > 0 ? '+' : ''}${m.delta} points).`)).join('')));
  }
  if (s.capitalization.length) {
    parts.push(section('New capitalization figures', s.capitalization.map((c) => row(c.url, c.title, `${esc(usd(c.capitalization))} capitalization, newly on the scorecard.`)).join('')));
  }
  if (issue.stat) {
    parts.push(section('One number', `<div style="color:${T.text};font-size:15px;line-height:1.6">${issue.stat.recouped} of the ${issue.stat.total} closed Broadway shows we have a final money label for recouped (${issue.stat.pct}%).</div>`));
  }
  const html = `<!doctype html><html><body style="margin:0;background:${T.surface};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${T.surface}"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${T.surfaceRaised};color:${T.text}">
<tr><td style="padding:24px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${T.brand}">Broadway Scorecard · Profitability Scorecard</div>
<div style="font-size:26px;font-weight:700;line-height:1.25;margin-top:8px">${esc(issue.window.catchup ? 'Money update' : `Money update, ${issue.window.label}`)}</div>
<div style="color:${T.textMuted};font-size:15px;line-height:1.6;margin-top:10px">${esc(intro(issue))}</div></td></tr>
${parts.join('\n')}
<tr><td style="padding:0 24px 24px 24px"><a href="${SITE}/biz" style="display:inline-block;background:${T.brand};color:${T.surface};text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Open the Profitability Scorecard</a></td></tr>
<tr><td style="padding:16px 24px 28px 24px;border-top:1px solid ${T.border};color:${T.textDim};font-size:12px;line-height:1.6">You are getting this because you signed up for the Profitability Scorecard. Estimates are ours, built from public filings and trade reports. <a href="${esc(unsubscribeUrl)}" style="color:${T.textMuted}">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
  return applyUtm(html, { source: 'money-list', medium: 'email', campaign: campaign || `money-monthly-${issue.window.monthKey}` });
}

module.exports = { renderHtml };
