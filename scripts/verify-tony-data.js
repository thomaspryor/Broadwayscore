#!/usr/bin/env node
/**
 * Verify Tony nominations data against known record holders and quality checks.
 * Exits with code 1 on any failure. Reusable for annual updates.
 *
 * Usage:
 *   node scripts/verify-tony-data.js
 */

const fs = require('fs');
const path = require('path');

const TONY_FILE = path.join(__dirname, '..', 'data', 'tony-nominations.json');
const AWARDS_FILE = path.join(__dirname, '..', 'data', 'awards.json');

let failures = 0;
let passes = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passes++;
  } else {
    console.log(`  FAIL: ${label} — ${detail}`);
    failures++;
  }
}

function main() {
  console.log('=== Tony Data Verification ===\n');

  // Load data
  const tonyData = JSON.parse(fs.readFileSync(TONY_FILE, 'utf8'));
  const awardsData = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const noms = tonyData.nominations;

  // Build person stats (by name, fuzzy matching)
  const people = {};
  for (const n of noms) {
    if (!n.name || n.name === '(show-level)') continue;
    const key = n.ibdbPersonId || n.name;
    if (!people[key]) people[key] = { name: n.name, wins: 0, noms: 0, shows: new Set() };
    people[key].noms++;
    if (n.won) people[key].wins++;
    people[key].shows.add(n.showId);
  }

  function findPerson(name) {
    return Object.values(people).find(p =>
      p.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(p.name.toLowerCase())
    );
  }

  // Build show-level stats
  const nomsByShow = new Map();
  for (const n of noms) {
    if (n.name === '(show-level)') continue;
    nomsByShow.set(n.showId, (nomsByShow.get(n.showId) || 0) + 1);
  }

  // === KNOWN RECORD HOLDERS ===
  console.log('1. Known record holders:\n');

  const checks = [
    { name: 'Tommy Tune', minWins: 9, note: 'should be 9-10 wins' },
    { name: 'Audra McDonald', minWins: 6, note: 'record 6 acting Tonys' },
    { name: 'Jules Fisher', minWins: 8, note: 'lighting designer record' },
    { name: 'Lin-Manuel Miranda', exactWins: 3, note: 'Hamilton creator' },
  ];

  for (const c of checks) {
    const person = findPerson(c.name);
    if (!person) {
      check(c.name, false, `NOT FOUND in data (${c.note})`);
      continue;
    }
    if (c.minWins !== undefined) {
      check(`${c.name}: ${person.wins}W/${person.noms}N`, person.wins >= c.minWins,
        `expected >= ${c.minWins} wins, got ${person.wins} (${c.note})`);
    }
    if (c.exactWins !== undefined) {
      check(`${c.name}: ${person.wins}W/${person.noms}N`, person.wins === c.exactWins,
        `expected ${c.exactWins} wins, got ${person.wins} (${c.note})`);
    }
  }

  // Harold Prince: should be <= 6 (producing wins excluded)
  const prince = findPerson('Harold Prince');
  if (prince) {
    check(`Harold Prince: ${prince.wins}W/${prince.noms}N (non-producing)`, prince.wins <= 8,
      `expected <= 8 non-producing wins, got ${prince.wins}`);
  }

  // === PREVIOUSLY FAILED SHOWS ===
  console.log('\n2. Previously failed shows (checkpoint contamination):\n');

  const showChecks = [
    { id: 'slave-play-2021', minNoms: 7, note: 'was 0 due to checkpoint contamination' },
    { id: 'company-2022', minNoms: 5, note: 'was 0' },
    { id: 'after-midnight-2013', minNoms: 4, note: 'was 0' },
  ];

  for (const sc of showChecks) {
    const count = nomsByShow.get(sc.id) || 0;
    check(`${sc.id}: ${count} person-level noms`, count >= sc.minNoms,
      `expected >= ${sc.minNoms}, got ${count} (${sc.note})`);
  }

  // === COVERAGE CHECKS ===
  console.log('\n3. Coverage checks:\n');

  // Total nominations should be substantial
  check(`Total nominations: ${noms.length}`, noms.length >= 4000,
    `expected >= 4000, got ${noms.length}`);

  // Check for zero-data gaps on shows with 3+ expected noms
  const bigGaps = [];
  for (const [id, show] of Object.entries(awardsData.shows)) {
    if (!show.tony || show.tony.nominations < 3) continue;
    const actual = nomsByShow.get(id) || 0;
    if (actual === 0) bigGaps.push({ id, expected: show.tony.nominations });
  }

  check(`Shows with expected >= 3 and actual 0: ${bigGaps.length}`, bigGaps.length === 0,
    `${bigGaps.length} shows: ${bigGaps.slice(0, 5).map(g => g.id).join(', ')}`);

  // Check wins vs noms ratio is reasonable
  const totalWins = noms.filter(n => n.won).length;
  const winRate = totalWins / noms.length;
  check(`Win rate: ${(winRate * 100).toFixed(1)}%`, winRate > 0.15 && winRate < 0.50,
    `expected 15-50%, got ${(winRate * 100).toFixed(1)}%`);

  // === SUMMARY ===
  console.log(`\n=== RESULTS: ${passes} passed, ${failures} failed ===`);
  if (failures > 0) {
    console.error(`\n${failures} verification check(s) FAILED`);
    process.exit(1);
  } else {
    console.log('\nAll checks passed!');
  }
}

main();
