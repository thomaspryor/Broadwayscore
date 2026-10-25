/**
 * A suspectedMisattribution fixture that the CURRENT on-disk critic registry
 * still confirms (Guard G would fire today), for tests that exercise
 * isIncludableForRebuild / isScoreable against data/critic-registry.json.
 *
 * Those predicates read the registry from disk and it is regenerated nightly
 * from the corpus, so a hardcoded critic goes stale: on 2026-10-24 one Sunday
 * Times review made Susannah Clapp a freelancer and three "confirmed
 * misattribution" tests failed every Test Suite run (BRO-5824). This picks a
 * critic who is non-freelance with known outlets, plus an outlet outside them.
 * Susannah Clapp / wsj is preferred while it still qualifies.
 *
 * With no registry on disk the predicates exclude every flagged file (the
 * empty-registry fail-safe), so the Clapp default is still a valid fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeCritic, normalizeOutlet } = require('../../scripts/lib/review-normalization.js');

const REGISTRY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'critic-registry.json');
const CANDIDATE_OUTLETS = ['wsj', 'variety', 'nytimes', 'hollywood-reporter', 'chicago-tribune', 'guardian', 'telegraph'];

function confirms(entry, outletId) {
  const known = entry.knownOutlets || [];
  return !known.includes(outletId) && !known.includes(normalizeOutlet(outletId));
}

export function confirmedMisattribution() {
  let critics = {};
  try { critics = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).critics || {}; } catch { /* fail-safe default below */ }
  const preferred = [['susannah-clapp', critics['susannah-clapp']]];
  for (const [slug, entry] of [...preferred, ...Object.entries(critics)]) {
    if (!entry || entry.isFreelancer === true || !(entry.knownOutlets || []).length) continue;
    const criticName = entry.displayName;
    if (!criticName || normalizeCritic(criticName) !== slug) continue;
    const outletId = CANDIDATE_OUTLETS.find(o => confirms(entry, o));
    if (outletId) return { criticName, outletId };
  }
  return { criticName: 'Susannah Clapp', outletId: 'wsj' };
}
