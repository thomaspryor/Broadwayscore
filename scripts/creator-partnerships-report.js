#!/usr/bin/env node
/**
 * creator-partnerships-report.js
 *
 * BRO-59: prints the creator-partner distribution pipeline (VideoScore
 * creators tracked for outreach in data/creator-partnerships.json, joined
 * against data/video-creators.json for identity/platform info).
 *
 * Usage:
 *   node scripts/creator-partnerships-report.js          # text summary
 *   node scripts/creator-partnerships-report.js --json   # raw JSON
 */

const {
  loadPartnerships,
  loadCreators,
  joinPartnershipsWithCreators,
  summarizeByStatus,
} = require('./lib/creator-partnerships');

const JSON_MODE = process.argv.includes('--json');

function main() {
  const partnerships = loadPartnerships();
  const creators = loadCreators();
  const joined = joinPartnershipsWithCreators(partnerships, creators);
  const summary = summarizeByStatus(partnerships);

  if (JSON_MODE) {
    console.log(JSON.stringify({ summary, partners: joined }, null, 2));
    return;
  }

  console.log('Creator Partnerships (BRO-59 distribution pivot)');
  console.log('==================================================\n');
  console.log(
    Object.entries(summary)
      .map(([status, count]) => `${status}: ${count}`)
      .join('  ·  ')
  );
  console.log();

  for (const p of joined) {
    const subs = p.subscribers ? ` (${p.subscribers})` : '';
    const notes = p.notes ? ` — ${p.notes}` : '';
    console.log(`[${p.status}] ${p.name}${subs} · ${p.primaryPlatform}${notes}`);
  }
}

main();
