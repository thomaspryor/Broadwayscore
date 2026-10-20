#!/usr/bin/env node
// Regenerates the owner's deep-research prompts page from live data (BRO-5570).
//   node scripts/research-prompts/build.js --out <html> [--work <dir>]
//   (--no-formd allows splicing without the Form D prompts, which drops them from the page)
//   node scripts/research-prompts/build.js --dry-run [--work <dir>]
// Reads data/commercial.json + data/shows.json. Without --out (or with --dry-run)
// it only prints each prompt id and its show count. Splicing needs the page HTML
// (read it back with the Artifact tool, action read, and republish to the same URL).
// Form D prompts (p13/p13b) also need <work>/formd-records.tsv and <work>/sold.tsv;
// sold.py <records.tsv> <work>/sec > <work>/sold.tsv (caches XML in <work>/sec) needs SEC_CONTACT_EMAIL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${(r.stderr || '').slice(-1500)}`);
  return r;
}

// Prompt ids and show counts of a prompt list, in order.
function summarize(prompts) {
  return prompts.map((p) => ({ id: p.id, shows: p.shows.length }));
}

function build({ work, out }) {
  fs.mkdirSync(work, { recursive: true });
  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const gaps = run(tsx, [path.join(__dirname, 'allgaps.mts')]).stdout;
  fs.writeFileSync(path.join(work, 'gaps-all2.txt'), gaps);
  const season = JSON.parse(run('node', [path.join(__dirname, 'gen-batches.js'), work]).stdout);
  const deep = JSON.parse(run(tsx, [path.join(__dirname, 'gen-deepdives.mts'), work]).stdout);
  fs.writeFileSync(path.join(work, 'season-prompts.json'), JSON.stringify(season));
  fs.writeFileSync(path.join(work, 'deepdives.json'), JSON.stringify(deep));
  if (out) {
    const haveFd = ['formd-records.tsv', 'sold.tsv'].every((f) => fs.existsSync(path.join(work, f)));
    if (!haveFd && !flag('--no-formd')) throw new Error('refusing to splice: p13/p13b would be dropped from the page. Put formd-records.tsv and sold.tsv in --work (sold.py <records> <work>/sec), or pass --no-formd.');
    const r = run('python3', ['-I', path.join(__dirname, 'splice.py'), out,
      path.join(work, 'season-prompts.json'), path.join(work, 'deepdives.json'), path.join(__dirname, 'ran-in.json')]);
    console.log(r.stdout.trim());
  }
  return { season, deep };
}

if (require.main === module) {
  const work = opt('--work') || fs.mkdtempSync(path.join(os.tmpdir(), 'research-prompts-'));
  if (flag('--out') && !opt('--out')) throw new Error('--out needs a path');
  const out = flag('--dry-run') ? null : opt('--out');
  const { season, deep } = build({ work, out });
  for (const s of summarize([...deep, ...season])) console.log(`${s.id}\t${s.shows}`);
}

module.exports = { build, summarize };
