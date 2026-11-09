// BRO-7181: advisory --strict audits in data-health-check.yml route findings to a
// worker card (scripts/lib/audit-alert.js) instead of only turning a
// continue-on-error step red, and workflow-hygiene rule (ad) keeps that class
// from coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const { buildAuditAlert, routeAuditDecisions, clampCardValue } = require('../../scripts/lib/audit-alert.js');
const { decideStarBandAlerts, NO_JOIN_KEY, OUT_OF_BAND_KEY } = require('../../scripts/lib/star-band-drift-alert.js');
const { decideSyndicatedPairAlert, PAIR_ALERT_KEY } = require('../../scripts/audit-syndicated-critic-pairs.js');
const { decideDefaultCriticAlert, DIVERSITY_ALERT_KEY } = require('../../scripts/lib/default-critic-diversity.js');
const { findStrictAdvisoryWithoutAlert } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const base = { conditionKey: 'k:x', title: (n) => `t ${n}`, intro: 'intro.', hint: 'hint' };

test('buildAuditAlert: empty rows resolve; rows route an auto warning with a 20h cooldown', () => {
  assert.deepEqual(buildAuditAlert({ ...base, rows: [], resolveReason: 'clean' }), { action: 'resolve', conditionKey: 'k:x', reason: 'clean' });
  const d = buildAuditAlert({ ...base, rows: ['a'] });
  assert.equal(d.action, 'route');
  assert.equal(d.alert.severity, 'warning');
  assert.equal(d.alert.disposition, 'auto');
  assert.equal(d.alert.cooldownHours, 20);
  assert.equal(d.alert.title, 't 1');
  assert.equal(d.alert.verify, undefined, 'router fallback verify keeps the card dispatchable');
});

test('buildAuditAlert: caps at 25 rows, states the overflow, clamps long or multi-line rows', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `row ${i}`);
  const d = buildAuditAlert({ ...base, rows });
  assert.match(d.alert.description, /row 24\n- \.\.\.and 5 more/);
  assert.doesNotMatch(d.alert.description, /row 25/);
  const long = buildAuditAlert({ ...base, rows: ['x'.repeat(1000) + '\nSECOND LINE'] });
  const line = long.alert.description.split('\n').find((l) => l.startsWith('- x'));
  assert.ok(line.length <= 245, `row clamped (${line.length})`);
  assert.equal(clampCardValue({ text: 'BODY' }), '<object, not shown>');
});

test('routeAuditDecisions: routes and resolves through the router, never throws', async () => {
  const calls = [];
  const router = {
    routeAlert: async (a) => { calls.push(['route', a.conditionKey]); return { action: 'filed', linearIdentifier: 'BRO-1' }; },
    resolveCondition: (k) => { calls.push(['resolve', k]); },
  };
  const logs = [];
  await routeAuditDecisions([{ action: 'resolve', conditionKey: 'a', reason: 'r' }, buildAuditAlert({ ...base, rows: ['x'] })], 't', { router, log: (m) => logs.push(m), error: (m) => logs.push(m) });
  assert.deepEqual(calls, [['resolve', 'a'], ['route', 'k:x']]);
  assert.ok(logs.some((l) => /BRO-1/.test(l)));
  const boom = { routeAlert: async () => { throw new Error('linear down'); }, resolveCondition: () => {} };
  const errs = [];
  await routeAuditDecisions(buildAuditAlert({ ...base, rows: ['x'] }), 't', { router: boom, log: () => {}, error: (m) => errs.push(m) });
  assert.match(errs[0], /alert failed: linear down/);
});

test('star-band: no join files the input card and leaves the findings card alone', () => {
  const ds = decideStarBandAlerts({ publishedJoined: 0, publishedOutOfBand: [] });
  assert.equal(ds.length, 1);
  assert.equal(ds[0].action, 'route');
  assert.equal(ds[0].alert.conditionKey, NO_JOIN_KEY);
  assert.ok(!ds.some((d) => d.conditionKey === OUT_OF_BAND_KEY), 'missing input never resolves the out-of-band card');
});

test('star-band: clean run clears both keys; out-of-band rows carry numbers only', () => {
  const clean = decideStarBandAlerts({ publishedJoined: 100, publishedOutOfBand: [] });
  assert.deepEqual(clean.map((d) => [d.action, d.conditionKey]), [['resolve', NO_JOIN_KEY], ['resolve', OUT_OF_BAND_KEY]]);
  const hit = decideStarBandAlerts({ publishedJoined: 100, publishedOutOfBand: [{ file: 'show/outlet--critic.json', score: 40, source: 'llm', kind: 'star-band', detail: 'star 4/5 band 71-90', fullText: 'SECRET' }] });
  assert.equal(hit[1].action, 'route');
  assert.equal(hit[1].alert.conditionKey, OUT_OF_BAND_KEY);
  assert.match(hit[1].alert.description, /show\/outlet--critic\.json: published 40 \(llm\), star-band: star 4\/5 band 71-90/);
  assert.doesNotMatch(JSON.stringify(hit), /SECRET/);
});

test('syndicated pairs: either finding kind keeps the card open; both kinds listed', () => {
  const pair = { showId: 's', criticName: 'A Critic', secondary: 'observer', primary: 'guardian' };
  const un = { showId: 't', criticName: 'B Critic', outlets: ['deadline', 'thewrap'] };
  assert.equal(decideSyndicatedPairAlert([pair], []).action, 'route', 'a syndicated pair alone must not resolve');
  assert.equal(decideSyndicatedPairAlert([], [un]).action, 'route');
  const both = decideSyndicatedPairAlert([pair], [un]);
  assert.equal(both.alert.conditionKey, PAIR_ALERT_KEY);
  assert.match(both.alert.description, /observer and its syndication primary guardian/);
  assert.match(both.alert.description, /deadline and thewrap/);
  assert.deepEqual(decideSyndicatedPairAlert([], []).action, 'resolve');
});

test('default-critic diversity: rows name outlet, default critic and counts only', () => {
  const d = decideDefaultCriticAlert([{ outletId: 'nysr', defaultCritic: 'X Y', defaultCount: 10, unnamedCount: 3, others: [{ name: 'P Q', count: 4 }] }]);
  assert.equal(d.alert.conditionKey, DIVERSITY_ALERT_KEY);
  assert.match(d.alert.description, /nysr: defaultCritic X Y x10, unnamed 3, 1 other named critics/);
  assert.equal(decideDefaultCriticAlert([]).action, 'resolve');
});

// ── Rule (ad) class guard ───────────────────────────────────────────────
const step = (body) => `jobs:\n  a:\n    runs-on: x\n    steps:\n      - name: S\n${body}\n`;

test('rule (ad): advisory --strict without --alert is flagged', () => {
  const hits = findStrictAdvisoryWithoutAlert(step('        continue-on-error: true\n        run: node scripts/audit-x.js --strict'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'S');
  assert.match(hits[0].text, /--strict/);
});

test('rule (ad): --alert, an exemption comment, no continue-on-error, or --strict only in a comment pass', () => {
  assert.equal(findStrictAdvisoryWithoutAlert(step('        continue-on-error: true\n        run: node scripts/audit-x.js --strict --alert')).length, 0);
  assert.equal(findStrictAdvisoryWithoutAlert(step('        # strict-alert-exempt: PR check\n        continue-on-error: true\n        run: node scripts/audit-x.js --strict')).length, 0);
  assert.equal(findStrictAdvisoryWithoutAlert(step('        run: node scripts/audit-x.js --strict')).length, 0);
  assert.equal(findStrictAdvisoryWithoutAlert(step('        # exits 1 with --strict\n        continue-on-error: true  # the script exits 0 unless --strict\n        run: node scripts/audit-x.js')).length, 0);
  assert.equal(findStrictAdvisoryWithoutAlert(step('        # strict-alert-exempt:\n        continue-on-error: true\n        run: node scripts/audit-x.js --strict')).length, 1, 'an exemption needs a reason');
});

test('rule (ad): every workflow in the repo is clean (the class cannot come back)', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const h of findStrictAdvisoryWithoutAlert(fs.readFileSync(path.join(dir, f), 'utf8'))) offenders.push(`${f}:${h.lineNum} ${h.name}`);
  }
  assert.deepEqual(offenders, []);
  const dh = fs.readFileSync(path.join(dir, 'data-health-check.yml'), 'utf8');
  for (const s of ['audit-star-band-drift.js', 'audit-syndicated-critic-pairs.js', 'audit-default-critic-diversity.js', 'audit-approved-fix-drift.js']) {
    assert.match(dh, new RegExp(`${s.replace('.', '\\.')} --strict --alert`), `${s} runs with --alert`);
  }
});

test('rule (ad): flag-name boundaries, per-command --alert, quoted true, accurate line number', () => {
  assert.equal(findStrictAdvisoryWithoutAlert(step('        continue-on-error: true\n        run: node scripts/audit-x.js --strict-ids')).length, 0, '--strict-ids is not --strict');
  assert.equal(findStrictAdvisoryWithoutAlert(step('        continue-on-error: true\n        run: node scripts/audit-x.js --strict --alert-only')).length, 1, '--alert-only is not --alert');
  assert.equal(findStrictAdvisoryWithoutAlert(step('        continue-on-error: true\n        run: |\n          node a.js --strict --alert\n          node b.js --strict')).length, 1, 'one --alert does not cover a sibling command');
  assert.equal(findStrictAdvisoryWithoutAlert(step('        continue-on-error: "true"\n        run: node a.js --strict')).length, 1);
  const [h] = findStrictAdvisoryWithoutAlert(step('        continue-on-error: true\n        # note\n        run: node a.js --strict  # trailing'));
  assert.equal(h.lineNum, 8);
});
