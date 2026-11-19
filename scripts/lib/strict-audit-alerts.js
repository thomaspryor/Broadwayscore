'use strict';
/**
 * strict-audit-alerts.js (BRO-7182)
 *
 * Worker-card decisions for six advisory --strict audits that ran under
 * continue-on-error with nothing but a red step (hygiene rule (ad),
 * findStrictAdvisoryWithoutAlert). Each script takes --alert and passes its
 * findings to the decide function here; routeAuditDecisions() does the I/O.
 *
 * Every function is pure and built on buildAuditAlert (disposition auto,
 * warning, 20h cooldown; a clean run resolves the key). Missing input (zero
 * files scanned, no archive, no rebuild exclusion lists, an unreadable file)
 * returns [] so an outage never closes a real card.
 *
 * Rows carry ids, file paths, numbers, flags and URLs only: never review text,
 * never reader data.
 */
const { buildAuditAlert } = require('./audit-alert');

const KEYS = Object.freeze({
  siblingCast: 'sibling-production-cast:live-hits',
  utcShift: 'utc-shifted-publish-dates:found',
  ukShowScore: 'uk-show-score-audience:on-us-shows',
  commercialContamination: 'commercial-contamination:strict',
  imageSourceRejected: 'image-source-rejected:in-use',
  appliedFixPlans: 'applied-fix-plans:no-includable-row',
  crossShowUrlFlags: 'cross-show-url-flags:unreviewed',
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * audit-sibling-production-cast.js (default mode). --strict fails on scored hits only.
 * @param {{scanned:number, hits:Array<{showId,file,assignedScore,siblingId}>}} out
 */
function decideSiblingCastAlert(out) {
  if (!out || !(out.scanned > 0)) return [];
  const live = (out.hits || []).filter((h) => h && h.assignedScore != null);
  return [buildAuditAlert({
    conditionKey: KEYS.siblingCast,
    rows: live.map((h) => `${h.showId}/${h.file}: score ${h.assignedScore}, names the cast of ${h.siblingId}`),
    title: (n) => `Wrong production: ${plural(n, 'scored review names', 'scored reviews name')} only a sibling production's cast`,
    intro: 'The daily corpus-drift run found scored reviews whose text names only the cast or creatives of a same-title production from another year (BRO-5499: the Sea Wall 2026 page held the 2019 review).',
    hint: 'For each row read the review and confirm the production. If it is the other production, set wrongProduction with a reason through a data/pending-fixes plan (node scripts/new-fix-plan.js). Done when node scripts/audit-sibling-production-cast.js --strict exits 0.',
    resolveReason: 'no scored sibling-cast mismatch',
  })];
}

/**
 * fix-utc-shifted-publish-dates.js --strict (dry run over the whole corpus).
 * @param {{scanned:number, found:Array<{file,publishDate,corrected,source}>}} out
 */
function decideUtcShiftAlert(out) {
  if (!out || !(out.scanned > 0)) return [];
  return [buildAuditAlert({
    conditionKey: KEYS.utcShift,
    rows: (out.found || []).map((r) => `${r.file}: publishDate ${r.publishDate} should be ${r.corrected} (${r.source})`),
    title: (n) => `${plural(n, 'review publishDate is', 'review publishDates are')} one day late (UTC truncation)`,
    intro: 'The daily corpus-drift run found review files whose stored publishDate is the URL permalink date plus one day, from a collector that truncates UTC timestamps (BRO-5499).',
    hint: 'Apply the correction through CI (review-texts is private): a data/pending-fixes plan setting publishDate per row, or run node scripts/fix-utc-shifted-publish-dates.js --apply where review-texts is writable. Done when node scripts/fix-utc-shifted-publish-dates.js --strict exits 0.',
    resolveReason: 'no UTC-shifted publishDate',
  })];
}

/**
 * purge-uk-show-score-audience.js --strict.
 * @param {{plan:Array<{id,score,rc}>, showsCount:number, buzzCount:number, archiveFiles:number}} out
 */
function decideUkShowScoreAlert(out) {
  if (!out || !(out.showsCount > 0) || !(out.buzzCount > 0) || !(out.archiveFiles > 0)) return [];
  return [buildAuditAlert({
    conditionKey: KEYS.ukShowScore,
    rows: (out.plan || []).map((p) => `${p.id}: showScore ${p.score}% on ${p.rc} ratings is the UK page's`),
    title: (n) => `UK Show Score audience data on ${plural(n, 'US show', 'US shows')}`,
    intro: 'The daily corpus-drift run found US shows whose stored Show Score audience rating came from a London Show Score page (the archived page canonical is /uk/...).',
    hint: 'Run node scripts/purge-uk-show-score-audience.js --apply through an approved fix plan or a workflow that writes audience-buzz.json, then check the show pages. Done when node scripts/purge-uk-show-score-audience.js --strict exits 0.',
    resolveReason: 'no UK Show Score data on US shows',
  })];
}

/**
 * audit-commercial-contamination.js --strict (fails on any fail or warn row).
 * @param {{issues:Array<{severity,key,resolvedId,flags}>, recordsCount:number, showsLoaded:boolean}} out
 */
function decideCommercialContaminationAlert(out) {
  if (!out || !out.showsLoaded || !(out.recordsCount > 0)) return [];
  const rows = (out.issues || []).map((i) => `[${i.severity}] ${i.key}${i.resolvedId && i.resolvedId !== i.key ? ` (${i.resolvedId})` : ''}: ${(i.flags || []).join(', ')}`);
  return [buildAuditAlert({
    conditionKey: KEYS.commercialContamination,
    rows,
    title: (n) => `Commercial data: ${plural(n, 'record fails', 'records fail')} the scope/contamination audit`,
    intro: 'The weekly commercial run found data/commercial.json records with impossible numbers, a recoupment contradiction, a key that matches no show, or a show outside Broadway scope.',
    hint: 'For each row fix or remove the record through an approved fix plan (scripts/pending-fix-actions.md); never mark recouped without a citation. Done when node scripts/audit-commercial-contamination.js --strict exits 0.',
    resolveReason: 'no commercial contamination finding',
  })];
}

/**
 * audit-image-source-rejected.js --strict.
 * @param {{rows:Array<{id,format,path,source}>, showsCount:number, sourcesCount:number}} out
 */
function decideImageSourceRejectedAlert(out) {
  if (!out || !(out.showsCount > 0) || !(out.sourcesCount > 0)) return [];
  return [buildAuditAlert({
    conditionKey: KEYS.imageSourceRejected,
    rows: (out.rows || []).map((r) => `${r.id}.${r.format}: ${r.path}, ${r.why || 'recorded from rejected'} ${r.source}`),
    title: (n) => `Show art: ${plural(n, 'image field points', 'image fields point')} at art from a rejected URL`,
    intro: 'The image fetch run found show poster/thumbnail/hero files whose recorded source in data/image-sources.json is one of that show\'s own rejectedImageUrls: wrong-production art, or a hand fix whose source map was never updated.',
    hint: 'For each row look at the image. If it is wrong, clear the field; if it is right, record the real source (or "manual:<note>") in data/image-sources.json. Done when node scripts/audit-image-source-rejected.js --strict exits 0.',
    resolveReason: 'no in-use art from a rejected URL',
  })];
}

/**
 * audit-applied-fix-plans.js --strict (inside rebuild-reviews.yml).
 * @param {{reported:Array<{planFile,file,field,reason}>, plansRead:number, sawRebuild:boolean}} out
 */
function decideAppliedFixPlansAlert(out) {
  // No rebuild exclusion lists means every action was skipped as unknown: nothing was checked.
  if (!out || !out.sawRebuild || !(out.plansRead > 0)) return [];
  return [buildAuditAlert({
    conditionKey: KEYS.appliedFixPlans,
    rows: (out.reported || []).map((r) => `${r.planFile}: cleared ${r.field} on ${r.file}, ${r.reason}`),
    title: (n) => `${plural(n, 'applied fix plan action has', 'applied fix plan actions have')} no review row`,
    intro: 'The rebuild found applied fix plans that cleared an exclusion flag on a review that still has no row in reviews.json. includable-but-absent needs the rebuild path; no-score needs scoring.',
    hint: 'For includable-but-absent rows run node scripts/verify-review-recovery.js --show=<showId> --production and follow the fix it prints; for no-score rows score the review. Done when node scripts/audit-applied-fix-plans.js --strict exits 0 after a rebuild.',
    resolveReason: 'every applied fix plan reached an includable row',
  })];
}

/**
 * audit-cross-show-url-flags.js (BRO-7815). --strict fails on unreviewed suspects:
 * gather "Same URL correctly belongs in" flags the file's own date/title contradicts.
 * @param {{scanned:number, items:Array<{file,otherShowId,reasons}>}} out
 */
function decideCrossShowUrlFlagAlert(out) {
  if (!out || !(out.scanned > 0)) return [];
  return [buildAuditAlert({
    conditionKey: KEYS.crossShowUrlFlags,
    rows: (out.items || []).map((s) => `${s.file}: flagged as belonging to ${s.otherShowId} (${(s.reasons || []).join(', ')})`),
    title: (n) => `${plural(n, 'review', 'reviews')} hidden by a cross-show URL flag the file itself contradicts`,
    intro: 'The daily corpus-drift run found reviews flagged wrongProduction ("Same URL correctly belongs in") whose own date or title points back at the show they sit in.',
    hint: 'Read each text. Wrong flag: clear it with scripts/new-fix-plan.js --review-edit=<file>:wrongProduction=false and run execute-approved-fix.yml. Flag stands: add it to data/audit/cross-show-url-flags-reviewed.json. Done when node scripts/audit-cross-show-url-flags.js --strict exits 0.',
    resolveReason: 'no unreviewed contradicted cross-show URL flags',
  })];
}

module.exports = {
  KEYS,
  decideSiblingCastAlert,
  decideUtcShiftAlert,
  decideUkShowScoreAlert,
  decideCommercialContaminationAlert,
  decideImageSourceRejectedAlert,
  decideAppliedFixPlansAlert,
  decideCrossShowUrlFlagAlert,
};
