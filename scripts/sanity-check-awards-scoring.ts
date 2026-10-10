/**
 * Sanity-check the new Site Award Score against canonical test cases.
 * Run: npx tsx scripts/sanity-check-awards-scoring.ts
 */

import { computeSiteAwardScore } from '../src/lib/awards-scoring';

const SHOWS: Array<{ id: string; label: string; expect?: string }> = [
  { id: 'hamilton-2015',              label: 'Hamilton',              expect: 'sweeper, breaks 100' },
  { id: 'next-to-normal-2009',        label: 'Next to Normal',        expect: 'honored — 3 Tonys + Pulitzer' },
  { id: 'stereophonic-2024',          label: 'Stereophonic',          expect: 'decorated — Tony Best Play + Pulitzer finalist' },
  { id: 'spring-awakening-2006',      label: 'Spring Awakening',      expect: 'decorated — 8 Tonys, no Pulitzer' },
  { id: 'maybe-happy-ending-2024',    label: 'Maybe Happy Ending',    expect: '~sweeper — 2025 Best Musical' },
  { id: 'purpose-2025',               label: 'Purpose',               expect: 'decorated — Pulitzer + Tony Best Play 2025' },
  { id: 'sunday-in-the-park-with-george-1984', label: 'Sunday in the Park...', expect: 'honored — Pulitzer, lost Best Musical' },
  { id: 'angels-in-america-perestroika-1993',  label: 'Angels in America',     expect: 'decorated — Pulitzer 1993 + Tonys' },
  { id: 'rent-1996',                           label: 'Rent',                  expect: 'decorated/sweeper — Pulitzer 1996 + Best Musical' },
  { id: 'a-chorus-line-1975',                  label: 'A Chorus Line',         expect: 'decorated — Pulitzer 1976 + 9 Tonys' },
  { id: 'wicked-2003',                label: 'Wicked',                expect: 'in-the-hunt — lots of noms, lost Best Musical to Avenue Q' },
  { id: 'come-from-away-2017',        label: 'Come From Away',        expect: 'nominated/honored — Best Musical nom, Direction win' },
];

function fmt(n: number, w = 4): string {
  return Math.round(n).toString().padStart(w);
}

for (const { id, label, expect } of SHOWS) {
  const r = computeSiteAwardScore(id, 'broadway');
  console.log('═'.repeat(70));
  console.log(`${label.padEnd(28)} → score ${fmt(r.displayScore, 3)}  (raw ${fmt(r.rawPoints)}) · ${r.badge.toUpperCase()}`);
  if (expect) console.log(`  expected: ${expect}`);
  if (r.breakdown.length === 0) {
    console.log('  (no awards data found)');
    continue;
  }
  for (const c of r.breakdown) {
    console.log(`  ${c.ceremony.padEnd(28)} +${fmt(c.subtotal, 5)}`);
    for (const it of c.items.slice(0, 6)) {
      const tag = it.result === 'win' ? 'WIN' : 'nom';
      const tier = it.revival ? `${it.tier}r` : it.tier;
      console.log(`     ${tier.padEnd(3)} ${tag.padEnd(3)} ${it.category.slice(0, 44).padEnd(44)} +${fmt(it.points, 4)}`);
    }
    if (c.items.length > 6) console.log(`     ... + ${c.items.length - 6} more line items`);
  }
}
console.log('═'.repeat(70));
