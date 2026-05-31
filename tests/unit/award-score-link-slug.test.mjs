/**
 * Regression guard for the broken /award-score/[season] link (forum report
 * 2026-05-24): AwardScoreCard/AwardsCard built the href with toFullSeasonLabel()
 * → "/award-score/2025-2026", but the route's generateStaticParams + validation
 * accept only the SHORT slug "2025-26" (/^\d{4}-\d{2}$/), so the link 404'd.
 *
 * Two distinct season-slug formats coexist on purpose:
 *   - /tony-awards/predictions/[season]  → FULL  "2025-2026" (toFullSeasonLabel)
 *   - /award-score/[season]              → SHORT "2025-26"   (seasonSlug)
 * It's easy to grab the wrong helper. This test pins every award-score link to
 * seasonSlug() and pins the route's accepted slug shape.
 *
 * Run: node --test tests/unit/award-score-link-slug.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', '..', 'src');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);

describe('award-score season link slug', () => {
  // Every interpolated /award-score/${...} link must use seasonSlug() — never
  // toFullSeasonLabel() (the full-year form 404s on this route).
  test('all /award-score/${...} links use seasonSlug()', () => {
    const offenders = [];
    const re = /\/award-score\/\$\{([^}]+)\}/g;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      let m;
      while ((m = re.exec(src)) !== null) {
        const expr = m[1].trim();
        // Allowed: seasonSlug(...) link helper, OR the route's own already-validated
        // `params.season` (self-referential canonical/breadcrumb URLs in the route).
        if (!/seasonSlug\s*\(/.test(expr) && expr !== 'params.season') {
          offenders.push(`${path.relative(SRC, f)}: /award-score/\${${expr}}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      `award-score links must build the slug with seasonSlug() (short YYYY-YY), not ` +
      `toFullSeasonLabel() or a raw value. Offenders:\n${offenders.join('\n')}`);
  });

  // Pin the route contract: the [season] route accepts only the short slug.
  test('award-score/[season] route validates the short YYYY-YY slug', () => {
    const routeFile = path.join(SRC, 'app', 'award-score', '[season]', 'page.tsx');
    const src = fs.readFileSync(routeFile, 'utf8');
    assert.ok(
      src.includes('/^\\d{4}-\\d{2}$/'),
      'route must validate params.season against /^\\d{4}-\\d{2}$/ (short slug). ' +
      'If this changed, update seasonSlug() and this guard together.'
    );
  });
});
