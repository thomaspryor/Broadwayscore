// BRO-5246: auto-onboarded outlets must not print a run-together slug as their
// display name ("Newjerseystage"). Every id-shaped name must be renamed from the
// outlet's homepage masthead or stamped displayNameReviewed (a real one-word name).
// The registry is private data and absent in some checkouts, so the registry
// checks skip there; the proposals-file checks always run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { applyDisplayNameProposals, proposalShapeProblem } = require(resolve(ROOT, 'scripts/lib/outlet-display-name-proposals.js'));

const REGISTRY = resolve(ROOT, 'data/outlet-registry.json');
const PROPOSAL_FILES = [
  'data/audit/outlet-display-name-proposals.json',
  'data/audit/outlet-display-name-proposals-bro-5246.json',
].map((f) => resolve(ROOT, f));

// Ids whose homepage could not be fetched on 2026-11-07 (blocked, dead or no domain).
// Do not add to this list: review the outlet (rename or stamp displayNameReviewed)
// and remove the id. The test fails if an id here no longer needs listing.
const UNREVIEWED_BACKLOG = new Set([
  'theatrely', 'neontommy', 'jazzwise', 'lemonwade', 'cultress', 'listener',
  'afropean', 'thurible', 'juliarank', 'theargus', 'wmscradio', 'buzznews',
]);

const cap = (id) => id.charAt(0).toUpperCase() + id.slice(1);
function slugNamed(outlets) {
  return Object.entries(outlets)
    .filter(([id, e]) => e && !e.displayNameReviewed && !id.includes('-') && id.length >= 8 && e.displayName === cap(id))
    .map(([id]) => id);
}
function loadProposals() {
  return PROPOSAL_FILES.filter(existsSync).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).proposals || []);
}

test('every proposal row is well formed and the BRO-5246 file exists', () => {
  assert.ok(existsSync(PROPOSAL_FILES[1]), 'BRO-5246 proposals file missing');
  for (const row of loadProposals()) assert.equal(proposalShapeProblem(row), null, row.outletId);
});

test('registry has no unreviewed slug-shaped display names after the proposals', { skip: !existsSync(REGISTRY) }, () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const sim = structuredClone(reg);
  applyDisplayNameProposals(sim, loadProposals());
  const left = slugNamed(sim.outlets || sim).filter((id) => !UNREVIEWED_BACKLOG.has(id));
  assert.deepEqual(left, [], `review these outlets (rename from the homepage or stamp displayNameReviewed): ${left.join(', ')}`);
});

test('the backlog allowlist only lists outlets that still need review', { skip: !existsSync(REGISTRY) }, () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const sim = structuredClone(reg);
  applyDisplayNameProposals(sim, loadProposals());
  const still = new Set(slugNamed(sim.outlets || sim));
  const stale = [...UNREVIEWED_BACKLOG].filter((id) => !still.has(id));
  assert.deepEqual(stale, [], `remove from UNREVIEWED_BACKLOG: ${stale.join(', ')}`);
});
