#!/usr/bin/env node
'use strict';
/**
 * research-venue-access.js — accessibility facts, seat-view links and official websites for
 * venue pages (BRO-8112, follows BRO-8088's research-venue-details.js).
 *
 * Three jobs, each publishing only what can be verified:
 *  1. ACCESS (Broadway + Off-Broadway + London): read the venue's own website (its homepage and the access /
 *     visitor pages it links to, through fetchPage()), give the SAME page text to Gemini and
 *     OpenAI, and publish a fact only when both answers match and both back it with a quote that
 *     appears word for word on the page (scripts/lib/venue-access-agree.js). The page URL the
 *     quote came from is stored per fact. No page, no quote, no agreement = nothing published.
 *  2. SEAT LINKS (Off-Broadway + London): SeatPlan (venue page listed in SeatPlan's own sitemap) and
 *     A View From My Seat (venue page fetched) count only when the page title names the venue.
 *  3. BROADWAY WEBSITES (the 41 houses in theater-metadata.json): both models are asked for the
 *     official site; published when they agree on the host (venue-info-agree.pickWebsite).
 *
 * Raw model answers are checkpointed to data/audit/venue-access-raw.json (no page text) so a rerun
 * skips finished venues. Published file: data/venue-access.json, keyed "<market>/<slug>"
 * (market: off-broadway | london | broadway), read by src/lib/data-core.ts.
 *
 * Usage:
 *   node scripts/research-venue-access.js [--phase=broadway,access,seats] [--market=broadway|off-broadway|london]
 *     [--only=slug,slug] [--limit=N] [--max-usd=15] [--workers=4] [--refresh]
 * Broadway access backfill (reuses agreed sites, preserves other markets):
 *   node scripts/research-venue-access.js --phase=access --market=broadway --max-usd=2
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { slugify } = require('./lib/url-slug');
const { broadwayWebsites, venueList, publishVenueAccess } = require('./lib/venue-access-publish');
const { FIELDS, htmlToText, accessLinks, titleNamesVenue } = require('./lib/venue-access-agree');

const ROOT = path.join(__dirname, '..');
const INFO_PATH = path.join(ROOT, 'data/venue-info.json');
const META_PATH = path.join(ROOT, 'data/theater-metadata.json');
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RAW_PATH = path.join(ROOT, 'data/audit/venue-access-raw.json');
const OUT_PATH = path.join(ROOT, 'data/venue-access.json');
const CACHE_DIR = process.env.VENUE_ACCESS_CACHE_DIR || path.join(os.tmpdir(), 'venue-access-pages');
const PAGE_CHARS = 9000; // per page handed to the models

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const phases = new Set(String(args.phase || 'broadway,access,seats').split(','));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);

// ---------- page fetching (always fetchPage, cached on disk by URL) ----------

function cachePath(url) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
}

/** HTML of a page via the shared provider chain; null when every tier failed. Cached. */
async function getHtml(url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cp = cachePath(url);
  if (!args.refresh && fs.existsSync(cp)) { const c = JSON.parse(fs.readFileSync(cp, 'utf8')).html; if (c) return c; }
  const { fetchPage } = require('./lib/scraper');
  let html = null;
  try {
    const r = await fetchPage(url, { skipVerify: true });
    html = r && r.content ? String(r.content) : null;
  } catch { html = null; }
  // A failed fetch is never cached: a transient outage must not freeze a venue as "no page" for good.
  if (html) fs.writeFileSync(cp, JSON.stringify({ url, html, at: new Date().toISOString() }));
  return html;
}

const titleOf = (html) => htmlToText((String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');

/** Keep the parts of a long page that talk about access; short pages pass through whole. */
function relevantText(text, cap = PAGE_CHARS) {
  if (text.length <= cap) return text;
  const re = /wheelchair|step[- ]?free|accessib|disab|\blifts?\b|elevator|hearing|loop|infra-?red|assistive|ramp|stairs|mobility/gi;
  const hits = [];
  for (const m of text.matchAll(re)) hits.push(m.index);
  if (!hits.length) return text.slice(0, cap);
  const windows = [];
  for (const h of hits) {
    const s = Math.max(0, h - 500);
    const e = Math.min(text.length, h + 700);
    const last = windows[windows.length - 1];
    if (last && s <= last[1]) last[1] = e; else windows.push([s, e]);
  }
  let out = '';
  for (const [s, e] of windows) { if (out.length >= cap) break; out += text.slice(s, e) + ' … '; }
  return out.slice(0, cap);
}

/** Homepage + the access/visitor pages it links to (and the access pages those link to), as [{url, text}]. */
async function accessPages(website) {
  const home = await getHtml(website);
  if (!home) return [];
  const pages = [{ url: website, text: htmlToText(home) }];
  const seen = new Set([website.replace(/\/+$/, '')]);
  const level2 = [];
  for (const u of accessLinks(home, website, 3)) {
    seen.add(u);
    const h = await getHtml(u);
    if (!h) continue;
    pages.push({ url: u, text: htmlToText(h) });
    // A visitor-info page often links on to the real access page.
    for (const x of accessLinks(h, u, 4)) if (/access|disab|wheelchair|a11y/i.test(x) && !seen.has(x)) { seen.add(x); level2.push(x); }
  }
  for (const u of level2.slice(0, 2)) {
    const h = await getHtml(u);
    if (h) pages.push({ url: u, text: htmlToText(h) });
  }
  return pages.filter((p) => p.text.length > 200);
}

// ---------- prompts ----------

function accessPrompt(name, pages) {
  const body = pages.map((p) => `=== PAGE ${p.url} ===\n${relevantText(p.text)}`).join('\n\n');
  return `You are extracting accessibility facts for one theatre from text copied from its OWN website.
Venue: "${name}"

Rules:
- Use ONLY the text below. No outside knowledge, no guessing, no inference.
- Answer for "${name}" itself. If the text covers a group of venues and does not make clear it applies to "${name}", answer null.
- For each fact give value true (the text says the venue has it), false (the text says it does NOT), or null (not stated). Prefer null over a guess.
- "quote" must be copied WORD FOR WORD from the text (one sentence or clause, at most 200 characters) and must itself state the fact. null when value is null.
- "note": ONE sentence copied word for word from the text that best sums up access (at most 220 characters), or null.

Facts:
- wheelchair: wheelchair users can attend / wheelchair spaces or wheelchair-accessible seating exist
- stepFree: step-free or level access into the building and auditorium
- elevator: a lift/elevator is available for audience members
- hearingLoop: a hearing loop / induction loop is installed
- assistiveListening: any assistive listening system (infrared, headsets, loop, receivers)

Return one JSON object, no prose:
{"wheelchair":{"value":null,"quote":null},"stepFree":{"value":null,"quote":null},"elevator":{"value":null,"quote":null},"hearingLoop":{"value":null,"quote":null},"assistiveListening":{"value":null,"quote":null},"note":null}

TEXT:
${body}`;
}

function websitePrompt(name) {
  return `Using web search, find the OFFICIAL website of this Broadway theatre building: "${name}", New York City.
Give the homepage of the venue itself or of the company that owns/operates it (not a ticket reseller, not a show's site, not Wikipedia).
Answer ONLY from what sources state; use null if you cannot confirm it.
Return one JSON object, no prose: {"website": "https://...", "sources": ["urls you used"]}`;
}

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- seat links ----------

let seatplanIndex = null;
/** Venue pages in SeatPlan's own sitemap: [{city, slug, url}]. */
async function loadSeatplanIndex() {
  if (seatplanIndex) return seatplanIndex;
  const res = await fetch('https://seatplan.com/sitemap.xml', { headers: { 'user-agent': 'BroadwayScorecard/1.0' }, signal: AbortSignal.timeout(60000) });
  const xml = await res.text();
  seatplanIndex = [...xml.matchAll(/<loc>(https:\/\/seatplan\.com\/(london|new-york)\/([a-z0-9-]+)\/)<\/loc>/g)]
    .filter((m) => !/-tickets$/.test(m[3]))
    .map((m) => ({ url: m[1], city: m[2], slug: m[3] }));
  return seatplanIndex;
}

async function seatplanLink(v) {
  const idx = await loadSeatplanIndex();
  const city = v.market === 'london' ? 'london' : 'new-york';
  const slugs = new Set([slugify(v.name), slugify(v.name.replace(/^the\s+/i, ''))]);
  const hit = idx.find((e) => e.city === city && slugs.has(e.slug));
  if (!hit) return null;
  const html = await getHtml(hit.url);
  return html && titleNamesVenue(titleOf(html), v.name) ? hit.url : null;
}

async function viewFromSeatLink(v) {
  const url = `https://aviewfrommyseat.com/venue/${encodeURIComponent(v.name).replace(/%20/g, '+')}/`;
  const html = await getHtml(url);
  if (!html) return null;
  // The page must be this venue's photo page, in the right city.
  const title = titleOf(html);
  if (!/^photos at/i.test(title) || !titleNamesVenue(title, v.name)) return null;
  const cityOk = v.market === 'london' ? /london|uk|england/i : /new york|ny\b|manhattan|brooklyn/i;
  return cityOk.test(htmlToText(html).slice(0, 6000)) ? url : null;
}

// ---------- main ----------

async function main() {
  require('./lib/llm-usage-install');
  const ask = require('./lib/dual-model-client');
  ask.spend.maxUsd = Number(args['max-usd'] || 15);
  const workers = Number(args.workers || 4);
  const raw = readJson(RAW_PATH, { access: {}, seats: {}, broadway: {} });
  // Venue contact emails appear in official-page quotes. The public repo's PII lint refuses
  // email-shaped strings under data/audit, so the checkpoint stores them redacted.
  const save = () => fs.writeFileSync(RAW_PATH, JSON.stringify(raw, null, 1).replace(EMAIL_RE, '[email]'));

  if (phases.has('broadway')) {
    const meta = readJson(META_PATH, {});
    let names = Object.keys(meta).filter((k) => k !== '_meta');
    if (args.only) { const only = new Set(String(args.only).split(',')); names = names.filter((n) => only.has(slugify(n))); }
    const todo = names.filter((n) => args.refresh || !raw.broadway[n] || !raw.broadway[n].gemini || !raw.broadway[n].openai || raw.broadway[n].gemini.error || raw.broadway[n].openai.error);
    console.log(`broadway websites: ${names.length}, to research: ${todo.length}`);
    await ask.pool(todo, workers, async (n) => {
      const p = websitePrompt(n);
      const [g, o] = await Promise.all([
        ask.askGemini(p, { grounded: true }).then(parseJson).catch((e) => ({ error: String(e.message || e) })),
        ask.askOpenAI(p, { search: true }).then(parseJson).catch((e) => ({ error: String(e.message || e) })),
      ]);
      raw.broadway[n] = { gemini: g, openai: o, at: new Date().toISOString() };
    });
    save();
  }

  const published = readJson(OUT_PATH, { venues: {} }).venues;
  const sites = broadwayWebsites(readJson(META_PATH, {}), raw.broadway, published);
  const info = readJson(INFO_PATH, { venues: {} }).venues;
  const venues = venueList(info, sites, args);

  if (phases.has('access')) {
    const withSite = venues.filter((v) => v.website);
    const todo = withSite.filter((v) => args.refresh || !raw.access[v.key] || !raw.access[v.key].gemini || !raw.access[v.key].openai || raw.access[v.key].gemini.error || raw.access[v.key].openai.error);
    console.log(`access: ${withSite.length} venues with a website, to research: ${todo.length}, cap $${ask.spend.maxUsd}`);
    let done = 0;
    await ask.pool(todo, workers, async (v) => {
      const pages = await accessPages(v.website);
      const urls = pages.map((p) => p.url);
      if (!pages.length || !pages.some((p) => /wheelchair|accessib|step[- ]?free|\blift\b|hearing|disab/i.test(p.text))) {
        raw.access[v.key] = { pages: urls, none: pages.length ? 'no access wording on the official pages' : 'official site unreachable', at: new Date().toISOString() };
      } else {
        const p = accessPrompt(v.name, pages);
        const [g, o] = await Promise.all([
          ask.askGemini(p).then(parseJson).catch((e) => ({ error: String(e.message || e) })),
          ask.askOpenAI(p).then(parseJson).catch((e) => ({ error: String(e.message || e) })),
        ]);
        // Re-verified at build time against the cached page text, so keep what was read.
        raw.access[v.key] = { pages: urls, gemini: g, openai: o, at: new Date().toISOString() };
      }
      if (++done % 10 === 0) { save(); console.log(`  access ${done}/${todo.length}  spend $${ask.spend.usd.toFixed(2)}`); }
    });
    save();
  }

  if (phases.has('seats')) {
    const todo = venues.filter((v) => v.market !== 'broadway' && (args.refresh || !raw.seats[v.key]));
    console.log(`seat links: to check ${todo.length}`);
    let done = 0;
    await ask.pool(todo, workers, async (v) => {
      const [sp, av] = await Promise.all([seatplanLink(v).catch(() => null), viewFromSeatLink(v).catch(() => null)]);
      raw.seats[v.key] = { seatplan: sp, aviewfrommyseat: av, at: new Date().toISOString() };
      if (++done % 20 === 0) { save(); console.log(`  seats ${done}/${todo.length}`); }
    });
    save();
  }

  // ---------- build the published file from the checkpoint ----------
  // The published file covers every venue; scoped runs preserve untouched entries.
  // A scoped backfill must not fetch or rewrite other markets' already published facts.
  const scoped = args.market || args.only || args.limit;
  const all = scoped ? venues : venueList(info, sites);
  const previousRejects = scoped ? readJson(path.join(ROOT, 'data/audit/venue-access-rejected.json'), {}) : {};
  const { out, rejects } = await publishVenueAccess(all, raw, accessPages, sites, scoped ? published : {}, previousRejects);

  const doc = {
    _meta: {
      description: 'Verified access facts, seat-view links and Broadway official websites (BRO-8112). Keyed "<market>/<slug>". Access facts are published only when two models agreed AND each quoted the venue\'s own page word for word; seat links only when the page title names the venue. Generated by scripts/research-venue-access.js; never hand-edit a fact without a source.',
      generated: new Date().toISOString(),
    },
    venues: Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y))),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'data/audit/venue-access-rejected.json'), JSON.stringify(rejects, null, 1) + '\n');
  const n = (f) => Object.values(out).filter(f).length;
  console.log('published:', JSON.stringify({
    venues: Object.keys(out).length,
    access: n((x) => x.access),
    seatplan: n((x) => x.seatLinks?.seatplan),
    aviewfrommyseat: n((x) => x.seatLinks?.aviewfrommyseat),
    broadwayWebsites: n((x) => x.website),
    wheelchairTrue: n((x) => x.access?.wheelchair === true),
  }));
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { accessPrompt, websitePrompt, relevantText, FIELDS };
