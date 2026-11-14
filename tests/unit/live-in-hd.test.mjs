// LIVE-DATA-LANE: reads data/grosses.json (untracked core data); data/grosses-history.json (untracked core data); data/audience-buzz.json (untracked core data); +9 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6769: Live in HD wording helpers and expiry. Real src/lib/met-live-in-hd.ts is exercised via tsx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = code => execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname }).trim();

test('liveInHd line, description and expiry', () => {
  const out = JSON.parse(run(`
    import('./src/lib/met-live-in-hd.ts').then(m => {
      const h = { date: '2026-10-03', encoreDate: '2026-10-14', sourceUrl: 'https://www.metopera.org/x' };
      console.log(JSON.stringify({
        line: m.liveInHdLine(h, '2026-09-01'),
        desc: m.liveInHdDescription(h, '2026-09-01'),
        afterLive: m.liveInHdLine(h, '2026-10-10'),
        afterEncore: m.liveInHdLine(h, '2026-10-15'),
        none: m.liveInHdLine(null),
      }));
    });`));
  assert.equal(out.line, 'In cinemas Oct 3, 2026 (encore Oct 14, 2026)');
  assert.equal(out.desc, 'Met Live in HD cinema broadcast: Oct 3, 2026.');
  assert.equal(out.afterLive, 'In cinemas: encore Oct 14, 2026');
  assert.equal(out.afterEncore, null);
  assert.equal(out.none, null);
});

test('after the live date only the pending encore is advertised, including in metadata', () => {
  const out = JSON.parse(run(`
    const m = require('./src/lib/met-live-in-hd.ts');
    const h = { date: '2026-10-03', encoreDate: '2026-10-14', sourceUrl: 'https://www.metopera.org/x' };
    console.log(JSON.stringify({
      onLive: m.liveInHdLine(h, h.date),
      encore: m.liveInHdLine(h, '2026-10-04'),
      onEncore: m.liveInHdLine(h, h.encoreDate),
      encoreDescription: m.liveInHdDescription(h, '2026-10-04'),
      withoutEncore: m.liveInHdLine({ ...h, encoreDate: null }, '2026-10-04'),
      singleDay: m.liveInHdLine({ ...h, encoreDate: null }, h.date),
      expired: m.liveInHdDescription(h, '2026-10-15'),
    }));
  `));
  assert.equal(out.onLive, 'In cinemas Oct 3, 2026 (encore Oct 14, 2026)');
  assert.equal(out.encore, 'In cinemas: encore Oct 14, 2026');
  assert.equal(out.onEncore, out.encore);
  assert.equal(out.encoreDescription, 'Met Live in HD encore: Oct 14, 2026.');
  assert.equal(out.withoutEncore, null);
  assert.equal(out.singleDay, 'In cinemas Oct 3, 2026');
  assert.equal(out.expired, null);
});

test('the final page metadata preserves the HD date for all seven title lengths and Figaro', () => {
  const { rows, encore, expired, nonOpera } = JSON.parse(run(`
    const Module = require('node:module');
    let show;
    const originalLoad = Module._load;
    Module._load = function(id, ...args) {
      if (id === '@/lib/data-core') return { getShowBySlug: () => show, getSharedTitleYear: () => null };
      // These optional generated datasets are not used by generateMetadata.
      if (/data\\/(cast-manifest|actor-slugs|video-reviews)\\.json$/.test(id)) return {};
      return originalLoad.call(this, id, ...args);
    };
    const { generateMetadata } = require('./src/app/show/[slug]/page.tsx');
    const titles = ['La Fanciulla del West', 'Manon', 'Otello', 'Parsifal', 'Samson et Dalila', 'Silent Night', 'Tosca', 'Le nozze di Figaro'];
    (async () => {
      const rows = [];
      for (const title of titles) {
        for (const score of [null, 95, 85, 65, 55, 35]) {
          for (const synopsis of ['', 'A long synopsis that continues beyond the description limit. '.repeat(5)]) {
            show = { id: 'opera-2099', slug: 'opera-2099', title, type: 'opera', category: 'off-broadway',
              status: score ? 'open' : 'upcoming', venue: 'Metropolitan Opera House', synopsis,
              criticScore: { score, reviewCount: score ? 12 : 0, tier1Count: 4, tier2Count: 4, reviews: [] },
              liveInHd: { date: '2099-01-23', sourceUrl: 'https://www.metopera.org/season/in-cinemas/' } };
            const m = await generateMetadata({ params: Promise.resolve({ slug: show.slug }) });
            rows.push({ title, score, hasSynopsis: !!synopsis, description: m.description });
          }
        }
      }
      show.liveInHd.date = '1900-01-01';
      show.liveInHd.encoreDate = '2099-02-03';
      const encore = await generateMetadata({ params: Promise.resolve({ slug: show.slug }) });
      show.liveInHd.encoreDate = '1900-01-02';
      const expired = await generateMetadata({ params: Promise.resolve({ slug: show.slug }) });
      show.liveInHd.date = '2099-01-23';
      show.liveInHd.encoreDate = null;
      show.type = 'play';
      const nonOpera = await generateMetadata({ params: Promise.resolve({ slug: show.slug }) });
      console.log(JSON.stringify({ rows, encore, expired, nonOpera }));
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `));
  assert.match(encore.description, /Met Live in HD encore: Feb 3, 2099\./);
  assert.match(encore.title.absolute, /Met Live in HD/);
  for (const metadata of [expired, nonOpera]) {
    assert.doesNotMatch(metadata.description, /Met Live in HD/);
    assert.doesNotMatch(metadata.title.absolute, /Met Live in HD/);
  }
  assert.equal(rows.length, 96);
  for (const row of rows) {
    assert.ok(row.description.includes('Jan 23, 2099'), JSON.stringify(row));
    assert.ok(row.description.length <= 160, JSON.stringify(row));
  }
});

test('the actual hero hydrates cached server wording across live and encore expiry', () => {
  const out = JSON.parse(run(`
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const React = require('react');
    const { renderToString } = require('react-dom/server');
    const { hydrateRoot } = require('react-dom/client');
    const { JSDOM } = require('jsdom');
    const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime');
    const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
    const Hero = require('./src/components/show-page/ShowHeroRedesign.tsx').default;
    const { AuthProvider } = require('./src/contexts/AuthContext.tsx');
    const { liveInHdLine } = require('./src/lib/met-live-in-hd.ts');
    const NativeDate = Date;
    let day;
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [day + 'T12:00:00Z'])); }
      static now() { return new NativeDate(day + 'T12:00:00Z').getTime(); }
    };
    const h = { date: '2026-10-03', encoreDate: '2026-10-14', sourceUrl: 'https://www.metopera.org/season/in-cinemas/' };
    const show = { id: 'opera-2026', slug: 'opera-2026', title: 'Cosi fan tutte', category: 'off-broadway',
      type: 'opera', status: 'upcoming', venue: 'Metropolitan Opera House', images: {}, liveInHd: h };
    (async () => {
      const results = [];
      for (const [serverDay, clientDay] of [['2026-10-03', '2026-10-04'], ['2026-10-14', '2026-10-15'], ['2026-10-15', '2026-10-01']]) {
        day = serverDay;
        const liveInHdText = liveInHdLine(h, serverDay);
        const element = React.createElement(AppRouterContext.Provider, { value: router },
          React.createElement(AuthProvider, null, React.createElement(Hero, {
          show, liveInHdText, consensusText: null, audienceGrade: null, audienceCount: 0,
          hasAudience: false, hasEnoughCriticReviews: false, sortedTicketLinks: [], lotteryRush: null,
          isWestEnd: false, isOffBroadway: true, ranks: null,
        })));
        const html = renderToString(element);
        const dom = new JSDOM('<div id="root">' + html + '</div>', { url: 'https://example.org/show/opera-2026', pretendToBeVisual: true });
        for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
          navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement,
          CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
          requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
          cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })) {
          Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        }
        dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        day = clientDay;
        const errors = [];
        let root;
        await React.act(async () => {
          root = hydrateRoot(document.getElementById('root'), element, { onRecoverableError: e => errors.push(e.message) });
        });
        results.push({ serverDay, clientDay, expected: liveInHdText,
          actual: document.querySelector('[data-testid="live-in-hd"] a')?.textContent ?? null, errors });
        await React.act(async () => root.unmount());
        dom.window.close();
        for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) delete globalThis[key];
      }
      globalThis.Date = NativeDate;
      console.log(JSON.stringify(results));
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `));
  assert.equal(out.length, 3);
  for (const row of out) {
    assert.equal(row.actual, row.expected, JSON.stringify(row));
    assert.deepEqual(row.errors, [], JSON.stringify(row));
  }
});


test('metadata and both hero layouts use the same cached server snapshot', () => {
  const page = readFileSync(new URL('../../src/app/show/[slug]/page.tsx', import.meta.url), 'utf8');
  const hero = readFileSync(new URL('../../src/components/show-page/ShowHeroRedesign.tsx', import.meta.url), 'utf8');
  assert.match(page, /const getLiveInHdForRender = cache\(/);
  assert.equal(page.match(/const hd = getLiveInHdForRender\(params.slug\);/g)?.length, 2);
  assert.match(page, /absolute: hd\.line/);
  assert.match(page, /liveInHdText=\{hd.line\}/);
  assert.match(page, /data-testid="live-in-hd"[^\n]*\{hd.line\}/);
  assert.doesNotMatch(hero, /liveInHdLine|liveInHdIsCurrent/);
});
