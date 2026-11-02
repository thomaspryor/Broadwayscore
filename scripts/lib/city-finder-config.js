'use strict';

/**
 * Per-city config for scripts/lib/city-review-finder.js (BRO-6854). Pure data.
 * The city's registry entry (data/city-hubs.json) carries `finder: { key, since, files }`;
 * outlets and producing theatres live here because they are code-adjacent (adapter kinds).
 *
 * Outlet fields: id, name, kind (wp | wpcom | sitemap | bww | index) + adapter fields.
 * Theatre fields: name (as BroadwayWorld / the outlets print it), aliases, pro (professional company).
 */

const monthsBetween = (from, to) => {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push([y, String(m).padStart(2, '0')]); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
};
const slug = (t) => String(t).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const FINDERS = {
  'san-diego': {
    key: 'san-diego',
    bwwRegion: 'san-diego',
    state: 'CA',
    outlets: [
      { id: 'sandiegouniontribune', name: 'San Diego Union-Tribune', kind: 'sitemap', base: 'https://www.sandiegouniontribune.com', slugPrefix: 'review-' },
      { id: 'broadwayworld-sd', name: 'BroadwayWorld San Diego', kind: 'bww', region: 'san-diego' },
      { id: 'stage-west', name: 'Stage West', kind: 'index', base: 'https://www.davidcoddon.com',
        pages: (w) => monthsBetween(w.from.slice(0, 7), w.to.slice(0, 7)).map(([y, m]) => `https://www.davidcoddon.com/theatre-reviews/archives/${m}-${y}`) },
      { id: 'sandiegostory', name: 'San Diego Story', kind: 'wp', base: 'https://sandiegostory.com' },
      { id: 'sdjewishworld', name: 'San Diego Jewish World', kind: 'wp', base: 'https://www.sdjewishworld.com' },
      { id: 'stageandcinema', name: 'Stage and Cinema', kind: 'wp', base: 'https://stageandcinema.com' },
      { id: 'fromanotherzero', name: 'From Another Zero', kind: 'wp', base: 'https://fromanother0.com' },
      { id: 'makaylahoppe', name: 'Makayla Hoppe', kind: 'wp', base: 'https://makaylahoppe.com' },
      { id: 'kurahashi', name: 'Theatre Reviews Kurahashi', kind: 'wpcom', host: 'theatrereviewskurahashi.wordpress.com' },
      { id: 'timesofsandiego', name: 'Times of San Diego', kind: 'wp', base: 'https://timesofsandiego.com' },
      { id: 'culturevulture', name: 'Culture Vulture', kind: 'wp', base: 'https://culturevulture.net' },
    ],
    // Productions the census (BRO-6834, through 2026-09-20) predates and BroadwayWorld's rolling listing no longer shows.
    extraProductions: [
      { title: 'Topdog/Underdog', theatre: 'The Old Globe', start: '2026-10-01' },
      { title: 'JOB', theatre: 'Cygnet Theatre', start: '2026-10-07' },
      { title: 'Ripcord', theatre: 'The Roustabouts Theatre Co', start: '2026-10-08' },
      { title: 'Carrie: The Musical', theatre: 'Oceanside Theatre Company', start: '2026-10-16' },
      { title: 'As You Like It', theatre: 'New Village Arts', start: '2026-10-16' },
    ],
    theatres: [
      { name: 'The Old Globe', city: 'San Diego', aliases: ['globe theatres', 'old globe theatre'], pro: true },
      { name: 'La Jolla Playhouse', city: 'La Jolla', pro: true },
      { name: 'Cygnet Theatre', city: 'San Diego', pro: true },
      { name: 'North Coast Repertory Theatre', city: 'Solana Beach', aliases: ['north coast rep'], pro: true },
      { name: 'Moxie Theatre', city: 'San Diego', pro: true },
      { name: "Lamb's Players Theatre", city: 'Coronado', aliases: ['lambs players'], pro: true },
      { name: 'Diversionary Theatre', city: 'San Diego', pro: true },
      { name: 'New Village Arts', city: 'Carlsbad', pro: true },
      { name: 'Backyard Renaissance', city: 'San Diego', pro: true },
      { name: 'Moonlight Stage Productions', city: 'Vista', aliases: ['moonlight amphitheatre', 'moonlight stage'], pro: true },
      { name: 'San Diego Musical Theatre', city: 'San Diego', pro: true },
      { name: 'San Diego Repertory Theatre', city: 'San Diego', aliases: ['san diego rep'], pro: true },
      { name: 'Ion Theatre', city: 'San Diego', pro: true },
      { name: 'Intrepid Shakespeare Company', city: 'Encinitas', pro: true },
      { name: 'The Roustabouts Theatre Co', city: 'San Diego', aliases: ['roustabouts'], pro: true },
      { name: 'Welk Resort Theatre', city: 'Escondido', pro: true },
      { name: 'Oceanside Theatre Company', city: 'Oceanside', pro: false },
      { name: 'Scripps Ranch Theatre', city: 'San Diego', pro: false },
      { name: 'OnStage Playhouse', city: 'Chula Vista', pro: false },
      { name: 'OnWord Theatre', city: 'San Diego', pro: false },
      { name: 'Coronado Playhouse', city: 'Coronado', pro: false },
    ],
  },
  boston: {
    key: 'boston',
    bwwRegion: 'boston',
    state: 'MA',
    outlets: [
      { id: 'sleeplesscritic', name: 'Sleepless Critic', kind: 'wp', base: 'https://sleeplesscritic.com' },
      { id: 'netheatregeek', name: 'New England Theatre Geek', kind: 'wp', base: 'https://www.netheatregeek.com' },
      { id: 'artsfuse', name: 'Arts Fuse', kind: 'wp', base: 'https://artsfuse.org' },
      { id: 'stageandcinema', name: 'Stage and Cinema', kind: 'wp', base: 'https://stageandcinema.com' },
      { id: 'broadwayworld-boston', name: 'BroadwayWorld Boston', kind: 'bww', region: 'boston' },
      { id: 'cambridgeday', name: 'Cambridge Day', kind: 'wp', base: 'https://www.cambridgeday.com' },
      { id: 'theatermirror', name: 'Theatre Mirror', kind: 'index', base: 'https://www.theatermirror.net',
        pages: (w, p) => [`https://www.theatermirror.net/tag/${slug(p.title)}`] },
      { id: 'metromag', name: 'Metro Mag', kind: 'index', base: 'https://www.metrmag.com',
        pages: () => ['https://www.metrmag.com/latest-reviews/'] },
    ],
    theatres: [],
  },
};

function getFinder(key) {
  const f = FINDERS[key];
  if (!f) throw new Error(`unknown finder city "${key}" (known: ${Object.keys(FINDERS).join(', ')})`);
  return f;
}

module.exports = { FINDERS, getFinder, monthsBetween, slug };
