// BRO-7348 class guard: review forecasts are private. The /admin/forecasts page must gate on the admin
// cookie before reading data, stay dynamic, and no public file or route may expose a forecast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
};

const PAGE = 'src/app/admin/forecasts/page.tsx';

test('page is dynamic, noindex, and returns 404 before touching data when not admin', () => {
  const s = read(PAGE);
  assert.match(s, /export const dynamic = 'force-dynamic'/);
  assert.match(s, /robots: \{ index: false/);
  const gate = s.indexOf('await isAdmin()');
  const data = s.indexOf('await getReviewForecastBoard()');
  assert.ok(gate > 0 && data > gate, 'isAdmin() must run before the data call');
  assert.match(s, /if \(!\(await isAdmin\(\)\)\) notFound\(\)/);
  assert.doesNotMatch(s, /generateStaticParams|revalidate\s*=/, 'no static generation of a forecast page');
});

test('no route handler or page other than the gated one reads the forecast data', () => {
  const offenders = walk('src').filter((f) => /\.(ts|tsx|js)$/.test(f) && f !== PAGE && f !== 'src/lib/admin-review-forecasts.ts'
    && /admin-review-forecasts|review-forecast-pilot|review-forecast-board/.test(read(f)));
  assert.deepEqual(offenders, [], 'only the gated page may import the forecast loader');
  const apiHits = walk('src/app/api').filter((f) => /review-forecast/.test(read(f)));
  assert.deepEqual(apiHits, []);
});

test('loader is server-only and the local-dir override cannot run in production', () => {
  const s = read('src/lib/admin-review-forecasts.ts');
  assert.match(s, /^import 'server-only'/);
  assert.match(s, /NODE_ENV !== 'production' \? process\.env\.FORECAST_PILOT_DIR/);
  assert.match(s, /thomaspryor|private-data-repo/);
});

test('no forecast data under public/ or data/, and no script writes pilot rows there', () => {
  for (const dir of ['public', 'data']) {
    const bad = walk(dir).filter((f) => /review-forecast-pilot|forecast-pilot/i.test(f));
    assert.deepEqual(bad, [], `${dir}/ must hold no pilot files`);
  }
  const recorder = read('scripts/record-review-forecast-pilot.mjs');
  assert.match(recorder, /outside every checkout|isInsideCheckout|must be outside/i, 'recorder refuses a --dir inside the repo');
});

test('forecast page reuses the shared home-page card and labels its number as a forecast (owner 2026-11-11)', () => {
  const src = fs.readFileSync(new URL('../../src/app/admin/forecasts/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /ShowListCard/, 'page must render the shared ShowListCard');
  assert.match(src, />\s*\{graded \? 'Forecast was' : 'Forecast'\}/, 'score box must be labelled Forecast');
  assert.doesNotMatch(src, /md:grid-cols/, 'single column, no desktop grid');
  assert.doesNotMatch(src, /className="card p-4"/, 'no bespoke card');
});
