// BRO-2777: drives scripts/opening-night-checklist.js the way its production
// callers do (opening-night-checklist.yml, opening-night-orchestrator.yml:
// `--json --out=<file>`), never by parsing stdout, which carries progress and
// scraper log lines ahead of the JSON. It spends nothing and writes nothing
// shared:
//   - OPENING_NIGHT_CHECKLIST_OFFLINE=1 skips every check that declares
//     `live: true` (BWW RR / DTLI page fetches through the paid scraper chain);
//   - OPENING_NIGHT_CHECKLIST_DATA_DIR + REVIEW_TEXTS_DIR point every data read
//     and write (history ledger, remediation log, score snapshot) at a temp
//     fixture, never the repo's data/ (a symlink into shared core data);
//   - OPENING_NIGHT_REMEDIATION_DISABLED=true keeps remediation from
//     dispatching workflows or filing alerts;
//   - scraper API keys are removed from the child env as a second fence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../scripts/opening-night-checklist.js');
const CWD = path.resolve(__dirname, '../..');

const SHOW_ID = 'bro2777-fixture-show-2099';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'on-checklist-cli-'));
  const dataDir = path.join(root, 'data');
  const reviewTexts = path.join(root, 'review-texts');
  fs.mkdirSync(path.join(dataDir, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(reviewTexts, SHOW_ID), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'shows.json'), JSON.stringify({
    shows: [{
      id: SHOW_ID,
      title: 'BRO-2777 Fixture Show',
      slug: SHOW_ID,
      category: 'broadway',
      status: 'open',
      type: 'play',
      openingDate: '2099-04-16',
      // A real-looking RR URL: without the offline seam the BWW RR check would
      // fetch it through the paid scraper chain. With it, the check is skipped.
      bwwRoundupUrl: 'https://www.broadwayworld.com/article/Review-Roundup-BRO-2777-Fixture-Show-20990416',
    }],
  }));
  fs.writeFileSync(path.join(dataDir, 'reviews.json'), JSON.stringify({ reviews: [] }));
  return { root, dataDir, reviewTexts, out: path.join(root, 'checklist.json') };
}

function runCli(fx, showId) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(SCRAPINGDOG|SCRAPINGBEE|BRIGHTDATA|BROWSERBASE|ANTHROPIC|OPENAI|GEMINI)_/.test(k)) delete env[k];
  }
  Object.assign(env, {
    OPENING_NIGHT_CHECKLIST_OFFLINE: '1',
    OPENING_NIGHT_CHECKLIST_DATA_DIR: fx.dataDir,
    REVIEW_TEXTS_DIR: fx.reviewTexts,
    OPENING_NIGHT_REMEDIATION_DISABLED: 'true',
    BSC_STAGE_LATENCY_MUTE: '1',
  });
  return spawnSync(process.execPath, [SCRIPT, `--show=${showId}`, '--json', `--out=${fx.out}`], {
    cwd: CWD, env, encoding: 'utf8', timeout: 60000,
  });
}

const readOut = (fx) => JSON.parse(fs.readFileSync(fx.out, 'utf8'));
const runLog = (r) => `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;

describe('opening-night-checklist CLI (--json --out, offline)', () => {
  it('unknown --show exits non-zero and still writes the error JSON to --out', () => {
    const fx = fixture();
    const r = runCli(fx, 'absolutely-does-not-exist-2099');
    assert.notEqual(r.status, 0, runLog(r));
    assert.ok(fs.existsSync(fx.out), `--out file not written on the 0-show path\n${runLog(r)}`);
    const json = readOut(fx);
    assert.match(json.error, /not found/);
    assert.deepEqual(json.shows, []);
    assert.ok(json.generatedAt, 'JSON should have generatedAt');
  });

  it('fixture show returns check results, live checks skipped, nothing fetched', () => {
    const fx = fixture();
    const r = runCli(fx, SHOW_ID);
    // 0 = clean, 1 = the show has check errors. Both are designed outcomes;
    // anything else (3 = history ledger failure, a crash) is not.
    assert.ok(r.status === 0 || r.status === 1, runLog(r));
    const json = readOut(fx);
    assert.ok(json.generatedAt, 'should have generatedAt');
    assert.equal(json.shows.length, 1, runLog(r));
    const show = json.shows[0];
    assert.equal(show.show.id, SHOW_ID);
    assert.ok(show.results.length >= 5, `should have at least 5 check results, got ${show.results.length}`);
    for (const k of ['errors', 'warnings', 'ok']) assert.equal(typeof show.summary[k], 'number');

    const skipped = show.results.filter((x) => x.details?.skippedOffline).map((x) => x.name).sort();
    assert.deepEqual(skipped, ['bww-rr-count-mismatch', 'dtli-count-mismatch']);

    // No scraper telemetry: a fetch through fetchPage() logs one of these.
    assert.doesNotMatch(r.stdout + r.stderr, /Scrapingdog|SD Call|SB Call|Trying /);
    // The run wrote its ledger into the fixture, not the repo's data/.
    assert.ok(fs.existsSync(path.join(fx.dataDir, 'audit', 'opening-night-history.json')));
  });
});
