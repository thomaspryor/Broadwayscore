"use strict";
const { slugify } = require('./url-slug');
const { websitesAgree, pickWebsite, pickWithFolded } = require('./venue-info-agree');
const { agreeAccess } = require('./venue-access-agree');

// Only current houses with an agreed official website can enter Broadway research.
function broadwayWebsites(metadata, raw = {}, published = {}) {
  const out = {};
  for (const name of Object.keys(metadata).filter(n => n !== '_meta')) {
    const key = `broadway/${slugify(name)}`;
    const b = raw[name];
    if (!b) {
      const old = published[key];
      if (old?.website && old.how?.website === 'gemini+openai') {
        const { access, seatLinks, ...site } = old;
        out[key] = site;
      }
      continue;
    }
    const g = b.gemini; const o = b.openai;
    if (!g || !o || g.error || o.error || !websitesAgree(g.website, o.website)) continue;
    const website = pickWebsite(g.website, o.website);
    if (!website) continue;
    const sources = [...new Set([...(g.sources || []), ...(o.sources || [])])].filter(u => /^https?:\/\//.test(u)).slice(0, 5);
    out[key] = { name, website, how: { website: 'gemini+openai' }, sources, researchedAt: b.at };
  }
  return out;
}

function venueList(info, broadway, args = {}) {
  let out = [
    ...Object.entries(info).map(([key, v]) => ({ key, name: v.name, website: v.fields.website || null })),
    ...Object.entries(broadway).map(([key, v]) => ({ key, name: v.name, website: v.website })),
  ].map(v => ({ ...v, market: v.key.split('/')[0], slug: v.key.split('/')[1] }));
  if (args.market) out = out.filter(v => v.market === args.market);
  if (args.only) { const only = new Set(String(args.only).split(',')); out = out.filter(v => only.has(v.slug)); }
  if (args.limit) out = out.slice(0, Number(args.limit));
  return out;
}

// The CLI and tests share the entire publish path, including the two-model quote gate.
async function publishVenueAccess(venues, raw, loadPages, broadway = {}, published = {}, previousRejects = {}) {
  const out = { ...published }; const rejects = { ...previousRejects };
  const usableAccess = r => !!(r.gemini && r.openai && !r.gemini.error && !r.openai.error);
  const usableSeats = r => !!(r.seatplan || r.aviewfrommyseat);
  for (const v of venues) {
    delete out[v.key];
    delete rejects[v.key];
    const entry = { ...(broadway[v.key] || {}) };
    const a = pickWithFolded(raw.access || {}, v.key, undefined, usableAccess);
    if (a && usableAccess(a) && v.website) {
      const r = agreeAccess(a.gemini, a.openai, await loadPages(v.website));
      if (Object.keys(r.access).length) {
        entry.access = { ...r.access, verified: true, sourceUrl: Object.values(r.evidence).map(e => e.url).find(Boolean), evidence: r.evidence, verifiedAt: a.at.slice(0, 10) };
      }
      if (r.rejected.length) rejects[v.key] = r.rejected;
    }
    const s = v.market !== 'broadway' && pickWithFolded(raw.seats || {}, v.key, undefined, usableSeats);
    if (s && usableSeats(s)) {
      entry.seatLinks = {};
      if (s.seatplan) entry.seatLinks.seatplan = s.seatplan;
      if (s.aviewfrommyseat) entry.seatLinks.aviewfrommyseat = s.aviewfrommyseat;
    }
    if (Object.keys(entry).length) out[v.key] = { name: v.name, ...entry };
  }
  return { out, rejects };
}

module.exports = { broadwayWebsites, venueList, publishVenueAccess };
