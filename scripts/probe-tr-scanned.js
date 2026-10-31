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

require('./lib/cli-help').exitOnHelp(module);

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
    if (q.startsWith('@dump:')) {
      // @dump:<hit path>:<pdf page>:<lines> prints short lines (headers) of one PDF page; long lines are prose and only counted
      const [, hitPath, pg, nl] = q.split(':');
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'trdump-'));
      const pdf2 = path.join(tmp2, 'v.pdf');
      const cookies2 = await context.cookies();
      const sess2 = cookies2.find(c => c.name === 'PHPSESSID');
      const jar2 = path.join(tmp2, 'c.txt');
      fs.writeFileSync(jar2, `www.theatrerecord.com\tFALSE\t/\tFALSE\t0\tPHPSESSID\t${sess2.value}\n`, { mode: 0o600 });
      try { sh('curl', ['-s', '-f', '-L', '-m', '120', '-o', pdf2, '-b', jar2, 'https://www.theatrerecord.com' + hitPath]); } catch (e) { console.log('dump download failed', e.status); continue; }
      // BRO-6428: a volume page past the volume's end returns HTML with a 200; every pdftotext below would throw on it
      if (!fs.existsSync(pdf2) || fs.readFileSync(pdf2).subarray(0, 5).toString() !== '%PDF-') { console.log(`${hitPath} not-a-pdf`); continue; }
      if (pg === 'azraw') {
        // BRO-6298: the A-Z section only (a listing of titles, types, venues, dates, phone numbers; no review prose).
        // Finds the marker page via per-page layout text, then prints up to 8 pages from it as one line per
        // pdftotext -bbox-layout text line with its position: AZL|issue|page|xMin|yMin|xMax|text
        const id = hitPath.replace('/archive/issue/', '');
        // BRO-6428: a volume page past the volume's end returns an HTML page, not a PDF; skip it instead of aborting the batch
        let pages;
        try { pages = sh('pdftotext', ['-layout', pdf2, '-'], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\f'); } catch (e) { console.log(`AZRAW ${id} not-a-pdf`); continue; }
        const markerRe = /A\s*[-\u2013]\s*Z of (?:current )?(?:London )?productions/i;
        let first = pages.findIndex((t, i) => i >= pages.length * 0.4 && markerRe.test(t.replace(/\s+/g, ' ')));
        // BRO-6343: issue 160 prints no "A-Z of productions" heading text; its A-Z page carries this footnote
        if (first < 0) first = pages.findIndex((t, i) => i >= pages.length * 0.4 && /Page numbers in \(brackets\) refer to London-listed/i.test(t.replace(/\s+/g, ' ')));
        console.log(`AZRAW ${id} pages=${pages.length} markerPage=${first}`);
        if (first < 0) {
          pages.forEach((t, i) => t.split('\n').forEach(l => { if (/\bA-Z\b|productions|running in/i.test(l)) console.log(`AZHINT|${id}|p${i + 1}|${l.replace(/\s+/g, ' ').slice(0, 120)}`); }));
          continue;
        }
        const last = Math.min(pages.length, first + 10);
        const xml = sh('pdftotext', ['-bbox-layout', '-f', String(first + 1), '-l', String(last), pdf2, '-']);
        const dec = t => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        let pageNo = first;
        for (const pm of xml.split('<page ').slice(1)) {
          pageNo++;
          for (const lm of pm.matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([\s\S]*?)<\/line>/g)) {
            const text = dec([...lm[4].matchAll(/<word [^>]*>([^<]*)<\/word>/g)].map(w => w[1]).join(' '));
            console.log(`AZL|${id}|${pageNo}|${Math.round(lm[1])}|${Math.round(lm[2])}|${Math.round(lm[3])}|${text}`);
          }
        }
        continue;
      }
      if (pg === 'az') {
        // the issue's "A-Z of productions" listing: layout lines clipped to 60 chars (title/venue/date columns, no review prose)
        const all = sh('pdftotext', ['-layout', pdf2, '-']).split('\n').map(l => l.replace(/\s{3,}/g, '  |  ').trim());
        const at = all.findIndex(l => /A-Z of productions/i.test(l));
        console.log('DUMP az marker line', at, 'of', all.length);
        all.slice(Math.max(at - 3, 0), Math.max(at - 3, 0) + (parseInt(nl, 10) || 100)).forEach((l, i) => console.log('  Z' + i, JSON.stringify(l.slice(0, 60))));
        continue;
      }
      if (pg.startsWith('title=')) {
        // BRO-6343: @dump:<hit path>:title=<TITLE+WORDS>:<lines> prints the lines after each line holding the title
        // in capitals, in -layout and -raw, with every lowercase word masked to "x" (structure, names, dates; no prose).
        const want = pg.slice(6).replace(/\+/g, ' ').toUpperCase();
        const mask = l => l.replace(/\s{3,}/g, '  |  ').trim().replace(/\b[a-z][a-z'’-]*\b/g, 'x').replace(/(?:x[\s,.;]+){3,}/g, 'x… ').slice(0, 120);
        for (const mode of ['-layout', '-raw']) {
          const all = sh('pdftotext', [mode, pdf2, '-']).split('\n');
          let shown = 0;
          all.forEach((l, i) => {
            if (shown >= 6 || !l.toUpperCase().includes(want) || !l.includes(want)) return;
            shown++;
            console.log(`  T${mode} @${i}/${all.length}`);
            all.slice(Math.max(0, i - 2), i + Math.min(parseInt(nl, 10) || 20, 25)).forEach((x, k) => console.log(`    ${k - 2}`, JSON.stringify(mask(x))));
          });
          if (!shown) console.log(`  T${mode} no caps line holding ${want}`);
        }
        continue;
      }
      if (pg === 'heads') {
        // every ALL CAPS short line with the next 3 short lines (production headers carry title, venue, dates; no prose)
        const all = sh('pdftotext', ['-layout', pdf2, '-']).split('\n').map(l => l.replace(/\s{3,}/g, '  |  ').trim());
        let shown = 0;
        all.forEach((l, i) => {
          const t = l.replace(/\s*\|\s*Index$/, '');
          if (shown < (parseInt(nl, 10) || 80) && t.length >= 3 && t.length <= 60 && t === t.toUpperCase() && /[A-Z]{3}/.test(t)) {
            shown++;
            console.log('  H' + i, JSON.stringify([l, ...all.slice(i + 1, i + 4)].map(x => x.length > 90 ? '<prose>' : x)));
          }
        });
        console.log('DUMP heads total lines', all.length);
        continue;
      }
      const txt = sh('pdftotext', ['-f', pg, '-l', pg, '-layout', pdf2, '-']).split('\n');
      console.log(`DUMP ${hitPath} pdfpage ${pg}: ${txt.length} lines`);
      txt.slice(0, parseInt(nl, 10) || 40).forEach((l, i) => console.log('  L' + i, l.trim().length > 70 ? `<prose ${l.trim().length}>` : JSON.stringify(l.replace(/\s{3,}/g, '  |  '))));
      continue;
    }
    if (q.startsWith('@')) {
      // browse mode: print the link structure of an archive page (no prose)
      await page.goto('https://www.theatrerecord.com' + q.slice(1), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => ({ h: a.getAttribute('href') || '', t: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) })).filter(l => l.h.includes('/archive/')));
      console.log(`BROWSE ${q}: ${links.length} archive links`);
      for (const l of links.slice(0, 40)) console.log('  LINK', JSON.stringify(l));
      continue;
    }
    const url = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + q + '"')}&title=on&order=oldest`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const hits = await page.evaluate(() => [...document.querySelectorAll('article')].map(a => ({
      title: a.querySelector('h2')?.textContent?.trim(),
      hall: a.querySelector('h3')?.textContent?.trim(),
      link: [...a.querySelectorAll('a')].map(l => l.href).find(h => h.includes('/archive/')) || '',
      text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 160),
    })));
    console.log(`QUERY "${q}": ${hits.length} hits`);
    for (const h of hits.slice(0, 8)) console.log('  HIT', JSON.stringify({ title: h.title, hall: h.hall, link: h.link.replace('https://www.theatrerecord.com', ''), years: (h.text.match(/\b(19|20)\d\d\b/g) || []).slice(0, 3) }));

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
