#!/usr/bin/env node
// venue-write-guard-ok: venue is passed to the verifier as read-only prompt context; nothing is written to data.
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
 *   node scripts/reverify-parent-building-wrongprod.js [--fetch] [--show=ID] [--limit=N] [--parent="Young Vic"]
 * --fetch (BRO-6946): for stub-text candidates, fetch the live page via fetchPage and verify it.
 * Env: ANTHROPIC_API_KEY (not needed with --count-only).
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const USAGE = 'reverify-parent-building-wrongprod.js [--count-only] [--show=ID] [--limit=N] [--parent=NAME] [--fetch]\n';
if (hasHelpFlag(process.argv.slice(2))) { process.stdout.write(USAGE); process.exit(0); }

const { MAIN_REPO_ROOT: MAIN_REPO } = require('./lib/repo-root');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { parentBuildingFlagCandidate, shortCandidateDecision, isCleanVerdict } = require('./lib/parent-building-wrongprod');

const args = process.argv.slice(2);
const opt = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const COUNT_ONLY = args.includes('--count-only');
const LIMIT = parseInt(opt('limit'), 10) || 0;
const ONLY_SHOW = opt('show');
const ONLY_PARENT = opt('parent');
const FETCH = args.includes('--fetch');
const stripTags = (h) => String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

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
  let n = 0, upheld = 0, errors = 0, short = 0, fetchFailed = 0, fetchAttempts = 0;
  // The ManualClear marker stops the rebuild's CV pre-pass re-promoting a stale
  // contentVerification.wrongProduction === true back onto the file.
  const clearActions = (c, description) => [
    { type: 'review-field-edit', file: `${c.show.id}/${c.file}`, field: 'wrongProduction', oldValue: true, newValue: false, description },
    { type: 'review-field-edit', file: `${c.show.id}/${c.file}`, field: 'wrongProductionManualClear', oldValue: null, newValue: true, description },
  ];
  for (const c of cands) {
    if (LIMIT && n + fetchAttempts >= LIMIT) break;
    let text = c.d.fullText;
    let fetched = false;
    if (!text || text.trim().length < 200) {
      // BRO-6946: stored text is a stub. Metadata cannot clear the flag; with
      // --fetch, pull the live page and verify that text instead (never stored).
      const m = shortCandidateDecision(c.show, c.d);
      if (m.decision !== 'fetch' || !FETCH) { short++; console.log(`[SHORT-HOLD] ${c.show.id}/${c.file} (${c.parent}) ${m.decision === 'fetch' ? 'run with --fetch to verify' : m.why}`); continue; }
      fetchAttempts++;
      fetched = true;
      let why = '';
      try {
        const scraper = require('./lib/scraper');
        const page = await scraper.fetchPage(c.d.url);
        const moved = page && page.finalUrl && page.finalUrl.replace(/[?#].*$/, '').replace(/\/$/, '') !== c.d.url.replace(/[?#].*$/, '').replace(/\/$/, '');
        if (moved || (scraper.wasUrlMismatch && scraper.wasUrlMismatch(c.d.url))) why = 'redirected or URL mismatch';
        else text = stripTags((page && page.content) || '').slice(0, 20000);
      } catch (e) { why = `fetch error: ${String(e.message).slice(0, 80)}`; }
      if (!why && text.trim().length < 800) why = 'fetched text too short to be an article';
      if (why) { short++; fetchFailed++; console.log(`[SHORT-HOLD] ${c.show.id}/${c.file} (${c.parent}) ${why}`); continue; }
    }
    n++;
    let cv;
    try {
      cv = await verifyContent({
        scrapedText: text, showTitle: c.show.title, criticName: c.d.criticName || null,
        outletName: c.d.outlet || null, url: c.d.url || null, venue: c.show.venue || null,
        openingDate: c.show.openingDate || null, publishDate: c.d.publishDate || null,
        market: c.show.category || 'broadway', show: c.show,
      });
    } catch (e) { errors++; console.log(`[ERROR] ${c.show.id}/${c.file}: ${e.message}`); continue; }
    const clean = isCleanVerdict(cv);
    console.log(`[${clean ? 'CLEAR' : 'UPHELD'}] ${c.show.id}/${c.file} (${c.parent}) valid=${cv?.isValid} wp=${cv?.wrongProduction}`);
    if (!clean) { upheld++; continue; }
    const description = `${fetched ? 'BRO-6946 (verified on live-fetched text): ' : ''}BRO-6923: ${c.show.venue} is a stage inside ${c.parent}; the flag reason named the building. Alias-aware re-verify: valid, not wrong production.`;
    actions.push(...clearActions(c, description));
  }
  console.log(`SUMMARY: verified=${n} clear=${actions.length / 2} upheld=${upheld} errors=${errors} tooShortHeld=${short} fetchFailed=${fetchFailed}`);
  // 24 actions (12 files) per chunk: plans split at 25 and a file's two edits stay together.
  for (let i = 0, k = 1; i < actions.length; i += 24, k++) {
    console.log(`PLAN-ACTIONS-BEGIN ${k}`);
    console.log(JSON.stringify(actions.slice(i, i + 24)));
    console.log('PLAN-ACTIONS-END');
  }
})();
