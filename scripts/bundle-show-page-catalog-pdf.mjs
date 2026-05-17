#!/usr/bin/env node
/**
 * Bundle the show-page-catalog screenshots + spec into a single PDF.
 *
 * Reads from ~/Documents/claude-outputs/show-page-catalog/
 *   (manifest.json + *.png + SPEC.md)
 * Outputs:
 *   ~/Documents/claude-outputs/show-page-catalog/show-page-catalog.pdf
 *
 * One file. Drag-and-drop into Claude Design.
 */

import { chromium } from 'playwright';
import { readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const DIR = join(homedir(), 'Documents/claude-outputs/show-page-catalog');
const COMPRESSED_DIR = join(DIR, '_compressed');
const OUT = join(DIR, 'show-page-catalog.pdf');

// Target widths for embedded images (px). Originals are 2× device-pixel-ratio,
// so 2880px for desktop, 780px for mobile. Resize to keep the PDF well under
// the typical 20MB upload limit while staying legible.
// Configurable via env: TARGET_DESKTOP_W, TARGET_MOBILE_W, JPEG_QUALITY.
const TARGET_DESKTOP_W = Number(process.env.TARGET_DESKTOP_W ?? 900);
const TARGET_MOBILE_W = Number(process.env.TARGET_MOBILE_W ?? 420);
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY ?? 65);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

/** Light markdown → HTML (headings, lists, code, paragraphs, blockquotes, tables). */
function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let inCode = false;
  let inBlockquote = false;
  let inTable = false;

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeBq = () => { if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; } };
  const closeTable = () => { if (inTable) { out.push('</table>'); inTable = false; } };

  for (let raw of lines) {
    const line = raw;
    if (line.startsWith('```')) {
      closeList(); closeBq(); closeTable();
      if (inCode) { out.push('</pre>'); inCode = false; }
      else { out.push('<pre>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }

    if (line.startsWith('# ')) { closeList(); closeBq(); closeTable(); out.push(`<h1>${inlineMd(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { closeList(); closeBq(); closeTable(); out.push(`<h2>${inlineMd(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('### ')) { closeList(); closeBq(); closeTable(); out.push(`<h3>${inlineMd(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('> ')) {
      closeList(); closeTable();
      if (!inBlockquote) { out.push('<blockquote>'); inBlockquote = true; }
      out.push(`<p>${inlineMd(line.slice(2))}</p>`);
      continue;
    }
    if (/^[-*] /.test(line)) {
      closeBq(); closeTable();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineMd(line.replace(/^[-*] /, ''))}</li>`);
      continue;
    }
    if (line.startsWith('|')) {
      closeList(); closeBq();
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^[:-]+$/.test(c))) continue; // separator row
      if (!inTable) { out.push('<table>'); inTable = true; }
      const tag = out[out.length - 1]?.startsWith('<table>') ? 'th' : 'td';
      out.push(`<tr>${cells.map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join('')}</tr>`);
      continue;
    }
    if (line.trim() === '') { closeList(); closeBq(); closeTable(); out.push(''); continue; }
    closeTable();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList(); closeBq(); closeTable();
  return out.join('\n');
}

/** Resize+JPEG-compress a PNG via macOS `sips`. Returns the compressed path. */
function compressImage(srcPath, vpName) {
  const targetW = vpName === 'desktop' ? TARGET_DESKTOP_W : TARGET_MOBILE_W;
  const outPath = join(COMPRESSED_DIR, basename(srcPath).replace(/\.png$/, '.jpg'));
  if (existsSync(outPath)) return outPath;
  execFileSync('sips', [
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(JPEG_QUALITY),
    '--resampleWidth', String(targetW),
    srcPath,
    '--out', outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return outPath;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8'));
  const spec = await readFile(join(DIR, 'SPEC.md'), 'utf8');
  await mkdir(COMPRESSED_DIR, { recursive: true });

  const groups = [];
  let lastHeading = null;
  for (const e of manifest.entries) {
    if (e.group !== lastHeading) {
      groups.push({ heading: e.group, entries: [] });
      lastHeading = e.group;
    }
    groups[groups.length - 1].entries.push(e);
  }

  // 1100×1500 pages (~ 4:5.5 aspect); fits a desktop and mobile column side-by-side.
  const css = `
    @page { size: 1100px 1500px; margin: 32px; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; color: #111; margin: 0; padding: 0; line-height: 1.45; }
    h1 { font-size: 36px; margin: 0 0 8px; }
    h2 { font-size: 22px; margin: 24px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    h3 { font-size: 17px; margin: 18px 0 6px; }
    p, li { font-size: 13px; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; background: #f3f3f3; padding: 1px 4px; border-radius: 3px; }
    pre { background: #1a1a1a; color: #eee; padding: 12px; border-radius: 6px; font-size: 11px; overflow-x: auto; white-space: pre-wrap; }
    blockquote { border-left: 4px solid #888; margin: 12px 0; padding: 0 12px; color: #444; }
    table { border-collapse: collapse; margin: 12px 0; font-size: 12px; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f7f7f7; }
    ul { margin: 4px 0; padding-left: 22px; }
    .pagebreak { page-break-before: always; }
    .capture { margin-top: 28px; page-break-inside: avoid; }
    .capture-header { background: #111; color: #fff; padding: 10px 14px; border-radius: 6px 6px 0 0; }
    .capture-header h3 { color: #fff; margin: 0; font-size: 16px; }
    .capture-header .meta { color: #aaa; font-size: 12px; margin-top: 4px; }
    .capture-body { border: 1px solid #ddd; border-top: 0; padding: 10px; border-radius: 0 0 6px 6px; background: #fafafa; }
    .capture-row { display: flex; gap: 12px; align-items: flex-start; }
    .capture-col-desktop { flex: 3; min-width: 0; }
    .capture-col-mobile  { flex: 1; min-width: 0; }
    .vp-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-bottom: 4px; }
    .capture-col-desktop img, .capture-col-mobile img { max-width: 100%; height: auto; border: 1px solid #eee; display: block; }
    .focus-list { font-size: 11px; color: #555; margin: 6px 0 10px; }
    .focus-list strong { color: #111; }
  `;

  const parts = [];
  parts.push(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>`);
  parts.push(`<h1>Show Page Catalog</h1>`);
  parts.push(`<p style="font-size:13px;color:#555;">${manifest.entries.length} curated URLs · ${manifest.viewports.map((v) => v.name).join(' + ')} viewports · captured ${new Date(manifest.capturedAt).toLocaleString()}</p>`);
  parts.push(renderMarkdown(spec));

  for (const g of groups) {
    parts.push(`<div class="pagebreak"></div>`);
    parts.push(`<h2>${escapeHtml(g.heading)}</h2>`);
    for (const e of g.entries) {
      parts.push(`<div class="capture">`);
      parts.push(`<div class="capture-header">`);
      parts.push(`<h3>${escapeHtml(e.label)} <span style="color:#888;font-weight:400;font-family:ui-monospace,monospace;font-size:13px;">${escapeHtml(e.slug)}</span></h3>`);
      parts.push(`<div class="meta">${escapeHtml(e.why)}</div>`);
      parts.push(`</div>`);
      parts.push(`<div class="capture-body">`);
      if (e.focus && e.focus.length) {
        parts.push(`<div class="focus-list"><strong>What to focus on:</strong> ${e.focus.map(escapeHtml).join(' · ')}</div>`);
      }
      parts.push(`<div class="capture-row">`);
      for (const vp of manifest.viewports) {
        const file = e.files?.[vp.name];
        if (!file) continue;
        const compressed = compressImage(join(DIR, file), vp.name);
        const src = pathToFileURL(compressed).href;
        const cls = vp.name === 'desktop' ? 'capture-col-desktop' : 'capture-col-mobile';
        parts.push(`<div class="${cls}"><div class="vp-label">${vp.name} · ${vp.width}px</div><img src="${src}" alt="${escapeHtml(e.label)} ${vp.name}"></div>`);
      }
      parts.push(`</div></div></div>`);
    }
  }
  parts.push(`</body></html>`);

  const html = parts.join('\n');
  const tmpHtml = join(DIR, '_bundle.html');
  await writeFile(tmpHtml, html);

  console.log(`Rendering PDF (this can take 30-60s for full-page screenshots)...`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: 'networkidle' });
  await page.pdf({
    path: OUT,
    printBackground: true,
    preferCSSPageSize: true,
  });
  await browser.close();
  await unlink(tmpHtml).catch(() => {});
  const { size } = await stat(OUT);
  console.log(`✓ Wrote ${OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
