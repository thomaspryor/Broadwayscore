// BRO-77: the hover rate stars must not offer a rating on a show nobody could
// have seen yet (announced, or upcoming before its first preview).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { couldHaveSeenShow } from '../../src/lib/show-rateability.ts';

const TODAY = '2026-10-13';

describe('couldHaveSeenShow', () => {
  test('open, previews and closed shows are rateable', () => {
    for (const status of ['open', 'previews', 'closed']) {
      assert.equal(couldHaveSeenShow({ status, openingDate: '2027-01-01' }, TODAY), true, status);
    }
  });
  test('announced with no dates is not rateable', () => {
    assert.equal(couldHaveSeenShow({ status: 'announced' }, TODAY), false);
  });
  test('upcoming with a future first preview is not rateable', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', previewsStartDate: '2026-11-02', openingDate: '2026-12-01' }, TODAY), false);
  });
  test('upcoming whose first preview is tonight is rateable (status lag)', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', previewsStartDate: TODAY }, TODAY), true);
  });
  test('upcoming with a past opening date and no preview date is rateable', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', previewsStartDate: null, openingDate: '2026-10-01' }, TODAY), true);
  });
  test('a full ISO timestamp is compared by its date part', () => {
    assert.equal(couldHaveSeenShow({ status: 'announced', openingDate: '2026-12-01T19:00:00Z' }, TODAY), false);
  });
  test('garbage date on a not-yet-open show stays hidden', () => {
    assert.equal(couldHaveSeenShow({ status: 'upcoming', openingDate: 'TBA' }, TODAY), false);
  });
  test('unknown or missing status falls open', () => {
    assert.equal(couldHaveSeenShow({ status: undefined }, TODAY), true);
    assert.equal(couldHaveSeenShow(null, TODAY), true);
  });
});

// Every call site must hand the component the show, so the gate can run.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

test('every <HoverRateStars> usage passes a show prop', () => {
  const offenders = [];
  let uses = 0;
  for (const file of walk('src')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<HoverRateStars\b([^>]*)\/?>/g)) {
      uses++;
      if (!/\bshow=\{/.test(m[1])) offenders.push(file);
    }
  }
  assert.ok(uses >= 4, `expected the browse + show-page call sites, found ${uses}`);
  assert.deepEqual(offenders, []);
});

test('rate controls decide after mount through one hook, never during render (hydration)', () => {
  // Deciding during render made cached server HTML (UTC clock, 24h ISR on
  // show pages) and the first client render disagree on preview day.
  const hook = readFileSync('src/hooks/useCouldHaveSeenShow.ts', 'utf8');
  assert.match(hook, /useEffect\(\(\) => \{\s*if \(dateDependent\) setAfterMount\(\{ key, seeable: couldHaveSeenShow\(/);
  // Every rate entry point gates on the hook: poster/card stars, the show-page
  // Rate button and the ?rate=1 deep link (BRO-5261 retro: the button and the
  // deep link still opened the editor for unseeable shows).
  const stars = readFileSync('src/components/user/HoverRateStars.tsx', 'utf8');
  assert.match(stars, /const seeable = useCouldHaveSeenShow\(show\);/);
  assert.match(stars, /if \(!seeable\) return null;/);
  const hero = readFileSync('src/components/show-page/ShowHeroRedesign.tsx', 'utf8');
  assert.match(hero, /const seeable = useCouldHaveSeenShow\(show\);/);
  assert.match(hero, /if \(!autoRate \|\| ratePanelOpen \|\| !showRateButton\) return;/);
  assert.match(hero, /\{showRateButton && \(/);
  for (const src of [stars, hero]) assert.doesNotMatch(src, /couldHaveSeenShow\(/, 'components call the hook, not the clock-reading helper');
});

test('dependsOnDate: only upcoming/announced need the viewer clock', async () => {
  const { dependsOnDate } = await import('../../src/lib/show-rateability.ts');
  assert.equal(dependsOnDate('upcoming'), true);
  assert.equal(dependsOnDate('announced'), true);
  for (const s of ['open', 'previews', 'closed', undefined, null]) assert.equal(dependsOnDate(s), false, String(s));
});

test('show page lottery card does not read the clock during render (hydration)', () => {
  const src = readFileSync('src/components/show-page/ShowPageBelowFold.tsx', 'utf8');
  assert.doesNotMatch(src, /const today = new Date\(\);\s*if \(today < previewsStart\)/);
  assert.match(src, /const previewsStarted = previewsDateDependent \? startedAfterMount : true;/);
  assert.match(src, /hasLocalDateArrived\(show\.previewsStartDate\)/);
  assert.match(src, /lotteryRush && previewsStarted &&/);
});

test('hasLocalDateArrived compares by local calendar date, not UTC midnight', async () => {
  const { hasLocalDateArrived } = await import('../../src/lib/show-rateability.ts');
  assert.equal(hasLocalDateArrived('2026-10-14', '2026-10-13'), false);
  assert.equal(hasLocalDateArrived('2026-10-14', '2026-10-14'), true);
  assert.equal(hasLocalDateArrived('2026-10-01T19:00:00Z', '2026-10-13'), true);
  assert.equal(hasLocalDateArrived(null, '2026-10-13'), true);
  assert.equal(hasLocalDateArrived('TBA', '2026-10-13'), true);
});

test('useCouldHaveSeenShow: server render hides date-dependent shows, fixed statuses decide at once', async () => {
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');
  const { useCouldHaveSeenShow } = await import('../../src/hooks/useCouldHaveSeenShow.ts');
  const Probe = ({ show }) => React.createElement('i', null, String(useCouldHaveSeenShow(show)));
  const html = (show) => renderToString(React.createElement(Probe, { show }));
  // Effects never run on the server, so upcoming/announced render as not seeable
  // whatever their dates; the client decides after mount with the viewer's clock.
  assert.match(html({ status: 'upcoming', previewsStartDate: '2000-01-01' }), />false</);
  assert.match(html({ status: 'announced' }), />false</);
  assert.match(html({ status: 'previews', previewsStartDate: '2099-01-01' }), />true</);
  assert.match(html({ status: 'open' }), />true</);
  assert.match(html(null), />true</);
});
