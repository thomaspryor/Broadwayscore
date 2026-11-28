const fs = require('fs');
const path = require('path');
const S = process.argv[2];
if (!S) throw new Error('usage: gen-batches.js <work-dir>');
const DATA = path.join(__dirname, '../../data');
const rows = fs.readFileSync(S + '/gaps-all2.txt', 'utf8').trim().split('\n').slice(2).map((l) => { const [season, slug, status, desig, gaps] = l.split(' | '); return { season, slug, status, desig, gaps: gaps.split(',') }; });
const shows = Object.values(require(DATA + '/shows.json').shows);
const comm = require(DATA + '/commercial.json').shows;
const by = new Map(shows.map((s) => [s.slug, s]));
const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmt = (d) => { if (!d) return null; const [y, m, dd] = d.split('-').map(Number); return `${M[m - 1]} ${dd}, ${y}`; };
const venue = (s) => (typeof s.venue === 'string' ? s.venue : (s.venue && s.venue.name) || s.theater || '');
const money = (n) => (n >= 1e6 && n % 1e5 === 0 ? `$${n / 1e6} million` : `$${n.toLocaleString('en-US')}`);
function entry(r, nonprofit) {
  const s = by.get(r.slug) || {}; const c = comm[r.slug] || {};
  const dates = [s.previewsStartDate && `previews ${fmt(s.previewsStartDate)}`, s.openingDate && `opened ${fmt(s.openingDate)}`, s.closingDate ? `closed ${fmt(s.closingDate)}` : 'still running'].filter(Boolean).join('; ');
  const where = nonprofit && c.nonprofitOrg ? `${c.nonprofitOrg} at the ${venue(s)}` : venue(s);
  if (nonprofit) return [s.title || r.slug, where, dates, null];
  const need = []; let known = null;
  if (r.gaps.includes('cap')) need.push('capitalization');
  if (r.gaps.includes('cap-uncited')) { need.push('capitalization'); known = `We have ${money(c.capitalization)} for capitalization with no source: confirm it or correct it.`; }
  if (r.gaps.includes('cost')) need.push('weekly running cost');
  if (r.gaps.includes('outcome')) need.push('outcome for investors');
  if (!r.gaps.includes('cap') && !r.gaps.includes('cap-uncited') && c.capitalization) known = (known ? known + ' ' : '') + `We have a capitalization of ${money(c.capitalization)}.`;
  return [s.title || r.slug, where, dates, need, known];
}
const SKIP = new Set(['the-lion-king','aladdin','book-of-mormon','hadestown','and-juliet']);
const yr = (r) => parseInt(r.season.slice(0, 4), 10);
const isSeason = (r) => /^\d{4}-\d{4}$/.test(r.season);
const np = rows.filter((r) => isSeason(r) && r.gaps.includes('nonprofit-check'));
const cm = rows.filter((r) => isSeason(r) && !SKIP.has(r.slug) && !r.gaps.includes('nonprofit-check') && r.gaps.some((g) => g !== 'nonprofit-check'));
const groups = [
  { id: 'p5', group: 'first', kind: 'commercial', title: '2024-25 season: budgets, costs and results', why: 'Last season: budgets the SEC filings did not cover, weekly costs, and closed shows that never said whether investors got paid back.', pick: (r) => yr(r) === 2024 },
  { id: 'p5b', group: 'first', kind: 'commercial', title: '2025-26 season and later: budgets, costs and results', why: 'This season and the next: the same gaps, for the shows a reporter will look at first.', pick: (r) => yr(r) >= 2025 },
  { id: 'p6', group: 'first', kind: 'commercial', title: '2023-24 season: budgets, costs and results', why: 'Two seasons back: the same three gaps.', pick: (r) => yr(r) === 2023 },
  { id: 'p4', group: 'first', kind: 'nonprofit', title: 'Nonprofit shows, 2023-24 and 2024-25', why: 'Which of these nonprofit productions had commercial investors or switched to a commercial run.', pick: (r) => yr(r) === 2023 || yr(r) === 2024 },
  { id: 'p4b', group: 'first', kind: 'nonprofit', title: 'Nonprofit shows, 2025-26 and later', why: 'Which of the current nonprofit productions had commercial investors or switched to a commercial run.', pick: (r) => yr(r) >= 2025 },
  { id: 'p7', group: 'later', kind: 'commercial', title: '2022-23 season: budgets, costs and results', why: 'Shows from three seasons back whose budgets, weekly costs or final results we are missing.', pick: (r) => yr(r) === 2022 },
  { id: 'p8', group: 'later', kind: 'commercial', title: '2021-22 season: budgets, costs and results', why: 'The first season back after the shutdown.', pick: (r) => yr(r) === 2021 },
  { id: 'p9', group: 'later', kind: 'commercial', title: '2017-18 to 2019-20: budgets and costs', why: 'The three seasons before the shutdown.', pick: (r) => yr(r) >= 2017 && yr(r) <= 2019 },
  { id: 'p10', group: 'later', kind: 'commercial', title: '2013-14 to 2016-17: budgets and costs', why: 'Shows from the seasons before 2017.', pick: (r) => yr(r) >= 2013 && yr(r) <= 2016 },
  { id: 'p10b', group: 'later', kind: 'commercial', title: '2012-13 and earlier: budgets and costs', why: 'The oldest shows in the tracker.', pick: (r) => yr(r) <= 2012 },
  { id: 'p11', group: 'later', kind: 'nonprofit', title: 'Nonprofit shows, 2021-22 and 2022-23', why: 'Which earlier nonprofit productions had commercial investors or switched to a commercial run.', pick: (r) => yr(r) === 2021 || yr(r) === 2022 },
  { id: 'p12', group: 'later', kind: 'nonprofit', title: 'Nonprofit shows, 2018-19 and 2019-20', why: 'Nonprofit productions from the two seasons before the shutdown.', pick: (r) => yr(r) >= 2018 && yr(r) <= 2020 },
  { id: 'p12b', group: 'later', kind: 'nonprofit', title: 'Nonprofit shows, 2014-15 to 2017-18', why: 'The oldest nonprofit productions in the tracker.', pick: (r) => yr(r) <= 2017 },
];
const seen = new Set();
const out = groups.map((g) => {
  const src = g.kind === 'nonprofit' ? np : cm;
  const list = src.filter(g.pick).filter((r) => !seen.has(g.kind + r.slug)).map((r) => { seen.add(g.kind + r.slug); return entry(r, g.kind === 'nonprofit'); })
    .sort((a, b) => a[0].localeCompare(b[0]));
  return { id: g.id, group: g.group, kind: g.kind, title: g.title, why: g.why, shows: list };
}).filter((g) => g.shows.length);
for (const g of out) console.error(g.id, g.kind, g.shows.length);
const all = [...np, ...cm].length, used = seen.size;
console.error('rows', all, 'placed', used);
if (used < all) throw new Error(`gen-batches: ${all - used} gap rows fit no prompt group (add or widen a group)`);
console.log(JSON.stringify(out));
