'use strict';

/**
 * BRO-2833: data inputs that scoring-delta.js cannot see through its
 * `git diff <ref> -- <watchlist>` selection.
 *
 * data/outlet-registry.json is tracked but was never on the watchlist, and
 * data/critic-registry.json is gitignored (private core-data repo), so an edit
 * to either reached the "nothing to check" green exit. Registry fields drive
 * inclusion/weight: tier (composite weight), cvStyle (arms shouldDeferCvWrongShow),
 * isDualMarket/region (UK wrong-production auto-clear ctx), aliases/domain
 * (outlet resolution), starScale (score parsing).
 *
 * Pure comparators take already-read content, so the verdicts are unit-testable;
 * the thin readers return null on any failure and the comparators turn null into
 * 'unobservable' — never into "no drift".
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Scoring-relevant per-outlet fields. Automation-written metadata
// (regionInferredBy/At, lastUpdated, _aliasIndex, ...) is deliberately absent.
const OUTLET_SCORING_FIELDS = ['tier', 'cvStyle', 'isDualMarket', 'region', 'market', 'starScale'];
// Resolution fields: a change re-routes raw outlet strings at rebuild without
// touching any stored outletId, so review counts under-report them.
const OUTLET_RESOLUTION_FIELDS = ['displayName', 'aliases', 'domain', 'domainAliases'];

const sig = (v) => JSON.stringify(v === undefined ? null : v);

/**
 * @param {object|null} baseReg  parsed registry at BASE_REF (null = unreadable)
 * @param {object|null} workReg  parsed working-tree registry (null = unreadable)
 * @param {Record<string,number>} reviewCounts  outletId -> review count
 * @returns {{status:'unobservable'|'unchanged'|'changed', significant:boolean, changes:object[], added:string[], removed:string[]}}
 */
function compareOutletRegistry(baseReg, workReg, reviewCounts = {}) {
  if (!baseReg || !workReg || !baseReg.outlets || !workReg.outlets) {
    return { status: 'unobservable', significant: false, changes: [], added: [], removed: [] };
  }
  const base = baseReg.outlets;
  const work = workReg.outlets;
  const changes = [];
  for (const id of Object.keys(work)) {
    if (!(id in base)) continue;
    const fields = [];
    for (const f of [...OUTLET_SCORING_FIELDS, ...OUTLET_RESOLUTION_FIELDS]) {
      if (sig(base[id][f]) !== sig(work[id][f])) {
        fields.push({ field: f, from: base[id][f] ?? null, to: work[id][f] ?? null });
      }
    }
    if (!fields.length) continue;
    const reviews = reviewCounts[id] || 0;
    const resolutionChange = fields.some(x => OUTLET_RESOLUTION_FIELDS.includes(x.field));
    changes.push({ outletId: id, fields, reviews, significant: reviews > 0 || resolutionChange });
  }
  const added = Object.keys(work).filter(id => !(id in base));
  // An added outlet that claims a name an existing outlet already answers to
  // takes it over at lookup time (Map.set overwrites), re-routing reviews.
  const nameKeys = (id, o) => [id, o.displayName, ...(o.aliases || []), o.domain, ...(o.domainAliases || [])]
    .filter(Boolean).map(x => String(x).toLowerCase());
  const claimed = new Set();
  for (const id of Object.keys(base)) for (const k of nameKeys(id, base[id])) claimed.add(k);
  const takeovers = added.filter(id => nameKeys(id, work[id]).some(k => claimed.has(k)));
  const removed = Object.keys(base).filter(id => !(id in work));
  const significant = removed.length > 0 || takeovers.length > 0 || changes.some(c => c.significant);
  const status = changes.length || added.length || removed.length ? 'changed' : 'unchanged';
  return { status, significant, changes, added, removed, takeovers };
}

/** Raw-content comparison for a file we can only hash (critic-registry). */
function compareHashedInput(baseBuf, workBuf) {
  if (baseBuf == null || workBuf == null) return { status: 'unobservable', significant: false };
  const h = (b) => crypto.createHash('sha1').update(b).digest('hex');
  const same = h(baseBuf) === h(workBuf);
  return { status: same ? 'unchanged' : 'changed', significant: !same };
}

function countReviewsByOutlet(reviewsJson) {
  const counts = {};
  const list = Array.isArray(reviewsJson) ? reviewsJson : (reviewsJson && reviewsJson.reviews) || [];
  for (const r of list) if (r && r.outletId) counts[r.outletId] = (counts[r.outletId] || 0) + 1;
  return counts;
}

// ── readers (null on any failure) ──
function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function gitShowOrNull(cwd, ref, relPath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch { return null; }
}
function readBufOrNull(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

/**
 * Inspect every data input scoring-delta's git selection cannot see.
 * Returns { inputs: [{name, status, significant, ...}], significant, unobservable: string[] }.
 */
function inspectDataInputs({ repoRoot, baseRef, coreDataDir = path.join(os.homedir(), 'broadway-scorecard-data') }) {
  const dataDir = path.join(repoRoot, 'data');
  const baseBuf = gitShowOrNull(repoRoot, baseRef, 'data/outlet-registry.json');
  let baseReg = null;
  try { baseReg = baseBuf ? JSON.parse(baseBuf.toString('utf8')) : null; } catch { /* unobservable */ }
  const workReg = readJsonOrNull(path.join(dataDir, 'outlet-registry.json'));
  const counts = countReviewsByOutlet(readJsonOrNull(path.join(dataDir, 'reviews.json')));
  const outlet = { name: 'data/outlet-registry.json', ...compareOutletRegistry(baseReg, workReg, counts) };

  // critic-registry.json is gitignored here; its committed baseline is the private clone's HEAD.
  const critic = {
    name: 'data/critic-registry.json (vs private core-data HEAD)',
    ...compareHashedInput(
      gitShowOrNull(coreDataDir, 'HEAD', 'critic-registry.json'),
      readBufOrNull(path.join(dataDir, 'critic-registry.json'))
    ),
  };
  const inputs = [outlet, critic];
  return {
    inputs,
    significant: inputs.some(i => i.significant),
    unobservable: inputs.filter(i => i.status === 'unobservable').map(i => i.name),
  };
}

function formatDataInputReport(report) {
  const lines = [];
  for (const i of report.inputs) {
    if (i.status === 'changed') {
      lines.push(`[scoring-delta] DATA-INPUT DRIFT: ${i.name} differs from its baseline${i.significant ? ' (affects scoring)' : ' (no reviewed outlet affected)'}.`);
      for (const c of i.changes || []) {
        const desc = c.fields.map(f => `${f.field}: ${sig(f.from)} -> ${sig(f.to)}`).join('; ');
        lines.push(`  - ${c.outletId} (${c.reviews} reviews${c.significant ? '' : ', not significant'}): ${desc}`);
      }
      if (i.added && i.added.length) lines.push(`  + added outlets: ${i.added.slice(0, 20).join(', ')}${i.added.length > 20 ? ' …' : ''}`);
      if (i.takeovers && i.takeovers.length) lines.push(`  ! added outlets claiming an existing outlet's name/alias/domain: ${i.takeovers.slice(0, 20).join(', ')}`);
      if (i.removed && i.removed.length) lines.push(`  - removed outlets: ${i.removed.slice(0, 20).join(', ')}${i.removed.length > 20 ? ' …' : ''}`);
      if (i.name.startsWith('data/critic-registry.json') && i.significant) lines.push('  (if the working copy is merely stale, re-run scripts/setup-local-data.sh to resync it from the private core-data repo)');
    } else if (i.status === 'unobservable') {
      lines.push(`[scoring-delta] CANNOT-OBSERVE: ${i.name} could not be compared against its baseline.`);
    }
  }
  if (report.significant) {
    lines.push('[scoring-delta] The Phase A/B replay cannot attribute these (baseline replay reads the working-tree registry), so NO flip count exists for them. Measure affected reviews by hand before merging.');
  }
  return lines;
}

/** Wording for the green branch: names what was and was not covered. */
function describeCoverage(report) {
  const inspected = report.inputs.filter(i => i.status !== 'unobservable').map(i => i.name);
  const parts = [`data inputs inspected: ${inspected.join(', ') || 'none'}`];
  if (report.unobservable.length) parts.push(`NOT inspected: ${report.unobservable.join(', ')}`);
  return parts.join('; ');
}

module.exports = {
  OUTLET_SCORING_FIELDS, OUTLET_RESOLUTION_FIELDS,
  compareOutletRegistry, compareHashedInput, countReviewsByOutlet,
  inspectDataInputs, formatDataInputReport, describeCoverage,
};
