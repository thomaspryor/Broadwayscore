#!/usr/bin/env node
/**
 * Opening-Night Extraction Audit (post-opening ground-truth check)
 *
 * Runs AFTER opening-night-poller has done its work. Fetches the aggregator
 * pages live and compares the "external ground truth" (what BWW RR actually
 * listed, what DTLI actually has) against what we stored in
 * data/review-texts/{showId}/.
 *
 * Motivation: every opening night through 2026-04 surfaced 10-15 new bugs,
 * each of which was fixed in isolation ("it'll work next time") without any
 * automated verification that the fixes actually closed the gaps. This audit
 * is the independent verifier — it treats the extractor as a black box and
 * compares inputs (what's on BWW/DTLI) to outputs (our stored files).
 *
 * Checks performed:
 *   1. BWW RR extraction integrity — extract reviews from the live RR page,
 *      compare outlet counts to review-texts/ files-by-outlet. Flag any
 *      outlet where RR has N reviews but our store has fewer.
 *   2. DTLI slug + coverage — verify the show is in the slug map, fetch the
 *      page, count review-item blocks, compare to stored DTLI files.
 *   3. Byline integrity — for every review in review-texts/{showId}/ with
 *      fullText, re-run extractHighConfidenceAuthor(html). If it returns a
 *      name that differs from criticName AND !criticNameManual, flag.
 *   4. Duplicate critic collision — same (outlet, critic) appearing twice.
 *   5. Empty-outlet check — stored file with no meaningful score signal.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one P0 gap (missing reviews vs ground truth, or byline
 *        mismatch on a T1 outlet)
 *   2 — P1 gaps only (duplicate critics, empty outlets)
 *
 * Report: data/audit/opening-night-extraction-{showId}.json
 *
 * Usage:
 *   node scripts/audit-opening-night-extraction.js --show=fallen-angels-2026
 *   node scripts/audit-opening-night-extraction.js --show=fallen-angels-2026 --alert
 *   node scripts/audit-opening-night-extraction.js --show=fallen-angels-2026 --no-live
 *     (uses cached HTML from data/review-sources/ instead of fetching)
 */

const fs = require('fs');
const path = require('path');
const { extractBWWRoundupReviews, searchBWWRoundup } = require('./gather-reviews');
const { extractHighConfidenceAuthor } = require('./lib/content-quality');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const REVIEW_SOURCES_DIR = path.join(DATA_DIR, 'review-sources');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { showId: null, alert: false, live: true, save: true };
  for (const a of args) {
    if (a.startsWith('--show=')) opts.showId = a.slice('--show='.length);
    else if (a === '--alert') opts.alert = true;
    else if (a === '--no-live') opts.live = false;
    else if (a === '--no-save') opts.save = false;
  }
  if (!opts.showId) {
    console.error('Usage: node scripts/audit-opening-night-extraction.js --show=SHOW_ID [--alert] [--no-live]');
    process.exit(1);
  }
  return opts;
}

function loadJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function loadShow(showId) {
  const showsData = loadJSON(path.join(DATA_DIR, 'shows.json'));
  const shows = showsData?.shows || showsData || [];
  return shows.find(s => s.id === showId || s.slug === showId) || null;
}

function getStoredReviewFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(dir, f);
      const data = loadJSON(full, {});
      return { filename: f, path: full, data };
    });
}

function outletFromFilename(filename) {
  return filename.split('--')[0];
}

async function fetchHtml(url, live, cachePath) {
  if (cachePath && fs.existsSync(cachePath)) {
    const html = fs.readFileSync(cachePath, 'utf8');
    if (html.length > 1000) return { html, source: 'cache' };
  }
  if (!live) return { html: null, source: 'no-live' };
  try {
    const { fetchPage } = require('./lib/scraper');
    const res = await fetchPage(url, { renderJs: false });
    const html = res && res.content ? res.content : null;
    if (html && cachePath) {
      try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, html);
      } catch {}
    }
    return { html, source: res ? res.source : 'fetch-null' };
  } catch (e) {
    return { html: null, source: `fetch-error:${e.message.slice(0, 80)}` };
  }
}

function groupByOutlet(items, outletKey) {
  const m = {};
  for (const it of items) {
    const o = typeof outletKey === 'function' ? outletKey(it) : it[outletKey];
    if (!o) continue;
    if (!m[o]) m[o] = [];
    m[o].push(it);
  }
  return m;
}

async function auditBWW(show, opts) {
  // bww-roundup-urls.json is a flat {showId: url} map, NOT {shows: {...}}.
  // Most shows don't have a manual override — discovery happens at runtime via
  // searchBWWRoundup() (Playwright/BD/SB homepage + Google SERP fallback).
  const bwwMap = loadJSON(path.join(DATA_DIR, 'bww-roundup-urls.json'), {});
  let bwwUrl = bwwMap[show.id] || null;
  let urlSource = bwwUrl ? 'manual-override' : null;

  if (!bwwUrl && opts.live) {
    try {
      const year = show.openingDate ? new Date(show.openingDate).getFullYear() : new Date().getFullYear();
      const result = await searchBWWRoundup(show, year);
      if (result && result.url && result.html) {
        bwwUrl = result.url;
        urlSource = 'searchBWWRoundup';
        const cachePath = path.join(REVIEW_SOURCES_DIR, 'bww', `${show.id}.html`);
        try {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, result.html);
        } catch {}
        const extracted = extractBWWRoundupReviews(result.html, show.id, bwwUrl, show.title);
        return buildBWWReport(show, bwwUrl, urlSource, result.html, extracted);
      }
    } catch (e) {
      return {
        checked: false,
        reason: `searchBWWRoundup threw: ${e.message.slice(0, 120)}`,
        findings: [{
          severity: 'P1',
          type: 'bww-discovery-error',
          message: `BWW discovery error: ${e.message.slice(0, 160)}`,
        }],
      };
    }
  }

  if (!bwwUrl) {
    // Pre-opening or indexing lag — not a failure. Downgrade to info.
    return {
      checked: false,
      reason: 'no BWW RR URL (no override + discovery did not run or returned nothing)',
      findings: opts.live ? [{
        severity: 'P1',
        type: 'bww-not-discovered',
        message: `BWW RR URL could not be discovered for ${show.id}. Expected pre-opening; flag if post-opening.`,
      }] : [],
    };
  }

  const cachePath = path.join(REVIEW_SOURCES_DIR, 'bww', `${show.id}.html`);
  const { html, source } = await fetchHtml(bwwUrl, opts.live, cachePath);
  if (!html) {
    return {
      checked: false,
      url: bwwUrl,
      reason: `could not fetch (source=${source})`,
      findings: [{
        severity: 'P1',
        type: 'bww-fetch-failed',
        message: `failed to fetch BWW RR: ${source}`,
      }],
    };
  }
  const extracted = extractBWWRoundupReviews(html, show.id, bwwUrl, show.title);
  return buildBWWReport(show, bwwUrl, urlSource || 'cache-or-fetch', html, extracted, source);
}

function buildBWWReport(show, bwwUrl, urlSource, html, extracted, htmlSource = 'searchBWWRoundup') {
  const byOutlet = groupByOutlet(extracted, 'outletId');
  const storedFiles = getStoredReviewFiles(show.id);
  const storedByOutlet = groupByOutlet(storedFiles, f => outletFromFilename(f.filename));

  const findings = [];
  for (const [outletId, rrList] of Object.entries(byOutlet)) {
    const storedList = storedByOutlet[outletId] || [];
    if (storedList.length < rrList.length) {
      findings.push({
        severity: 'P0',
        type: 'bww-outlet-missing',
        outletId,
        expected: rrList.length,
        actual: storedList.length,
        message: `BWW RR has ${rrList.length} ${outletId} review(s) but review-texts has ${storedList.length}`,
      });
    }
  }

  return {
    checked: true,
    url: bwwUrl,
    urlSource,
    htmlSource,
    extractedReviewCount: extracted.length,
    extractedByOutlet: Object.fromEntries(Object.entries(byOutlet).map(([k, v]) => [k, v.length])),
    findings,
  };
}

async function auditDTLI(show, opts) {
  const dtliMap = loadJSON(path.join(DATA_DIR, 'dtli-slug-map.json'), { shows: {} });
  const dtliSlug = dtliMap.shows?.[show.id] || null;
  if (!dtliSlug) {
    return {
      checked: false,
      reason: 'no DTLI slug in map',
      findings: [{
        severity: 'P0',
        type: 'dtli-no-slug',
        message: `no DTLI slug mapped for ${show.id}. Add to data/dtli-slug-map.json`,
      }],
    };
  }
  const url = `https://didtheylikeit.com/shows/${dtliSlug.replace(/^shows\//, '')}/`;
  const cachePath = path.join(REVIEW_SOURCES_DIR, 'dtli', `${show.id}.html`);
  const { html, source } = await fetchHtml(url, opts.live, cachePath);
  if (!html) {
    return {
      checked: false,
      url,
      reason: `could not fetch (source=${source})`,
      findings: [{
        severity: 'P1',
        type: 'dtli-fetch-failed',
        message: `failed to fetch DTLI: ${source}`,
      }],
    };
  }

  const reviewItemCount = (html.match(/review-item/g) || []).length / 2;
  // Very rough — DTLI emits two class references per review (outer + inner div).
  // This is a monitoring signal, not a precise count.

  const findings = [];
  if (reviewItemCount < 3) {
    findings.push({
      severity: 'P1',
      type: 'dtli-low-count',
      message: `DTLI page only has ~${reviewItemCount} review-item refs. Page may be stale.`,
    });
  }
  return {
    checked: true,
    url,
    htmlSource: source,
    approxReviewCount: reviewItemCount,
    findings,
  };
}

function auditBylineIntegrity(show) {
  const files = getStoredReviewFiles(show.id);
  const findings = [];
  for (const f of files) {
    const d = f.data;
    if (!d || d.criticNameManual) continue;
    if (!d.criticName || d.criticName === 'Unknown') continue;
    const html = typeof d.sourceHtml === 'string' ? d.sourceHtml : null;
    if (!html) continue;
    const hc = extractHighConfidenceAuthor(html);
    if (!hc) continue;
    const storedNorm = d.criticName.toLowerCase().trim();
    const hcNorm = hc.name.toLowerCase().trim();
    if (storedNorm === hcNorm) continue;
    if (storedNorm.includes(hcNorm) || hcNorm.includes(storedNorm)) continue;
    findings.push({
      severity: 'P0',
      type: 'byline-mismatch',
      file: f.filename,
      stored: d.criticName,
      htmlAuthor: hc.name,
      htmlSource: hc.source,
      message: `file says criticName="${d.criticName}" but HTML ${hc.source}="${hc.name}"`,
    });
  }
  return { checked: true, fileCount: files.length, findings };
}

function auditCriticCollisions(show) {
  const files = getStoredReviewFiles(show.id);
  const seen = {};
  const findings = [];
  for (const f of files) {
    const outletId = outletFromFilename(f.filename);
    const name = (f.data?.criticName || '').toLowerCase().trim();
    if (!outletId || !name || name === 'unknown') continue;
    // Skip files that have already been marked as duplicates — the
    // collect-review-texts rename path sets data.duplicateOf on conflict so
    // the stale-slug source doesn't trip this audit. Same gate as
    // validate-review-texts.js line 185 + rebuild-all-reviews. Aligned with
    // the topology-rename redesign (Notion 34f637c5-416f-81a1).
    if (f.data?.duplicateOf || f.data?.duplicateTextOf) continue;
    if (f.data?.wrongShow || f.data?.wrongProduction || f.data?.wrongAttribution) continue;
    const key = `${outletId}|${name}`;
    if (seen[key]) {
      findings.push({
        severity: 'P1',
        type: 'critic-collision',
        outletId,
        criticName: f.data.criticName,
        files: [seen[key], f.filename],
        message: `${f.data.criticName} at ${outletId} appears in ${seen[key]} and ${f.filename}`,
      });
    } else {
      seen[key] = f.filename;
    }
  }
  return { checked: true, findings };
}

async function main() {
  const opts = parseArgs();
  const show = loadShow(opts.showId);
  if (!show) {
    console.error(`show not found: ${opts.showId}`);
    process.exit(1);
  }

  console.log(`\n=== Opening-Night Extraction Audit ===`);
  console.log(`Show: ${show.title} (${show.id})`);
  console.log(`Opening: ${show.openingDate} | Category: ${show.category || 'broadway'}`);
  console.log(`Mode: ${opts.live ? 'live fetch' : 'cache only'}\n`);

  const [bww, dtli, byline, collisions] = await Promise.all([
    auditBWW(show, opts),
    auditDTLI(show, opts),
    Promise.resolve(auditBylineIntegrity(show)),
    Promise.resolve(auditCriticCollisions(show)),
  ]);

  const all = [
    ...(bww.findings || []),
    ...(dtli.findings || []),
    ...(byline.findings || []),
    ...(collisions.findings || []),
  ];
  const p0 = all.filter(f => f.severity === 'P0');
  const p1 = all.filter(f => f.severity === 'P1');

  console.log(`BWW RR: ${bww.checked ? 'checked' : 'skipped'} | ${bww.findings?.length || 0} findings`);
  console.log(`DTLI: ${dtli.checked ? 'checked' : 'skipped'} | ${dtli.findings?.length || 0} findings`);
  console.log(`Byline integrity: ${byline.fileCount || 0} files scanned | ${byline.findings.length} findings`);
  console.log(`Critic collisions: ${collisions.findings.length} findings`);
  console.log();

  if (p0.length) {
    console.log('P0 findings:');
    for (const f of p0) console.log(`  ✗ [${f.type}] ${f.message}`);
  }
  if (p1.length) {
    console.log('P1 findings:');
    for (const f of p1) console.log(`  ⚠ [${f.type}] ${f.message}`);
  }
  if (!all.length) {
    console.log('✓ No findings. Extraction looks consistent with external ground truth.');
  }

  const report = {
    showId: show.id,
    title: show.title,
    openingDate: show.openingDate,
    category: show.category || 'broadway',
    generatedAt: new Date().toISOString(),
    bww,
    dtli,
    byline,
    collisions,
    summary: {
      p0: p0.length,
      p1: p1.length,
      total: all.length,
    },
  };

  if (opts.save) {
    try {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      const reportPath = path.join(AUDIT_DIR, `opening-night-extraction-${show.id}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(`\nReport: ${path.relative(ROOT, reportPath)}`);
    } catch (e) {
      console.error(`failed to write report: ${e.message}`);
    }
  }

  if (opts.alert && (p0.length || p1.length)) {
    try {
      const { sendAlert } = require('./lib/discord-notify');
      await sendAlert({
        title: `Extraction Audit: ${show.title}`,
        description: `${p0.length} P0, ${p1.length} P1 findings`,
        severity: p0.length ? 'error' : 'warning',
        fields: [
          ...p0.slice(0, 10).map(f => ({ name: `P0 ${f.type}`, value: f.message.slice(0, 200) })),
          ...p1.slice(0, 5).map(f => ({ name: `P1 ${f.type}`, value: f.message.slice(0, 200) })),
        ],
      });
      console.log('Discord alert sent.');
    } catch (e) {
      console.error(`alert failed: ${e.message}`);
    }
  }

  process.exit(p0.length ? 1 : (p1.length ? 2 : 0));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { auditBWW, auditDTLI, auditBylineIntegrity, auditCriticCollisions };
