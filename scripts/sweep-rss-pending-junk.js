#!/usr/bin/env node
'use strict';

/**
 * sweep-rss-pending-junk.js — one-time + re-runnable sweep (task #1073, W4.2).
 *
 * Tags _pending/ files created by rss-discovery's pre-fix openingWindow branch
 * (date-proximity-only acceptance) that fail the show-identity check now
 * enforced at write time in lib/rss-discovery.js: neither the stored article
 * title nor the URL slug mentions the show. These are obituaries / unrelated
 * theater-section news attributed to whatever show opened that week (8 NYT
 * items on the-vessel-off-broadway-2026, 4 on the-pass-off-broadway-2026,
 * 2026-08-05).
 *
 * Files are KEPT, never deleted (drain-rejects KEEP rule) — they get
 * `rssIdentityRejected: true` + reason so gap/census/pending counts can
 * exclude them as junk instead of counting them as stuck work.
 *
 * Usage:
 *   node scripts/sweep-rss-pending-junk.js            # dry-run (default)
 *   node scripts/sweep-rss-pending-junk.js --apply    # write tags
 *   node scripts/sweep-rss-pending-junk.js --show=ID  # limit to one show
 */

const fs = require('fs');
const path = require('path');
const { titleMatchesShow, urlSlugMatchesShow } = require('./lib/rss-discovery');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const PENDING_DIR = path.join(ROOT, 'data', 'review-texts', '_pending');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');

const APPLY = process.argv.includes('--apply');
const showArg = (process.argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;

const USAGE = `sweep-rss-pending-junk.js — Remove junk RSS review files from data/review-texts/_pending.

Usage:
  node scripts/sweep-rss-pending-junk.js [--apply] [--show=<showId>]
  node scripts/sweep-rss-pending-junk.js --help, -h    print this usage and exit

Dry-run by default; --apply performs the deletes/rewrites via safeWriteReview.
`;

function main() {
  // --help must short-circuit BEFORE any filesystem work. This script deletes
  // and rewrites review files, so `--help` on a machine without data/ must not
  // exit(2) from the missing-dir check below, and must never reach a write.
  // (Help-flag safety guard, Rule B — the audit flagged this after the script
  // started routing writes through safeWriteReview.)
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!fs.existsSync(PENDING_DIR)) {
    console.error(`::error::_pending dir not found at ${PENDING_DIR} — run from a checkout with data/review-texts present`);
    process.exit(2);
  }
  const showsRaw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
  const titleById = new Map(shows.map(s => [s.id, s.title]));

  let scanned = 0, tagged = 0, alreadyTagged = 0, kept = 0;
  const showDirs = fs.readdirSync(PENDING_DIR)
    .filter(d => !d.startsWith('.') && (!showArg || d === showArg))
    .filter(d => { try { return fs.statSync(path.join(PENDING_DIR, d)).isDirectory(); } catch { return false; } });

  for (const showId of showDirs) {
    const showTitle = titleById.get(showId);
    if (!showTitle) continue; // unknown show dir — leave alone
    const dir = path.join(PENDING_DIR, showId);
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const fp = path.join(dir, f);
      let j;
      try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (j.source !== 'rss-discovery') continue;
      scanned++;
      if (j.rssIdentityRejected) { alreadyTagged++; continue; }
      const identityOk =
        (j.title && titleMatchesShow(j.title, showTitle)) ||
        (j.articleTitle && titleMatchesShow(j.articleTitle, showTitle)) ||
        urlSlugMatchesShow(j.url, showTitle);
      if (identityOk) { kept++; continue; }
      tagged++;
      console.log(`${APPLY ? 'TAG' : 'would-tag'} ${showId}/${f} — ${j.url}`);
      if (APPLY) {
        j.rssIdentityRejected = true;
        j.rssIdentityRejectedReason = 'no title/slug match to show (pre-fix openingWindow date-only acceptance, task #1073)';
        j.rssIdentityRejectedAt = new Date().toISOString();
        safeWriteReview(fp, j);
      }
    }
  }

  console.log(`\nScanned ${scanned} rss-discovery _pending file(s): ${tagged} ${APPLY ? 'tagged' : 'would tag'}, ${kept} identity-ok, ${alreadyTagged} already tagged.`);
  if (!APPLY && tagged > 0) console.log('Dry-run — re-run with --apply to write tags.');
}

main();
