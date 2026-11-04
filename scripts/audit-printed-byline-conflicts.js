#!/usr/bin/env node
/**
 * audit-printed-byline-conflicts.js (BRO-6940): find review files whose stored
 * criticName disagrees with the byline the article itself prints.
 *
 * Origin: Waiting for Lefty's NYSR review was credited to Frank Scheck while the
 * text says "By Michael Sommers". Per-critic SERP discovery names the critic from
 * the search QUERY, and the author cross-check in collect-review-texts.js missed
 * NYSR's one-line header layout. See scripts/lib/printed-byline-conflict.js.
 *
 * Two tiers:
 *   known     the printed name is a critic known to write for this outlet (registry
 *             defaultCritics, plus critics the corpus already files at the outlet in
 *             3+ files across 2+ shows) and the credited critic is not printed in the
 *             head. Safe to re-credit.
 *   unlisted  the head prints "By <Name>" for someone not known at the outlet. Report
 *             only: could be a new critic, a guest critic or scrape chrome.
 *
 * Read-only. Private data is never edited from here; `--actions-out=FILE` writes
 * pending-fix actions (review-file-op move + review-field-edit) for the safe `known`
 * tier, for `node scripts/new-fix-plan.js --id=bro-N --summary=... --actions=FILE`.
 * Files that are _locked, criticNameManual, or whose destination already exists are
 * listed but never given an action.
 *
 * Exit code: 1 when any known conflict remains, else 0 (machine-checkable).
 *
 * Usage:
 *   node scripts/audit-printed-byline-conflicts.js [--show=ID] [--outlet=ID]
 *        [--tier=known|unlisted|all] [--json] [--actions-out=FILE] [--exclude=show/file,...] [--limit=N]
 *   node scripts/audit-printed-byline-conflicts.js --help
 */

'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const { generateReviewFilename, normalizeOutlet } = require('./lib/review-normalization');
const {
  findPrintedBylineConflict,
  findPrintedKnownByline,
  findUnlistedPrintedByline,
  buildKnownCriticsIndex,
  NO_FILL_OUTLETS,
  isPlaceholderName,
  sameCritic,
} = require('./lib/printed-byline-conflict');

const args = process.argv.slice(2);
const flag = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const JSON_OUT = args.includes('--json');
const ONLY_SHOW = flag('show');
const ONLY_OUTLET = flag('outlet');
const TIER = flag('tier') || 'all';
const ACTIONS_OUT = flag('actions-out');
const LIMIT = Number(flag('limit')) || 0;
// show/file paths a human reviewed and rejected (roundup pages, scrape chrome): never given an action.
const EXCLUDE = new Set((flag('exclude') || '').split(',').map((x) => x.trim()).filter(Boolean));

// A corpus critic counts as "known at the outlet" with this much evidence.
const CORPUS_MIN_FILES = 3;
const CORPUS_MIN_SHOWS = 2;

function readRecords(root) {
  const recs = [];
  for (const show of fs.readdirSync(root)) {
    if (show.startsWith('_') || show.startsWith('.')) continue;
    const dir = path.join(root, show);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const file of names) {
      if (!file.endsWith('.json') || !isReviewTextFile(file)) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      recs.push({ show, file, dir, r });
    }
  }
  return recs;
}

function outletOf(rec) {
  return normalizeOutlet(rec.r.outletId || rec.r.outlet || rec.file.split('--')[0]);
}

function buildKnown(recs, registryIndex) {
  const counts = new Map(); // outlet -> name -> { files, shows:Set }
  for (const rec of recs) {
    const name = rec.r.criticName;
    if (isPlaceholderName(name)) continue;
    const o = outletOf(rec);
    if (!counts.has(o)) counts.set(o, new Map());
    const m = counts.get(o);
    if (!m.has(name)) m.set(name, { files: 0, shows: new Set() });
    const e = m.get(name);
    e.files++; e.shows.add(rec.show);
  }
  const known = new Map();
  for (const [o, names] of registryIndex) known.set(normalizeOutlet(o), new Set(names));
  for (const [o, m] of counts) {
    if (!known.has(o)) known.set(o, new Set());
    for (const [name, e] of m) if (e.files >= CORPUS_MIN_FILES && e.shows.size >= CORPUS_MIN_SHOWS) known.get(o).add(name);
  }
  return { known, counts };
}

// The corpus often holds several spellings of one critic ("Kathleen Foley", "F. Kathleen Foley").
// Re-credit to the one the outlet already files most, so the rename lands on the existing file name.
function canonicalVariant(counts, outlet, name) {
  const m = counts.get(outlet);
  if (!m) return name;
  let best = name;
  let bestN = (m.get(name) || { files: 0 }).files;
  for (const [other, e] of m) {
    if (other !== name && sameCritic(other, name) && e.files > bestN) { best = other; bestN = e.files; }
  }
  return best;
}

function main() {
  const root = resolveReviewTextsDir();
  const registryPath = path.join(__dirname, '..', 'data', 'outlet-registry.json');
  let registry = null;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { /* corpus-only */ }
  const recs = readRecords(root);
  const { known, counts } = buildKnown(recs, buildKnownCriticsIndex(registry));

  const findings = [];
  for (const rec of recs) {
    const { r } = rec;
    if (ONLY_SHOW && rec.show !== ONLY_SHOW) continue;
    const outlet = outletOf(rec);
    if (ONLY_OUTLET && outlet !== ONLY_OUTLET) continue;
    if (!r.fullText) continue;
    if (EXCLUDE.has(`${rec.show}/${rec.file}`)) continue;
    if (NO_FILL_OUTLETS.has(outlet) && isPlaceholderName(r.criticName)) continue;
    const knownCritics = [...(known.get(outlet) || [])];
    const unnamed = isPlaceholderName(r.criticName);
    // Unnamed files ("Unknown", "Staff") are filled from a printed byline naming a known critic.
    let hit = unnamed
      ? findPrintedKnownByline({ fullText: r.fullText, knownCritics })
      : findPrintedBylineConflict({ criticName: r.criticName, fullText: r.fullText, knownCritics });
    if (!hit && !unnamed) hit = findUnlistedPrintedByline({ criticName: r.criticName, fullText: r.fullText, knownCritics });
    if (!hit) continue;
    hit = { ...hit, printedName: canonicalVariant(counts, outlet, hit.printedName) };
    const dest = generateReviewFilename(outlet, hit.printedName);
    const destExists = fs.existsSync(path.join(rec.dir, dest));
    findings.push({
      kind: hit.kind,
      show: rec.show,
      file: rec.file,
      outletId: outlet,
      credited: r.criticName,
      unnamed,
      printed: hit.printedName,
      source: r.source || null,
      url: r.url || null,
      destFile: dest,
      destExists,
      locked: !!(r._locked || r.criticNameManual),
      excluded: !!(r.wrongProduction || r.wrongShow || r.isRoundupArticle || r.duplicateOf),
    });
  }

  const shown = findings
    .filter((f) => TIER === 'all' || f.kind === TIER)
    .sort((a, b) => (a.kind === b.kind ? a.show.localeCompare(b.show) : a.kind === 'known' ? -1 : 1));
  const knownN = findings.filter((f) => f.kind === 'known').length;
  const unlistedN = findings.filter((f) => f.kind === 'unlisted').length;

  if (ACTIONS_OUT) {
    const actions = [];
    for (const f of findings) {
      if (f.kind !== 'known' || f.locked || f.excluded || f.destExists) continue;
      // Edit the credit in place first (the file still lives at its old name, which is where preflight
      // and the executor look), then move it to the name the new credit generates.
      actions.push({
        type: 'review-field-edit', file: `${f.show}/${f.file}`, field: 'criticName',
        oldValue: f.credited, newValue: f.printed,
        description: `BRO-6940: article byline prints ${f.printed}; file was credited to ${f.credited}`,
      });
      actions.push({
        type: 'review-file-op', operation: 'move',
        sourcePath: `${f.show}/${f.file}`, destPath: `${f.show}/${f.destFile}`,
      });
    }
    fs.writeFileSync(ACTIONS_OUT, JSON.stringify(actions, null, 2) + '\n');
    console.error(`wrote ${actions.length} actions (${actions.length / 2} files) to ${ACTIONS_OUT}`);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned: recs.length, known: knownN, unlisted: unlistedN, findings: shown }, null, 2));
  } else {
    console.log(`scanned ${recs.length} review files in ${root}`);
    console.log(`printed-byline conflicts: ${knownN} known (re-creditable), ${unlistedN} unlisted (human triage)`);
    const list = LIMIT ? shown.slice(0, LIMIT) : shown;
    for (const f of list) {
      const tags = [f.destExists ? 'DEST-EXISTS' : '', f.locked ? 'LOCKED' : '', f.excluded ? 'excluded' : ''].filter(Boolean).join(',');
      console.log(`  [${f.kind}] ${f.show}/${f.file}: ${f.credited} -> ${f.printed}${tags ? ` (${tags})` : ''} src=${f.source}`);
    }
  }
  process.exit(knownN > 0 ? 1 : 0);
}

if (require.main === module) main();
