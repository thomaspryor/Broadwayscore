/**
 * How good is the "expect about N" number? (BRO-7376, round 3)
 *
 * For each of the last 40 Broadway openings, rebuild what the status would have
 * said using only the 10 openings BEFORE it (src/lib/review-arrival.ts), and
 * compare with the morning-after count (reviews in by 9am ET). Publish dates in
 * reviews.json are date-only, so that count is a calibrated proxy (MORNING_SHARE).
 * Also scores the old rule (median of the last 10 openings' 3-day totals) so the
 * two can be compared.
 *
 *   npx tsx scripts/review-arrival-accuracy.ts [--json] [--asof=YYYY-MM-DD]
 */
import fs from 'node:fs';
import path from 'node:path';
import { expectedForShow, morningCount, type HistoryShow } from '../src/lib/review-arrival';

const root = path.join(__dirname, '..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const asofArg = process.argv.find((a) => a.startsWith('--asof='));
const ASOF = asofArg ? Date.parse(asofArg.split('=')[1]) : Date.now();
const json = process.argv.includes('--json');
const N = 40;

const showsRaw = read('data/shows.json');
const shows: any[] = showsRaw.shows || showsRaw;
const revRaw = read('data/reviews.json');
const reviews: any[] = revRaw.reviews || revRaw;
const byShow = new Map<string, any[]>();
for (const r of reviews) {
  if (r.wrongProduction || r.wrongShow || r.isRoundupArticle) continue;
  (byShow.get(r.showId) || byShow.set(r.showId, []).get(r.showId)!).push(r);
}
const dates = (id: string) => (byShow.get(id) || []).map((r) => r.publishDate);
const DAY = 86400000;
const within3d = (id: string, open: string) => dates(id).filter((d) => d && Date.parse(String(d).slice(0, 10)) - Date.parse(open) <= 3 * DAY && Date.parse(String(d).slice(0, 10)) >= Date.parse(open)).length;

const history: HistoryShow[] = shows
  // Intentionally NOT isBroadwayCategory: the status backtest only counts shows explicitly marked broadway, same as src/lib/data-review-arrival.ts (null-category history shows have no press-night timing).
  .filter((s) => s.category === 'broadway' && s.openingDate)
  .map((s) => ({ id: s.id, category: s.category, openingDate: s.openingDate, reviewDates: dates(s.id) }));

const opened = shows
  // Intentionally NOT isBroadwayCategory: the status backtest only counts shows explicitly marked broadway, same as src/lib/data-review-arrival.ts (null-category history shows have no press-night timing).
  .filter((s) => s.category === 'broadway' && s.openingDate && Date.parse(s.openingDate) < ASOF - 5 * DAY && within3d(s.id, s.openingDate) >= 5)
  .sort((a, b) => (a.openingDate < b.openingDate ? 1 : -1))
  .slice(0, N);

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r5 = (x: number) => Math.round(x / 5) * 5;
const rows = opened.map((s) => {
  const actual = morningCount(dates(s.id), s.openingDate);
  const total72 = within3d(s.id, s.openingDate);
  const prior = history.filter((h) => h.id !== s.id && Date.parse(h.openingDate!) < Date.parse(s.openingDate) && h.reviewDates.length > 0)
    .sort((a, b) => (a.openingDate! < b.openingDate! ? 1 : -1)).slice(0, 10);
  const ex = expectedForShow(s, history);
  const conservative = ex?.expected ?? null;
  const high = ex?.expectedHigh ?? null;
  const oldRule = prior.length ? Math.max(5, r5(median(prior.map((h) => within3d(h.id, h.openingDate!))))) : null;
  return { id: s.id, opened: s.openingDate, morning: actual, total72, conservative, high, oldRule };
});
const score = (key: 'conservative' | 'oldRule') => {
  const r = rows.filter((x) => x[key] != null);
  const miss = r.map((x) => Math.abs((x[key] as number) - x.morning));
  return {
    n: r.length,
    meanMiss: +(miss.reduce((a, b) => a + b, 0) / Math.max(1, r.length)).toFixed(1),
    fellShort: r.filter((x) => x.morning < (x[key] as number)).length,
    shortBy3Plus: r.filter((x) => x.morning < (x[key] as number) - 2).length,
    typicalEstimate: median(r.map((x) => x[key] as number)),
  };
};
const ranged = rows.filter((r) => r.conservative != null && r.high != null);
const rangeScore = {
  n: ranged.length,
  inside: ranged.filter((r) => r.morning >= r.conservative! && r.morning <= r.high!).length,
  below: ranged.filter((r) => r.morning < r.conservative!).length,
  above: ranged.filter((r) => r.morning > r.high!).length,
  medianWidth: median(ranged.map((r) => r.high! - r.conservative!)),
};
const summary = {
  range: rangeScore,
  openings: rows.length,
  medianMorningCount: median(rows.map((r) => r.morning)),
  median72hTotal: median(rows.map((r) => r.total72)),
  medianMorningShareOf72h: +median(rows.map((r) => r.morning / r.total72)).toFixed(2),
  conservative: score('conservative'),
  oldMedianRule: score('oldRule'),
};
if (json) { console.log(JSON.stringify({ rows, summary }, null, 1)); process.exit(0); }
console.log('opened      show                                              morning  72h  conservative  oldRule');
for (const r of rows) console.log(`${r.opened}  ${r.id.padEnd(48)} ${String(r.morning).padStart(6)} ${String(r.total72).padStart(4)} ${String(r.conservative).padStart(8)} ${String(r.oldRule).padStart(9)}`);
console.log(JSON.stringify(summary, null, 1));
