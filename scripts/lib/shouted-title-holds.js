'use strict';
// venue-write-guard-ok: the hold file stores the candidate venue string for human review; it never writes a venue into shows.json.
/**
 * Held shouted-title candidates (BRO-3957, follow-up to BRO-3920).
 *
 * discover-new-shows.js holds back any candidate whose title looks shouted
 * (title-display-case.js) instead of writing guessed casing. That hold used to
 * be one console line, gone when the cron log scrolled off. This file keeps it.
 *
 * File: data/audit/shouted-title-holds.json, { holds: { <hash>: entry } }.
 * CI-written state, committed by update-show-status.yml. A person resolves a
 * hold by confirming the real title at the source, then either promoting the
 * show by hand or running `node scripts/report-shouted-title-holds.js --resolve=<hash>`
 * (removes the entry; rediscovery would hold it again only if it is still shouted).
 *
 * The West End promoter records the same decision in we-rejected-candidates.json
 * (kind 'skip-shouted-title'); the report script lists both, so there is one place to look.
 */

const fs = require('fs');
const path = require('path');
const { candidateHash } = require('./owe-candidate-hash');

const HOLDS_FILE = path.join(__dirname, '..', '..', 'data', 'audit', 'shouted-title-holds.json');

function load(file = HOLDS_FILE) {
  if (!fs.existsSync(file)) return { holds: {} };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { holds: parsed && typeof parsed.holds === 'object' && parsed.holds ? parsed.holds : {} };
}

// Pure. Returns a new store with the candidates recorded; a repeat hold keeps
// discoveredAt and bumps lastSeenAt/seenCount.
function recordHolds(store, candidates, now = new Date()) {
  const holds = { ...store.holds };
  const stamp = now.toISOString();
  for (const c of candidates || []) {
    if (!c || !c.title) continue;
    const hash = candidateHash({ title: c.title, venue: c.venue });
    const prior = holds[hash];
    holds[hash] = {
      title: c.title,
      venue: c.venue || null,
      source: c.source || null,
      sourceUrl: c.sourceUrl || (prior && prior.sourceUrl) || null,
      origin: c.origin || 'discover-new-shows',
      discoveredAt: prior ? prior.discoveredAt : stamp,
      lastSeenAt: stamp,
      seenCount: prior ? (prior.seenCount || 1) + 1 : 1,
    };
  }
  return { holds };
}

function resolveHold(store, hash) {
  if (!store.holds[hash]) return { store, removed: false };
  const holds = { ...store.holds };
  delete holds[hash];
  return { store: { holds }, removed: true };
}

function save(store, file = HOLDS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(store.holds).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify({ holds: sorted }, null, 2) + '\n');
}

// Open holds, oldest first, for the report.
function listHolds(store) {
  return Object.entries(store.holds)
    .map(([hash, e]) => ({ hash, ...e }))
    .sort((a, b) => String(a.discoveredAt).localeCompare(String(b.discoveredAt)));
}

module.exports = { HOLDS_FILE, load, recordHolds, resolveHold, save, listHolds };
