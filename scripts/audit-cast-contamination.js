#!/usr/bin/env node
/**
 * Audit data/cast/*.json for contamination signals — cast files where the
 * web-search backfill grabbed the wrong show's cast or corrupted the role
 * field with TV-show / opera-production titles.
 *
 * Background: scripts/backfill-cast-web.js does SERP → LLM extraction. When
 * the SERP returns a generic page (BWW article about an unrelated production,
 * a similarly-named musical, an actor's biography), the LLM dutifully extracts
 * whatever cast is on that page. Result: data/cast/{show-id}.json ends up
 * with names + roles from a different production. These rows lack
 * ibdbPersonId (we can't IBDB-match opera singers or wrong-show cast), so
 * they're currently hidden by build-cast-manifest.js — but they're stored,
 * and any future change to surface orphans would ship the bad data.
 *
 * Usage:
 *   node scripts/audit-cast-contamination.js          # human-readable report
 *   node scripts/audit-cast-contamination.js --json   # machine-readable
 *
 * Signals (file is flagged if it has orphans AND at least one signal):
 *   OPERA_ROLES:N        — N roles match opera-title list
 *   TV_ROLES:N           — N roles match TV-show / film / "known for" patterns
 *   NAME_SWAP:N          — N names look LASTNAME-FIRSTNAME
 *   ROLE_IS_COLUMN_HEADER:N — N roles are bare "Original"/"Replacement"/etc.
 *   SRC_URL_NO_TITLE     — sourceUrl doesn't contain any token from the show ID
 *   SHOW_NOT_IN_DB       — showId not present in shows.json (orphaned file)
 *
 * See feedback_orphan_cast_invisible_by_design.md and Notion card
 * 369637c5-416f-8103-ba73-f958627f3a5e.
 */

const fs = require('fs');
const path = require('path');
const {
  OPERA_TITLES,
  TV_PATTERNS,
  COLUMN_HEADER_RE,
  KNOWN_SWAP_SURNAMES,
  isOperaSourceUrl,
} = require('./lib/cast-extraction-guards');

const ROOT = path.join(__dirname, '..');
const CAST_DIR = path.join(ROOT, 'data', 'cast');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');

function loadShowIds() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8')).shows.map(s => s.id));
  } catch {
    return null;
  }
}

function titleTokensFromShowId(showId) {
  return showId
    .replace(/-(off-)?(broadway|west-end)-(20\d{2})$/, '')
    .replace(/-globe-west-end-(20\d{2})$/, '')
    .split('-')
    .filter(t => t.length >= 4);
}

function audit() {
  const showIds = loadShowIds();
  const files = fs.readdirSync(CAST_DIR).filter(f => f.endsWith('.json'));
  const issues = [];

  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(CAST_DIR, f), 'utf-8')); }
    catch { continue; }
    const showId = d.showId || f.replace(/\.json$/, '');
    const all = [
      ...(d.openingNightCast || []),
      ...(d.currentCast || []),
      ...(d.replacements || []),
    ];
    const orphans = all.filter(m => m && !m.ibdbPersonId);
    if (orphans.length === 0) continue;

    const flags = [];

    const operaHits = orphans.filter(m => m.role && OPERA_TITLES.some(o => m.role.toLowerCase().includes(o)));
    if (operaHits.length >= 2) flags.push(`OPERA_ROLES:${operaHits.length}`);

    const tvHits = orphans.filter(m => m.role && TV_PATTERNS.some(t => m.role.toLowerCase().includes(t)));
    if (tvHits.length >= 2) flags.push(`TV_ROLES:${tvHits.length}`);

    const swapped = orphans.filter(m => {
      if (!m.name) return false;
      const parts = m.name.split(/\s+/);
      if (parts.length !== 2) return false;
      return KNOWN_SWAP_SURNAMES.has(parts[0].toLowerCase());
    });
    if (swapped.length >= 2) flags.push(`NAME_SWAP:${swapped.length}`);

    const colHits = orphans.filter(m => m.role && COLUMN_HEADER_RE.test(m.role.trim()));
    if (colHits.length >= 1) flags.push(`ROLE_IS_COLUMN_HEADER:${colHits.length}`);

    if (d.sourceUrl) {
      const tokens = titleTokensFromShowId(showId);
      const url = d.sourceUrl.toLowerCase();
      const hasTitle = tokens.some(t => url.includes(t));
      if (!hasTitle) flags.push('SRC_URL_NO_TITLE');

      // Opera-publication source for a non-opera show. Showing this as a
      // distinct signal lets future contamination be triaged faster.
      const showIsOpera = /\bopera\b|the met\b/.test(showId.toLowerCase());
      if (!showIsOpera && isOperaSourceUrl(d.sourceUrl)) flags.push('SRC_URL_OPERA_DOMAIN');
    }

    if (showIds && !showIds.has(showId)) flags.push('SHOW_NOT_IN_DB');

    if (flags.length > 0) {
      issues.push({
        showId,
        orphans: orphans.length,
        source: d.source || null,
        sourceUrl: d.sourceUrl || null,
        flags,
      });
    }
  }

  return issues.sort((a, b) => b.orphans - a.orphans);
}

function main() {
  const issues = audit();
  const json = process.argv.includes('--json');

  if (json) {
    process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
    return;
  }

  console.log(`[audit-cast-contamination] flagged ${issues.length} cast files\n`);
  for (const i of issues) {
    console.log(`  ${i.showId} (${i.orphans} orphans, source=${i.source || '?'})`);
    console.log(`     flags: ${i.flags.join(', ')}`);
    if (i.sourceUrl) console.log(`     src:   ${i.sourceUrl}`);
  }

  // Exit nonzero so CI can detect new contamination
  if (issues.length > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { audit };
