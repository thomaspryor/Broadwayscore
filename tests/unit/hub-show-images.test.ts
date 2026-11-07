// TESTS-VS-DERIVED-DATA-EXEMPT: structural coverage check (every hub show has an image), pins no specific facts
/**
 * Every show on a city hub's main page (now, soon, recently closed) needs a real
 * thumbnail (BRO-6771, owner rule 2026-11-01). Calls the real HUB_CITIES,
 * sectionHubShows and hasRealImage.
 *
 * Advisory first (CLAUDE.md §19): against the live data this warns and lists the
 * offenders. Set HUB_IMAGES_STRICT=1 to make it fail; flip the default once the
 * hubs have been clean for a week. The logic tests below always run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HUB_CITIES, sectionHubShows } from '../../src/lib/city-hub';

const require = createRequire(import.meta.url);
const { hasRealImage } = require('../../scripts/lib/show-images.js');

const ROOT = path.join(__dirname, '..', '..');
const TODAY = new Date().toISOString().slice(0, 10);

type HubShow = { id: string; city?: string; status?: string; openingDate?: string; closingDate?: string; images?: Record<string, string> };

/** Main-page shows (everything but the archive) of every hub city that lack a real image. */
export function hubShowsMissingImages(shows: HubShow[], today: string, hasImage: (s: HubShow) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const metro of Object.keys(HUB_CITIES)) {
    const sec = sectionHubShows(shows as never[], metro, today) as { now: HubShow[]; soon: HubShow[]; closedRecent: HubShow[] };
    const bad = [...sec.now, ...sec.soon, ...sec.closedRecent].filter(s => !hasImage(s)).map(s => s.id);
    if (bad.length) out[metro] = bad;
  }
  return out;
}

test('finds main-page hub shows without an image, ignores archive-only ones', () => {
  const metro = Object.keys(HUB_CITIES)[0];
  const mk = (id: string, o: Partial<HubShow> = {}): HubShow => ({ id, city: metro, status: 'open', openingDate: '2026-09-01', ...o });
  const shows = [
    mk('has-img', { images: { thumbnail: '/x.webp' } }),
    mk('no-img'),
    mk('old-closed-no-img', { status: 'closed', openingDate: '2024-01-01', closingDate: '2024-02-01' }),
  ];
  const out = hubShowsMissingImages(shows, '2026-11-01', s => !!s.images);
  assert.deepEqual(out[metro], ['no-img']);
});

test('hub shows have a real thumbnail (advisory unless HUB_IMAGES_STRICT=1)', (t) => {
  const file = path.join(ROOT, 'data', 'shows.json');
  if (!fs.existsSync(file)) return t.skip('no data/shows.json in this checkout');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shows: HubShow[] = Array.isArray(raw) ? raw : raw.shows;
  const missing = hubShowsMissingImages(shows, TODAY, s => hasRealImage(s));
  const total = Object.values(missing).reduce((n, a) => n + a.length, 0);
  if (!total) return;
  const msg = Object.entries(missing).map(([m, ids]) => `${m}: ${ids.join(', ')}`).join('\n');
  if (process.env.HUB_IMAGES_STRICT === '1') assert.fail(`hub main-page shows without an image:\n${msg}`);
  console.warn(`WARN (advisory): ${total} hub main-page show(s) without a real image:\n${msg}`);
});
