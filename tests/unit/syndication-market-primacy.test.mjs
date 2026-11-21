// BRO-7957: market-aware primacy for Chris Jones (Chicago Tribune vs NY Daily News).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const synd = require('../../scripts/lib/syndication-pairs.js');
const { normalizeOutlet } = require('../../scripts/lib/review-normalization');

const NYC = { category: 'broadway', market: 'broadway', openingDate: '2026-11-19' };
const OB = { category: 'off-broadway', market: 'off-broadway', openingDate: '2025-03-01' };
const OLD = { category: 'broadway', market: 'broadway', openingDate: '1982-10-07' };
const WE = { category: 'west-end', market: 'west-end', openingDate: '2026-05-01' };
const P = (o, show) => synd.getSyndicationPrimaries('Chris Jones', o, { show });

test('NYC era show: Daily News primary, Tribune the reprint', () => {
  for (const show of [NYC, OB]) {
    assert.deepEqual(P('chicagotribune', show), ['nydailynews']);
    assert.deepEqual(P('nydailynews', show), []);
  }
});
test('no show / pre-2024 / non-NYC: unchanged (Tribune primary)', () => {
  for (const show of [undefined, OLD, WE, { ...NYC, openingDate: '2023-12-31' }, { ...NYC, openingDate: undefined }]) {
    assert.deepEqual(P('nydailynews', show), ['chicagotribune']);
    assert.deepEqual(P('chicagotribune', show), []);
  }
  assert.deepEqual(P('nydailynews', { ...NYC, openingDate: '2024-01-01' }), []);
});
test('other critics and other group members are untouched', () => {
  assert.deepEqual(synd.getSyndicationPrimaries('Jane Roe', 'nydailynews', { show: NYC }), ['chicagotribune']);
  assert.deepEqual(synd.getSyndicationPrimaries('Chris Jones', 'baltimoresun', { show: NYC }).sort(), ['chicagotribune', 'nydailynews']);
});
test('InDir threads the show; isCrossOutletSyndicationPair stays symmetric', () => {
  assert.deepEqual(synd.getSyndicationPrimariesInDir('Chris Jones', 'chicagotribune', [], normalizeOutlet, { show: NYC }), ['nydailynews']);
  assert.ok(synd.isCrossOutletSyndicationPair({ criticName: 'Chris Jones', outletId: 'chicagotribune' }, { criticName: 'Chris Jones', outletId: 'nydailynews' }));
});
test('rebuild threads the show to every primacy call (class guard: no show-less InDir call in rebuild/guards)', async () => {
  const fs = await import('node:fs');
  for (const f of ['scripts/rebuild-all-reviews.js', 'scripts/lib/review-guards.js', 'scripts/lib/dedup-survivor.js', 'scripts/lib/star-score-mismatch.js', 'scripts/lib/press-night-review-state.js', 'scripts/lib/rebuild-staleness-scan.js', 'scripts/lib/opening-night-lane/lane-runner.js']) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:getSyndicationPrimaries(?:InDir)?|hasFullerSecondary|findFullerSecondaryFile)\(/g)) {
      let depth = 0, end = m.index + m[0].length - 1; // the call's own parens, so a multi-line call is read whole
      for (; end < src.length; end++) { if (src[end] === '(') depth++; else if (src[end] === ')' && --depth === 0) break; }
      const call = src.slice(m.index, end + 1);
      assert.match(call, /[{,]\s*show\s*[:},]/, `${f}: ${call.slice(0, 90)} must pass the show (BRO-7957)`);
    }
  }
});

test('review-field-edit: the flip clears a Daily News flag only on a NYC-era show, never the Tribune side', () => {
  const { syndicationPrimacyFlipApplies } = require('../../scripts/lib/review-field-edit.js');
  const ny = { criticName: 'Chris Jones', outletId: 'nydailynews', isSyndicatedDuplicate: true, syndicatedPrimaryFile: 'x/chicagotribune--chris-jones.json' };
  assert.equal(syndicationPrimacyFlipApplies(ny, { folder: 'x' }, NYC), true);
  assert.equal(syndicationPrimacyFlipApplies(ny, { folder: 'x' }, OLD), false);
  assert.equal(syndicationPrimacyFlipApplies(ny, { folder: 'x' }, WE), false);
  assert.equal(syndicationPrimacyFlipApplies({ ...ny, syndicatedPrimaryFile: 'y/chicagotribune--chris-jones.json' }, { folder: 'x' }, NYC), false);
  assert.equal(syndicationPrimacyFlipApplies({ ...ny, outletId: 'chicagotribune', syndicatedPrimaryFile: 'x/nydailynews--chris-jones.json' }, { folder: 'x' }, NYC), false);
  const noPtr = { ...ny, syndicatedPrimaryFile: undefined };
  assert.equal(syndicationPrimacyFlipApplies(noPtr, { folder: 'x', siblings: ['chicagotribune--chris-jones.json'] }, NYC), true);
  assert.equal(syndicationPrimacyFlipApplies(noPtr, { folder: 'x', siblings: [] }, NYC), false, 'no Tribune counterpart on disk: nothing would take over');
});
test('migration planPair: same text flips; different text or dates stays', () => {
  const { planPair } = require('../../scripts/migrate-chris-jones-nyc-primacy.js');
  const text = Array.from({ length: 60 }, (_, i) => `word${i}x`).join(' ');
  const a = { fullText: text, publishDate: '2026-11-19' };
  assert.equal(planPair(a, { fullText: text, publishDate: '2026-11-19' }, NYC, 't.json').action, 'flip');
  assert.equal(planPair(a, { fullText: 'something else entirely '.repeat(30), publishDate: '2026-11-19' }, NYC, 't.json').action, 'skip');
  assert.equal(planPair(a, { fullText: text, publishDate: '2018-09-30' }, NYC, 't.json').action, 'skip');
  assert.equal(planPair(a, { fullText: text, publishDate: '2026-11-19' }, OLD, 't.json').action, 'skip');
});

test('fuller-secondary fallback follows the market primacy (a stub Daily News copy yields to the complete Tribune copy)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7957-'));
  const text = 'A full review of the production. '.repeat(60);
  const ny = { criticName: 'Chris Jones', outletId: 'nydailynews', contentTier: 'excerpt', fullText: 'short', assignedScore: 70 };
  const tr = { criticName: 'Chris Jones', outletId: 'chicagotribune', contentTier: 'complete', fullText: text, assignedScore: 70, publishDate: '2026-11-19', url: 'https://www.chicagotribune.com/x' };
  fs.writeFileSync(path.join(dir, 'nydailynews--chris-jones.json'), JSON.stringify(ny));
  fs.writeFileSync(path.join(dir, 'chicagotribune--chris-jones.json'), JSON.stringify(tr));
  try {
    // default primacy: the stub is the Tribune, not NYDN, so NYDN has nothing to yield
    assert.equal(synd.hasFullerSecondary(dir, 'nydailynews--chris-jones.json', ny, {}), false);
    // NYC-era: NYDN is the primary; the lookup now considers it (finds the Tribune as its secondary when it is live)
    const r = synd.findFullerSecondaryFile(dir, 'nydailynews--chris-jones.json', ny, { show: NYC });
    assert.ok(r === null || r === 'chicagotribune--chris-jones.json');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
