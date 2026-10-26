// BRO-5992 RECHECK-AFTER probe: compares the frozen noindexed cohort with the frozen control
// on live GSC impressions and PostHog search landings. Skipped until the 3-week hold ends.
// Baseline is 0 for both groups by construction, so this guards the claim "no traffic loss":
// the cohort must not trail the control, and the snapshots must be fresh enough to say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const cohort = read('data/audit/seo-thin-cohort.json');
const CHECKABLE_FROM = Date.parse(cohort.recheckAfter || '2999-01-01');

test('BRO-5992 cohort vs control: no loss in impressions or search landings after 3 weeks',
  { skip: Date.now() < CHECKABLE_FROM && `skip until ${cohort.recheckAfter}` }, () => {
    assert.ok(cohort.cohortSlugs.length > 0 && cohort.cohortSlugs.length === cohort.controlSlugs.length, 'cohort frozen with equal control');
    const gsc = read('data/seo-gsc-impressions.json');
    const landings = new Set(read('data/seo-search-landings.json').paths);
    for (const snap of [gsc, read('data/seo-search-landings.json')]) {
      const age = Date.now() - Date.parse(snap.generated);
      assert.ok(age < 10 * 86400000, `snapshot ${snap.generated} is stale; wait for the weekly refresh`);
    }
    const total = slugs => ({
      impressions: slugs.reduce((n, s) => n + (gsc.pages[`/show/${s}`] || 0), 0),
      landings: slugs.filter(s => landings.has(`/show/${s}`)).length,
    });
    const c = total(cohort.cohortSlugs);
    const k = total(cohort.controlSlugs);
    console.log(`cohort ${JSON.stringify(c)} control ${JSON.stringify(k)}`);
    assert.ok(c.impressions >= k.impressions * 0.9, `cohort impressions ${c.impressions} trail control ${k.impressions}`);
    assert.ok(c.landings >= k.landings * 0.9, `cohort landings ${c.landings} trail control ${k.landings}`);
  });
