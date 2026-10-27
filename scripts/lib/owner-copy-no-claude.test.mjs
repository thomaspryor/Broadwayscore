// BRO-5542 (owner 2026-10-16): "I hate getting emailed about issues that can
// be fixed just by me pasting it into a Claude session." Owner-facing alert
// text must say what broke and what the automation is doing, and name an owner
// action only when one truly exists. This scans code and workflows for text
// that tells the owner to open, ask or tell Claude, or paste an email.
// Own baseline (CLAUDE.md §19): the files below already hold such text; their
// count may shrink, never grow, and any other file must hold none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const BANNED = /(?:open|ask|tell) (?:a |the )?claude\b|paste (?:this|the|that|it) (?:email|alert|message)|paste (?:it )?into (?:a |the )?(?:claude|session)/i;
const COMMENT = /^\s*(?:\/\/|\*|\/\*|#)/;

// BRO-5543 split health-check.js's 28 humanAction paste-prompts into
// ownerText + workerInstruction, so the baseline is empty: every file must
// hold none.
const BASELINE = {};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|ts|yml|sh)$/.test(e.name) && !/\.test\.(mjs|js|ts)$/.test(e.name)) out.push(full);
  }
  return out;
}

function offenders() {
  const counts = {};
  const files = [...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, '.github', 'workflows'))];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const hits = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !COMMENT.test(l) && BANNED.test(l)).length;
    if (hits) counts[rel] = hits;
  }
  return counts;
}

test('no owner-facing text asks the owner to open Claude, ask Claude or paste an email (shrink-only baseline)', () => {
  const found = offenders();
  const grew = Object.entries(found).filter(([f, n]) => n > (BASELINE[f] || 0)).map(([f, n]) => `${f}: ${n} (allowed ${BASELINE[f] || 0})`);
  assert.deepEqual(grew, [], 'Owner alert text must say what is broken and what the automation does; name an owner action only for a login, a payment or a decision. Fix the text; do not raise the baseline.');
  const stale = Object.keys(BASELINE).filter((f) => (found[f] || 0) < BASELINE[f]);
  assert.deepEqual(stale, [], 'baseline shrank: lower these numbers in owner-copy-no-claude.test.mjs');
});

test('every OWNER_ACTIONS row passes the same ban, with no em dash', () => {
  const { OWNER_ACTIONS } = require('./page-worthy-alerts.js');
  for (const [k, t] of Object.entries(OWNER_ACTIONS)) {
    assert.doesNotMatch(t, BANNED, k);
    assert.ok(!t.includes('—'), `em dash in ${k}`);
  }
});

test('the signed-in-users alert files a START-NOW card and no longer asks the owner to paste', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/test-ugc-roundtrip.yml'), 'utf8');
  assert.match(yml, /file-ugc-fix-card\.js/);
  assert.doesNotMatch(yml, BANNED);
  assert.match(yml, /FIX_CARD: \$\{\{ steps\.fixcard\.outputs\.card \}\}/);
  assert.match(yml, /process\.env\.FIX_CARD\s*\?/);
  const { buildCard } = require('../file-ugc-fix-card.js');
  const { startNowUnpickableReason } = require('./cloud-worker-pick.js');
  const card = buildCard({ failed: 'x', runUrl: 'u' });
  assert.match(card.description, /^START-NOW: /);
  assert.match(card.description, /^VERIFY: /m);
  assert.equal(startNowUnpickableReason({ ...card, priority: 1, mode: 'dispatch' }), null);
});

test('BRO-5543: every split playbook row has owner text in plain English and a worker hint, neither naming Claude', async () => {
  const { getPlaybookEntry } = require('../health-check.js');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/health-check.js'), 'utf8');
  const names = ['Dispatch health: dead-launch rate', 'Sync: cast coverage', 'Quality: opening date vs review dates', 'Cookies: nyt', 'Secrets: x', 'Workflow repeat-failure: x', 'Cron failed: x'];
  for (const n of names) {
    const e = getPlaybookEntry(n);
    assert.ok(e && e.ownerText && e.workerInstruction, `${n} is split`);
    assert.equal(e.humanAction, undefined, `${n} keeps no shared humanAction`);
    assert.doesNotMatch(e.ownerText, BANNED, n);
    assert.doesNotMatch(e.workerInstruction, BANNED, n);
    assert.ok(!e.ownerText.includes('\u2014'), `em dash in ${n} ownerText`);
  }
  assert.ok((src.match(/^\s+ownerText: /gm) || []).length >= 28, 'all 28 former paste-prompt rows carry ownerText');
});

test('BRO-5543: the digest renders ownerText and the card hint uses workerInstruction, with humanAction back-compat', () => {
  const { ownerDigestInstruction, playbookWorkerHint, playbookOwnerText, hasPlaybookAction } = require('./playbook-copy.js');
  const split = { ownerText: 'Cast lists are missing. Nothing is needed from you.', workerInstruction: 'Run backfill-cast.js.' };
  const legacy = { humanAction: 'Legacy text' };
  const row = { message: 'raw row message' };
  // Owner side: ownerText wins, never the worker text, for every tracker state.
  for (const d of [undefined, { deferred: true }, { action: 'silent', linearIdentifier: 'BRO-1' }, { action: 'silent' }, { dispatchOk: false, dispatchError: 'boom' }, { linearIdentifier: 'BRO-2' }, {}]) {
    const out = ownerDigestInstruction(split, row, d);
    assert.ok(out.startsWith(split.ownerText), JSON.stringify(d));
    assert.doesNotMatch(out, /backfill-cast/);
    assert.ok(!out.includes('\u2014'), 'no em dash in rendered owner line');
  }
  assert.equal(ownerDigestInstruction(split, row, { linearIdentifier: 'BRO-2' }), `${split.ownerText} Filed as BRO-2 in Linear for triage.`);
  // Back-compat: humanAction-only rows render as before, minus the em dash.
  assert.equal(ownerDigestInstruction(legacy, row, { deferred: true }), 'Legacy text. Being watched; a card is filed if this is still happening after 3 days.');
  assert.equal(ownerDigestInstruction({ humanFallback: 'fb' }, row), 'fb');
  assert.equal(ownerDigestInstruction(null, row), 'raw row message');
  assert.equal(playbookOwnerText({ ownerText: 'o', humanAction: 'h' }), 'o');
  // Worker side.
  assert.equal(playbookWorkerHint(split), 'Run backfill-cast.js.');
  assert.equal(playbookWorkerHint(legacy), 'Legacy text');
  assert.equal(hasPlaybookAction(split), true);
  assert.equal(hasPlaybookAction(legacy), true);
  assert.equal(hasPlaybookAction({ workflow: 'x.yml', humanFallback: 'f' }), false);
});

test('BRO-5543: health-check.js reads playbook copy only through playbook-copy.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/health-check.js'), 'utf8');
  assert.doesNotMatch(src, /entry\??\.humanAction/, 'read entry text via playbook-copy.js helpers');
  assert.match(src, /hint: playbookWorkerHint\(entry\)/);
  assert.match(src, /ownerDigestInstruction\(entry, r, dispatch\)/);
  const { selectUnroutedVisitorRows } = require('./start-now-filing.js');
  const rows = selectUnroutedVisitorRows([{ name: 'A', status: 'error' }], { getPlaybookEntry: () => ({ ownerText: 'o', workerInstruction: 'w' }) });
  assert.deepEqual(rows, [], 'a split playbook row counts as routed');
});
