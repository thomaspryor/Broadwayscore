#!/usr/bin/env node
'use strict';
// Audit every national-tour surface on the live site (BRO-4723).
//
// Crawls the tours list, every category:'tour' show page and every
// /tours/<city> page the data says should exist, and checks each against
// data/shows.json, data/tour-schedules.json and data/tour-tickets.json:
// stale "Now in", stops past closing, copied/merged schedules, wrong
// Broadway parent or borrowed art, missing poster/runtime/synopsis, ticket
// links on the wrong stop or on closed tours, review counts that disagree,
// noindex vs sitemap, Event JSON-LD validity, city page venues/dates, and
// (with --mobile) horizontal overflow at 390px.
//
// Usage:
//   node scripts/audit-tour-pages.js                 # prod, all checks but mobile
//   node scripts/audit-tour-pages.js --mobile        # add the 390px overflow probe (Playwright)
//   node scripts/audit-tour-pages.js --base=http://localhost:3000
//   node scripts/audit-tour-pages.js --json=out.json --summary
//   node scripts/audit-tour-pages.js --data-only     # data checks, no network
//   node scripts/audit-tour-pages.js --alert         # one Linear card per error code (CI)
// Exit: 0 clean (warnings allowed; with --alert, also when every error has a
// card), 1 errors found, 2 could not run, 3 --alert could not file a card.
// Pure checks: scripts/lib/tour-page-audit.js (tests/unit/tour-page-audit.test.mjs).

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('audit-tour-pages.js [--base=URL] [--mobile] [--warnings] [--json=FILE] [--summary] [--data-only] [--alert] [--today=YYYY-MM-DD]');
  process.exit(0);
}

const A = require('./lib/tour-page-audit');

// Error codes from the last --alert run (deploy-lag confirmation, see runAlerts).
const LAST_CODES_FILE = path.join(__dirname, '..', 'data', 'audit', 'tour-audit-last-codes.json');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const BASE = String(args.base || 'https://broadwayscorecard.com').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const today = args.today || new Date().toISOString().slice(0, 10);
// A page built before midnight UTC is still the live one until the next
// deploy, so yesterday's answer is accepted too.
const todays = [A.addDays(today, -1), today];

const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'BroadwayScorecard-tour-audit/1.0' } });
      // A 5xx or 429 is usually a blip: retry before it becomes a finding.
      if ((res.status >= 500 || res.status === 429) && i < tries - 1) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      const text = res.status === 200 ? await res.text() : '';
      return { status: res.status, text, location: res.headers.get('location') };
    } catch (e) {
      if (i === tries - 1) return { status: 0, text: '', error: e.message };
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return { status: 0, text: '' };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function sitemapUrls() {
  const robots = await fetchText(`${BASE}/robots.txt`);
  let maps = (robots.text.match(/^Sitemap:\s*(\S+)/gim) || []).map(l => l.replace(/^Sitemap:\s*/i, ''));
  if (!maps.length) maps = [`${BASE}/sitemap.xml`];
  const urls = new Set();
  for (const m of maps) {
    const r = await fetchText(m.replace(/^https?:\/\/[^/]+/, BASE));
    for (const loc of r.text.match(/<loc>[^<]+<\/loc>/g) || []) urls.add(loc.replace(/<\/?loc>/g, '').replace(/^https?:\/\/[^/]+/, ''));
  }
  return urls;
}

async function mobileOverflow(paths) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return { skipped: 'playwright not installed' }; }
  const launch = { headless: true };
  if (fs.existsSync('/opt/pw-browsers/chromium')) {
    const dir = fs.readdirSync('/opt/pw-browsers').find(d => /^chromium-\d+$/.test(d));
    const exe = dir && path.join('/opt/pw-browsers', dir, 'chrome-linux', 'chrome');
    if (exe && fs.existsSync(exe)) launch.executablePath = exe;
  }
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const results = [];
  await pool(paths, 3, async p => {
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const sw = document.documentElement.scrollWidth;
        const offenders = [];
        if (sw > vw + 1) {
          for (const el of document.querySelectorAll('body *')) {
            const b = el.getBoundingClientRect();
            if (b.width && b.right > vw + 1) {
              let hidden = false;
              for (let a = el.parentElement; a; a = a.parentElement) {
                const o = getComputedStyle(a).overflowX;
                if (o === 'hidden' || o === 'auto' || o === 'scroll' || o === 'clip') { hidden = true; break; }
              }
              if (!hidden) offenders.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).split(' ').slice(0, 3).join('.')} right=${Math.round(b.right)}`);
            }
            if (offenders.length >= 3) break;
          }
        }
        return { vw, sw, offenders };
      });
      if (r.sw > r.vw + 1) results.push({ path: p, ...r });
    } catch (e) {
      results.push({ path: p, error: e.message });
    } finally { await page.close(); }
  });
  await browser.close();
  return { results };
}

async function main() {
  const showsFile = readJson('data/shows.json');
  const shows = showsFile.shows || showsFile;
  const byId = new Map(shows.map(s => [s.id, s]));
  const tours = shows.filter(s => s.category === 'tour');
  const schedules = readJson('data/tour-schedules.json').tours || {};
  const tickets = readJson('data/tour-tickets.json').tours || {};
  if (!tours.length) { console.error('No category:tour shows in data/shows.json (stub data?)'); process.exit(2); }

  const findings = [];
  const add = fs_ => findings.push(...fs_);

  // 1. Data checks (no network).
  for (const t of tours) {
    add(A.checkTourData({ show: t, parent: byId.get(t.tourOf), schedule: schedules[t.id], tickets: tickets[t.id] || [], others: schedules, today, shows }));
  }
  for (const id of Object.keys(schedules)) {
    const s = byId.get(id);
    if (!s) findings.push({ severity: 'error', code: 'schedule-orphan', where: `data:${id}`, message: 'schedule for an id not in shows.json' });
    else if (s.category !== 'tour') findings.push({ severity: 'error', code: 'schedule-non-tour', where: `data:${id}`, message: `schedule attached to a ${s.category} show` });
  }
  for (const id of Object.keys(tickets)) if (!schedules[id]) findings.push({ severity: 'error', code: 'tickets-orphan', where: `data:${id}`, message: 'ticket rows for a tour with no schedule' });

  let pagesChecked = 0;
  let cityCount = 0;
  if (!args['data-only']) {
    // 2. Tours list + sitemap.
    const sitemap = await sitemapUrls();
    if (!sitemap.size) { console.error(`Could not read the sitemap from ${BASE}`); process.exit(2); }
    const listUrl = '/browse/broadway-national-tours';
    const listRes = await fetchText(`${BASE}${listUrl}`);
    if (listRes.status !== 200) { console.error(`${listUrl} returned ${listRes.status}`); process.exit(2); }
    const list = A.parseListPage(listRes.text);
    pagesChecked++;
    const listed = new Map(list.shows.filter(s => byId.get(s.id)?.category === 'tour').map(s => [s.id, s]));
    // Listed tours are indexed and on the list: a missing schedule is an error there.
    for (const f of findings) if (f.code === 'schedule-missing' && listed.has(f.where.slice(5))) f.severity = 'error';
    for (const s of list.shows) if (!byId.has(s.id) || byId.get(s.id).category !== 'tour') findings.push({ severity: 'error', code: 'list-non-tour', where: listUrl, message: `list links /show/${s.id}, not a tour` });
    if (list.countLabel != null && list.countLabel !== listed.size) findings.push({ severity: 'error', code: 'list-count-label', where: listUrl, message: `"${list.countLabel} shows" label, ${listed.size} cards` });
    if (/noindex/.test(list.robots)) findings.push({ severity: 'error', code: 'list-noindex', where: listUrl, message: 'tours list is noindex' });
    if (!sitemap.has(listUrl)) findings.push({ severity: 'error', code: 'list-not-in-sitemap', where: listUrl, message: 'tours list missing from sitemap' });
    for (const [id, s] of listed) {
      const t = byId.get(id);
      const nn = A.nowNext((schedules[id] && schedules[id].stops) || [], today);
      if (t.status === 'closed' && s.line) findings.push({ severity: 'error', code: 'list-closed-now-next', where: listUrl, message: `${id} is closed but its card says "${s.line}"` });
      if (s.line && /^Now in/.test(s.line) && !nn.now && !A.nowNext(schedules[id]?.stops || [], todays[0]).now) findings.push({ severity: 'error', code: 'list-now-stale', where: listUrl, message: `${id} card says "${s.line}", nothing playing today` });
    }

    // 3. City pages the data says exist.
    const expected = A.expectedCities({ tours, schedules, listedIds: new Set(listed.keys()), today });
    const expectedYesterday = A.expectedCities({ tours, schedules, listedIds: new Set(listed.keys()), today: todays[0] });
    const cityPages = new Set(expected.keys());
    cityCount = expected.size;
    for (const p of sitemap) {
      const m = p.match(/^\/tours\/([^/]+)$/);
      if (m && !expected.has(m[1]) && !expectedYesterday.has(m[1])) findings.push({ severity: 'error', code: 'sitemap-city-unexpected', where: p, message: 'city page in sitemap but data gives it no page' });
    }
    if (list.cityLinks.length) {
      for (const c of list.cityLinks) if (!cityPages.has(c)) findings.push({ severity: 'error', code: 'list-city-dead-link', where: listUrl, message: `links /tours/${c}, which the data gives no page` });
      for (const c of cityPages) if (!list.cityLinks.includes(c)) findings.push({ severity: 'error', code: 'list-city-missing', where: listUrl, message: `city page /tours/${c} is not linked from the tours list` });
    }

    // 4. Every tour show page.
    await pool(tours, 6, async t => {
      const url = `/show/${t.slug || t.id}`;
      const [r, j] = await Promise.all([fetchText(`${BASE}${url}`), fetchText(`${BASE}/data/shows/${t.id}.json`)]);
      pagesChecked++;
      if (r.status !== 200) {
        // A tour added to shows.json after the live build has no page yet:
        // core-data changes ride the next deploy (up to 6h). Listed or in
        // the sitemap means the live build knows it, so a miss is real.
        const known = listed.has(t.id) || sitemap.has(url);
        findings.push({ severity: known || r.status !== 404 ? 'error' : 'warn', code: 'page-status', where: url, message: `HTTP ${r.status}${known ? '' : ' (not in the live build yet?)'}` });
        return;
      }
      let jsonCount = null;
      try { const d = JSON.parse(j.text); jsonCount = Array.isArray(d.rv) ? d.rv.length : null; } catch { /* no public json */ }
      const page = A.parseShowPage(r.text);
      add(A.checkShowPage({
        url, page, show: t, parent: byId.get(t.tourOf), schedule: schedules[t.id], tickets: tickets[t.id] || [], todays,
        listed: listed.has(t.id), inSitemap: sitemap.has(url), listReviewCount: listed.get(t.id)?.reviewCount ?? null, jsonReviewCount: jsonCount,
        cityPages: args['city-links'] === 'off' ? null : cityPages,
      }));
      for (const k of ['poster', 'thumbnail']) {
        const src = t.images && t.images[k];
        if (src && src.startsWith('/')) {
          let ir = { status: 0 };
          for (let n = 0; n < 3 && (ir.status === 0 || ir.status >= 500 || ir.status === 429); n++) {
            if (n) await new Promise(r => setTimeout(r, 2000 * n));
            ir = await fetch(`${BASE}${src}`, { method: 'HEAD' }).catch(() => ({ status: 0 }));
          }
          if (ir.status !== 200) findings.push({ severity: 'error', code: 'image-broken', where: url, message: `${k} ${src} returns ${ir.status}` });
        }
      }
    });

    // 5. Every city page.
    await pool(Array.from(expected.values()), 6, async c => {
      const url = `/tours/${c.slug}`;
      const r = await fetchText(`${BASE}${url}`);
      pagesChecked++;
      if (r.status !== 200) { findings.push({ severity: 'error', code: 'city-page-status', where: url, message: `HTTP ${r.status} (data says ${c.city} has a page)` }); return; }
      add(A.checkCityPage({ url, page: A.parseCityPage(r.text), expected: c, tours, schedules, tickets, todays, inSitemap: sitemap.has(url) }));
    });

    // 6. Mobile overflow.
    if (args.mobile) {
      const paths = [listUrl, ...tours.map(t => `/show/${t.slug || t.id}`), ...Array.from(expected.keys()).map(s => `/tours/${s}`)];
      const mo = await mobileOverflow(paths);
      if (mo.skipped) findings.push({ severity: 'error', code: 'mobile-skipped', where: 'mobile', message: mo.skipped });
      for (const r of mo.results || []) {
        findings.push(r.error
          ? { severity: 'warn', code: 'mobile-load-failed', where: r.path, message: r.error.slice(0, 160) }
          : { severity: 'error', code: 'mobile-overflow', where: r.path, message: `scrollWidth ${r.sw} > ${r.vw} at 390px: ${r.offenders.join('; ')}` });
      }
    }
  }

  const errors = findings.filter(f => f.severity === 'error');
  const warns = findings.filter(f => f.severity === 'warn');
  const byCode = {};
  for (const f of findings) byCode[`${f.severity}:${f.code}`] = (byCode[`${f.severity}:${f.code}`] || 0) + 1;
  if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ base: BASE, today, pagesChecked, cityPages: cityCount, tours: tours.length, errors: errors.length, warnings: warns.length, byCode, findings }, null, 2));

  console.log(`Tour audit ${BASE} as of ${today}: ${tours.length} tours, ${cityCount} city pages, ${pagesChecked} pages fetched`);
  console.log(`${errors.length} error(s), ${warns.length} warning(s)`);
  for (const [k, n] of Object.entries(byCode).sort()) console.log(`  ${k} ×${n}`);
  if (!args.summary) {
    for (const f of [...errors, ...(args.warnings ? warns : [])]) console.log(`${f.severity.toUpperCase()} ${f.code} ${f.where}: ${f.message}`);
    if (!args.warnings && warns.length) console.log('(add --warnings to list warnings)');
  }
  if (args.alert) {
    const runContext = process.env.GITHUB_RUN_ID ? {
      runId: process.env.GITHUB_RUN_ID,
      runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    } : {};
    let previousCodes = null;
    try { previousCodes = new Set(JSON.parse(fs.readFileSync(LAST_CODES_FILE, 'utf8')).codes); } catch { /* first run: file at once */ }
    const { alerts, pending, codes, alertDispatchFailed } = await A.runAlerts({ findings, router: require('./lib/owner-alert-router'), runContext, previousCodes });
    for (const a of alerts) console.log(`  [alert] ${a.conditionKey} -> ${a.action}${a.linearIdentifier ? ` (${a.linearIdentifier})` : ''}${a.dispatchOk ? '' : ' DISPATCH FAILED'}`);
    for (const c of pending) console.log(`  [alert] ${A.CONDITION_PREFIX}${c} -> waiting for a second run`);
    fs.mkdirSync(path.dirname(LAST_CODES_FILE), { recursive: true });
    fs.writeFileSync(LAST_CODES_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), base: BASE, codes }, null, 2) + '\n');
    process.exit(alertDispatchFailed ? 3 : 0);
  }
  process.exit(errors.length ? 1 : 0);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(2); });
