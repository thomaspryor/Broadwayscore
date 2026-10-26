#!/usr/bin/env node
/**
 * Probe Theatre Record's pre-2016 (scanned PDF) archive (BRO-6268).
 *
 * Logs in (TR_EMAIL / TR_PASSWORD, Actions only), then prints STRUCTURE only,
 * never review prose (CLAUDE.md §11):
 *   1. the search form's field names and select options (what filters exist),
 *   2. per query: result count, link shapes, venue/date labels of the first hits,
 *   3. for the first scanned (PDF) hit: page count, pdftotext chars per page,
 *      and tesseract word count + mean confidence on a few pages at each dpi.
 *
 * Usage (CI only, via we-historical-tr-ocr-probe.yml):
 *   node scripts/probe-tr-scanned.js --queries="Kinky Boots,Hangmen" --ocr-pages=3 --dpis=200,300
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { pdfUrlVariants } = require('./lib/tr-pdf-url');

const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || d;
const QUERIES = arg('queries', 'Kinky Boots').split(',').map(s => s.trim()).filter(Boolean);
const OCR_PAGES = Math.min(Math.max(parseInt(arg('ocr-pages', '3'), 10) || 1, 1), 10);
const DPIS = arg('dpis', '300').split(',').map(Number).filter(d => d >= 100 && d <= 400);
const PAGES_FROM = parseInt(arg('first-page', '1'), 10);
const TR_EMAIL = process.env.TR_EMAIL || '';
const TR_PASSWORD = process.env.TR_PASSWORD || '';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 200 * 1024 * 1024, ...opts }).toString();

function tesseractStats(imgPath) {
  const tsv = sh('tesseract', [imgPath, 'stdout', '--psm', '1', '-l', 'eng', 'tsv']);
  const rows = tsv.split('\n').slice(1).map(l => l.split('\t')).filter(c => c.length >= 12 && c[11] && c[11].trim());
  const confs = rows.map(c => parseFloat(c[10])).filter(x => x >= 0);
  const words = rows.length;
  const mean = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  const lowConf = confs.filter(x => x < 60).length;
  return { words, meanConf: +mean.toFixed(1), lowConfPct: confs.length ? +(100 * lowConf / confs.length).toFixed(1) : 0 };
}

(async () => {
  if (!TR_PASSWORD) { console.error('TR_PASSWORD required'); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });
  const page = await context.newPage();
  await page.goto('https://www.theatrerecord.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(TR_EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(TR_PASSWORD);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForTimeout(3000);
  const loggedIn = (await page.locator('text=Sign Out').count()) > 0;
  console.log('logged in:', loggedIn);
  if (!loggedIn) { console.error('login failed'); process.exit(1); }

  await page.goto('https://www.theatrerecord.com/search', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const form = await page.evaluate(() => [...document.querySelectorAll('form')].map(f => ({
    action: f.getAttribute('action'),
    fields: [...f.querySelectorAll('input,select')].map(e => ({
      tag: e.tagName, name: e.name, type: e.type, ph: e.placeholder || '',
      opts: e.tagName === 'SELECT' ? [...e.options].slice(0, 40).map(o => o.value + '=' + o.textContent.trim()) : undefined,
    })),
  })));
  console.log('SEARCH FORM:', JSON.stringify(form));

  let ocrDone = false;
  for (const q of QUERIES) {
    const url = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + q + '"')}&title=on&order=oldest`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const hits = await page.evaluate(() => [...document.querySelectorAll('article')].map(a => ({
      title: a.querySelector('h2')?.textContent?.trim(),
      venue: a.querySelector('h3')?.textContent?.trim(),
      link: [...a.querySelectorAll('a')].map(l => l.href).find(h => h.includes('/archive/')) || '',
      text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 160),
    })));
    console.log(`QUERY "${q}": ${hits.length} hits`);
    for (const h of hits.slice(0, 8)) console.log('  HIT', JSON.stringify({ title: h.title, venue: h.venue, link: h.link.replace('https://www.theatrerecord.com', ''), years: (h.text.match(/\b(19|20)\d\d\b/g) || []).slice(0, 3) }));

    if (ocrDone) continue;
    const pdfHit = hits.find(h => /\/(volume|issue)\//.test(h.link));
    if (!pdfHit) continue;
    const cookies = await context.cookies();
    const sess = cookies.find(c => c.name === 'PHPSESSID');
    if (!sess) { console.log('no PHPSESSID'); continue; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trocr-'));
    const pdf = path.join(tmp, 'issue.pdf');
    let got = false;
    for (const u of pdfUrlVariants(pdfHit.link)) {
      const jar = path.join(tmp, 'cookies.txt');
      fs.writeFileSync(jar, `www.theatrerecord.com\tFALSE\t/\tFALSE\t0\tPHPSESSID\t${sess.value}\n`, { mode: 0o600 });
      try { sh('curl', ['-s', '-f', '-L', '-m', '120', '-o', pdf, '-b', jar, u]); } catch (e) { console.log('  download failed, curl status', e.status); continue; }
      if (fs.readFileSync(pdf).subarray(0, 5).toString() === '%PDF-') { got = true; break; }
    }
    if (!got) { console.log('  not a PDF:', pdfHit.link); continue; }
    const info = sh('pdfinfo', [pdf]);
    const pages = parseInt((info.match(/Pages:\s+(\d+)/) || [])[1] || '0', 10);
    const textChars = sh('pdftotext', [pdf, '-']).replace(/\s+/g, '').length;
    console.log(`  PDF ${pdfHit.link.replace('https://www.theatrerecord.com', '')} pages=${pages} pdftotextChars=${textChars} (${(textChars / Math.max(pages, 1)).toFixed(0)}/page) size=${fs.statSync(pdf).size}`);
    const imgs = sh('pdfimages', ['-list', pdf]).split('\n').slice(2, 5).join(' | ');
    console.log('  pdfimages sample:', imgs.replace(/\s+/g, ' '));
    for (const dpi of DPIS) {
      for (let p = PAGES_FROM; p < PAGES_FROM + OCR_PAGES && p <= pages; p++) {
        const t0 = Date.now();
        const base = path.join(tmp, `p${p}-${dpi}`);
        sh('pdftoppm', ['-r', String(dpi), '-f', String(p), '-l', String(p), '-gray', '-png', pdf, base]);
        const img = fs.readdirSync(tmp).find(f => f.startsWith(`p${p}-${dpi}`) && f.endsWith('.png'));
        if (!img) { console.log(`  OCR dpi=${dpi} page=${p}: no image rendered`); continue; }
        const st = tesseractStats(path.join(tmp, img));
        console.log(`  OCR dpi=${dpi} page=${p}: ${JSON.stringify(st)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
    ocrDone = true;
  }
  await browser.close();
  if (!ocrDone) { console.error('no OCR performed'); process.exit(1); }
})().catch(e => { console.error('probe failed:', String(e && e.message).split('\n')[0].slice(0, 200)); process.exit(1); });
