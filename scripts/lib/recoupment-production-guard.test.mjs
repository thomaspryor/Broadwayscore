// BRO-4623: real wrong-production recoupment matches, and real true positives.
// Show fixtures copy only the shows.json fields the guard reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkRecoupmentProduction,
  applyProductionGuard,
  nonBroadwayMarker,
  extractHeadlines,
  extractPublishedDate,
  datePrecedes,
  urlDate,
  guardRejectionWarning,
} = require('./recoupment-production-guard.js');

const DEATH_OF_A_SALESMAN = { id: 'death-of-a-salesman-2026', slug: 'death-of-a-salesman', status: 'closed', category: 'broadway', previewsStartDate: '2026-03-06', openingDate: '2026-04-09', closingDate: '2026-08-09' };
const BEETLEJUICE_2025 = { id: 'beetlejuice-2025', slug: 'beetlejuice-2025', status: 'closed', category: 'broadway', previewsStartDate: null, openingDate: '2025-10-08', closingDate: '2026-01-03' };
const THE_OUTSIDERS = { id: 'the-outsiders-2024', slug: 'the-outsiders', status: 'open', category: 'broadway', previewsStartDate: '2024-03-16', openingDate: '2024-04-11' };
const OH_MARY = { id: 'oh-mary-2024', slug: 'oh-mary', status: 'open', category: 'broadway', previewsStartDate: '2024-06-26', openingDate: '2024-07-11' };
const EVERY_BRILLIANT_THING = { id: 'every-brilliant-thing-2026', slug: 'every-brilliant-thing', status: 'closed', category: 'broadway', previewsStartDate: '2026-02-21', openingDate: '2026-03-12', closingDate: '2026-08-09' };
const HADESTOWN = { id: 'hadestown-2019', slug: 'hadestown', status: 'open', category: 'broadway', previewsStartDate: '2019-03-22', openingDate: '2019-04-17' };

const positive = (extra) => ({ recouped: true, productionMatch: 'exact', confidence: 'high', ...extra });

test('death-of-a-salesman 2026: the 2012 revival recoupment (Friday run 37083591866) is rejected by date', () => {
  const r = checkRecoupmentProduction({
    show: DEATH_OF_A_SALESMAN,
    verdict: positive({ recoupedDate: '2012-05-16' }),
    url: 'https://www.theatermania.com/broadway/news/broadways-death-of-a-salesman-recoups-capitalizati_56835.html/',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /2012-05-16 is before .* 2026-03-06/);
});

test('beetlejuice-2025: the national tour article (2023-10-30) is rejected by date AND by URL', () => {
  const url = 'https://playbill.com/article/beetlejuice-national-tour-recoups';
  const byDate = checkRecoupmentProduction({ show: BEETLEJUICE_2025, verdict: positive({ recoupedDate: '2023-10-30' }), url });
  assert.equal(byDate.ok, false);
  assert.match(byDate.reason, /2023-10-30 is before .* 2025-10-08/);
  // Even with no date at all, the URL alone says tour.
  const byUrl = checkRecoupmentProduction({ show: BEETLEJUICE_2025, verdict: positive({ recoupedDate: null }), url });
  assert.equal(byUrl.ok, false);
  assert.match(byUrl.reason, /tour production/);
});

test("the-outsiders: Deadline's North American Tour recoupment (weekly run 37151980535) is rejected by headline", () => {
  const r = checkRecoupmentProduction({
    show: THE_OUTSIDERS,
    verdict: positive({ recoupedDate: '2026-05-20', articleDate: '2026-05-20' }),
    url: 'https://deadline.com/2026/05/the-outsiders-broadway-recoup-1236698348/',
    headlines: ["'The Outsiders' Recoups $11 Million North American Tour ... - Deadline"],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /headline is about a tour production/);
});

test('true positives pass: Oh, Mary!, Every Brilliant Thing, Hadestown', () => {
  // commercial.json's own recoupedSource for each (URL dates read too).
  assert.deepEqual(checkRecoupmentProduction({
    show: OH_MARY,
    verdict: positive({ recoupedDate: '2024-11' }),
    url: 'https://deadline.com/2024/11/oh-mary-broadway-recoups-1236186683/',
  }), { ok: true });
  assert.deepEqual(checkRecoupmentProduction({
    show: EVERY_BRILLIANT_THING,
    verdict: positive({ recoupedDate: '2026-05' }),
    url: 'https://playbill.com/article/every-brilliant-thing-recoups-on-broadway',
  }), { ok: true });
  assert.deepEqual(checkRecoupmentProduction({
    show: HADESTOWN,
    verdict: positive({ recoupedDate: '2019-11-11' }),
    url: 'https://deadline.com/2019/11/hadestown-recoup-investment-broadway-1202782727/',
    // the Playbill headline the weekly reconciler matched (run 37151980535)
    headlines: ['Tony Award–Winning Hadestown Recoups on Broadway | Playbill'],
  }), { ok: true });
});

test('a Broadway recoupment headline that also mentions a tour or an Off-Broadway past is not rejected', () => {
  assert.equal(nonBroadwayMarker('Hadestown Recoups on Broadway; National Tour Launches This Fall'), null);
  assert.equal(nonBroadwayMarker('Oh, Mary! Recoups on Broadway After Its Off-Broadway Run'), null);
  assert.equal(nonBroadwayMarker('Hamilton Recoups, Plans Tour'), null);
});

test('tour / West End / Off-Broadway headlines are flagged', () => {
  assert.equal(nonBroadwayMarker('Beetlejuice National Tour Recoups'), 'tour');
  assert.equal(nonBroadwayMarker('Six Recoups in the West End'), 'West End');
  assert.equal(nonBroadwayMarker('Little Shop Recoups Off-Broadway'), 'Off-Broadway');
  assert.equal(nonBroadwayMarker('Wicked North American Tour Has Recouped'), 'tour');
});

// Ship-check finding (BRO-4623): replaying the guard over commercial.json's
// 48 recouped:true entries rejected a real Broadway source, and reviewers
// found the same shape in URL slugs, where textFromUrl() erases the comma
// that kept 'Hamilton Recoups, Plans Tour' passing above.
const STEREOPHONIC = { id: 'stereophonic-2024', slug: 'stereophonic', status: 'closed', category: 'broadway', previewsStartDate: '2024-04-02', openingDate: '2024-04-19' };
const OPERATION_MINCEMEAT = { id: 'operation-mincemeat-2025', slug: 'operation-mincemeat', status: 'open', category: 'broadway', previewsStartDate: '2025-02-15', openingDate: '2025-03-20' };

test('a recoupment that announces a tour or West End run NEXT is still the Broadway recoupment (real stereophonic source)', () => {
  assert.equal(nonBroadwayMarker('Stereophonic Recoups Investment, Will Tour and Play West End in 2025'), null);
  assert.deepEqual(checkRecoupmentProduction({
    show: STEREOPHONIC,
    recoupedDate: '2025-01',
    url: 'https://www.broadwaynews.com/stereophonic-recoups-investment-will-tour-and-play-west-end-in-2025/',
  }), { ok: true });
});

test('URL-slug forms of Broadway recoupments with a tour plan are not rejected', () => {
  for (const slug of [
    'hamilton-recoups-plans-tour',
    'aladdin-recoups-ahead-of-national-tour',
    'hadestown-recoups-on-broadway-national-tour-launches',
    'oh-mary-recoups-as-national-tour-is-announced',
  ]) {
    const r = checkRecoupmentProduction({ show: HADESTOWN, url: `https://example.com/news/${slug}` });
    assert.deepEqual(r, { ok: true }, slug);
  }
});

test('the recoupment clause still catches a non-Broadway recoupment, and a site-name suffix is not a Broadway mention', () => {
  assert.equal(nonBroadwayMarker('Six Recoups in the West End | WhatsOnStage'), 'West End');
  assert.equal(nonBroadwayMarker('Six Recoups in the West End - Broadway News'), 'West End');
  assert.equal(nonBroadwayMarker('The Outsiders Recoups $11,000,000 on North American Tour'), 'tour');
  assert.equal(checkRecoupmentProduction({ show: HADESTOWN, url: 'https://example.com/hadestown-national-tour-recoups' }).ok, false);
});

test("one article's headlines are judged together: a Broadway headline overrides another's soft West End mention, never an explicit tour recoupment", () => {
  const westEndOnly = ['West End Hit Operation Mincemeat Recoups Its Investment'];
  assert.equal(checkRecoupmentProduction({ show: OPERATION_MINCEMEAT, headlines: westEndOnly }).ok, false);
  assert.deepEqual(checkRecoupmentProduction({
    show: OPERATION_MINCEMEAT,
    headlines: [...westEndOnly, 'Operation Mincemeat Recoups on Broadway'],
  }), { ok: true });
  const r = checkRecoupmentProduction({
    show: THE_OUTSIDERS,
    headlines: ["'The Outsiders' Recoups $11 Million North American Tour", "The Outsiders, Broadway's Tony-Winning Musical"],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tour production/);
});

test('the classifier productionType answer is honoured', () => {
  const r = checkRecoupmentProduction({ show: OH_MARY, verdict: positive({ recoupedDate: '2024-11', productionType: 'west-end' }) });
  assert.equal(r.ok, false);
  assert.equal(checkRecoupmentProduction({ show: OH_MARY, verdict: positive({ recoupedDate: '2024-11', productionType: 'broadway' }) }).ok, true);
  assert.equal(checkRecoupmentProduction({ show: OH_MARY, verdict: positive({ recoupedDate: '2024-11', productionType: 'unclear' }) }).ok, true);
});

test('partial dates compare at their own precision; garbage never rejects', () => {
  assert.equal(datePrecedes('2025-10', '2025-11-01'), true);
  assert.equal(datePrecedes('2025-11', '2025-11-20'), false, 'same month as first preview is not provably earlier');
  assert.equal(datePrecedes('2025', '2025-11-20'), false);
  assert.equal(datePrecedes('2024', '2025-01-05'), true);
  assert.equal(datePrecedes('null', '2025-01-05'), false);
  assert.equal(datePrecedes(undefined, '2025-01-05'), false);
});

test('URL-embedded dates are read (deadline.com/2026/05/...)', () => {
  assert.equal(urlDate('https://deadline.com/2026/05/the-outsiders-broadway-recoup-1236698348/'), '2026-05');
  assert.equal(urlDate('https://www.nytimes.com/2026/01/27/theater/outsiders-broadway-musical-profit.html'), '2026-01-27');
  assert.equal(urlDate('https://playbill.com/article/beetlejuice-national-tour-recoups'), null);
});

test('extractHeadlines reads og:title and <title>', () => {
  const html = `<html><head><meta property="og:title" content="&#039;The Outsiders&#039; Recoups $11 Million North American Tour"><title>Deadline</title></head></html>`;
  assert.deepEqual(extractHeadlines(html), ["'The Outsiders' Recoups $11 Million North American Tour", 'Deadline']);
  // raw apostrophes inside a double-quoted attribute (first cut stopped at the first ')
  const raw = `<meta property="og:title" content="'The Outsiders' Recoups $11 Million North American Tour" />`;
  assert.deepEqual(extractHeadlines(raw), ["'The Outsiders' Recoups $11 Million North American Tour"]);
  // playbill.com shape: content= BEFORE property=, many other metas/scripts
  // first. A document-wide regex paired one tag's content with a later tag's
  // property and returned 9KB of <head> as the "headline".
  const playbill = `<meta name="viewport" content="width=device-width"><script>var a="x";</script><title>Every Brilliant Thing Recoups on Broadway | Playbill</title><meta content="article" property="og:type"><meta content="https://playbill.com/article/every-brilliant-thing-recoups-on-broadway" property="og:url"><meta content="Every Brilliant Thing Recoups on Broadway" property="og:title">`;
  assert.deepEqual(extractHeadlines(playbill), ['Every Brilliant Thing Recoups on Broadway', 'Every Brilliant Thing Recoups on Broadway | Playbill']);
});

test('extractPublishedDate reads article:published_time and JSON-LD datePublished (real page shapes)', () => {
  assert.equal(extractPublishedDate('<meta property="article:published_time" content="2012-05-16T15:46:00+00:00">'), '2012-05-16'); // theatermania
  assert.equal(extractPublishedDate('<script type="application/ld+json">{"datePublished":"2023-10-30T09:37:00-04:00"}</script>'), '2023-10-30'); // playbill
  assert.equal(extractPublishedDate('<p>no dates here</p>'), null);
});

test('death-of-a-salesman: the page publish date alone rejects it when the LLM gives no recoupedDate (local run of the fixed scanner)', () => {
  const r = checkRecoupmentProduction({
    show: DEATH_OF_A_SALESMAN,
    verdict: positive({ recoupedDate: null, articleDate: null }),
    url: 'https://www.theatermania.com/broadway/news/broadways-death-of-a-salesman-recoups-capitalizati_56835.html/',
    publishedDate: '2012-05-16',
    headlines: ['Broadway’s Death of a Salesman Recoups Capitalization - TheaterMania.com'],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /published date 2012-05-16/);
});

test('applyProductionGuard fails closed for every consumer gate and keeps the evidence', () => {
  const v = applyProductionGuard(positive({ recoupedDate: '2012-05-16', evidence: 'x' }), { show: DEATH_OF_A_SALESMAN });
  assert.equal(v.recouped, false);
  assert.equal(v.llmRecouped, true);
  assert.equal(v.productionMatch, 'wrong-production');
  assert.match(v.guardReason, /2012-05-16/);
  // No show, or a negative verdict: untouched.
  const neg = { recouped: false, productionMatch: 'exact' };
  assert.equal(applyProductionGuard(neg, { show: DEATH_OF_A_SALESMAN }), neg);
  const noShow = positive({ recoupedDate: '2012-05-16' });
  assert.equal(applyProductionGuard(noShow, { show: null }), noShow);
});

test('guardRejectionWarning: a rejection becomes one ::warning:: line on the run page, a pass prints nothing', () => {
  const url = 'https://playbill.com/article/beetlejuice-national-tour-recoups';
  const rejected = applyProductionGuard(positive({ recoupedDate: '2023-10-30' }), { show: BEETLEJUICE_2025, url, headline: 'Beetlejuice National Tour Recoups' });
  const line = guardRejectionWarning('beetlejuice-2025', url, rejected);
  assert.match(line, /^::warning title=Recoupment production guard%3A beetlejuice-2025::Rejected a recouped=true verdict for beetlejuice-2025: /);
  assert.ok(line.includes(rejected.guardReason.replace(/%/g, '%25')), 'carries the guard reason');
  assert.ok(line.includes(url));
  assert.equal(line.split('\n').length, 1, 'one line: a newline would end the annotation early');
  assert.equal(guardRejectionWarning('x', url, { ...rejected, guardReason: 'a\nb 50%' }).includes('a%0Ab 50%25'), true);
  assert.equal(guardRejectionWarning('giant', url, positive({ recoupedDate: '2026-09' })), null);
  assert.equal(guardRejectionWarning('giant', url, null), null);
});

test('every script that logs a production-guard rejection also emits the annotation', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const scriptsDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const loggers = fs.readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /verdict\.guardReason/.test(fs.readFileSync(path.join(scriptsDir, f), 'utf8')));
  assert.ok(loggers.length >= 3, `expected the scan, poller and reconciler, found ${loggers.join(', ')}`);
  for (const f of loggers) {
    assert.match(fs.readFileSync(path.join(scriptsDir, f), 'utf8'), /guardRejectionWarning\(/, `${f} logs guard rejections but never annotates them`);
  }
});
