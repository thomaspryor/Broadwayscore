#!/usr/bin/env node
/**
 * Recoupment Announcement Scraper
 *
 * Detects "X recouped" / "X earned back capitalization" trade-press announcements
 * for Broadway shows. Designed for the Sunday newsletter pipeline — runs Friday
 * to surface late-week recoupment news that the weekly commercial-weekly.yml run
 * (Sundays 6pm UTC) would otherwise miss for 6 days.
 *
 * Flow per show:
 *   1. SERP queries on the show title scoped to recoupment language
 *   2. Filter results to credible Broadway outlets
 *   3. fetchPage() each candidate, LLM-extract (OpenAI gpt-4o-mini):
 *        { recouped, recoupedDate, productionMatch, confidence }
 *   4. Write high-confidence finds into commercial-pending-review.json
 *      with promoteRecommended:true so apply-commercial-pending picks them up.
 *
 * Default scope: shows with status open/closed AND opened 30-365 days ago AND
 * currently recouped=false/null. (Recoupment window is typically 6-52 weeks.)
 *
 * Usage:
 *   node scripts/scrape-recoupment-announcements.js                  # default scope
 *   node scripts/scrape-recoupment-announcements.js --shows=giant,ragtime
 *   node scripts/scrape-recoupment-announcements.js --dry-run        # print only
 *   node scripts/scrape-recoupment-announcements.js --window-days=14
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { serpQuery } = require('./lib/url-discovery');
const { fetchPage } = require('./lib/scraper');

// Worktrees don't ship the gitignored data files (shows.json, commercial.json
// live in the private repo and are only symlinked in the main checkout). Fall
// back to the main repo's data dir for inputs; keep pending-review writes local.
function dataPath(filename, { writable = false } = {}) {
  const local = path.join(__dirname, '..', 'data', filename);
  if (fs.existsSync(local)) return local;
  if (writable) return local;
  const mainRepo = path.join('/Users/tompryor/Broadwayscore/data', filename);
  if (fs.existsSync(mainRepo)) return mainRepo;
  return local;
}
const SHOWS_PATH = dataPath('shows.json');
const COMMERCIAL_PATH = dataPath('commercial.json');
const PENDING_PATH = dataPath('commercial-pending-review.json', { writable: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;

const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}
const DRY_RUN = flags['dry-run'] === true;
const WINDOW_DAYS = parseInt(flags['window-days'], 10) || 30;
const TARGETED = flags['shows'] ? flags['shows'].split(',').map(s => s.trim()).filter(Boolean) : null;
const MAX_RESULTS_PER_QUERY = 8;

// Outlets we trust for recoupment announcements (preferred sources). Shared with
// apply-commercial-pending.js so the auto-apply gate uses the same whitelist.
const { TRUSTED_RECOUPMENT_HOSTS: TRUSTED_OUTLETS } = require('./lib/trusted-recoupment-domains');

function log(...args) { console.log(...args); }

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(dateStr) {
  if (!dateStr) return Infinity;
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / 86_400_000);
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pickCandidates(allShows, commercial) {
  const shows = allShows.shows || allShows;
  const cMap = commercial.shows || {};

  if (TARGETED) {
    return TARGETED.map(slug => {
      const show = shows.find(s => s.slug === slug);
      if (!show) {
        log(`  ⚠ --shows=${slug}: not found in shows.json`);
        return null;
      }
      return show;
    }).filter(Boolean);
  }

  // Nonprofit-org enhancement deals: LCT/MTC/Roundabout/Second Stage shows
  // are technically "nonprofit" by designation but routinely carry commercial
  // co-producers (Ragtime 2025 had Tom Kirdahy / Greenblatt / Furman on top of
  // LCT). Those enhancement investors DO recoup, and the announcement IS
  // trade-press news. So we include Nonprofit shows that name a recognized
  // enhancement-friendly org. Pure non-enhancement nonprofits (NYTW, Public,
  // Signature, etc.) still skipped — they don't transfer or recoup.
  const ENHANCEMENT_FRIENDLY_ORGS = new Set([
    'Lincoln Center Theater',
    'Manhattan Theatre Club',
    'Roundabout Theatre Company',
    'Second Stage Theater',
    'The Public Theater',  // can transfer to Broadway with commercial enhancement
  ]);

  return shows.filter(s => {
    const c = cMap[s.slug];
    if (c?.recouped === true) return false;            // already known
    // Nonprofit-org filter: only skip pure-nonprofits (no enhancement-friendly
    // org). Enhancement deals (Ragtime, Oh Mary, etc.) must be scanned.
    if (c?.designation === 'Nonprofit' && !ENHANCEMENT_FRIENDLY_ORGS.has(c?.nonprofitOrg)) return false;
    const opened = s.openingDate || s.previewsStartDate;
    if (!opened) return false;
    const age = daysBetween(opened);
    if (age < 28) return false;       // too early
    if (age > 365) return false;      // beyond typical announcement window
    if (!['open', 'closed', 'closing'].includes(s.status)) return false;
    if (s.market && s.market !== 'broadway') return false; // OB/WE recoupment scraping needs different outlets
    return true;
  });
}

function buildQueries(showTitle) {
  return [
    `"${showTitle}" Broadway recouped`,
    `"${showTitle}" recoupment announcement`,
    `"${showTitle}" earned back investment`,
  ];
}

async function searchShow(show) {
  const title = show.title;
  const queries = buildQueries(title);
  const allResults = [];
  const seen = new Set();
  for (const q of queries) {
    log(`    🔎 ${q}`);
    let res;
    try {
      res = await serpQuery(q, { nbResults: MAX_RESULTS_PER_QUERY, preferSpeed: true });
    } catch (e) {
      log(`      ✗ SERP error: ${e.message}`);
      continue;
    }
    if (!res) continue;
    for (const r of res) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      allResults.push({ ...r, query: q });
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  return allResults;
}

function filterCandidates(results, showTitle) {
  return results.filter(r => {
    const host = hostnameOf(r.url);
    if (!host) return false;
    const titleLc = (r.title || '').toLowerCase();
    const haystack = `${titleLc} ${r.url.toLowerCase()}`;
    // Must mention recoupment or "recouped"
    if (!/recoup|earned back|paid off|profit/i.test(haystack)) return false;
    // Soft filter: prefer trusted outlets
    if (!TRUSTED_OUTLETS.has(host)) return false;
    return true;
  });
}

function callOpenAI(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function extractArticleText(html) {
  if (!html) return '';
  // Strip scripts/styles/comments
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 6000);
}

async function classifyArticle(showTitle, url, html) {
  const text = extractArticleText(html);
  if (text.length < 200) {
    return { recouped: false, confidence: 'low', reason: 'article body too short or unfetched' };
  }
  const prompt = `You are extracting a single fact from a trade-press article about a Broadway show.

Show: "${showTitle}"
Article URL: ${url}
Article text (truncated):
"""
${text}
"""

Question: Does this article state that THIS SPECIFIC production of "${showTitle}" has recouped its capitalization (earned back its investors' money)?

Important rules:
- "Recouped" means the show paid back its full initial capital investment.
- "Tracking to recoup", "expected to recoup", "on pace to recoup" do NOT count as recouped.
- An article about a PRIOR production of the same title (e.g. a 2009 revival when we're asking about a 2026 production) does NOT count.
- An article mentioning recoupment of a DIFFERENT show does NOT count.

Respond with a single JSON object:
{
  "recouped": true | false,
  "recoupedDate": "YYYY-MM-DD" or null,    // date the show recouped, if stated
  "articleDate": "YYYY-MM-DD" or null,     // when the article was published
  "productionMatch": "exact" | "same-title-different-year" | "different-show" | "unclear",
  "confidence": "high" | "medium" | "low",
  "evidence": "short quote from article supporting your answer"
}`;
  try {
    const raw = await callOpenAI(prompt);
    return JSON.parse(raw);
  } catch (e) {
    return { recouped: false, confidence: 'low', reason: `LLM error: ${e.message}` };
  }
}

function loadPending() {
  if (!fs.existsSync(PENDING_PATH)) return { shows: {}, lastUpdated: null };
  return loadJSON(PENDING_PATH);
}

// Archive of human-rejected pending entries (sweep moves things here). We read
// the archive before writing new finds — if a slug appears there with a
// rejected recouped:true claim, the scraper has already found and a human said
// no. Don't re-surface the same article.
function loadArchive() {
  const archivePath = dataPath('commercial-pending-archive.json', { writable: true });
  if (!fs.existsSync(archivePath)) return { shows: {} };
  try { return JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch { return { shows: {} }; }
}

// Strip volatile URL bits (utm_*, fbclid, gclid, ref, hash, trailing slash) so
// a single article shared with different tracking params still matches a prior
// rejection. Ship-check P1: without this, the same NYT recoupment article
// keeps re-surfacing through trivial URL variations.
function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    const drop = [];
    for (const k of u.searchParams.keys()) {
      if (k.startsWith('utm_') || ['fbclid', 'gclid', 'mc_eid', 'mc_cid', 'ref', 'source'].includes(k)) {
        drop.push(k);
      }
    }
    for (const k of drop) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, '');
  } catch { return url; }
}

function isRejectedInArchive(archive, slug, finding) {
  const e = archive.shows?.[slug];
  if (!e) return false;
  // Rejected if archived for being a recouped claim that didn't pass review,
  // and the same source URL (normalized) reappears.
  if (e.archivedReason !== 'rejected-recouped-claim') return false;
  if (!e.recoupedSource || !finding.url) return false;
  return normalizeUrl(e.recoupedSource) === normalizeUrl(finding.url);
}

function writePending(pending) {
  pending.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
}

async function processShow(show) {
  log(`\n— ${show.slug} (${show.title}) —`);
  const serpResults = await searchShow(show);
  const candidates = filterCandidates(serpResults, show.title);
  log(`  ${serpResults.length} SERP hits → ${candidates.length} credible candidates`);
  if (candidates.length === 0) return null;

  const findings = [];
  for (const c of candidates.slice(0, 4)) {  // cap per show
    log(`    📰 ${hostnameOf(c.url)} :: ${c.title?.slice(0, 80)}`);
    let html;
    try {
      const fetched = await fetchPage(c.url, { timeout: 25_000 });
      html = typeof fetched === 'string' ? fetched : (fetched?.content || '');
    } catch (e) {
      log(`      ✗ fetch failed: ${e.message}`);
      continue;
    }
    const verdict = await classifyArticle(show.title, c.url, html);
    log(`      → recouped=${verdict.recouped} match=${verdict.productionMatch} conf=${verdict.confidence}`);
    if (verdict.evidence) log(`         "${verdict.evidence.slice(0, 140)}"`);
    findings.push({ url: c.url, host: hostnameOf(c.url), serpTitle: c.title, verdict });
    if (verdict.recouped && verdict.productionMatch === 'exact' && verdict.confidence === 'high') break;
  }
  return findings;
}

function summarize(allFindings) {
  const promotable = [];
  for (const { show, findings } of allFindings) {
    if (!findings) continue;
    const positive = findings.find(f =>
      f.verdict.recouped === true &&
      f.verdict.productionMatch === 'exact' &&
      ['high', 'medium'].includes(f.verdict.confidence)
    );
    if (positive) promotable.push({ show, finding: positive, all: findings });
  }
  return promotable;
}

async function main() {
  if (!OPENAI_KEY) {
    console.error('FATAL: OPENAI_API_KEY not set');
    process.exit(1);
  }

  const allShows = loadJSON(SHOWS_PATH);
  const commercial = loadJSON(COMMERCIAL_PATH);
  const candidates = pickCandidates(allShows, commercial);

  log(`Recoupment scraper — ${candidates.length} shows in scope (window=${WINDOW_DAYS}d, dry-run=${DRY_RUN})`);
  log('');

  const allFindings = [];
  for (const show of candidates) {
    try {
      const findings = await processShow(show);
      allFindings.push({ show, findings });
    } catch (e) {
      log(`  ✗ ${show.slug} errored: ${e.message}`);
    }
  }

  const promotable = summarize(allFindings);

  log(`\n========== SUMMARY ==========`);
  log(`Shows scanned: ${candidates.length}`);
  log(`Promotable recoupment findings: ${promotable.length}`);
  for (const p of promotable) {
    log(`  ✅ ${p.show.slug}: ${p.finding.verdict.recoupedDate || 'date?'} (${p.finding.host})`);
    log(`     ${p.finding.url}`);
  }

  if (DRY_RUN) {
    log('\n[dry-run] not writing to commercial-pending-review.json');
    return;
  }

  if (promotable.length === 0) {
    log('\nNo high-confidence findings to write.');
    return;
  }

  const pending = loadPending();
  const archive = loadArchive();
  pending.shows = pending.shows || {};
  const now = new Date().toISOString();
  let written = 0;
  let skippedRejected = 0;
  for (const { show, finding } of promotable) {
    if (isRejectedInArchive(archive, show.slug, finding)) {
      log(`  ⏭️  ${show.slug}: same URL was archived as rejected — skipping`);
      skippedRejected++;
      continue;
    }
    pending.shows[show.slug] = {
      ...(pending.shows[show.slug] || {}),
      // Match deep-research-commercial.js:696-699 pattern: set BOTH
      // `recouped: true` (the value flowing into commercial.json on apply, see
      // apply-commercial-pending.js:145) AND `_recoupedClaim: true` (the
      // safety flag the apply gate checks). The auto-apply gate
      // (--auto-apply-claims-from + sourceHost + confidence) is what decides
      // whether this lands in commercial.json automatically.
      recouped: true,
      _recoupedClaim: true,
      recoupedDate: finding.verdict.recoupedDate || null,
      recoupedSource: finding.url,
      confidence: finding.verdict.confidence,
      evidence: finding.verdict.evidence || null,
      sourceHost: finding.host,
      detectedBy: 'recoupment-announcement-scraper',
      detectedAt: now,
      researchedAt: now, // canonical age-tracking field (sweep + apply use this)
      promoteRecommended: true,
    };
    written++;
  }
  writePending(pending);
  log(`\nWrote ${written} promote-recommended entries to ${path.relative(process.cwd(), PENDING_PATH)}` +
      (skippedRejected ? ` (skipped ${skippedRejected} previously-rejected URLs)` : ''));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
