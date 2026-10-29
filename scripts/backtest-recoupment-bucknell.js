#!/usr/bin/env node
'use strict';

/**
 * backtest-recoupment-bucknell.js — score our recoupment answers (the
 * reported `recouped` field and the model's `modelRecouped`) against the
 * Bucknell study's classification of 2008-2017 commercial musicals. BRO-6143.
 *
 *   node scripts/backtest-recoupment-bucknell.js            # summary + disagreements
 *   node scripts/backtest-recoupment-bucknell.js --summary  # summary only
 *   node scripts/backtest-recoupment-bucknell.js --json     # machine-readable
 *   --data-dir=DIR  read shows.json / commercial.json from DIR (default data/)
 *
 * Read-only. Exit 0 always: this reports, it does not gate.
 *
 * How to read it: our `recouped` field and the study's press labels often
 * cite the same articles, so the reported-field line is a consistency check,
 * not an accuracy score. The model lines carry an "always no" baseline: most
 * study musicals did not recoup, so a high agreement can be cheap.
 */

const path = require('path');
const { runBacktest, accuracy, alwaysNoBaseline, splitNoCommercial } = require('./lib/bucknell-backtest');

const argv = process.argv.slice(2);
const dataDirArg = argv.find((a) => a.startsWith('--data-dir='));
const dataDir = dataDirArg ? path.resolve(dataDirArg.split('=')[1]) : path.join(__dirname, '..', 'data');

const study = require(path.join(__dirname, '..', 'data', 'analysis', 'bucknell-recoupment-2008-2017.json'));
const showsRaw = require(path.join(dataDir, 'shows.json'));
const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
const commercialShows = require(path.join(dataDir, 'commercial.json')).shows || {};

const result = runBacktest(study.shows, shows, commercialShows);

const noSourceDoc = require(path.join(__dirname, '..', 'data', 'analysis', 'bucknell-no-readable-source.json')).shows || {};
const split = splitNoCommercial(result.rows, noSourceDoc);

if (argv.includes('--json')) {
  const documentedIds = new Set(split.documented.map((r) => r.showId));
  const rows = result.rows.map((r) => (documentedIds.has(r.showId) && !r.commercialKey ? { ...r, documentedNoSource: true } : r));
  console.log(JSON.stringify({ ...result, rows, staleDoc: split.staleDoc }, null, 2));
  process.exit(0);
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const fmt = (m, { baseline = false } = {}) => {
  const n = m.tp + m.fp + m.fn + m.tn;
  if (!n) return `n=0 (nothing to score)${m.unknown ? `, no answer ${m.unknown}` : ''}`;
  return `n=${n}${n < 10 ? ' (small sample)' : ''}: agree ${m.tp + m.tn} = ${pct(accuracy(m))}`
    + `; we say recouped, study no: ${m.fp}; we say no, study recouped: ${m.fn}; no answer ${m.unknown}`
    + (baseline ? `; "always no" would score ${pct(alwaysNoBaseline(m))}` : '');
};

const matched = result.rows.filter((r) => r.commercialKey);
const neverOpened = result.rows.filter((r) => !r.showId && r.neverOpened);
const noShow = result.rows.filter((r) => !r.showId && !r.neverOpened);
const { documented, openRows: noComm, staleDoc } = split; // BRO-6182
const loose = result.rows.filter((r) => r.matchRule && r.matchRule !== 'opening');
console.log(`Bucknell backtest: ${result.rows.length} study musicals; ${matched.length} have a commercial.json record`);
console.log(`  never opened (no page expected): ${neverOpened.length}; missing from shows.json: ${noShow.length}; page but no commercial record: ${noComm.length} (+${documented.length} documented as no readable source)`);
if (staleDoc.length) console.log(`  WARNING: bucknell-no-readable-source.json lists shows that now have a record or no page, remove them: ${staleDoc.join(', ')}`);
console.log(`  matched by closing date or a longer billing title (check these): ${loose.length}`);
if (result.unlabeled.length) console.log(`  WARNING: ${result.unlabeled.length} study rows have a label this script does not know: ${result.unlabeled.join(', ')}`);
console.log('');
console.log('Reported recouped field vs study (consistency check: both often cite the same press)');
console.log(`  firm labels (press / grosses below cap): ${fmt(result.reported.firm)}`);
console.log(`  soft labels (authors' judgment):         ${fmt(result.reported.soft)}`);
console.log('Model (modelRecouped) vs study');
console.log(`  firm labels:                             ${fmt(result.model.firm, { baseline: true })}`);
console.log(`  soft labels:                             ${fmt(result.model.soft, { baseline: true })}`);
console.log(`  firm labels, our reported field empty:   ${fmt(result.model.firmUnreported, { baseline: true })}`);
console.log(`  skipped (ai-estimated, copies the reported field): ${result.model.passthrough}`);

if (argv.includes('--summary')) process.exit(0);

const line = (r) => `  ${r.title} (${r.opening}) [${r.commercialKey || r.showId || '-'}${r.matchRule && r.matchRule !== 'opening' ? `, matched by ${r.matchRule}` : ''}] study=${r.classification}; reported=${r.ourReported}; model=${r.ourModel}${r.modelPct === null ? '' : ` (${r.modelPct}%)`}`;
const reportedConflicts = result.rows.filter((r) => r.reportedConflict);
const modelConflicts = result.rows.filter((r) => r.modelConflict && !r.reportedConflict);
console.log(`\nReported-field conflicts (${reportedConflicts.length}):`);
reportedConflicts.forEach((r) => console.log(line(r)));
console.log(`\nModel-only conflicts (${modelConflicts.length}):`);
modelConflicts.forEach((r) => console.log(line(r)));
console.log(`\nLooser matches (${loose.length}):`);
loose.forEach((r) => console.log(line(r)));
console.log(`\nMissing from shows.json (${noShow.length}):`);
noShow.forEach((r) => console.log(line(r)));
console.log(`\nPage but no commercial record (${noComm.length}):`);
noComm.forEach((r) => console.log(line(r)));
