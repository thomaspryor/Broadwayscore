// BRO-6791: Opera header, branding config and social kit must share one colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const nav = fs.readFileSync(new URL('../src/components/MarketNav.tsx', import.meta.url), 'utf8');
const branding = fs.readFileSync(new URL('../src/config/branding.ts', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../src/components/OperaPageClient.tsx', import.meta.url), 'utf8');
const kit = fs.readFileSync(new URL('./generate-opera-brand-kit.js', import.meta.url), 'utf8');
const social = fs.readFileSync(new URL('./social-autopost/config.js', import.meta.url), 'utf8');

const [light, dark] = kit.match(/const RED = \['(#[0-9a-f]{6})', '(#[0-9a-f]{6})'\]/i).slice(1);

test('header gradient uses the kit gradient, not amber', () => {
  assert.ok(nav.includes(`from-[${light}] to-[${dark}]`), 'logo gradient matches kit RED');
  assert.doesNotMatch(nav, /amber-/, 'no amber left in MarketNav');
});

test('branding config has an opera entry with the kit gradient', () => {
  const m = branding.match(/opera:\s*\{[\s\S]*?\n  \},/);
  assert.ok(m, 'MARKET_BRAND.opera exists');
  assert.ok(m[0].includes(`from-[${light}] to-[${dark}]`));
  const brand = social.match(/opera:[^\n]*brand: '(#[0-9a-f]{6})'/i)[1];
  assert.ok(m[0].includes(`emailColor: '${brand}'`), 'emailColor matches social autopost brand');
});

test('opera landing page hero uses the kit gradient, not amber', () => {
  assert.ok(page.includes(`from-[${light}] to-[${dark}]`));
  assert.doesNotMatch(page, /from-amber-/);
});
