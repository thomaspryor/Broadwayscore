#!/usr/bin/env node
'use strict';
/**
 * Apply regional→Broadway transfer pairs detected by
 * scripts/lib/transfer-detection.js (pure logic + tests live there).
 *
 * Sets transferredTo on the regional show and transferOf on the Broadway
 * show (the reciprocal pair validate-data enforces), writes shows.json with
 * the canonical formatting, and (with --email) notifies the owner. Ambiguous
 * matches are reported, never applied.
 *
 * Wired into update-show-status.yml after discovery — a Broadway entry for a
 * tracked tryout gets its cross-link the same run it's discovered.
 *
 * Flags:
 *   --dry-run   detect + print, write nothing
 *   --email     send owner a notification for applied pairs / ambiguities
 */

const fs = require('fs');
const path = require('path');
const { detectTransferPairs } = require('./lib/transfer-detection');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const emailAlerts = args.includes('--email');

async function main() {
  const data = loadShows();
  const shows = data.shows || data;
  const results = detectTransferPairs(shows);
  const applied = [];
  const ambiguous = results.filter(r => !r.broadwayId);

  for (const pair of results.filter(r => r.broadwayId)) {
    const regional = shows.find(s => s.id === pair.regionalId);
    const broadway = shows.find(s => s.id === pair.broadwayId);
    if (!regional || !broadway) continue;
    console.log(`LINK: ${pair.regionalId} → ${pair.broadwayId} (${pair.reason})`);
    if (!dryRun) {
      regional.transferredTo = broadway.id;
      broadway.transferOf = regional.id;
    }
    applied.push(pair);
  }
  for (const a of ambiguous) {
    console.log(`::warning::transfer detection ambiguous for ${a.regionalId}: ${a.reason} — link manually`);
  }

  if (applied.length === 0 && ambiguous.length === 0) {
    console.log('No new transfer pairs detected.');
    return;
  }
  if (dryRun) { console.log('(dry-run: no writes)'); return; }

  if (applied.length > 0) {
    if (data._meta) data._meta.lastUpdated = new Date().toISOString();
    saveShows(data);
    console.log(`Wrote shows.json with ${applied.length} new transfer pair(s).`);
  }

  if (emailAlerts && (applied.length > 0 || ambiguous.length > 0)) {
    try {
      const { sendEmailAlert } = require('./lib/discord-notify');
      await sendEmailAlert({
        title: applied.length > 0
          ? `${applied.length} regional tryout(s) linked to Broadway transfers`
          : 'Ambiguous regional transfer match needs a human',
        severity: 'info',
        description:
          'Auto-detected regional→Broadway transfer pair(s). Both show pages now cross-link and the Broadway page carries the tryout score. Ambiguous matches (if any, below) were NOT applied — set transferOf/transferredTo by hand.',
        fields: [
          ...applied.map(p => ({ name: `${p.regionalId} → ${p.broadwayId}`, value: p.reason })),
          ...ambiguous.map(a => ({ name: `${a.regionalId} (NOT applied)`, value: a.reason })),
        ],
      });
    } catch (e) {
      console.warn(`::warning::transfer notification email failed: ${e.message}`);
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
