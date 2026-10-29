#!/usr/bin/env node
'use strict';
/**
 * BRO-6516: turn data/audit/uk-regional/production-list.json (one row per
 * Guardian review at a UK hub house, built from the Guardian theatre review
 * listing) into add-show actions for scripts/new-fix-plan.js --actions=.
 *
 * Venue: the venue-metros canonical name + city when an alias matches, else
 * the Guardian standfirst venue tidied ("Bolton Octagon" -> "Bolton Octagon,
 * Bolton"). id: <title>-<house>-regional-<year>, the shape the Guardian
 * flagship trigger mints (king-lear-royal-exchange-regional-2026). Rows whose
 * id, or city + title + year, already exist in shows.json are skipped.
 *
 *   node scripts/uk-regional-add-plan.js --hub=yorkshire --limit=5 --out=/tmp/a.json
 *   node scripts/uk-regional-add-plan.js --urls=<guardianUrl>,... --out=...   # explicit rows
 */
const fs = require('fs');
const path = require('path');
const { buildRegionalShowEntry } = require('./promote-ob-venue-candidates');
const { resolveMetroInfo, norm, TABLE } = require('./lib/venue-metro');
const { applyAddShow } = require('./lib/add-show-action');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const LIST = path.join(ROOT, 'data', 'audit', 'uk-regional', 'production-list.json');

const kebab = (s) => norm(s).replace(/ /g, '-');

// Canonical venue from the metro table, longest alias first.
const VENUE_ALIASES = TABLE.venues
  .flatMap((v) => (v.aliases || []).map((a) => ({ key: norm(a), v })))
  .sort((a, b) => b.key.length - a.key.length);

function canonicalVenue(raw, info) {
  const padded = ` ${norm(raw)} `;
  const hit = VENUE_ALIASES.find((a) => padded.includes(` ${a.key} `) && a.v.metro === info.slug);
  let city = info.name;
  if (hit) {
    // The town comes from a listed place named in the venue's aliases ("octagon theatre, bolton" -> Bolton);
    // the metro name is the hub city, and wins when it is the fuller spelling (Stratford -> Stratford-upon-Avon).
    const said = ` ${[raw, ...(hit.v.aliases || [])].map(norm).join(' | ')} `;
    const town = Object.entries(TABLE.places)
      .filter(([p, m]) => m === hit.v.metro && said.includes(` ${norm(p)} `))
      .map(([p]) => p).sort((a, b) => b.length - a.length)[0];
    if (town && !norm(city).startsWith(norm(town))) city = town;
    const name = hit.v.venue.split(',')[0].trim();
    return { venue: `${name}, ${city}`, houseKey: hit.v.idKey || kebab(name.replace(/^the /i, '').replace(/\b(theatre|theatres|playhouse)\b/gi, '')) || kebab(name) };
  }
  const parts = String(raw).split(',').map((p) => p.trim()).filter(Boolean);
  const head = parts[0].replace(/\btheatre\b/g, 'Theatre');
  return { venue: `${head}, ${parts.length > 1 ? parts[parts.length - 1] : city}`, houseKey: kebab(head.replace(/^the /i, '').replace(/\b(theatre|theatres)\b/gi, '')) };
}

function decode(t) {
  return String(t)
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&rsquo;|’/g, "'").replace(/&quot;|“|”/g, '"')
    .replace(/^['"]+|['"]+$/g, '').trim();
}

function buildAction(row, shows) {
  const info = resolveMetroInfo(row.venue);
  if (!info || info.country !== 'UK' || !info.hub) return { skip: `not a hub venue: ${row.venue}` };
  const title = decode(row.title);
  const { venue, houseKey } = canonicalVenue(row.venue, info);
  const base = buildRegionalShowEntry({ title, venue, articlePublishedAt: `${row.date}T12:00:00Z`, source: 'guardian-review', sourceUrl: row.guardianUrl });
  const year = base.id.match(/-(\d{4})$/)[1];
  const id = `${kebab(title)}-${houseKey}-regional-${year}`.replace(/-+/g, '-');
  const show = {
    ...base, id, slug: id, venue, city: info.slug,
    discoverySource: 'uk-regional-guardian-backfill',
    discoveredAt: new Date().toISOString(),
    evidenceUrls: [row.guardianUrl],
    statusSource: base.status === 'closed' ? 'guardian-review-age' : 'guardian-review',
  };
  const t = norm(title);
  // A title the corpus already knows (My Fair Lady, Fun Home) takes that type;
  // the builder only sees a "musical" in the title itself.
  const known = shows.filter((s) => norm(s.title) === t && s.type).map((s) => s.type);
  if (known.length) show.type = known.sort((a, b) => known.filter((x) => x === b).length - known.filter((x) => x === a).length)[0];
  const dup = shows.find((s) => s.id === id || (s.city === info.slug && norm(s.title) === t && String(s.openingDate || '').slice(0, 4) === year));
  if (dup) return { skip: `exists as ${dup.id}` };
  // Same guards CI applies, run here so a bad row never reaches a plan.
  const trial = applyAddShow(shows.map((s) => ({ ...s })), { type: 'add-show', show });
  if (!trial.ok) return { skip: trial.reason };
  return { action: { type: 'add-show', show } };
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-regional-add-plan.js [--hub=<hub>] [--urls=<guardianUrl>,...] [--limit=N] [--list=<file>] [--out=<actions.json>]');
    return;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || null;
  const rows = JSON.parse(fs.readFileSync(arg('list') || LIST, 'utf8'));
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(data) ? data : data.shows;
  const hub = arg('hub');
  const ids = arg('urls') ? new Set(arg('urls').split(',')) : null;
  const limit = Number(arg('limit')) || Infinity;
  const actions = [];
  const skipped = [];
  for (const row of rows) {
    if (actions.length >= limit) break;
    if (hub && row.hub !== hub) continue;
    if (ids && !ids.has(row.guardianUrl)) continue;
    const r = buildAction(row, shows);
    if (r.action) {
      actions.push(r.action);
      shows.push(r.action.show);
    } else skipped.push(`${row.title} @ ${row.venue}: ${r.skip}`);
  }
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify(actions, null, 2) + '\n');
  console.log(`${actions.length} add-show action(s)${out ? ` -> ${out}` : ''}; ${skipped.length} skipped`);
  for (const a of actions) console.log(`  + ${a.show.id} | ${a.show.venue} | ${a.show.status} ${a.show.openingDate}`);
  for (const s of skipped.slice(0, 20)) console.log(`  - ${s}`);
}

if (require.main === module) main();
module.exports = { buildAction, canonicalVenue };
