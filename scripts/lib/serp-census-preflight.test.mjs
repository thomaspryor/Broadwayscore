// Run: node --test scripts/lib/serp-census-preflight.test.mjs
// Requires the real predicate (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serpCensusPreflight, SERP_KEY_VARS } = require('./serp-census-preflight.js');

test('no SERP key and no explicit opt-out: REFUSE', () => {
  // The 2026-09-24 shape: a re-audit of jeeves-takes-charge-west-end-2026
  // returned a 0/0 census against a stored 18/19, with a fresh zero-gap
  // checkpoint entry that newsletter-preflight reads as VERIFIED COMPLETE —
  // while Bright Data page fetches succeeded throughout, so nothing looked
  // wrong. Only the blast-radius guard stood between that and the corpus.
  const v = serpCensusPreflight({});
  assert.equal(v.ok, false);
  assert.match(v.reason, /VERIFIED COMPLETE/);
  assert.match(v.reason, /SERP_GAP_CENSUS_DISABLED=1/, 'must name the explicit opt-out');
});

test('either key alone is enough to proceed', () => {
  for (const k of SERP_KEY_VARS) {
    assert.equal(serpCensusPreflight({ [k]: 'abc123' }).ok, true, `${k} should suffice`);
  }
});

test('a blank or whitespace key is NOT a key', () => {
  // A dropped env: line in CI yields an empty string, not an absent var.
  assert.equal(serpCensusPreflight({ SCRAPINGBEE_API_KEY: '' }).ok, false);
  assert.equal(serpCensusPreflight({ BRIGHTDATA_TOKEN: '   ' }).ok, false);
  assert.equal(serpCensusPreflight({ SCRAPINGBEE_API_KEY: '', BRIGHTDATA_TOKEN: '' }).ok, false);
});

test('the explicit opt-out proceeds even with no keys — a zero census is then a CHOICE', () => {
  for (const v of ['1', 'true', 'TRUE']) {
    const r = serpCensusPreflight({ SERP_GAP_CENSUS_DISABLED: v });
    assert.equal(r.ok, true, `SERP_GAP_CENSUS_DISABLED=${v} should opt out`);
    assert.match(r.reason, /explicitly disabled/);
  }
});

test('a non-truthy opt-out value does NOT opt out', () => {
  // "0"/"false"/"no" must not read as disabled, or a typo silently restores
  // the exact silent-degradation this guard exists to stop.
  for (const v of ['0', 'false', 'no', '']) {
    assert.equal(serpCensusPreflight({ SERP_GAP_CENSUS_DISABLED: v }).ok, false, `${JSON.stringify(v)} must not opt out`);
  }
});

// BRO-4139: five more callers share this predicate via opts.disableVar/
// consequence/workflowHint (e.g. coverage-adversarial-probe.js,
// audit-serp-census-recall.js) — a typo'd disableVar would silently disable
// the WRONG switch, and a caller's custom reason text must actually reach
// the operator reading it during an incident.
test('opts.disableVar names a DIFFERENT opt-out switch — the default one no longer works', () => {
  const r = serpCensusPreflight({ SERP_GAP_CENSUS_DISABLED: '1' }, { disableVar: 'CUSTOM_DISABLED' });
  assert.equal(r.ok, false, 'the default switch must not opt out once disableVar is overridden');
  const custom = serpCensusPreflight({ CUSTOM_DISABLED: '1' }, { disableVar: 'CUSTOM_DISABLED' });
  assert.equal(custom.ok, true);
  assert.match(custom.reason, /CUSTOM_DISABLED/);
});

test('opts.consequence and opts.workflowHint reach the caller-facing reason text', () => {
  const r = serpCensusPreflight({}, {
    consequence: 'UNIQUE_MARKER_CONSEQUENCE_TEXT',
    workflowHint: 'unique-workflow-marker.yml',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /UNIQUE_MARKER_CONSEQUENCE_TEXT/);
  assert.match(r.reason, /unique-workflow-marker\.yml/);
  // The gap-audit's own consequence text (VERIFIED COMPLETE) must NOT leak
  // into a caller that supplied its own — that would be actively misleading
  // during an incident on a script this text doesn't describe.
  assert.doesNotMatch(r.reason, /VERIFIED COMPLETE/);
});

test('disableVar: null means NO keyless opt-out — no switch, however spelled, unlocks it', () => {
  for (const env of [{}, { SERP_GAP_CENSUS_DISABLED: '1' }, { SERP_GAP_CENSUS_DISABLED: 'yes' }, { null: '1' }]) {
    const r = serpCensusPreflight(env, { disableVar: null });
    assert.equal(r.ok, false, JSON.stringify(env));
    assert.doesNotMatch(r.reason, /say so:/, 'no opt-out remedy is offered when none exists');
  }
  assert.equal(serpCensusPreflight({ BRIGHTDATA_TOKEN: 'x' }, { disableVar: null }).ok, true);
});
