// BRO-5729 (BRO-3425 pattern): live-data assertions split out of scripts/lib/outlet-domain-validation.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/review-texts + data/outlet-registry.json), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health, which checks out core data and
// review-texts), excluded from the unit batches in scripts/lib/unit-test-collection.js. Pure-logic tests stay in scripts/lib/outlet-domain-validation.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { explainOutletDomainMismatch } = require_('../../scripts/lib/outlet-domain-validation.js');

// ── Corpus-wide false-positive guard ────────────────────────────────────────
// The actual regression test for the adversarial-review finding: run the real
// gate against the FULL local review-texts corpus (present in this worktree
// via setup-local-data.sh --all) and assert it flags at most the 2 known real
// instances — never a broader set. Skips gracefully if the corpus isn't
// present (e.g. a fresh worktree that hasn't pulled review-texts yet).

describe('corpus-wide false-positive guard', () => {
  const fs = require_('fs');
  const path = require_('path');
  const url = require_('url');
  const dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const root = path.join(dirname, '..', '..', 'data', 'review-texts');
  const hasCorpus = fs.existsSync(root);

  test('at most the 2 known real instances are flagged across the full corpus', { skip: !hasCorpus && 'no review-texts corpus in this worktree (run ./scripts/setup-local-data.sh --all)' }, () => {
    const registry = require_('../../data/outlet-registry.json');
    const shows = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    const flagged = [];
    for (const showDir of shows) {
      const dir = path.join(root, showDir.name);
      let files;
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (!data.outletId || !data.url) continue;
        if (explainOutletDomainMismatch(data, registry)) flagged.push(`${showDir.name}/${f}`);
      }
    }
    assert.ok(
      flagged.length <= 2,
      `expected at most 2 flagged files (the known incident + its sibling), got ${flagged.length}: ${flagged.slice(0, 20).join(', ')}`
    );
  });
});
