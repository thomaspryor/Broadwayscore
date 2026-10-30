/**
 * Builds the data the app's quiz onboarding ships/fetches (BRO-6579):
 *   public/data/onboarding-cities.json  city picker (nyc, london, UK regional, touring)
 *   public/data/onboarding-hits.json    per city: the longest-running titles of the last 10 years
 *
 * Every row derives from mobile-shows.json / uk-regional-venues.json / tour data; nothing is typed in.
 * Run: npx tsx scripts/generate-onboarding-data.ts
 */
import fs from 'fs';
import path from 'path';
import { getTourCities } from '../src/lib/data-tour-cities';

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const YEARS = 10;
const TOP = 16;
const DAY = 86400000;

type Show = {
  id: string; t: string; ty?: string; st: string; cat?: string; od?: string; cd?: string;
  cs?: number; img?: { po?: string; th?: string };
};
const shows: Show[] = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'mobile-shows.json'), 'utf8')).shows;
const today = new Date();
const windowStart = new Date(today.getTime() - YEARS * 365.25 * DAY);

const norm = (t: string) => t.toLowerCase().replace(/[:\-–]\s*(both|one|two)\s+parts?$/, '').replace(/\s+(both|one|two)\s+parts?$/, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
// Broadway was dark 2020-03-12 to 2021-09-14: those days are not days played.
const DARK_START = new Date('2020-03-12').getTime();
const DARK_END = new Date('2021-09-14').getTime();
const daysInWindow = (s: Show) => {
  if (!s.od) return 0;
  const start = Math.max(new Date(s.od).getTime(), windowStart.getTime());
  const end = Math.min(s.cd ? new Date(s.cd).getTime() : today.getTime(), today.getTime());
  if (end <= start) return 0;
  let ms = end - start;
  if (s.cat === undefined || s.cat === 'broadway') {
    ms -= Math.max(0, Math.min(end, DARK_END) - Math.max(start, DARK_START));
  }
  return Math.max(0, Math.round(ms / DAY));
};

function hitsFor(match: (s: Show) => boolean) {
  const byTitle = new Map<string, Show[]>();
  for (const s of shows) {
    if (!match(s) || !s.od) continue;
    const k = norm(s.t);
    byTitle.set(k, [...(byTitle.get(k) || []), s]);
  }
  const rows = [...byTitle.values()].map(prods => {
    const days = prods.reduce((n, p) => n + daysInWindow(p), 0);
    // Newest production with art is the current one; poster comes from any production that has it.
    const lead = [...prods].sort((a, b) => daysInWindow(b) - daysInWindow(a))[0];
    const art = [...prods].sort((a, b) => (a.od! < b.od! ? 1 : -1)).find(p => p.img?.po || p.img?.th);
    if (!art) return null;
    return {
      title: lead.t,
      showId: lead.id,
      poster: art.img!.po || art.img!.th,
      days,
      score: lead.cs ?? null,
      productions: prods
        .filter(p => daysInWindow(p) > 0)
        .sort((a, b) => (a.od! < b.od! ? -1 : 1))
        .map(p => ({ showId: p.id, opened: p.od, closed: p.cd ?? null })),
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null);
  return rows.filter(r => r.days > 0).sort((a, b) => b.days - a.days || (b.score ?? 0) - (a.score ?? 0)).slice(0, TOP);
}

const ukRegional: { match: string; city: string }[] = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'uk-regional-venues.json'), 'utf8'),
);

const cities: any[] = [
  { id: 'nyc', name: 'New York', kind: 'home', market: 'nyc' },
  { id: 'london', name: 'London', kind: 'home', market: 'london' },
];
const hits: Record<string, any[]> = {
  nyc: hitsFor(s => s.cat === undefined || s.cat === 'broadway'),
  london: hitsFor(s => s.cat === 'west-end'),
};

const seenUk = new Set<string>();
for (const v of ukRegional) {
  if (seenUk.has(v.city)) continue;
  seenUk.add(v.city);
  cities.push({ id: `uk-${norm(v.city).replace(/ /g, '-')}`, name: v.city, kind: 'uk-regional', market: 'london' });
}
for (const c of getTourCities().values()) {
  cities.push({
    id: `tour-${c.slug}`, name: c.city, kind: 'tour', market: 'nyc',
    tag: /^Chicago\b/.test(c.city) ? 'Local shows + tours' : 'Touring city',
  });
}

// Chicago is a first-class app market (local shows + tours), not just a tour stop.
if (!cities.some(c => /^Chicago\b/.test(c.name))) {
  cities.push({ id: 'chicago', name: 'Chicago', kind: 'tour', market: 'chicago', tag: 'Local shows + tours' });
}

const stamp = today.toISOString().slice(0, 10);
fs.writeFileSync(path.join(OUT_DIR, 'onboarding-cities.json'), JSON.stringify({ generated: stamp, cities }) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'onboarding-hits.json'), JSON.stringify({ generated: stamp, windowYears: YEARS, hits }) + '\n');
for (const [k, v] of Object.entries(hits)) console.log(k, v.length, v.slice(0, 5).map(h => `${h.title}(${h.days}d)`).join(', '));
console.log('cities', cities.length);
