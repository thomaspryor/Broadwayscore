// BRO-4885 (owner decision 2026-10-11): outlet pages show T1-T4 with the same
// neutral gray chip as show-page review rows, never the old yellow/blue badges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const OUTLET_FILES = [
  'src/app/critics/outlets/[slug]/OutletDetailClient.tsx',
  'src/app/critics/outlets/OutletIndexClient.tsx',
  'src/lib/critic-page-utils.tsx',
];

test('outlet pages render the shared OutletTierChip', () => {
  for (const f of OUTLET_FILES.slice(0, 2)) {
    assert.match(read(f), /<OutletTierChip tier=\{outlet\.tier\} \/>/, f);
  }
});

test('no colored tier badges remain on outlet pages', () => {
  for (const f of OUTLET_FILES) {
    const s = read(f);
    assert.doesNotMatch(s, /\bTierBadge(Small)?\b/, `${f}: old TierBadge`);
    assert.doesNotMatch(s, /(bg|text|border)-(yellow|blue)-\d{3}/, `${f}: yellow/blue tier color`);
  }
});

test('show-page chip and outlet chip share one box style and bar component', () => {
  const list = read('src/components/ReviewsList.tsx');
  assert.match(list, /import \{ TIER_CHIP_BOX, TIER_CHIP_BOX_TIGHT, TierBars, tierChipTextClass \} from '@\/components\/show-cards\/OutletTierChip'/);
  assert.doesNotMatch(list, /const TIER_CHIP_BOX\s*=/, 'ReviewsList must not redefine the chip box');
  const chip = read('src/components/show-cards/OutletTierChip.tsx');
  assert.match(chip, /TIER_CHIP_BOX_TIGHT = `\$\{TIER_CHIP_BOX\} /, 'the tight key chip must extend the one box style, not copy it');
  assert.match(chip, /\$\{TIER_CHIP_BOX\}[^`]*border-white\/\[0\.12\][^`]*\$\{tierChipTextClass\(tier\)\}/);
});
