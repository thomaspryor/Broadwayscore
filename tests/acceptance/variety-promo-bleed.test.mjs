/**
 * Acceptance for BRO-5254: no stored Variety review text still carries the
 * "Related Stories" / "Popular on Variety" promo modules the old generic
 * extractor kept, or an excerpt repeated as the first paragraph. Runs over data/review-texts (private; skipped where the
 * corpus is not checked out, e.g. the land gate). Rows the rebuild excludes
 * anyway, and _locked rows (hand-curated), are left out.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DEFAULT_REVIEW_TEXTS_DIR } = require('../../scripts/lib/critic-review-scan.js');
const { listShowDirs } = require('../../scripts/lib/list-show-dirs.js');
const { hasVarietyPromoBleed, hasDuplicatedLead, isExcludedRow } = require('../../scripts/lib/variety-promo-bleed.js');

const corpusPresent = fs.existsSync(DEFAULT_REVIEW_TEXTS_DIR) && fs.readdirSync(DEFAULT_REVIEW_TEXTS_DIR).length > 100;

test('no stored Variety text carries promo bleed', { skip: corpusPresent ? false : 'data/review-texts corpus not present' }, () => {
  let variety = 0;
  const hits = [];
  for (const showId of listShowDirs(DEFAULT_REVIEW_TEXTS_DIR)) {
    const dir = path.join(DEFAULT_REVIEW_TEXTS_DIR, showId);
    for (const f of fs.readdirSync(dir)) {
      if (!/^variety--.*\.json$/.test(f)) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (typeof d.fullText !== 'string') continue;
      variety++;
      if (isExcludedRow(d) || d._locked) continue;
      if (hasVarietyPromoBleed(d.fullText)) hits.push(`${showId}/${f}`);
      else if (hasDuplicatedLead(d.fullText)) hits.push(`${showId}/${f} (duplicated lead)`);
    }
  }
  assert.ok(variety > 500, `too few Variety texts (${variety})`);
  assert.deepStrictEqual(hits, [], `${hits.length} Variety texts still carry promo bleed`);
});
