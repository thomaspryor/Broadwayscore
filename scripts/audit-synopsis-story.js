#!/usr/bin/env node
/**
 * audit-synopsis-story.js — which live shows.json synopses are not story
 * (BRO-5063). Read-only: prints a report, writes nothing.
 *
 * hard: wikitext debris (image captions, ";Act I" headings) or audience pitch
 *       ("Don't miss", "Join us", "invites you"). isValidSynopsis now rejects
 *       both, so a hard hit was saved before that rule or by a writer that
 *       skips it. Fix: trim it, or clear it so auto-fix-show-data.js
 *       (backfill-historical-metadata.yml, shows=<id>) regenerates it.
 * soft: a sentence the TodayTix cleaner's nonStoryReason calls non-story
 *       (press quote, billing, fragment). Advisory: read before acting.
 *
 * Usage:
 *   node scripts/audit-synopsis-story.js                # summary + hard rows
 *   node scripts/audit-synopsis-story.js --soft         # also list soft rows
 *   node scripts/audit-synopsis-story.js --show=a,b     # only these ids
 *   node scripts/audit-synopsis-story.js --json         # machine-readable
 *   node scripts/audit-synopsis-story.js --fail-on-hit  # exit 1 on any hard row
 *
 * Exit: 0 clean (or hits without --fail-on-hit), 1 hard rows with
 * --fail-on-hit, 2 shows.json missing or unreadable.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const { synopsisStoryProblems } = require('./lib/synopsis-story-audit');
const { nonStoryReason } = require('./lib/todaytix-page-identity');

const args = process.argv.slice(2);
const showArg = args.find(a => a.startsWith('--show='));
const only = showArg ? new Set(showArg.slice('--show='.length).split(',').map(s => s.trim()).filter(Boolean)) : null;
const SHOWS_PATH = path.join(process.cwd(), 'data', 'shows.json');

let shows;
try {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  shows = Array.isArray(data) ? data : data.shows;
  if (!Array.isArray(shows) || shows.length === 0) throw new Error('no shows');
} catch (e) {
  console.error(`audit-synopsis-story: cannot read ${SHOWS_PATH}: ${e.message}`);
  process.exit(2);
}

const hard = [];
const soft = [];
let checked = 0;
for (const show of shows) {
  if (only && !only.has(show.id)) continue;
  if (typeof show.synopsis !== 'string' || !show.synopsis.trim()) continue;
  checked++;
  const p = synopsisStoryProblems(show, nonStoryReason);
  if (p.hard.length) hard.push({ id: show.id, reasons: p.hard, synopsis: show.synopsis.slice(0, 160) });
  if (p.soft.length) soft.push({ id: show.id, ...p.soft[0] });
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ checked, hardCount: hard.length, softCount: soft.length, hard, soft }, null, 2));
} else {
  console.log(`Synopses checked: ${checked}`);
  console.log(`Hard (debris or pitch): ${hard.length}`);
  for (const h of hard) console.log(`  ${h.id} [${h.reasons.join(', ')}] ${h.synopsis}`);
  console.log(`Soft (nonStoryReason, advisory): ${soft.length}${args.includes('--soft') ? '' : ' (--soft to list)'}`);
  if (args.includes('--soft')) for (const s of soft) console.log(`  ${s.id} [${s.reason}] ${s.sentence.slice(0, 140)}`);
}

process.exit(args.includes('--fail-on-hit') && hard.length ? 1 : 0);
