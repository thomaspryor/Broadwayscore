#!/usr/bin/env node
/**
 * Collect each show's OFFICIAL social handles into data/social-handles.json (BRO-7413).
 * Source of truth is the show's own site (officialUrl): a handle counts only when that page
 * links to it, so the show vouches for its own account. Bluesky handles are also resolved
 * against the public Bluesky API. Generic platform and ticketing accounts are refused, and a
 * handle that two different shows' sites both claim is dropped as shared. Existing entries
 * keep their verifiedAt unless the handle changed.
 *   node scripts/social-autopost/harvest-handles.js [--write] [--only=<showId,...>]
 */
const fs = require('fs');
const path = require('path');
const { HANDLES_FILE } = require('./tags');
const { socialNotable } = require('./notable');

const ROOT = path.join(__dirname, '..', '..');
const PATTERNS = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})\/?(?=["'\s<>?#)]|$)/gi,
  twitter: /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?=["'\s<>?#)]|$)/gi,
  threads: /https?:\/\/(?:www\.)?threads\.(?:net|com)\/@([A-Za-z0-9._]{2,30})\/?(?=["'\s<>?#)]|$)/gi,
  bluesky: /https?:\/\/bsky\.app\/profile\/([A-Za-z0-9.-]{3,80})\/?(?=["'\s<>?#)]|$)/gi,
};
// Platform, ticketing and aggregator accounts that show sites link to but are not the show's own.
const GENERIC = new Set(['instagram', 'explore', 'accounts', 'share', 'intent', 'home', 'i', 'search', 'x', 'twitter', 'facebook', 'threads', 'broadway', 'broadwaycom', 'telecharge', 'ticketmaster', 'todaytix', 'playbill', 'shubert', 'shubertorg', 'nederlander', 'jujamcyn', 'atgtickets', 'atgentertainment', 'broadwayinc', 'broadwaydirect', 'broadwaybox', 'seatgeek', 'vividseats', 'stubhub', 'tdf', 'tdfnyc', 'lincolncenter', 'roundabouttheatre', 'manhattantheatreclub', 'publictheaterny', 'signaturetheatre', 'newyorkcityc', 'nytheatre', 'playwrightshorizons', 'atlantictheater', 'wearebroadway', 'broadwayworld', 'bsky.app', 'sharer', 'sharer.php', 'dialog', 'privacy', 'login', 'about',
  // Theatre-company or venue accounts (not the show's own) seen on show sites.
  'irish_rep', 'audibletheater']);
const UA = 'Mozilla/5.0 (compatible; BroadwayScorecardHandleCheck/1.0)';

async function page(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

/** Most-linked non-generic handle per network found in `html`, or {}. */
function extract(html) {
  const out = {};
  for (const [net, re] of Object.entries(PATTERNS)) {
    const counts = new Map();
    for (const m of html.matchAll(re)) {
      const h = m[1].replace(/\.$/, '');
      if (GENERIC.has(h.toLowerCase()) || /^x+$/i.test(h)) continue; // XXXXXXX is a site template placeholder
      counts.set(h, (counts.get(h) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out[net] = best[0];
  }
  return out;
}

async function blueskyResolves(handle) {
  try {
    const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`, { signal: AbortSignal.timeout(15000) });
    return res.ok;
  } catch { return null; } // null: could not check, not "does not exist"
}

async function main() {
  const write = process.argv.includes('--write');
  const only = ((process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = (Array.isArray(raw) ? raw : raw.shows).filter(s => ['broadway', 'off-broadway'].includes(s.category) && ['open', 'previews'].includes(s.status) && s.officialUrl && (!only.length || only.includes(s.id)));
  const existing = (() => { try { return JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8')); } catch { return {}; } })();
  const prev = existing.shows || {};
  const today = new Date().toISOString().slice(0, 10);
  const found = {};
  for (const s of shows) {
    if (s.category === 'off-broadway' && !socialNotable(s)) continue; // only shows that can post need a handle
    const html = await page(s.officialUrl);
    if (!html) { console.log(`- ${s.id}: official site did not load (${s.officialUrl})`); continue; }
    found[s.id] = { site: s.officialUrl, ...extract(html) };
  }
  // A handle two shows both claim is a venue, producer or ticketing account.
  const owners = new Map();
  for (const [id, f] of Object.entries(found)) for (const net of Object.keys(PATTERNS)) if (f[net]) { const k = `${net}:${f[net].toLowerCase()}`; owners.set(k, [...(owners.get(k) || []), id]); }
  const result = { ...prev };
  for (const [id, f] of Object.entries(found)) {
    const entry = {};
    for (const net of Object.keys(PATTERNS)) {
      if (!f[net]) continue;
      if (owners.get(`${net}:${f[net].toLowerCase()}`).length > 1) { console.log(`- ${id}: ${net} @${f[net]} is claimed by several shows, dropped`); continue; }
      if (net === 'bluesky' && (await blueskyResolves(f[net])) === false) { console.log(`- ${id}: bluesky ${f[net]} does not resolve, dropped`); continue; }
      const old = prev[id] && prev[id][net];
      entry[net] = { handle: f[net], verifiedAt: old && old.handle === f[net] ? old.verifiedAt : today, source: f.site };
    }
    if (Object.keys(entry).length) result[id] = entry; else delete result[id];
  }
  const nets = n => Object.values(result).filter(e => e[n]).length;
  console.log(`${shows.length} shows checked; handles: ${Object.keys(result).length} shows (instagram ${nets('instagram')}, twitter ${nets('twitter')}, threads ${nets('threads')}, bluesky ${nets('bluesky')})`);
  if (write) {
    fs.writeFileSync(HANDLES_FILE, `${JSON.stringify({ _meta: { description: "Official social handles per show, from each show's own site (scripts/social-autopost/harvest-handles.js). Missing = no tag.", lastUpdated: new Date().toISOString() }, shows: result }, null, 2)}\n`);
    console.log(`wrote ${HANDLES_FILE}`);
  } else for (const [id, e] of Object.entries(result)) console.log(id, Object.entries(e).map(([n, v]) => `${n}=@${v.handle}`).join(' '));
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { extract };
