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
 * Above the summary sits a Google Analytics-style block (BRO-4136): nine
 * metric tiles and two charts, built from traffic-metrics.json (written by
 * analyze-traffic-sources.js via scripts/lib/traffic-metrics.js). They are
 * passed as data, not as markdown. Charts are rendered to PNG by QuickChart
 * at SEND time and attached inline (cid:), so the inbox never depends on a
 * third-party image host being up when the email is opened; if QuickChart is
 * down at send time the email goes out without the charts.
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
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
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
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(h[1].length + 1, 6); // report's h1 → h2 (email already has a title)
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
    // Every iteration MUST consume at least one line — a line no branch claims
    // (e.g. "#", "|" alone) would otherwise loop forever (Codex review).
    if (!para.length) { para.push(lines[i]); i++; }
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
  const range = title.replace(/^Traffic sources — /, '');
  // "biggest changes", not "spikes": the headline list is capped and deduped,
  // so it is a highlight count, not the number of spikes detected.
  return `Weekly traffic report${incomplete}: ${spikes} biggest change${spikes === 1 ? '' : 's'}, ${range}`;
}

/** Subject from the human summary: the week and the one-line gist. */
function buildHumanSubject(md) {
  const week = (md.match(/^# Your traffic, week of (.+)$/m) || [, ''])[1];
  const count = (md.match(/\*\*In short\.\*\* Last week the site had ([\d,]+) visits/) || [])[1];
  const mv = md.match(/visits \([^)]*\), (about the same as|(\d+)% (more|fewer) than) a typical week/) || [];
  const move = mv[1] ? (mv[2] ? `, ${mv[2]}% ${mv[3]} than usual` : ', about usual') : '';
  const incomplete = /Part of the data did not load/.test(md) ? ' (partial data)' : '';
  return `Your traffic, week of ${week}${count ? `: ${count} visits${move}` : ''}${incomplete}`;
}

const attr = (v) => escapeHtml(v).replace(/"/g, '&quot;'); // escapeHtml skips quotes

/**
 * The tiles as wrapping inline-blocks ("fluid hybrid"): 3 across in a desktop
 * inbox, 2 across on a phone, no media queries (Gmail apps ignore many). A
 * fixed 3-column table overflowed a 390px iPhone screen. Inline styles only.
 * Exported for tests.
 */
function tilesHtml(tiles) {
  if (!Array.isArray(tiles) || !tiles.length) return '';
  const tile = (t) => {
    const lines = (t.lines || []).map((l) => {
      // Colour only the leading change figure: green up, red down.
      const m = String(l).match(/^([+−-]\d+%)(.*)$/);
      if (!m) return `<div style="font-size:12px;color:#6b7280;">${escapeHtml(l)}</div>`;
      const color = m[1].startsWith('+') ? '#047857' : '#b91c1c';
      return `<div style="font-size:12px;color:#6b7280;"><span style="color:${color};font-weight:600;">${escapeHtml(m[1])}</span>${escapeHtml(m[2])}</div>`;
    }).join('');
    const size = String(t.value).length > 12 ? 16 : 24;
    return `<div class="bwsc-tile" style="display:inline-block;box-sizing:border-box;width:31.3%;min-width:150px;min-height:96px;margin:0 1% 8px 0;padding:10px 12px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;vertical-align:top;font-size:14px;line-height:1.35;">`
      + `<div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;">${escapeHtml(t.label)}</div>`
      + `<div style="font-size:${size}px;font-weight:700;color:#111827;margin:4px 0 2px;line-height:1.2;">${escapeHtml(t.value)}</div>${lines}</div>`;
  };
  // font-size:0 removes the whitespace gaps between inline-blocks.
  return `<div style="font-size:0;margin:8px 0 12px;">${tiles.map(tile).join('')}</div>`;
}

/** Inline chart images; `images` is [{ cid, alt }] for charts that rendered. */
function chartsHtml(images) {
  return (images || []).map((im) => `<p style="margin:12px 0;"><img src="cid:${attr(im.cid)}" alt="${attr(im.alt)}" width="640" style="max-width:100%;height:auto;border:1px solid #e5e7eb;border-radius:6px;"></p>`).join('');
}

/**
 * @param md the summary (or report) markdown
 * @param opts.tiles / opts.images  the GA-style block, placed right under the title
 * @param opts.dashboardUrl         footer link to /admin/traffic
 */
function buildHtml(md, { runUrl, tiles, images, dashboardUrl } = {}) {
  const { summary } = splitReport(md);
  // Title first, then the tiles and charts, then the rest of the summary.
  const firstBreak = summary.indexOf('\n');
  const hasTitle = /^# /.test(summary) && firstBreak !== -1;
  const title = hasTitle ? summary.slice(0, firstBreak) : '';
  const rest = hasTitle ? summary.slice(firstBreak + 1) : summary;
  const block = tilesHtml(tiles) + chartsHtml(images);
  const dash = dashboardUrl ? `<p style="margin:16px 0;font-size:14px;"><a href="${attr(dashboardUrl)}" style="color:#2563eb;font-weight:600;">See the dashboard</a> for the full charts, 52 weeks back.</p>` : '';
  const safeUrl = runUrl ? attr(runUrl) : '';
  const link = runUrl ? `<p style="margin:16px 0;color:#9ca3af;font-size:11px;">Run log (for debugging only): <a href="${safeUrl}">${safeUrl}</a></p>` : '';
  return `<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:#111827;max-width:720px;">${title ? markdownToHtml(title) : ''}${block}${markdownToHtml(rest)}${dash}${link}</div>`;
}

const QUICKCHART_URL = 'https://quickchart.io/chart';

/**
 * Render a Chart.js config to PNG via QuickChart's POST endpoint (no URL
 * length limit, no API key). Returns a Buffer, or null on any failure — the
 * caller then sends without that chart. `fetchImpl` is injectable for tests.
 */
async function renderChartPng(config, { width = 640, height = 260, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(QUICKCHART_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: config, width, height, backgroundColor: 'white', devicePixelRatio: 2, format: 'png' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { console.error(`[email] QuickChart ${res.status}; sending without this chart`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG signature check: an error page with a 200 must not go out as a broken image.
    if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) { console.error('[email] QuickChart returned a non-PNG body; sending without this chart'); return null; }
    return buf;
  } catch (e) {
    console.error(`[email] QuickChart unreachable (${e.message}); sending without this chart`);
    return null;
  }
}

/** Render the charts in traffic-metrics.json → { images: [{cid, alt}], attachments: [...] }. */
async function renderCharts(charts, opts = {}) {
  const specs = [
    ['weekly', 'traffic-weekly', 'Visits per week, last 13 weeks', 260],
    ['topPages', 'traffic-top-pages', 'Top landing pages last week', 300],
  ];
  const images = [];
  const attachments = [];
  for (const [key, cid, alt, height] of specs) {
    if (!charts || !charts[key]) continue;
    const png = await renderChartPng(charts[key], { height, ...opts });
    if (!png) continue;
    images.push({ cid, alt });
    attachments.push({ filename: `${cid}.png`, content: png.toString('base64'), content_id: cid });
  }
  return { images, attachments };
}

/**
 * @param summaryPath the human summary (scripts/lib/traffic-report-human.js);
 *   when given it is the email body and the full report is only attached.
 *   Without it the top of the full report is used (older artifacts).
 */
async function sendTrafficReportEmail({ reportPath, summaryPath, metricsPath, dashboardUrl, runUrl, dryRun = false, to } = {}) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const OWNER_EMAIL = to || process.env.OWNER_EMAIL;
  if (!RESEND_API_KEY || !OWNER_EMAIL) return { sent: false, reason: 'RESEND_API_KEY or OWNER_EMAIL not set' };
  if (!fs.existsSync(reportPath)) return { sent: false, reason: `report not found: ${reportPath}` };

  const md = fs.readFileSync(reportPath, 'utf8');
  // An empty or truncated file must not go out looking like a clean report.
  if (!/^# /m.test(md) || !/^## What changed/m.test(md)) {
    return { sent: false, reason: `report at ${reportPath} is missing its title or "What changed" section (${md.length} bytes)` };
  }
  let body = md;
  let subject = buildSubject(md);
  if (summaryPath) {
    if (!fs.existsSync(summaryPath)) return { sent: false, reason: `summary not found: ${summaryPath}` };
    body = fs.readFileSync(summaryPath, 'utf8');
    if (!/^# Your traffic/m.test(body) || !/## What's working/.test(body)) return { sent: false, reason: `summary at ${summaryPath} is not a complete human summary (${body.length} bytes)` };
    subject = buildHumanSubject(body);
  }
  // The GA-style block is optional: an older artifact (or a failed metrics
  // write) still sends the plain summary.
  let tiles = null;
  let charts = { images: [], attachments: [] };
  if (metricsPath && fs.existsSync(metricsPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
      tiles = m.tiles;
      charts = await renderCharts(m.charts);
    } catch (e) { console.error(`[email] metrics at ${metricsPath} unreadable (${e.message}); sending without tiles`); }
  }
  const html = buildHtml(body, { runUrl, tiles, images: charts.images, dashboardUrl });
  if (dryRun) {
    console.log(`[email] DRY RUN — would send "${subject}" to ${OWNER_EMAIL} (${html.length} bytes HTML, ${tiles ? tiles.length : 0} tiles, ${charts.images.length} charts, ${md.length} bytes attachment)`);
    return { sent: false, reason: 'dry-run', subject, html, attachments: charts.attachments };
  }
  try {
    await postJSON('https://api.resend.com/emails', {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [OWNER_EMAIL],
      subject,
      html,
      attachments: [...charts.attachments, { filename: 'traffic-sources-report.md', content: Buffer.from(md).toString('base64') }],
    }, { Authorization: `Bearer ${RESEND_API_KEY}` });
    return { sent: true, subject, to: OWNER_EMAIL };
  } catch (e) {
    return { sent: false, reason: `Resend API error: ${e.message}` };
  }
}

module.exports = { sendTrafficReportEmail, markdownToHtml, splitReport, buildSubject, buildHumanSubject, buildHtml, tilesHtml, chartsHtml, renderChartPng, renderCharts };
