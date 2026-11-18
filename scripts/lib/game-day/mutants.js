'use strict';
/**
 * Proves the simulated opening night still catches each post-mortem fix being reverted (BRO-7781 acceptance): for each
 * mutant, patch the fix out of a file, run the night in a child process, restore the file, and expect the night to FAIL
 * on the named check. A mutant whose night still passes means the simulation no longer guards that fix.
 *
 * Usage: node scripts/lib/game-day/mutants.js [--only=<id>]   exit 0 = every mutant caught, 1 = one escaped, 2 = error
 *
 * Each patch is an exact string swap; a patch whose `from` text is missing fails loudly (the fix moved: update it here).
 * The file is restored in a finally block and verified byte-for-byte afterwards.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');

const MUTANTS = [
  {
    id: 'BRO-7739-subtitle-matcher',
    what: 'the lane matcher loses main-title matching for quoted-subtitle shows',
    file: 'scripts/lib/opening-night-lane/discovery.js',
    from: 'return allShowTitlesCache ? { fuzzy: true, mainTitle: true, allShowTitles: allShowTitlesCache } : { fuzzy: true };',
    to: 'return { fuzzy: true };',
    expectFail: /live with the right critic and score: sim-blue-man-group-holiday-2026 theatermania/,
  },
  {
    id: 'BRO-7745-theatermania-byline',
    what: 'manual ingest reads the TheaterMania JSON-LD poster again instead of the visible author tag',
    file: 'scripts/lib/content-quality.js',
    patches: [
      { from: "const visible = require('./byline-extraction').extractTheaterManiaAuthorTag(html);", to: 'const visible = null;' },
      { from: "const area = /<section\\b[^>]*\\bclass=[\"'][^\"']*\\bauthor-area\\b[^>]*>([\\s\\S]*?)<\\/section>/i.exec(html);", to: 'const area = null;' },
    ],
    expectFail: /byline: manual ingest credits the TheaterMania critic/,
  },
  {
    id: 'BRO-7748-near-miss-alarm',
    what: 'the lane stops recording near-misses, so a headline that names the show but fails the matcher raises nothing',
    file: 'scripts/lib/opening-night-lane/lane-runner.js',
    from: "kind: 'near-miss', items: pass.nearMisses || [],",
    to: "kind: 'near-miss', items: [],",
    expectFail: /exactly one alert names the missed review/,
  },
  {
    id: 'BRO-7781-inbox-outlet',
    what: 'a bare manual-inbox URL (no --outlet) gets no outlet and fails',
    file: 'scripts/lib/opening-night-lane/lane-runner.js',
    from: 'const outletIdFor = (e) => e.outletId || ((resolveOutletFromUrl(e.url) || {}).outletId) || null;',
    to: 'const outletIdFor = (e) => e.outletId || null;',
    expectFail: /manual inbox: every dropped URL ends published/,
  },
];

function runNight() {
  const out = path.join(require('os').tmpdir(), `game-day-mutant-${process.pid}-${Date.now()}.json`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'simulated-opening-night.js'), `--out=${out}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* reported below */ }
  fs.rmSync(out, { force: true });
  return { status: r.status, report, stderr: String(r.stderr || '').slice(-2000) };
}

function runMutant(m) {
  const file = path.join(REPO, m.file);
  const original = fs.readFileSync(file, 'utf8');
  const patches = m.patches || [{ from: m.from, to: m.to }];
  let mutated = original;
  for (const p of patches) {
    if (!mutated.includes(p.from)) return { id: m.id, error: `patch text not found in ${m.file}: ${p.from.slice(0, 80)}` };
    mutated = mutated.replace(p.from, p.to);
  }
  let out;
  try {
    fs.writeFileSync(file, mutated);
    out = runNight();
  } finally {
    fs.writeFileSync(file, original);
  }
  if (fs.readFileSync(file, 'utf8') !== original) return { id: m.id, error: `${m.file} was not restored` };
  if (!out.report) return { id: m.id, error: `the night crashed (exit ${out.status}): ${out.stderr}` };
  const failed = out.report.checks.filter((c) => !c.ok).map((c) => c.name);
  return { id: m.id, what: m.what, nightPassed: out.report.pass, failed, caught: !out.report.pass && failed.some((n) => m.expectFail.test(n)) };
}

function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
  const results = MUTANTS.filter((m) => !only || m.id === only).map((m) => { const r = runMutant(m); console.log(JSON.stringify(r)); return r; });
  const bad = results.filter((r) => r.error || !r.caught);
  console.log(bad.length ? `MUTANTS ESCAPED: ${bad.map((r) => r.id).join(', ')}` : `all ${results.length} mutant(s) caught: the simulated night fails when each fix is reverted`);
  process.exit(results.some((r) => r.error) ? 2 : bad.length ? 1 : 0);
}

module.exports = { MUTANTS, runMutant };
if (require.main === module) main();
