// Builds the deep-dive research prompts (p13-p16) from live data. Usage:
//   npx tsx gen-deepdives.mts <scratchpad> > deepdives.json
// Each show appears once, in the first prompt that needs it (p16, p13, p14, p15).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getSeasonsWithCommercialData, getShowsBySeasonWithCommercial } from '../../src/lib/data-commercial';

const SP = process.argv[2];
if (!SP) throw new Error('usage: gen-deepdives.mts <work-dir>');
const comm = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/commercial.json'), 'utf8')).shows as Record<string, any>;
const showsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/shows.json'), 'utf8'));
const shows = (showsRaw.shows ? Object.values(showsRaw.shows) : showsRaw) as any[];
const bySlug = new Map(shows.map((s) => [s.slug || s.id, s]));
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d?: string | null) => { if (!d) return null; const [y, m, dd] = d.split('-').map(Number); return dd ? `${M[m - 1]} ${dd}, ${y}` : `${M[m - 1]} ${y}`; };
const venue = (s: any) => (typeof s.venue === 'string' ? s.venue : (s.venue && s.venue.name) || s.theater || '');
const money = (n: number) => (n >= 1e6 && n % 1e5 === 0 ? `$${n / 1e6} million` : `$${n.toLocaleString('en-US')}`);
const dates = (s: any) => [s.previewsStartDate && `previews ${fmt(s.previewsStartDate)}`, s.openingDate && `opened ${fmt(s.openingDate)}`, s.closingDate ? `closed ${fmt(s.closingDate)}` : 'still running'].filter(Boolean).join('; ');
const entry = (slug: string, need: string[], known: string | null) => { const s = bySlug.get(slug) || {}; return [s.title || slug, venue(s), dates(s), need, known]; };

const rows: any[] = []; const seenRow = new Set<string>();
for (const season of getSeasonsWithCommercialData()) for (const r of getShowsBySeasonWithCommercial(season)) if (!seenRow.has(r.slug)) { seenRow.add(r.slug); rows.push({ season, ...r }); }
const commercial = rows.filter((r) => !['Nonprofit', 'Tour Stop'].includes(r.designation) || r.productionType === 'enhancement');
const used = new Set<string>();
const take = (slug: string) => { if (used.has(slug)) return false; used.add(slug); return true; };
// Shows that have not opened yet have no final raise, running cost or outcome to report.
const TODAY = new Date().toISOString().slice(0, 10);
const opened = (slug: string) => { const o = (bySlug.get(slug) || {}).openingDate; return !!o && o <= TODAY; };
const openYear = (slug: string) => Number(String((bySlug.get(slug) || {}).openingDate || '0').slice(0, 4));

// p16: figures we hold without a source we can print, and five newspaper figures we could not open.
const PAYWALLED: Record<string, { need: string; what: string; outlet: string; url: string }> = {
  'mrs-doubtfire-2021': { need: 'capitalization', what: 'a capitalization of $17 million', outlet: 'The New York Times (Jan 2, 2022)', url: 'https://www.nytimes.com/2022/01/02/theater/mrs-doubtfire-broadway.html' },
  'natasha-pierre-and-the-great-comet-of-1812-2016': { need: 'weekly running cost', what: 'weekly running costs of about $700,000', outlet: 'The New York Times (Aug 29, 2017)', url: 'https://www.nytimes.com/2017/08/29/theater/great-comet-broadway-race.html' },
  'on-the-town-2014': { need: 'capitalization', what: 'a capitalization of $8.5 million', outlet: 'The New York Times (Jan 21, 2015)', url: 'https://www.nytimes.com/2015/01/21/theater/on-the-town-producers-keep-faith-in-their-investment.html' },
  'godspell-2011': { need: 'weekly running cost', what: 'weekly running costs of $250,000 to $300,000', outlet: 'The New York Times (Mar 21, 2012)', url: 'https://www.nytimes.com/2012/03/21/theater/godspell-sister-act-and-priscilla-push-through-the-winter.html' },
  'ragtime-2009': { need: 'weekly running cost', what: 'weekly running costs of more than $500,000', outlet: 'The Washington Post (Dec 29, 2009)', url: 'https://www.washingtonpost.com/archive/style/2009/12/29/kennedy-centers-hobbled-ragtime-to-end-broadway-run-this-weekend/330893de-1860-487f-bc35-16470fb1838b/' },
};
const p16: any[] = [];
for (const [slug, p] of Object.entries(PAYWALLED)) {
  if (!comm[slug]) { console.error('p16: no record', slug); continue; }
  if (take(slug)) p16.push(entry(slug, [p.need], `An earlier answer cited ${p.outlet} for ${p.what}: ${p.url}. That page is behind a paywall. Quote the sentence exactly, and link any free-to-read copy: a syndicated reprint, a press release, or another outlet reporting the same figure.`));
}
for (const r of commercial) {
  if (!r.capitalization || !r.capitalizationIsEstimate || !take(r.slug)) continue;
  p16.push(entry(r.slug, ['capitalization'], comm[r.slug]?.isEstimate?.capitalization
    ? `We estimate about ${money(r.capitalization)} for capitalization. Find a reported figure.`
    : `We have ${money(r.capitalization)} for capitalization with no source we can print: confirm it or correct it, with a source.`));
}

// p13: capitalizations that are only a Form D maximum, with under half raised at filing.
// formd-records.tsv (slug, cik, adsh, ...) and sold.tsv (sold.py output) live in the work dir; without them p13/p13b are skipped.
const FD_RECORDS = `${SP}/formd-records.tsv`, FD_SOLD = `${SP}/sold.tsv`;
const haveFd = fs.existsSync(FD_RECORDS) && fs.existsSync(FD_SOLD);
if (!haveFd) console.error('p13: no formd-records.tsv/sold.tsv in the work dir, skipping the Form D prompts');
const fd = new Map(!haveFd ? [] : fs.readFileSync(FD_RECORDS, 'utf8').trim().split('\n').map((l) => { const [slug, cik, adsh] = l.split('\t'); return [slug, { cik, adsh }]; }));
const PRESS = /broadway (?:news|journal)|new york times|\bnyt\b|variety|playbill|deadline|hollywood reporter|broadwayworld|crain|sarasota|bloomberg|wall street journal|forbes/i;
const p13: any[] = []; const p13b: any[] = [];
for (const line of haveFd ? fs.readFileSync(FD_SOLD, 'utf8').trim().split('\n') : []) {
  const [slug, , offering, sold, pct] = line.split('\t');
  const rec = comm[slug]; const f = fd.get(slug);
  if (!rec || !f || pct === 'None' || Number(pct) >= 50) continue;
  if (rec.capitalization !== Number(offering) || PRESS.test(rec.capitalizationSource || '') || !opened(slug)) continue;
  const xml = fs.readFileSync(`${SP}/sec/${f.adsh}.xml`, 'utf8');
  const signed = (/<signatureDate>(\d{4}-\d{2}-\d{2})<\/signatureDate>/.exec(xml) || [])[1];
  const raised = Number(sold) === 0 ? 'Nothing had been raised' : `${money(Number(sold))} had been raised`;
  if (take(slug)) (openYear(slug) >= 2024 ? p13 : p13b).push(entry(slug, ['capitalization'], `We have ${money(Number(offering))}, the most its SEC Form D${signed ? ` (filed ${fmt(signed)})` : ''} allowed it to raise. ${raised} when it was filed. Find the amount actually raised: a later amended filing (Form D/A) or a news report of the final capitalization.`));
}

// p14: weekly running costs for shows still running or from the last two seasons, not yet recouped.
const recentSeason = (s: string) => /^(2025-2026|2026-2027)$/.test(s);
const p14: any[] = []; const p14b: any[] = [];
for (const r of commercial) {
  if (r.recouped === true || (r.weeklyCost && !r.weeklyCostIsEstimate)) continue;
  if (!(r.status !== 'closed' || recentSeason(r.season))) continue;
  if (!opened(r.slug) || !take(r.slug)) continue;
  const known = [r.capitalization && !r.capitalizationIsEstimate ? `We have a capitalization of ${money(r.capitalization)}.` : null, r.weeklyCost ? `We use a typical weekly cost of about ${money(Math.round(r.weeklyCost / 1000) * 1000)}; find a reported figure.` : null].filter(Boolean).join(' ') || null;
  (r.status !== 'closed' ? p14 : p14b).push(entry(r.slug, ['weekly running cost'], known));
}

// p15: closed shows counted as not recouped only because no recoupment was announced.
const p15new: any[] = []; const p15old: any[] = [];
for (const r of commercial) {
  const rec = comm[r.slug];
  if (r.status !== 'closed' || rec.recouped !== false || rec.designationBasis !== 'no-recoupment-announced') continue;
  if (!take(r.slug)) continue;
  const s = bySlug.get(r.slug) || {};
  const e = entry(r.slug, ['outcome for investors'], `We count it as not recouped because no recoupment was ever announced. Find any report that it recouped, or of how much investors got back or lost.${r.capitalization && !r.capitalizationIsEstimate ? ` We have a capitalization of ${money(r.capitalization)}.` : ''}`);
  ((s.openingDate || '') >= '2023-01-01' ? p15new : p15old).push(e);
}

const byTitle = (a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0]));
const out = [
  { id: 'p13', group: 'first', kind: 'commercial', title: 'Budgets that are only a filing maximum, 2024 on', why: 'For these shows, our budget is the most the SEC filing allowed. Most had raised far less when they filed, so the real figure may be lower.', shows: p13.sort(byTitle) },
  { id: 'p13b', group: 'first', kind: 'commercial', title: 'Budgets that are only a filing maximum, before 2024', why: 'The same question for earlier shows.', shows: p13b.sort(byTitle) },
  { id: 'p14', group: 'first', kind: 'commercial', title: 'Weekly running costs, shows still running', why: 'The weekly running cost moves our estimates more than any other number, and few are published. These shows are running and have not recouped.', shows: p14.sort(byTitle) },
  { id: 'p14b', group: 'first', kind: 'commercial', title: 'Weekly running costs, closed this season', why: 'The current season is the one a reporter will look at first. These closed without a published running cost.', shows: p14b.sort(byTitle) },
  { id: 'p15', group: 'first', kind: 'commercial', title: 'Outcomes nobody announced, 2023 on', why: 'We count these closed shows as not recouped only because no recoupment was announced. A report either way settles it.', shows: p15new.sort(byTitle) },
  { id: 'p15b', group: 'first', kind: 'commercial', title: 'Outcomes nobody announced, before 2023', why: 'The same question for older shows.', shows: p15old.sort(byTitle) },
  { id: 'p16', group: 'first', kind: 'commercial', title: 'Figures we could not check', why: 'Budgets we estimated or hold without a source we can print, and five newspaper figures behind paywalls I could not open.', shows: p16.sort(byTitle) },
].filter((g) => g.shows.length);
for (const g of out) console.error(g.id, g.shows.length);
console.log(JSON.stringify(out));
