// BRO-7803: publish hot-show score payloads to the public live-scores bucket so
// the show page can overlay them minutes after a review lands, without a Next
// build + Vercel deploy. Run with tsx. All logic is in scripts/lib/live-score/*.
//
//   npx tsx scripts/publish-live-scores.ts                 publish hot shows
//   npx tsx scripts/publish-live-scores.ts --show=ID       force one show (by-hand ramp step)
//   npx tsx scripts/publish-live-scores.ts --dry-run
//   npx tsx scripts/publish-live-scores.ts --purge=ID      takedown tombstone
//   npx tsx scripts/publish-live-scores.ts --kill|--enable   write kill.json (the only writer)
//   npx tsx scripts/publish-live-scores.ts --ensure-bucket
import fs from 'fs';
import { getAllShows, getDataFreshness } from '../src/lib/data-core';
import { getReviewListItems } from '../src/lib/show-review-items';
import { getCriticConsensus } from '../src/lib/data-consensus';
import { buildScoreRegionView } from '../src/lib/live-score/view';

const { makeStorage, DEFAULT_BUCKET } = require('./lib/live-score/storage');
const { publish, purge } = require('./lib/live-score/publish');
const { selectHotShows, SCHEMA } = require('./lib/live-score/core');
const { PUBLISHER_ENABLED } = require('./lib/live-score/config');

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main() {
  const baseUrl = process.env.LIVE_SCORES_BASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!baseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL (or LIVE_SCORES_BASE_URL) is not set');
  const storage = makeStorage({ baseUrl, serviceKey, bucket: process.env.LIVE_SCORES_BUCKET || DEFAULT_BUCKET });
  const rev = Number(val('rev')) || Date.parse(getDataFreshness().reviewsLastUpdated) || Date.now();

  if (flag('ensure-bucket')) { console.log('bucket:', await storage.ensureBucket()); return; }
  if (flag('kill') || flag('enable')) {
    await storage.ensureBucket().catch(() => {});
    await storage.put('kill.json', JSON.stringify({ schema: SCHEMA, enabled: flag('enable'), at: new Date().toISOString() }), { cacheSeconds: 20 });
    console.log(flag('enable') ? 'overlay ENABLED (kill.json)' : 'overlay DISABLED (kill.json)');
    return;
  }
  if (val('purge')) { console.log(JSON.stringify(await purge({ storage, showId: val('purge'), rev: Date.now() }))); return; }

  if (!PUBLISHER_ENABLED) { console.log('live-score publisher disabled in scripts/lib/live-score/config.js; nothing published'); return; }
  const all = getAllShows();
  const only = val('show');
  const flaggedFile = val('flagged-file');
  const flagged = new Set<string>(flaggedFile && fs.existsSync(flaggedFile)
    ? fs.readFileSync(flaggedFile, 'utf8').split(/\s+/).filter(Boolean) : []);
  const dates: Record<string, string[]> = {};
  for (const s of all) dates[s.id] = (s.criticScore?.reviews ?? []).map((r: any) => r.publishDate).filter(Boolean);
  const days = Number(val('days')) || undefined;
  const ids = only ? [only] : selectHotShows({ shows: all.filter((s: any) => s.status === 'open' || s.status === 'previews'), reviewDatesByShow: dates, days });
  const plan = ids.map((id: string) => {
    const show = all.find((s) => s.id === id);
    if (!show) throw new Error(`unknown show ${id}`);
    return { showId: id, view: buildScoreRegionView(show as never, !!getCriticConsensus(id)), reviews: getReviewListItems(show) };
  });
  const safe = process.env.LIVE_SCORES_SAFE !== 'false';
  await storage.ensureBucket().catch(() => {});
  const out = await publish({ storage, plan, rev, flagged, safe, allowDecrease: flag('allow-decrease'), dryRun: flag('dry-run'), log: console.log });
  console.log(JSON.stringify(out, null, 1));
  if (out.results.some((r: any) => r.status === 'failed')) process.exitCode = 1;
}

main().catch((e) => { console.error('publish-live-scores failed:', e.message || e); process.exit(1); });
