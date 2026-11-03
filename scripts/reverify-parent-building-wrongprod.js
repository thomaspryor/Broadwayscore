#!/usr/bin/env node
/**
 * BRO-6923: re-verify wrongProduction flags on shows filed at a stage inside a
 * bigger building (The Maria / Young Vic, Lyttelton / National Theatre ...)
 * whose flag reason names that building. Read-only: runs the alias-aware
 * content verifier and prints verdicts plus a ready `review-field-edit` plan
 * action list (wrongProduction true -> false) for the clean ones. Never prints
 * review text. Apply the actions through a pending-fix plan (CLOUD.md).
 *
 * Usage:
 *   node scripts/reverify-parent-building-wrongprod.js --count-only
 *   node scripts/reverify-parent-building-wrongprod.js [--show=ID] [--limit=N] [--parent="Young Vic"]
 * Env: ANTHROPIC_API_KEY (not needed with --count-only).
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const USAGE = 'reverify-parent-building-wrongprod.js [--count-only] [--show=ID] [--limit=N] [--parent=NAME]\n';
if (hasHelpFlag(process.argv.slice(2))) { process.stdout.write(USAGE); process.exit(0); }

const { MAIN_REPO_ROOT: MAIN_REPO } = require('./lib/repo-root');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { parentBuildingFlagCandidate } = require('./lib/parent-building-wrongprod');

const args = process.argv.slice(2);
const opt = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const COUNT_ONLY = args.includes('--count-only');
const LIMIT = parseInt(opt('limit'), 10) || 0;
const ONLY_SHOW = opt('show');
const ONLY_PARENT = opt('parent');

(async () => {
  const dir = resolveReviewTextsDir();
  if (!dir) { console.error('no review-texts dir'); process.exit(3); }
  if (!COUNT_ONLY && !process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
  const sd = JSON.parse(fs.readFileSync(path.join(MAIN_REPO, 'data/shows.json'), 'utf8'));
  const shows = sd.shows || sd;
  const byParent = {};
  const cands = [];
  for (const show of shows) {
    if (ONLY_SHOW && show.id !== ONLY_SHOW) continue;
    const sdir = path.join(dir, show.id);
    if (!fs.existsSync(sdir)) continue;
    for (const f of fs.readdirSync(sdir).filter((x) => x.endsWith('.json'))) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')); } catch { continue; }
      const r = parentBuildingFlagCandidate(show, d);
      if (!r.candidate || (ONLY_PARENT && r.parent !== ONLY_PARENT)) continue;
      byParent[r.parent] = (byParent[r.parent] || 0) + 1;
      cands.push({ show, file: f, d, parent: r.parent });
    }
  }
  console.log('CANDIDATES BY PARENT:', JSON.stringify(byParent), 'total', cands.length);
  console.log('CANDIDATE SHOWS:', JSON.stringify([...new Set(cands.map((c) => `${c.show.id}|${c.show.venue}`))]));
  if (COUNT_ONLY) return;

  const { verifyContent } = require('./lib/content-verifier');
  const actions = [];
  let n = 0, upheld = 0, errors = 0, short = 0;
  for (const c of cands) {
    if (LIMIT && n >= LIMIT) break;
    if (!c.d.fullText || c.d.fullText.trim().length < 200) { short++; continue; }
    n++;
    let cv;
    try {
      cv = await verifyContent({
        scrapedText: c.d.fullText, showTitle: c.show.title, criticName: c.d.criticName || null,
        outletName: c.d.outlet || null, url: c.d.url || null, venue: c.show.venue || null,
        openingDate: c.show.openingDate || null, publishDate: c.d.publishDate || null,
        market: c.show.category || 'broadway', show: c.show,
      });
    } catch (e) { errors++; console.log(`[ERROR] ${c.show.id}/${c.file}: ${e.message}`); continue; }
    const clean = cv && cv.isValid === true && cv.wrongProduction !== true && cv.wrongArticle !== true
      && cv.isFilmTv !== true && typeof cv.verifiedBy === 'string' && cv.verifiedBy.startsWith('llm');
    console.log(`[${clean ? 'CLEAR' : 'UPHELD'}] ${c.show.id}/${c.file} (${c.parent}) valid=${cv?.isValid} wp=${cv?.wrongProduction}`);
    if (!clean) { upheld++; continue; }
    actions.push({
      type: 'review-field-edit', file: `${c.show.id}/${c.file}`, field: 'wrongProduction',
      oldValue: true, newValue: false,
      description: `BRO-6923: ${c.show.venue} is a stage inside ${c.parent}; the flag reason named the building. Alias-aware re-verify: valid, not wrong production.`,
    });
  }
  console.log(`SUMMARY: verified=${n} clear=${actions.length} upheld=${upheld} errors=${errors} tooShort=${short}`);
  console.log('PLAN-ACTIONS-BEGIN');
  console.log(JSON.stringify(actions));
  console.log('PLAN-ACTIONS-END');
})();
