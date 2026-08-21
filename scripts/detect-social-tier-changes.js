#!/usr/bin/env node
/**
 * detect-social-tier-changes.js
 *
 * BRO-770: appends a change entry into data/audit/show-changes-digest.json
 * whenever a show's social pulse tier ENTERS 'Buzzing' or 'Troubled', so
 * send-follow-notifications.js emails that show's followers on the next
 * run. Debounced via data/audit/social-tier-transitions.json — fires once
 * per tier entry, not on every run while a show stays in the tier.
 *
 * Runs AFTER detect-show-changes.js in send-follow-notifications.yml (not
 * as a step in update-social-pulse.yml): detect-show-changes.js rewrites
 * digest.changes[showId] wholesale, so a tier change written before it
 * would be silently dropped for any show that also has a structural
 * change (status/score/cast) that week. Appending after it is race-free.
 *
 * Usage: node scripts/detect-social-tier-changes.js
 */

const fs = require('fs');
const path = require('path');
const { detectTierTransitions, buildTierChangeEntry } = require('./lib/tier-transition-notifier');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SOCIAL_PULSE_DIR = path.join(DATA_DIR, 'social-pulse');
const DIGEST_PATH = path.join(DATA_DIR, 'audit', 'show-changes-digest.json');
const STATE_PATH = path.join(DATA_DIR, 'audit', 'social-tier-transitions.json');

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadPulseEntries() {
  if (!fs.existsSync(SOCIAL_PULSE_DIR)) return [];
  const files = fs.readdirSync(SOCIAL_PULSE_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'));

  const entries = [];
  for (const file of files) {
    const data = loadJSON(path.join(SOCIAL_PULSE_DIR, file), null);
    if (!data) continue;
    const showId = data.showId || path.basename(file, '.json');
    entries.push({ showId, tier: data.tier || null });
  }
  return entries;
}

function main() {
  console.log('Detecting social pulse tier transitions...\n');

  const pulseEntries = loadPulseEntries();
  console.log(`Loaded ${pulseEntries.length} social pulse files`);

  // First-ever run (no state file yet): establish a baseline silently,
  // same convention as detect-show-changes.js's "no previous digest ->
  // don't report". Without this, launch day would email every follower of
  // every show that already happens to be Buzzing/Troubled, which is noise,
  // not a transition.
  const isBootstrap = !fs.existsSync(STATE_PATH);
  const transitionState = loadJSON(STATE_PATH, {});
  const { transitions: detected, nextState } = detectTierTransitions(pulseEntries, transitionState);
  const transitions = isBootstrap ? [] : detected;
  if (isBootstrap) {
    console.log('No previous state file — first run, establishing baseline (no emails sent)');
  }

  console.log(`${transitions.length} show(s) just entered Buzzing or Troubled:`);
  for (const t of transitions) {
    console.log(`  ${t.showId}: ${t.previousTier || '(no prior tier)'} -> ${t.tier}`);
  }

  if (transitions.length > 0) {
    const digest = loadJSON(DIGEST_PATH, null) || { generatedAt: new Date().toISOString(), currentState: {}, changes: {} };
    digest.changes = digest.changes || {};

    for (const t of transitions) {
      const entry = buildTierChangeEntry(t);
      const existing = digest.changes[t.showId] || [];
      // Idempotency guard: if this exact tier-change type is already queued
      // (e.g. an earlier run wrote the change but a later step failed before
      // send-follow-notifications.js could deliver+clear it), don't stack a
      // duplicate — detectTierTransitions itself won't re-fire once state is
      // persisted, but state and digest are two separate writes and a run
      // could fail between them.
      if (!existing.some(c => c.type === entry.type)) {
        digest.changes[t.showId] = [...existing, entry];
      }
    }

    fs.mkdirSync(path.dirname(DIGEST_PATH), { recursive: true });
    fs.writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2));
    console.log(`\nAppended ${transitions.length} tier-change entr${transitions.length === 1 ? 'y' : 'ies'} to ${path.relative(process.cwd(), DIGEST_PATH)}`);
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2));
  console.log(`State written to ${path.relative(process.cwd(), STATE_PATH)} (${Object.keys(nextState).length} shows tracked)`);
}

main();
