// BRO-8229: allowCrossMarket / allowEarlyDate must never strip the wrongProduction flag
// from a strict class-A leak (the sibling run's review). Without the veto, a rescue flag
// made every rebuild un-flag the file and the zero-tolerance audit gate reddened main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { makeClassAVeto } = require('./cross-market-contamination.js');
const { shouldAutoClearWrongProduction } = require('./wrong-production-autoclear.js');
const { parseDate } = require('./date-utils.js');

const shows = [
  { id: 'a-christmas-carol-west-end-2026', title: 'A Christmas Carol', openingDate: '2026-11-24', category: 'west-end', market: 'west-end' },
  { id: 'a-christmas-carol-regional-2025', title: 'A Christmas Carol', openingDate: '2025-11-23', category: 'regional', market: 'regional' },
  { id: 'solo-2020', title: 'Solo Show', openingDate: '2020-03-01', category: 'broadway' },
  { id: 'a-christmas-carol-tour-2024', title: 'A Christmas Carol', openingDate: '2025-11-20', category: 'tour', market: 'tour' },
];
const by = Object.fromEntries(shows.map(s => [s.id, s]));
const veto = makeClassAVeto(shows, parseDate);
// The real failing file (run 43660704888): Old Vic 2025 review filed under the 2026 West End show.
const leak = { wrongProduction: true, allowCrossMarket: true, publishDate: '2025-11-26' };

test('class-A leak with an allowCrossMarket rescue is vetoed (the BRO-8229 case)', () => {
  assert.equal(veto(leak, by['a-christmas-carol-west-end-2026']), true);
  assert.equal(shouldAutoClearWrongProduction(leak), true, 'without ctx the old behaviour strips the flag (documents the bug)');
  assert.equal(shouldAutoClearWrongProduction(leak, { classA: true }), false);
  assert.equal(shouldAutoClearWrongProduction({ ...leak, allowCrossMarket: false, allowEarlyDate: true }, { classA: true }), false);
});

test('legit bypass still clears: not class A, no siblings, tour show, audit allowlist', () => {
  assert.equal(veto({ ...leak, publishDate: '2026-11-25' }, by['a-christmas-carol-west-end-2026']), false);
  assert.equal(veto(leak, by['solo-2020']), false);
  assert.equal(veto(leak, by['a-christmas-carol-tour-2024']), false);
  assert.equal(veto({ ...leak, _auditAllowCrossMarket: true }, by['a-christmas-carol-west-end-2026']), false);
  assert.equal(veto({ wrongProduction: true }, by['a-christmas-carol-west-end-2026']), false);
  assert.equal(shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }, { classA: false }), true);
  assert.equal(shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }), true);
});

test('wiring: rebuild and scoring-delta pass the class-A veto into the auto-clear', () => {
  for (const f of ['../rebuild-all-reviews.js', '../scoring-delta.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /shouldAutoClearWrongProduction\([a-z]+, \{ classA: /, `${f} must pass { classA } to shouldAutoClearWrongProduction`);
  }
});

// ── BRO-8231: the other rebuild clearers honour the same veto ─────────────────
const ac = require('./wrong-production-autoclear.js');
const { isStaleCvPromotedWrongProduction } = require('./review-guards.js');
const rebuildSrc = fs.readFileSync(new URL('../rebuild-all-reviews.js', import.meta.url), 'utf8');
const deltaSrc = fs.readFileSync(new URL('../scoring-delta.js', import.meta.url), 'utf8');

// Each case: a flag the predicate clears on its own, then vetoed once classA is passed.
const CASES = {
  urlYear: {
    fn: ac.shouldAutoClearWrongProductionUrlYear,
    call: (d, classA) => ac.shouldAutoClearWrongProductionUrlYear(d, { isLondonOrOffBroadway: true, classA }),
    data: { wrongProduction: true, wrongProductionNote: 'URL contains year 2019 (show opened 2026)' },
  },
  ukDualMarket: {
    call: (d, classA) => ac.shouldAutoClearWrongProductionUkDualMarket(d, {
      isLondonMarketShow: true, showEarliestDate: '2025-11-20', isUkUrl: true, classA }),
    data: { wrongProduction: true, wrongProductionNote: 'Cross-market: US outlet reviewing London show',
      url: 'https://www.theguardian.com/stage/2025/nov/26/a-christmas-carol-review', publishDate: '2025-11-26' },
  },
  staleLondon: {
    call: (d, classA) => ac.shouldAutoClearStaleLondonOutletCrossMarket(d, {
      isNycMarketShow: true, outletIsDualMarket: true, urlOnOutletPrimaryDomain: true, inOwnProductionWindow: true, classA }),
    data: { wrongProduction: true, wrongProductionNote: 'Cross-market: London outlet reviewing NYC show', url: 'https://observer.com/2025/11/x/' },
  },
  datelessRevival: {
    call: (d, classA) => ac.shouldAutoClearDatelessRevival(d, { hasUsableDate: true, classA }),
    data: { wrongProduction: true, wrongProductionNote: 'Dateless revival guard: held', wrongProductionReason: 'dateless-revival' },
  },
  collectedBeforePreviews: {
    call: (d, classA) => ac.shouldAutoClearCollectedBeforePreviews(d, { hasUsableDate: true, show: null, classA }),
    data: { wrongProduction: true, wrongProductionReason: 'collected-before-previews', allowEarlyDate: true },
  },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`${name}: clears without class-A, refuses with class-A (veto)`, () => {
    assert.equal(c.call({ ...c.data }, false), true, `${name} fixture must clear on its own or the veto test proves nothing`);
    assert.equal(c.call({ ...c.data }, undefined), true, 'omitted ctx keeps old behaviour');
    assert.equal(c.call({ ...c.data }, true), false, `${name} must not strip a class-A leak`);
  });
}

test('real veto output drives every predicate on the BRO-8229 leak file', () => {
  const show = by['a-christmas-carol-west-end-2026'];
  for (const [name, c] of Object.entries(CASES)) {
    const d = { ...c.data, publishDate: '2025-11-26' };
    assert.equal(c.call(d, veto(d, show)), false, name);
  }
});

test('CV self-heal: stale CV-promoted flag would clear; rebuild gates it behind the veto', () => {
  const d = { wrongProduction: true, wrongProductionReason: 'CV-promoted: x', publishDate: '2025-11-26',
    contentVerification: { wrongProduction: false, confidence: 'high' }, llmScore: { score: 70, confidence: 'high' } };
  assert.equal(isStaleCvPromotedWrongProduction(d, false), true, 'predicate alone clears (documents why the gate is in rebuild)');
  assert.equal(veto(d, by['a-christmas-carol-west-end-2026']), true);
  assert.match(rebuildSrc, /isStaleCvPromotedWrongProduction\(data, cvIsStale\) && !isClassAContaminated\(/);
  assert.match(rebuildSrc, /if \(wpHealKind && !isClassAContaminated\(/);
});

test('wiring: every rebuild + scoring-delta call of a vetoable clearer passes classA', () => {
  const names = ['shouldAutoClearWrongProductionUrlYear', 'shouldAutoClearWrongProductionUkDualMarket',
    'shouldAutoClearStaleLondonOutletCrossMarket', 'shouldAutoClearDatelessRevival', 'shouldAutoClearCollectedBeforePreviews'];
  for (const [file, src] of [['rebuild-all-reviews.js', rebuildSrc], ['scoring-delta.js', deltaSrc]]) {
    for (const n of names) {
      const re = new RegExp(`${n}\\(`, 'g');
      let m;
      while ((m = re.exec(src))) {
        const head = src.slice(m.index - 20, m.index);
        if (/function\s*$|\.\s*$|typeof\s/.test(head) && !/autoClear\.\s*$/.test(head)) continue;
        let depth = 0, i = m.index + n.length;
        for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
        assert.match(src.slice(m.index, i), /classA/, `${file}: ${n} call at offset ${m.index} lacks classA`);
      }
    }
  }
});

test('scoring-delta guard identity hashes the class-A classifier, not just the auto-clear', () => {
  for (const f of ['makeClassAVeto', 'classifyClassAContamination', 'classAApplies', 'buildSiblingOpeningsMap']) {
    assert.match(deltaSrc, new RegExp(`__classALib\\?\\.${f}\\?\\.toString`), f);
  }
});
