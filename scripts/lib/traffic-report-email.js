/**
 * traffic-report-email.js — email the weekly traffic-source report to the owner.
 *
 * The report is produced by scripts/analyze-traffic-sources.js as markdown and
 * rendered on the GitHub Actions run Summary page. The owner never opens
 * GitHub (2026-09-20: "I never go there. I never had"), so the run also sends
 * the report as an email. Transactional send to OWNER_EMAIL only — never a
 * broadcast (CLAUDE.md rule 17).
 *
 * The email body is the top of the report (the "What changed" list, the
 * channel table and "How to read this"); the full report with every weekly
 * table is attached as markdown so the inbox message stays short.
 *
 * Markdown → HTML is a small purpose-built renderer (headings, paragraphs,
 * bullets, bold, tables, blockquotes) — the report only uses those, and the
 * repo has no markdown dependency.
 *
 * Requires env: RESEND_API_KEY, OWNER_EMAIL
 */
const fs = require('fs');
const { postJSON, escapeHtml, FONT } = require('./email-templates');

const FROM_EMAIL = 'updates@broadwayscorecard.com';
const FROM_NAME = 'BWSC Traffic';

function inline(md) {
  return escapeHtml(md)
    .replace(/\\\|/g, '|') // mdCell() escapes pipes in the report; not needed in HTML
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Render the subset of markdown the traffic report uses. Exported for tests. */
function markdownToHtml(md) {
  const lines = String(md).split('\n');
  const out = [];
  let i = 0;
  const cell = 'padding:4px 8px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:13px;';
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length + 1; // report's h1 → h2 (email already has a title)
      const size = lvl === 2 ? 20 : lvl === 3 ? 16 : 14;
      out.push(`<h${lvl} style="font-size:${size}px;margin:20px 0 8px;">${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i++; }
      const parse = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const header = parse(rows[0]);
      const body = rows.slice(2).map(parse);
      out.push('<table style="border-collapse:collapse;margin:8px 0;">'
        + `<tr>${header.map((c) => `<th style="${cell}font-weight:600;background:#f3f4f6;">${inline(c)}</th>`).join('')}</tr>`
        + body.map((r) => `<tr>${r.map((c) => `<td style="${cell}">${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</table>');
      continue;
    }
    if (line.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].startsWith('>')) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote style="border-left:4px solid #f59e0b;background:#fffbeb;padding:8px 12px;margin:8px 0;">${markdownToHtml(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push(`<ul style="margin:8px 0;padding-left:20px;">${items.map((t) => `<li style="margin:4px 0;">${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||>|\s*[-*]\s)/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<p style="margin:8px 0;">${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

/**
 * Split the report: everything before the first tool section ("## PostHog" /
 * "## GA4") is the summary that goes in the email body. Exported for tests.
 */
function splitReport(md) {
  const idx = md.search(/^## (PostHog|GA4)/m);
  return idx === -1 ? { summary: md, rest: '' } : { summary: md.slice(0, idx), rest: md.slice(idx) };
}

function buildSubject(md) {
  const title = (md.match(/^# (.+)$/m) || [, 'Traffic sources'])[1];
  const incomplete = /Incomplete report/.test(md) ? ' (incomplete)' : '';
  // Count only the headline list under "What changed" (the "How to read" bullets are bold too).
  const changed = (md.split(/^## What changed/m)[1] || '').split(/^## /m)[0];
  const spikes = (changed.match(/^- \*\*/gm) || []).length;
  return `${title}${incomplete} — ${spikes} spike${spikes === 1 ? '' : 's'}`;
}

function buildHtml(md, { runUrl } = {}) {
  const { summary } = splitReport(md);
  const safeUrl = runUrl ? escapeHtml(runUrl).replace(/"/g, '&quot;') : ''; // escapeHtml skips quotes
  const link = runUrl ? `<p style="margin:16px 0;color:#6b7280;font-size:12px;">Full tables are attached as markdown. Run log: <a href="${safeUrl}">${safeUrl}</a></p>` : '';
  return `<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:#111827;max-width:720px;">${markdownToHtml(summary)}${link}</div>`;
}

async function sendTrafficReportEmail({ reportPath, runUrl, dryRun = false, to } = {}) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const OWNER_EMAIL = to || process.env.OWNER_EMAIL;
  if (!RESEND_API_KEY || !OWNER_EMAIL) return { sent: false, reason: 'RESEND_API_KEY or OWNER_EMAIL not set' };
  if (!fs.existsSync(reportPath)) return { sent: false, reason: `report not found: ${reportPath}` };

  const md = fs.readFileSync(reportPath, 'utf8');
  const subject = buildSubject(md);
  const html = buildHtml(md, { runUrl });
  if (dryRun) {
    console.log(`[email] DRY RUN — would send "${subject}" to ${OWNER_EMAIL} (${html.length} bytes HTML, ${md.length} bytes attachment)`);
    return { sent: false, reason: 'dry-run', subject, html };
  }
  try {
    await postJSON('https://api.resend.com/emails', {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [OWNER_EMAIL],
      subject,
      html,
      attachments: [{ filename: 'traffic-sources-report.md', content: Buffer.from(md).toString('base64') }],
    }, { Authorization: `Bearer ${RESEND_API_KEY}` });
    return { sent: true, subject, to: OWNER_EMAIL };
  } catch (e) {
    return { sent: false, reason: `Resend API error: ${e.message}` };
  }
}

module.exports = { sendTrafficReportEmail, markdownToHtml, splitReport, buildSubject, buildHtml };
