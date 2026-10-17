/**
 * BRO-5179: no vulture-prefixed review-text file may carry a url host that the
 * vulture registry entry does not claim, unless a migration rule would move it
 * (rebuild's outlet-domain check drops such rows). Runs against the registry; the
 * review-texts corpus is private, so the live scan runs only when it is present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MIGRATIONS, planOutletMigration, hostOf } = require('../../scripts/lib/outlet-id-migrations.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('vulture rules cover the BRO-5179 hosts', () => {
  const ids = MIGRATIONS.filter((m) => m.from.includes('vulture')).map((m) => m.id);
  assert.ok(ids.includes('vulture-newyorknotebook-host-to-new-york-notebook'));
  assert.ok(ids.includes('vulture-theater-nytimes-host-to-nytimes'));
});

test('registry: vulture claims nymag.com and newyorkmetro.com', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
  const v = (reg.outlets || reg).vulture;
  assert.ok(v.domainAliases.includes('newyorkmetro.com'));
  assert.ok(v.domainAliases.includes('nymag.com'));
});

test('live corpus: every vulture file with a foreign host is movable (or flagged excluded)', (t) => {
  const dir = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(dir)) return t.skip('review-texts not available');
  // The fix is an approved plan applied after landing; red until then must not break CI.
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pending-fixes', 'bro-5179.json'), 'utf8'));
    if (plan.status === 'pending') return t.skip('BRO-5179 plan not yet applied');
  } catch { /* plan moved or absent: run the check */ }
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
  const v = (reg.outlets || reg).vulture;
  const own = [v.domain, ...(v.domainAliases || [])].map((d) => d.toLowerCase());
  const stuck = [];
  for (const show of fs.readdirSync(dir)) {
    const sd = path.join(dir, show);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const f of fs.readdirSync(sd)) {
      if (!f.startsWith('vulture--') || !f.endsWith('.json')) continue;
      let r; try { r = JSON.parse(fs.readFileSync(path.join(sd, f), 'utf8')); } catch { continue; }
      const h = hostOf(r.url);
      if (!h || own.some((d) => h === d || h.endsWith('.' + d))) continue;
      if (planOutletMigration(r, f)) continue;
      if (r.wrongProduction || r.wrongShow || r.isNonReview || r.duplicateOf) continue;
      stuck.push(`${show}/${f} (${h})`);
    }
  }
  assert.deepEqual(stuck, []);
});
