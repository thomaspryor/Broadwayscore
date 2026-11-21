#!/usr/bin/env node
'use strict';
/**
 * BRO-7683: turn the productions scripts/bww-regional-coverage.js reports missing into add-show actions.
 *
 *   node scripts/bww-regional-add-plan.js [--report=data/audit/bww-regional-coverage.json] [--city=<hub slug>]
 *        [--max=N] [--apply] [--out=<actions.json>] [--today=YYYY-MM-DD]
 *
 * For each missing production it fetches the first BroadwayWorld review (fetchPage), asks Gemini what the review
 * covers (scripts/lib/bww-review-add.js checks every fact against the review text), and:
 *   - professional production -> add-show action (art from the review's og:image when it is usable),
 *   - community / school / touring / not theatre -> recorded as declined in data/audit/bww-regional-decisions.json,
 *     so the coverage audit stops reporting it,
 *   - a reading the text does not support -> held and reported (retried next run).
 * Without --apply nothing is written except the report printed to stdout.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const A = require('./lib/bww-review-add');
const S = require('./lib/city-season');
const { pageToText } = require('./lib/season-page-reader');
const { applyAddShow } = require('./lib/add-show-action');
const { DECISIONS } = require('./bww-regional-coverage');
const { GEMINI_FLASH } = require('./lib/models');
const { geminiThinkingOff } = require('./lib/llm-batch.js'); // 2.x: thinkingBudget 0, 3.x: thinkingLevel minimal (BRO-7511)

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => argv.includes(`--${k}`);
const today = arg('today', new Date().toISOString().slice(0, 10));

// Where a hub's own city row lives, for venues the review names without a town.
const HUB_HOME = {
  'chicago-il': { town: 'Chicago', state: 'IL' },
  'washington-dc': { town: 'Washington', state: 'DC' },
  'los-angeles-ca': { town: 'Los Angeles', state: 'CA' },
  'san-diego-ca': { town: 'San Diego', state: 'CA' },
  'boston-ma': { town: 'Boston', state: 'MA' },
};

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  require('./lib/gemini-usage-ledger').install();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: geminiThinkingOff(GEMINI_FLASH) } }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const t = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(String(t || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim());
}

/**
 * The review's own text: the page's NewsArticle JSON-LD articleBody (the visible page carries sidebars with other
 * shows' ads, which a model then reads as the review). Falls back to the page text.
 */
function articleText(html, url) {
  for (const m of String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    for (const n of [].concat(d && d['@graph'] ? d['@graph'] : d)) {
      if (n && typeof n.articleBody === 'string' && n.articleBody.length > 200) return n.articleBody.replace(/\s+/g, ' ').trim();
    }
  }
  return pageToText(html, url).text;
}

// BroadwayWorld's image CDN refuses a bot user agent without a referer (HTTP 403); a browser UA plus the article as
// referer gets the photo.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
async function downloadImage(url, referer) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': BROWSER_UA, Referer: referer || 'https://www.broadwayworld.com/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function ogImage(html, base) {
  const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html || '') || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html || '');
  if (!m) return null;
  try { return new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch { return null; }
}

async function main() {
  const report = JSON.parse(fs.readFileSync(arg('report', path.join(ROOT, 'data', 'audit', 'bww-regional-coverage.json')), 'utf8'));
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8')).shows;
  let decisions = { reviews: {} };
  try { decisions = JSON.parse(fs.readFileSync(DECISIONS, 'utf8')); } catch { /* first run */ }
  decisions.reviews = decisions.reviews || {};

  const taken = new Set(shows.map((s) => s.id));
  const pending = [];
  const pf = path.join(ROOT, 'data', 'pending-fixes');
  if (fs.existsSync(pf)) {
    const plans = [];
    for (const f of fs.readdirSync(pf)) { try { plans.push(JSON.parse(fs.readFileSync(path.join(pf, f), 'utf8'))); } catch { /* skip */ } }
    for (const sh of S.pendingShows(plans)) { taken.add(sh.id); pending.push(sh); }
  }
  let retired = () => false;
  try { retired = require('./lib/retired-show-ids').isRetiredId; } catch { /* registry missing */ }

  const { fetchPage, cleanup } = require('./lib/scraper');
  const { writeArt } = require('./city-season-sync');
  const max = Number(arg('max', 0)) || Infinity;
  const only = arg('city', null);
  const actions = [];
  const out = { added: [], declined: [], held: [], noArt: [] };
  const work = shows.map((s) => ({ ...s }));
  try {
    for (const hub of report.hubs) {
      if (only && hub.metro !== only) continue;
      const hubShows = shows.filter((s) => s.city === hub.metro);
      for (const m of hub.missing) {
        if (actions.length >= max) { out.held.push(`${m.title}: over the per-run cap`); continue; }
        const url = m.urls[0];
        let page;
        try { page = await fetchPage(url, { skipVerify: true }); } catch (e) { out.held.push(`${m.title}: fetch failed (${String(e.message).slice(0, 80)})`); continue; }
        const html = (page && page.content) || '';
        const text = articleText(html, url);
        if (text.length < 400) { out.held.push(`${m.title}: review text too short`); continue; }
        let reading;
        try { reading = await askGemini(A.buildPrompt({ headline: m.headline || m.title, text, reviewDate: m.firstReview })); } catch (e) { out.held.push(`${m.title}: model failed (${String(e.message).slice(0, 80)})`); continue; }
        const checked = A.checkReading(reading, { text, today, headline: m.headline || m.title });
        if (!checked.ok) { out.held.push(`${m.title}: ${checked.reason}`); continue; }
        const f = checked.facts;
        if (f.kind !== 'professional') {
          // Only the review that was read: another review of the same title may be another company's production.
          decisions.reviews[url] = { decision: f.kind, title: f.title, metro: hub.metro, on: today };
          out.declined.push(`${f.title} (${hub.metro}): ${f.kind}`);
          continue;
        }
        const built = A.buildShow(f, { review: { url, date: m.firstReview }, hubSlug: hub.metro, hubShows: [...hubShows, ...pending], hubHome: HUB_HOME[hub.metro], taken, today });
        if (built.hold) { out.held.push(`${f.title}: ${built.hold}`); continue; }
        const show = built.show;
        if (retired(show.id)) { out.held.push(`${f.title}: id ${show.id} is retired`); continue; }
        const existing = A.existingRow(f, show, [...shows, ...pending]);
        if (existing) { decisions.reviews[url] = { decision: 'exists', showId: existing.id, on: today }; out.declined.push(`${f.title}: exists as ${existing.id}`); continue; }
        // Art: the review's lead photo. A show with no usable image is still added (the image job fills it later).
        const img = ogImage(html, url);
        if (img && flag('apply')) {
          try {
            const buf = await downloadImage(img, url);
            const meta = await require('sharp')(buf).metadata();
            if ((meta.width || 0) >= 300 && (meta.height || 0) >= 200 && !/logo|placeholder|default/i.test(img)) show.images = await writeArt(show.id, buf);
          } catch (e) { out.noArt.push(`${show.id}: ${String(e.message).slice(0, 60)}`); }
        }
        const trial = applyAddShow(work, { type: 'add-show', show }, { root: ROOT });
        if (!trial.ok) {
          // Art written for a row that is not added would be committed with no plan behind it.
          if (show.images) fs.rmSync(path.join(ROOT, 'public', 'images', 'shows', show.id), { recursive: true, force: true });
          out.held.push(`${f.title}: ${trial.reason}`);
          continue;
        }
        taken.add(show.id);
        pending.push(show);
        actions.push({ type: 'add-show', show, description: `add ${show.id} (BroadwayWorld review ${m.firstReview})` });
        out.added.push(`${show.id} | ${show.venue} | ${show.type} | ${show.status} ${show.openingDate}..${show.closingDate || '?'}${show.images ? ' | art' : ''}`);
      }
    }
  } finally {
    if (cleanup) await cleanup().catch(() => {});
  }
  if (flag('apply')) {
    const file = arg('out', path.join(process.env.TMPDIR || '/tmp', 'bww-regional-actions.json'));
    fs.writeFileSync(file, JSON.stringify(actions, null, 1) + '\n');
    decisions.updated = today;
    fs.writeFileSync(DECISIONS, JSON.stringify(decisions, null, 1) + '\n');
    console.log(`actions -> ${file}`);
  }
  console.log(`${actions.length} to add, ${out.declined.length} declined, ${out.held.length} held${flag('apply') ? '' : ' (dry run)'}`);
  for (const a of out.added) console.log(`  + ${a}`);
  for (const d of out.declined) console.log(`  x ${d}`);
  for (const h of out.held) console.log(`  ? ${h}`);
  for (const n of out.noArt) console.log(`  (no art) ${n}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { articleText, ogImage, downloadImage, HUB_HOME };
