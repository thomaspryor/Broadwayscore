#!/usr/bin/env node
'use strict';
/**
 * research-venue-details.js — verified venue facts for Off-Broadway and London venue pages (BRO-8088).
 *
 * For every venue page (same names/slugs the site builds, scripts/lib/page-name-sources.js),
 * ask Gemini (Google Search grounding) and OpenAI (web search) independently for the address,
 * official website, seat count, year opened and operator. A field is published only when both
 * answers agree (scripts/lib/venue-info-agree.js). An agreed address must also geocode inside
 * the right city (OpenStreetMap Nominatim) or it is dropped. A disputed address is settled only
 * by the venue's own website text naming one of the two candidates.
 *
 * Raw answers are checkpointed to data/audit/venue-info-raw.json so a rerun skips finished venues.
 * The published file is data/venue-info.json, read by src/lib/data-core.ts.
 *
 * Usage:
 *   node scripts/research-venue-details.js [--market=off-broadway|london] [--only=slug,slug]
 *     [--limit=N] [--max-usd=40] [--workers=4] [--refresh] [--rebuild-only]
 * --rebuild-only re-derives venue-info.json from the raw checkpoint with no model calls.
 */

const fs = require('fs');
const path = require('path');
const { stubTheaterName, londonShows, offBroadwayShows } = require('./lib/page-name-sources');
const { slugify } = require('./lib/url-slug');
const { agree, addressesAgree, streetKey, inCity } = require('./lib/venue-info-agree');

const ROOT = path.join(__dirname, '..');
const RAW_PATH = path.join(ROOT, 'data/audit/venue-info-raw.json');
const OUT_PATH = path.join(ROOT, 'data/venue-info.json');
const DISAGREE_PATH = path.join(ROOT, 'data/audit/venue-info-disagreements.json');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}

/** Venue pages per market, with a few recent shows as disambiguation context. */
function venueList(shows) {
  const out = [];
  const markets = [
    { market: 'off-broadway', city: 'nyc', rows: offBroadwayShows(shows), complexes: 'data/venue-complexes.json' },
    { market: 'london', city: 'london', rows: londonShows(shows), complexes: 'data/venue-complexes-west-end.json' },
  ];
  for (const m of markets) {
    const bySlug = new Map();
    for (const s of m.rows) {
      const name = stubTheaterName(s.venue);
      if (!name) continue;
      const slug = slugify(name);
      if (!slug) continue;
      const e = bySlug.get(slug) || { market: m.market, city: m.city, slug, name, shows: [], existingAddresses: new Set() };
      e.shows.push({ title: s.title, year: (s.openingDate || s.previewsStartDate || '').slice(0, 4), live: ['open', 'previews', 'upcoming'].includes(s.status) });
      if (s.theaterAddress) e.existingAddresses.add(s.theaterAddress);
      bySlug.set(slug, e);
    }
    const defs = JSON.parse(fs.readFileSync(path.join(ROOT, m.complexes), 'utf8')).complexes || {};
    for (const [slug, def] of Object.entries(defs)) {
      if (bySlug.has(slug)) continue;
      const subs = def.subVenueSlugs.map((x) => bySlug.get(x)).filter(Boolean);
      if (!subs.length) continue;
      bySlug.set(slug, { market: m.market, city: m.city, slug, name: def.name, complex: true, shows: subs.flatMap((x) => x.shows), existingAddresses: new Set() });
    }
    for (const v of bySlug.values()) {
      v.shows.sort((a, b) => (b.live - a.live) || String(b.year).localeCompare(String(a.year)));
      v.existingAddresses = [...v.existingAddresses];
      out.push(v);
    }
  }
  return out;
}

function prompt(v) {
  const where = v.city === 'nyc' ? 'New York City (an Off-Broadway or Off-Off-Broadway venue)' : 'London, UK (a West End or Off-West End venue)';
  const shows = v.shows.slice(0, 4).map((s) => `"${s.title}"${s.year ? ` (${s.year})` : ''}`).join(', ');
  return `Research this theatre venue using web search. Answer ONLY from what sources state; use null for anything you cannot confirm from a source.

Venue name as listed: "${v.name}"
Location: ${where}
${v.complex ? 'This is a multi-stage building/company; answer for the building as a whole.\n' : ''}Productions staged there include: ${shows || 'unknown'}

Return one JSON object, no prose:
{
  "exists": true if this is a real, fixed theatre venue (false for a street-address-only listing, a site-specific location, a festival, or a name you cannot identify),
  "canonicalName": "the venue's own name for itself",
  "address": "full street address of THIS performance space as the venue publishes it, ${v.city === 'nyc' ? 'format: \\"<number> <street>, <city or borough>, NY <ZIP>\\"' : 'format: \\"<number> <street>, London <postcode>\\"'}",
  "website": "official homepage URL of the venue or the company that runs it (not a ticket reseller)",
  "capacity": seat count of THIS specific space as an integer, or null,
  "yearOpened": year this space first opened as a theatre (integer) or null,
  "operator": "the organisation that owns, runs or is resident in the venue" or null,
  "sources": ["urls you used"]
}`;
}

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastNominatim = 0;
async function geocode(address) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'venue-info-check/1.0' } });
    const j = await res.json();
    if (!Array.isArray(j) || !j.length) return null;
    return { lat: Number(j[0].lat), lng: Number(j[0].lon), display: j[0].display_name };
  } catch {
    return null;
  }
}

/** Fetch the official site (home + common contact/visit pages) as plain text, for a tiebreak. */
async function siteText(url) {
  const base = new URL(url);
  let text = '';
  for (const p of ['/', '/contact', '/visit', '/about', '/visit-us', '/plan-your-visit', '/contact-us']) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(new URL(p, base), { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      if (res.ok) text += ' ' + (await res.text()).replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
    } catch { /* unreachable page: skip */ }
  }
  return text.replace(/\s+/g, ' ');
}

/** Does the site text contain this address's house number next to its street words? */
function siteNamesAddress(text, address) {
  const k = streetKey(address);
  if (!k.number || !k.street) return false;
  const norm = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const firstWord = k.street.split(' ').find((w) => !['w', 'e', 'n', 's'].includes(w)) || k.street.split(' ')[0];
  const re = new RegExp(`\\b${k.number}\\s+(?:[a-z]+\\s+){0,2}${firstWord.replace(/(st|nd|rd|th)$/, '(?:$1)?')}`);
  return re.test(norm);
}

async function research(v, ask) {
  const p = prompt(v);
  const [g, o] = await Promise.all([
    ask.askGemini(p, { grounded: true }).then(parseJson).catch((e) => ({ error: String(e.message || e) })),
    ask.askOpenAI(p, { search: true }).then(parseJson).catch((e) => ({ error: String(e.message || e) })),
  ]);
  return { gemini: g, openai: o, at: new Date().toISOString() };
}

async function decide(v, raw, { network = true } = {}) {
  const { fields, disagreements } = agree(raw.gemini, raw.openai);
  const how = {};
  for (const f of Object.keys(fields)) how[f] = 'gemini+openai';

  // Tiebreak a disputed address only with the venue's own website text.
  const addrD = disagreements.find((d) => d.field === 'address');
  if (network && addrD && addrD.gemini && addrD.openai && fields.website) {
    const text = await siteText(fields.website);
    const g = siteNamesAddress(text, addrD.gemini);
    const o = siteNamesAddress(text, addrD.openai);
    if (g !== o) {
      fields.address = g ? addrD.gemini : addrD.openai;
      how.address = `${g ? 'gemini' : 'openai'}+official-site`;
      addrD.resolvedBy = 'official-site';
    }
  }

  let geo = null;
  if (fields.address && network) {
    geo = await geocode(fields.address);
    if (geo && !inCity(geo.lat, geo.lng, v.city)) {
      disagreements.push({ field: 'address', reason: 'geocodes outside city', address: fields.address, geocoded: geo.display });
      delete fields.address;
      delete how.address;
      geo = null;
    }
  }
  return { fields, how, geo, disagreements: disagreements.filter((d) => !d.resolvedBy) };
}

async function main() {
  const shows = loadShows();
  let venues = venueList(shows);
  if (args.market) venues = venues.filter((v) => v.market === args.market);
  if (args.only) {
    const only = new Set(String(args.only).split(','));
    venues = venues.filter((v) => only.has(v.slug));
  }
  // Live venues first, then by show count.
  venues.sort((a, b) => (b.shows.some((s) => s.live) - a.shows.some((s) => s.live)) || b.shows.length - a.shows.length);
  if (args.limit) venues = venues.slice(0, Number(args.limit));

  const rawStore = fs.existsSync(RAW_PATH) ? JSON.parse(fs.readFileSync(RAW_PATH, 'utf8')) : {};
  const key = (v) => `${v.market}/${v.slug}`;

  if (!args['rebuild-only']) {
    require('./lib/llm-usage-install');
    const ask = require('./lib/dual-model-client');
    ask.spend.maxUsd = Number(args['max-usd'] || 40);
    const todo = venues.filter((v) => args.refresh || !rawStore[key(v)] || rawStore[key(v)].gemini?.error || rawStore[key(v)].openai?.error || !rawStore[key(v)].gemini || !rawStore[key(v)].openai);
    console.log(`venues: ${venues.length}, to research: ${todo.length}, cap $${ask.spend.maxUsd}`);
    let done = 0;
    await ask.pool(todo, Number(args.workers || 4), async (v) => {
      const r = await research(v, ask);
      rawStore[key(v)] = { name: v.name, ...r };
      done++;
      if (done % 10 === 0 || done === todo.length) {
        fs.writeFileSync(RAW_PATH, JSON.stringify(rawStore, null, 1));
        console.log(`  ${done}/${todo.length}  spend $${ask.spend.usd.toFixed(2)}`);
      }
    });
    fs.writeFileSync(RAW_PATH, JSON.stringify(rawStore, null, 1));
  }

  // Build the published file from every venue in the raw store (not only this run's subset).
  const all = venueList(shows);
  const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : { venues: {} };
  const outVenues = {};
  const disputes = {};
  const addressConflicts = [];
  let i = 0;
  for (const v of all) {
    const raw = rawStore[key(v)];
    if (!raw) continue;
    i++;
    const prev = existing.venues?.[key(v)];
    const sameRaw = prev && prev.researchedAt === raw.at;
    // Reuse the previous decision when the raw answers did not change (saves geocode calls).
    const d = sameRaw && !args.redecide
      ? { fields: prev.fields, how: prev.how, geo: prev.lat != null ? { lat: prev.lat, lng: prev.lng } : null, disagreements: prev._disagreements || [] }
      : await decide(v, raw);
    if (d.disagreements.length) disputes[key(v)] = { name: v.name, disagreements: d.disagreements };
    if (d.fields.address) {
      for (const a of v.existingAddresses) {
        if (!addressesAgree(a, d.fields.address)) addressConflicts.push({ venue: key(v), showsJsonAddress: a, verified: d.fields.address });
      }
    }
    if (!Object.keys(d.fields).length) continue;
    const sources = [...new Set([...(raw.gemini?.sources || []), ...(raw.openai?.sources || [])])].filter((s) => /^https?:\/\//.test(s)).slice(0, 6);
    outVenues[key(v)] = {
      name: v.name,
      fields: d.fields,
      how: d.how,
      ...(d.geo ? { lat: Math.round(d.geo.lat * 1e6) / 1e6, lng: Math.round(d.geo.lng * 1e6) / 1e6 } : {}),
      sources,
      researchedAt: raw.at,
      ...(d.disagreements.length ? { _disagreements: d.disagreements } : {}),
    };
    if (i % 25 === 0) console.log(`  decided ${i}`);
  }

  const out = {
    _meta: {
      description: 'Verified venue facts for Off-Broadway and London venue pages (BRO-8088). Keyed "<market>/<page slug>". A field appears only when two independent web-search models agree (scripts/lib/venue-info-agree.js); addresses also geocode inside the city. Generated by scripts/research-venue-details.js; do not hand-edit fields without a source.',
      generated: new Date().toISOString(),
    },
    venues: Object.fromEntries(Object.entries(outVenues).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(DISAGREE_PATH, JSON.stringify({ generated: out._meta.generated, disputes, showsJsonAddressConflicts: addressConflicts }, null, 2) + '\n');

  const counts = { venues: Object.keys(outVenues).length, address: 0, website: 0, capacity: 0, yearOpened: 0, operator: 0 };
  for (const x of Object.values(outVenues)) for (const f of Object.keys(x.fields)) counts[f]++;
  console.log('published:', JSON.stringify(counts));
  console.log(`disputed venues: ${Object.keys(disputes).length}; shows.json address conflicts: ${addressConflicts.length}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { venueList, prompt, siteNamesAddress, decide };
