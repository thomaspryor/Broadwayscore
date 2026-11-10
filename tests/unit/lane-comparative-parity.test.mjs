// BRO-7283: the opening-night lane published isolated anchored-v6 scores; the regular pipeline's comparative within-band
// pass (llm-ensemble-score.yml -> comparative-rescore.ts) later rewrote them, so the headline moved the morning after
// (Blueberries 81 -> 80). The lane now runs the same pass (comparative-core.ts settleShow) at score time.
//
// Real functions only (CLAUDE.md section 15): runLaneNight, settleShow and the rebuild's getBestScore are the production
// ones; only the fetch, the scorer and the comparative models are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runLaneNight } = require('../../scripts/lib/opening-night-lane/lane-runner.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');
const core = require('../../scripts/llm-scoring/comparative-core.ts');

const NIGHT = '2026-11-09';
const SHOW = { id: 'parity-show-2026', title: 'Parity Show', openingDate: NIGHT };
const T0 = Date.parse('2026-11-09T22:00:00-05:00');
const REVIEWS = [
  { url: 'https://www.nytimes.com/2026/11/09/theater/parity-show-review.html', outletId: 'nytimes', criticName: 'Critic One', isolated: 85 },
  { url: 'https://variety.com/2026/legit/reviews/parity-show-review-1236000000/', outletId: 'variety', criticName: 'Critic Two', isolated: 85 },
  { url: 'https://nypost.com/2026/11/09/entertainment/parity-show-review/', outletId: 'nypost', criticName: 'Critic Three', isolated: 85 },
];
const BODY = 'A full review of the production, with enough prose for the comparative pass to read. '.repeat(4);

// Two stub comparative models that agree on a spread inside the 4-star band. They answer for whichever file names the
// prompt carries, so the same models serve the lane's settle and the cron's.
function stubModels() {
  const answer = (offsets) => async (prompt) => {
    const ids = [...new Set(prompt.match(/[\w.-]+--[\w.-]+\.json/g) || [])].sort();
    return JSON.stringify(ids.map((id, i) => ({ id, score: 84 + offsets[i % offsets.length], warmthRank: i + 1, reasoning: 'stub' })));
  };
  return [{ name: 'stub-a', call: answer([4, 0, 2]) }, { name: 'stub-b', call: answer([5, 1, 3]) }];
}

async function runNight({ settle, settleMaxRuns }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7283-parity-'));
  const reviewTextsDir = path.join(dir, 'review-texts');
  let t = T0;
  let doc = { reviews: [] };
  const live = () => ({ rv: doc.reviews.map((r) => ({ u: r.url, s: r.assignedScore })) });
  const byUrl = new Map(REVIEWS.map((r) => [r.url, r]));
  const settleCalls = [];
  const models = stubModels();
  try {
    const run = await runLaneNight({
      show: SHOW, night: NIGHT, openingDate: NIGHT, ledgerDir: path.join(dir, 'ledger'), reviewTextsDir, dryRun: true, maxPasses: 1, passIntervalMs: 0, windowMs: 40 * 60 * 1000,
      adapters: [{ name: 'roundup', kind: 'aggregator', phase: 'main', discover: async () => REVIEWS.map((r) => ({ url: r.url, source: 'aggregator', aggregatorCited: true })) }],
      ...(settleMaxRuns ? { settleMaxRuns } : {}),
      fetchText: async () => '',
      fetchReview: async (a) => { const r = byUrl.get(a.url); return { outletId: r.outletId, outlet: r.outletId, criticName: r.criticName, fullText: BODY, publishDate: NIGHT }; },
      scoreReview: async (row) => {
        const r = byUrl.get(row.url);
        return { score: r.isolated, extra: { scoreSource: 'anchored-v6', llmScore: { score: r.isolated, band: { floor: 71, ceiling: 90 } } } };
      },
      ...(settle ? { settleComparative: async ({ file }) => { settleCalls.push(file); const st = await core.settleShow(SHOW.id, { reviewTextsDir, models, onlyFile: file }); return { changed: st.changedFiles, unsettled: st.unsettled }; } } : {}),
      publishPorts: {
        updateReviews: async (fn) => { const out = fn(doc); doc = out.doc; return out; },
        regenShow: async () => ({}), deploy: async () => {}, fetchLiveShow: async () => live(),
      },
      now: () => t, wait: async (ms) => { t += ms; }, pollMs: 1, publishTimeoutMs: 60 * 1000,
    });
    const files = fs.readdirSync(path.join(reviewTextsDir, SHOW.id)).filter((f) => f.endsWith('.json'));
    const onDisk = () => Object.fromEntries(files.map((f) => [f, JSON.parse(fs.readFileSync(path.join(reviewTextsDir, SHOW.id, f), 'utf8'))]));
    const published = Object.fromEntries(doc.reviews.map((r) => [r.url, r.assignedScore]));
    // The same pass the cron runs, over the same directory.
    const cron = await core.settleShow(SHOW.id, { reviewTextsDir, models });
    // Read before the temp dir goes: what the next full rebuild would publish for each file.
    const rebuild = Object.fromEntries(Object.values(onDisk()).map((d) => [d.url, getBestScore(d).score]));
    return { run, published, cron, settleCalls, rebuild };
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

test('red: without the lane settle, the cron pass moves published scores (the BRO-7283 drift)', async () => {
  const res = await runNight({ settle: false });
  assert.equal(res.run.unpublished.length, 0);
  assert.deepEqual(Object.values(res.published).sort(), [85, 85, 85], 'the lane published the isolated scores');
  assert.ok(res.cron.changed > 0, 'the cron pass then rewrote scores the site already showed');
});

test('green: with the lane settle, published == the rebuild score and the cron pass moves nothing', async () => {
  const res = await runNight({ settle: true });
  assert.equal(res.run.unpublished.length, 0);
  assert.ok(res.settleCalls.length >= 1, 'the settle port ran');
  assert.equal(res.cron.changed, 0, 'the cron pass finds every group settled');
  assert.equal(res.cron.rescoresDone, 0, 'and makes no model call');
  const rebuild = res.rebuild;
  assert.equal(Object.keys(rebuild).length, REVIEWS.length);
  for (const r of REVIEWS) assert.equal(res.published[r.url], rebuild[r.url], `${r.outletId}: published score equals getBestScore(file)`);
  assert.ok(Object.values(res.published).some((s) => s !== 85), 'the settle did move a score (the stub models spread the band)');
});

test('the lane CLI and the cron script share one pass: both import comparative-core', () => {
  const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.match(read('scripts/opening-night-lane.js'), /comparative-core/);
  assert.match(read('scripts/llm-scoring/comparative-rescore.ts'), /from '\.\/comparative-core'/);
  assert.doesNotMatch(read('scripts/llm-scoring/comparative-rescore.ts'), /function rescoreGroup|function writeBack/, 'no second copy of the pass');
});

test('publish waits for a re-sent (rescored) row\'s NEW score to be live, not just its URL', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/opening-night-lane/publish.js', import.meta.url), 'utf8');
  assert.match(src, /rescored === true/);
  assert.match(src, /liveScore\.get\(url\) !== wantScore\.get\(url\)/);
});

test('the settle is capped per night: runs past the cap publish the isolated score and report why', async () => {
  const res = await runNight({ settle: true, settleMaxRuns: 1 });
  assert.equal(res.run.unpublished.length, 0);
  assert.equal(res.settleCalls.length, 1, 'only one settle call was made');
  assert.equal(res.run.settle.runs, 1);
  assert.ok(res.run.settle.failed.some((f) => /runs already made/.test(f.reason)), 'the skipped runs are reported');
});
