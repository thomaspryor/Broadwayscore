#!/usr/bin/env node
/**
 * check-tour-sweep.js (BRO-4931): run a recorded set of Tours To You pages
 * through classifier -> candidate -> buildTourEntry WITHOUT writing and compare
 * each page's outcome class with what the fixture expects.
 *
 *   node scripts/check-tour-sweep.js --expect=tests/fixtures/tour-pages/sweep-2026-10-09.json
 *   node scripts/check-tour-sweep.js --expect=... --live        read the live pages and Wikipedia
 *   node scripts/check-tour-sweep.js --expect=... --only=slug,slug
 *
 * Offline (default) uses the page HTML saved under tests/fixtures/tour-pages/pages/
 * and judges as of the fixture's date, so it is deterministic; a page with no
 * saved HTML is judged only if the classifier can decide it without reading the
 * page (an override or a slug rule), otherwise it is reported as not checked.
 * --live judges as of today. A page whose outcome differs from the expectation
 * today but matches as of the fixture date, among the outcomes that depend on
 * the date, is a warning (time passed); any other difference is a failure.
 * Exit 1 on a failure.
 *
 * Fixture: { asOf: 'YYYY-MM-DD', pages: { <slug>: { expect: <outcome>|[<outcome>], id?, parent?, pageTitle?, note } } }
 * Outcomes are listed in lib/tour-sweep.js. Nothing is written; shows.json is only read.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { evaluateTourPage, compareOutcome } = require('./lib/tour-sweep');
const { classifyTourPage, loadTourPageClasses, overrideProblems, SKIPPED_CLASSES, pageTitleFromHtml } = require('./lib/tour-page-class');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const PAGES_DIR = path.join(ROOT, 'tests', 'fixtures', 'tour-pages', 'pages');
const WIKI_DIR = path.join(ROOT, 'tests', 'fixtures', 'tour-pages', 'wiki');

const USAGE = `check-tour-sweep.js — compare a Tours To You sweep with its expected outcomes (BRO-4931)
  --expect=FILE   fixture (tests/fixtures/tour-pages/sweep-2026-10-09.json)
  --live          read the live pages and Wikipedia (default: saved pages, as of the fixture date)
  --only=a,b      only these page slugs
  --shows=FILE    shows.json to judge against (default data/shows.json)`;

const arg = (argv, name) => ((argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=')) || '';
const readIf = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const noon = iso => new Date(`${iso}T12:00:00Z`);

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const expectFile = arg(argv, 'expect');
  if (!expectFile) { console.error('--expect=FILE is required'); process.exitCode = 2; return; }
  const live = argv.includes('--live');
  const fixture = JSON.parse(fs.readFileSync(path.resolve(expectFile), 'utf8'));
  const only = arg(argv, 'only').split(',').filter(Boolean);
  const showsRaw = JSON.parse(fs.readFileSync(path.resolve(arg(argv, 'shows') || SHOWS_PATH), 'utf8'));
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
  const overrides = loadTourPageClasses();
  const problems = overrideProblems(overrides);
  for (const p of problems) console.log(`override problem: ${p}`);
  let tourSchedules = {};
  try { tourSchedules = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tour-schedules.json'), 'utf8')).tours || {}; } catch { /* none */ }
  const retiredIds = { has: (id) => { try { return require('./lib/retired-show-ids').isRetiredId(id); } catch { return false; } } };

  const asOf = noon(fixture.asOf);
  const today = new Date();
  const now = live ? today : asOf;
  let fetchPageText = null;
  let titles = {};
  let fetchWiki = null;
  let fetchWikiArticle = null;
  if (live) {
    const { politeFetchText } = require('./lib/tours-to-you');
    const { listShowPages } = require('./lib/tour-discovery');
    const listed = await listShowPages(url => politeFetchText(url));
    titles = listed.titles || {};
    fetchPageText = async slug => politeFetchText(`https://tourstoyou.org/shows/${slug}/`);
    ({ fetchWikiText: fetchWiki, fetchWikiArticle } = require('./enrich-tour-dates'));
  } else {
    fetchWiki = async () => '';
    fetchWikiArticle = async () => null;
  }

  const rows = [];
  const slugs = Object.keys(fixture.pages).filter(s => !only.length || only.includes(s));
  for (const slug of slugs) {
    const want = fixture.pages[slug];
    const pageTitle = want.pageTitle || titles[slug] || null;
    let html = null;
    let readError = null;
    // A page the classifier can rule out on the slug or an override alone is not fetched.
    const pre = classifyTourPage({ slug, pageTitle, shows, overrides });
    const ruledOut = SKIPPED_CLASSES.has(pre.class) && pre.source !== 'structure';
    if (ruledOut) html = '';
    else if (live) { try { html = await fetchPageText(slug); } catch (e) { readError = e.message; } }
    else html = readIf(path.join(PAGES_DIR, `${slug}.html`));
    if (html === null) {
      rows.push({ slug, status: readError ? 'fail' : 'skip', want, why: readError ? `could not read the page: ${readError}` : 'no saved page (run with --live)' });
      continue;
    }
    const title = pageTitle || pageTitleFromHtml(html);
    // Saved Wikipedia article offline, if any (first line "<!-- article: NAME -->"); live asks Wikipedia
    // for the title the pipeline would use. The saved text feeds the dates only if it mentions a tour,
    // as fetchWikiText would, and always feeds classification, as fetchWikiArticle would.
    const saved = readIf(path.join(WIKI_DIR, `${slug}.txt`));
    let wikiFor = fetchWiki;
    let articleFor = fetchWikiArticle;
    if (saved !== null) {
      const m = /^<!-- article: (.*) -->\n/.exec(saved);
      const text = saved.replace(/^<!-- article: .* -->\n/, '');
      wikiFor = async () => (/\btour\b/i.test(text) ? text : '');
      articleFor = async () => ({ title: m ? m[1] : null, text });
    }
    const run = at => evaluateTourPage({ slug, pageTitle: title, html, shows, overrides, tourSchedules, retiredIds, now: at, fetchWiki: wikiFor, fetchWikiArticle: articleFor });
    const got = await run(now);
    // The same page as of the fixture date, for telling time passing from a regression.
    const then = live ? await run(asOf) : null;
    const cmp = compareOutcome(want, got, then);
    rows.push({ slug, status: cmp.status, want, got, why: cmp.why });
  }

  const label = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: 'skip' };
  for (const r of rows) {
    const wanted = [].concat(r.want.expect).join('|');
    const detail = r.got && r.got.entry ? ` -> ${r.got.entry.id} (${r.got.entry.tourOf ? `of ${r.got.entry.tourOf}` : 'standalone'}, ${r.got.entry.openingDate}..${r.got.entry.closingDate || 'running'}, ${r.got.entry.status})` : '';
    console.log(`${label[r.status]} ${r.slug}: ${r.got ? r.got.outcome : '-'}${r.status === 'ok' ? '' : ` (expected ${wanted})`}${detail}${r.why ? `\n       ${r.why}` : ''}`);
  }
  const count = s => rows.filter(r => r.status === s).length;
  console.log(`\n${rows.length} page(s): ${count('ok')} ok, ${count('warn')} date-dependent warning(s), ${count('fail')} failure(s), ${count('skip')} not checked${live ? ' (live)' : ` (offline, as of ${fixture.asOf})`}`);
  if (problems.length || count('fail')) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

