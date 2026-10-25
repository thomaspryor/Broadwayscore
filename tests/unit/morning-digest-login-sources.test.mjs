import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findFrozenLoginSources, injectLoginRows, LOGIN_SOURCES } = require('../../scripts/lib/login-sources.js');
const { planAutofix } = require('../../scripts/lib/digest-autofix.js');
const { buildSubject, composeDigestEmail } = require('../../scripts/send-morning-digest.js');

const NOW = new Date('2026-10-18T11:30:00Z');
const iso = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const fail = (d) => ({ conclusion: 'failure', createdAt: iso(d) });
const ok = (d) => ({ conclusion: 'success', createdAt: iso(d) });

// Mezzanine: 401 every run since Oct 4 (14 days); everything else healthy.
const fetchRuns = (wf) => wf === 'update-mezzanine.yml' ? [fail(0), fail(1), fail(7), ok(14)] : [ok(0), ok(1)];

test('auth-failed source is found with days frozen, worst first', () => {
  const { rows } = findFrozenLoginSources({ fetchRuns, now: NOW });
  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /Mezzanine ratings frozen 14 days/);
  assert.ok(rows[0].fixUrl);
});

test('one recent failure after a recent success is not a frozen login', () => {
  const { rows } = findFrozenLoginSources({ fetchRuns: () => [fail(0), ok(1)], now: NOW });
  assert.equal(rows.length, 0);
});

test('works for every registered source, not just Mezzanine', () => {
  for (const src of LOGIN_SOURCES) {
    const { rows } = findFrozenLoginSources({ fetchRuns: (wf) => wf === src.workflow ? [fail(0), fail(1), ok(6)] : [ok(0)], now: NOW });
    assert.equal(rows.length, 1, src.id);
    assert.match(rows[0].name, new RegExp(src.name));
  }
});

test('mezzanine: nightly skipped-job "success" runs do not hide a frozen login', () => {
  const skipped = (d) => ({ conclusion: 'success', createdAt: iso(d), scrapeSkipped: true });
  const runs = [fail(0), skipped(1), skipped(2), fail(7), ok(14)];
  const { rows } = findFrozenLoginSources({ fetchRuns: (wf) => wf === 'update-mezzanine.yml' ? runs : [ok(0)], now: NOW });
  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /frozen 14 days/);
});

test('a single failed run is not enough', () => {
  const { rows } = findFrozenLoginSources({ fetchRuns: () => [fail(0)], now: NOW });
  assert.equal(rows.length, 0);
});

test('a failing fetch is reported, not thrown', () => {
  const { rows, errors } = findFrozenLoginSources({ fetchRuns: () => { throw new Error('gh down'); }, now: NOW });
  assert.equal(rows.length, 0);
  assert.equal(errors.length, LOGIN_SOURCES.length);
});

function digestWith(autofixRows) {
  const sections = { health: { errors: [], warns: [], passedCount: 40 } };
  injectLoginRows(sections, findFrozenLoginSources({ fetchRuns, now: NOW }).rows);
  return { sections, subject: buildSubject({ health: sections.health, autofixRows, now: NOW }) };
}

test('subject says visitors affected and names the source', () => {
  const { subject } = digestWith(null);
  assert.match(subject, /visitors affected: Mezzanine ratings frozen 14 days/);
  assert.ok(subject.length < 120, subject);
});

test('an autofix row can never demote it to "all with automation"', () => {
  const name = 'Login expired: Mezzanine ratings frozen 14 days';
  const { subject } = digestWith([{ name, state: 'dispatched', affected: [{ name }] }]);
  assert.match(subject, /visitors affected: Mezzanine/);
  assert.doesNotMatch(subject, /all with automation/);
});

test('body top block lists it with days frozen and the fix link', () => {
  const { sections } = digestWith(null);
  const { html } = composeDigestEmail({ sections, now: NOW });
  const i = html.indexOf('Mezzanine ratings frozen 14 days');
  assert.ok(i > -1, 'row missing from body');
  assert.ok(html.indexOf('Visitors may notice a problem') > -1 && html.indexOf('Visitors may notice a problem') < i);
  assert.match(html, /BRO-5235/);
  assert.match(html, /fix it here/);
});

test('autofix never plans a card or dispatch for an expired login', () => {
  const { sections } = digestWith(null);
  const plan = planAutofix({ health: sections.health, today: '2026-10-18' });
  assert.ok(!JSON.stringify(plan).includes('Login expired'), 'login row reached the autofix plan');
});
