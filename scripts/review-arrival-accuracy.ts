/**
 * How good is the "about N reviews expected" number? (BRO-7376)
 *
 * For each of the last 10 Broadway openings, rebuild what the status would have
 * said with only the openings BEFORE it as history (src/lib/review-arrival.ts),
 * and compare with the reviews actually on file within the arrival window.
 * Also prints the regular-outlet hit rate and how much of the opening wave had
 * landed by each day after press night (reviews.json publish dates).
 *
 *   npx tsx scripts/review-arrival-accuracy.ts [--json] [--asof=YYYY-MM-DD]
 */
import fs from 'node:fs';
import path from 'node:path';
import { expectedForShow, windowCount, arrivalWindowEndMs, type HistoryShow } from '../src/lib/review-arrival';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { standingOutletIds } = require('./lib/standing-outlets');

const root = path.join(__dirname, '..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const asofArg = process.argv.find((a) => a.startsWith('--asof='));
const ASOF = asofArg ? Date.parse(asofArg.split('=')[1]) : Date.now();
const json = process.argv.includes('--json');

const showsRaw = read('data/shows.json');
const shows: any[] = showsRaw.shows || showsRaw;
const revRaw = read('data/reviews.json');
const reviews: any[] = revRaw.reviews || revRaw;
const registry = read('data/outlet-registry.json').outlets;
const regular = new Set<string>(standingOutletIds(registry, 'broadway'));

const byShow = new Map<string, any[]>();
for (const r of reviews) (byShow.get(r.showId) || byShow.set(r.showId, []).get(r.showId)!).push(r);

const history: HistoryShow[] = shows
  .filter((s) => s.category === 'broadway' && s.openingDate)
  .map((s) => ({ id: s.id, category: s.category, openingDate: s.openingDate, reviewDates: (byShow.get(s.id) || []).map((r) => r.publishDate) }));

const opened = shows
  .filter((s) => s.category === 'broadway' && s.openingDate && Date.parse(s.openingDate) < ASOF && (byShow.get(s.id) || []).length > 0)
  .sort((a, b) => (a.openingDate < b.openingDate ? 1 : -1))
  .slice(0, 10);

const DAY = 86400000;
const rows = opened.map((s) => {
  const rs = byShow.get(s.id) || [];
  const dates = rs.map((r) => r.publishDate);
  const actual = windowCount(dates, s.openingDate);
  const exp = expectedForShow(s, history);
  const outs = new Set(rs.map((r) => String(r.outletId)));
  const regIn = [...regular].filter((id) => outs.has(id)).length;
  const end = arrivalWindowEndMs(s.openingDate)!;
  return {
    id: s.id, opened: s.openingDate, type: s.type, onFile: rs.length, actual,
    expected: exp?.expected ?? null, range: exp ? [exp.low, exp.high] : null,
    error: exp ? exp.expected - actual : null,
    inRange: exp ? actual >= exp.low && actual <= exp.high : null,
    regularIn: regIn, regularTotal: regular.size,
    windowStillOpen: ASOF < end,
  };
});
const scored = rows.filter((r) => r.error != null);
const abs = scored.map((r) => Math.abs(r.error as number));
const summary = {
  openings: rows.length,
  meanAbsError: +(abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length)).toFixed(1),
  within5: scored.filter((r) => Math.abs(r.error as number) <= 5).length,
  within20pct: scored.filter((r) => Math.abs(r.error as number) <= 0.2 * r.actual).length,
  inQuartileRange: scored.filter((r) => r.inRange).length,
  overCount: scored.filter((r) => (r.error as number) > 5).length,
  underCount: scored.filter((r) => (r.error as number) < -5).length,
  regularHits: rows.map((r) => r.regularIn),
};
// Share of each opening's on-file reviews by publish day after press night.
const dayShare: Record<string, number> = {};
let total = 0;
for (const s of opened) for (const r of byShow.get(s.id) || []) {
  if (!r.publishDate) continue;
  const off = Math.round((Date.parse(String(r.publishDate).slice(0, 10)) - Date.parse(s.openingDate)) / DAY);
  const k = off <= 0 ? 'day0' : off <= 1 ? 'day1' : off <= 3 ? 'day2-3' : 'later';
  dayShare[k] = (dayShare[k] || 0) + 1; total++;
}
const shares = Object.fromEntries(Object.entries(dayShare).map(([k, v]) => [k, +(v / total * 100).toFixed(0)]));
if (json) { console.log(JSON.stringify({ rows, summary, shares }, null, 1)); process.exit(0); }
console.log('opened      show                                              onFile window expected(range)  err  regular/14  open?');
for (const r of rows) console.log(`${r.opened}  ${r.id.padEnd(48)} ${String(r.onFile).padStart(5)} ${String(r.actual).padStart(6)} ${String(r.expected).padStart(8)} (${r.range?.join('-')})`.padEnd(100) + ` ${String(r.error).padStart(4)}  ${r.regularIn}/${r.regularTotal}  ${r.windowStillOpen ? 'window still open' : ''}`);
console.log(JSON.stringify(summary));
console.log('share of dated reviews by publish day after press night (%):', JSON.stringify(shares));
