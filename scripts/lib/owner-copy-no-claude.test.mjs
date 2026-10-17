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

// health-check.js humanAction paste-prompts are filed as cards by the router;
// owner-decision-notify.js is a reply to a decision the owner must make.
const BASELINE = {
  'scripts/health-check.js': 29,
  'scripts/lib/owner-decision-notify.js': 1,
};

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
  const { buildCard } = require('../file-ugc-fix-card.js');
  const { startNowUnpickableReason } = require('./cloud-worker-pick.js');
  const card = buildCard({ failed: 'x', runUrl: 'u' });
  assert.match(card.description, /^START-NOW:/);
  assert.equal(startNowUnpickableReason({ ...card, priority: 1, mode: 'dispatch' }), null);
});
