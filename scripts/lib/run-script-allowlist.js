'use strict';
// Scripts a pending-fix plan's run-script action may run (execute-approved-fix.js).
// Shared so new-fix-plan.js preflight refuses an unlisted name before the plan
// lands, instead of CI refusing it after (BRO-6742: plan g named
// "scripts/ingest-review-from-url.js" and both actions were refused in CI).
const ALLOWED_SCRIPTS = [
  // BRO-5582: stamp wrongProductionLegacyAudit on legacy wrongProduction flags with no trail.
  // Needs --apply --expect=N in args.
  'backfill-wrongproduction-legacy-audit.js',
  // BRO-5276: delete Theatr audience data attached to shows that closed before
  // Theatr existed, recompute their combined score. Needs --apply in args.
  'neutralize-stale-theatr-buzz.js',
  // BRO-5499: delete Show Score audience data that came from a UK production page on a US show
  // (stored rating must equal the archived UK page's). Needs --apply in args.
  'purge-uk-show-score-audience.js',
  // BRO-5866: delete Show Score data from another production's page (review dates outside this
  // run, or recorded under show-score-urls.json _productionMismatch). Needs --apply in args.
  'purge-wrong-production-show-score.js',
  // BRO-5499: publishDate stored one day late (UTC truncation) -> permalink date; evidence rules in the script.
  'fix-utc-shifted-publish-dates.js',
  // BRO-4779: delete sibling-misfiled aggregator-archive pages (+ tombstone ids).
  // Needs --delete --expect=N; the workflow checks out and pushes the archive.
  'audit-sibling-misfile-archive.js',
  // BRO-6141: delete aggregator-archive pages that fail their own category check (the pages
  // audit-aggregator-archive-integrity --strict reports). Needs --delete --expect=N; same archive checkout/push as above.
  'quarantine-poisoned-aggregator-archive.js',
  // BRO-6690: delete WestEndTheatre archives filed under a non-London show (a West End roundup on a
  // Broadway/off-Broadway row). Needs --delete --expect=N; same archive checkout/push as above.
  'audit-wet-archive-market.js',
  // BRO-4371: repair bwwExcerpt cut at digit-leading outlets from the private BWW archive. Dry run unless
  // --write; --write needs --expect=N and exits nonzero on any refusal or count mismatch.
  'repair-bww-digit-outlets.js',
  'rebuild-all-reviews.js',
  'gather-reviews.js',
  'collect-review-texts.js',
  'generate-critic-consensus.js',
  'validate-data.js',
  'fetch-show-images-auto.js',
  // BRO-4431: session-authored plans can ingest a specific review URL
  // (fans multi-show articles out, retry stub on an unreadable page), re-run
  // the multi-show split on an already-collected article, and re-read a
  // show's theatre.reviews round-up (paywalled rows + star relay).
  'ingest-review-from-url.js',
  'split-multi-show-roundups.js',
  // BRO-6742: re-judge multi-show blog post verdicts made on the whole post (refetches the
  // post; clears only a verdict naming another section's show). Needs --apply --refetch.
  'isolate-multi-show-sections.js',
  'scrape-theatre-reviews.js',
  // BRO-4623: remove id-keyed duplicate commercial records (the fix command
  // the weekly strict gate names). run-script alone triggers no validation;
  // pair it with a data-edit on commercial.json in the same plan so the
  // executor's commercial-record check runs on the touched keys.
  'dedupe-commercial-id-keys.js',
  // BRO-5182: drop pending-review entries commercial.json already covers with a cited
  // record (never writes commercial.json or a recouped flag; rules in lib/pending-commercial-reconcile.js).
  'reconcile-pending-commercial.js',
  // BRO-4947: move review files from a wrong or duplicate outlet id to the canonical one
  // (rules are code, in scripts/lib/outlet-id-migrations.js; conflicts are left in place).
  'migrate-outlet-ids.js',
  // BRO-5133: add a URL to a show's _blocklist.json (a wrong-production review or
  // a news item an aggregator cites) so ingest and the gap audit both skip it.
  // execSync splits args on spaces: pass --reason without spaces.
  'block-review.js',
  // BRO-2851: put a quarantined review body back after its wrong-content flag
  // was released by a human or override (refuses anything else; the plan
  // author must have read the text). One --file per action.
  'restore-released-quarantined-body.js',
  // BRO-5294: queue named multi-review-column rows for a rescore that reads
  // only the target show's section (llm-scoring/venue-box-sections.ts).
  'flag-multishow-column-rescore.js',
  // BRO-5325: file a show's section of a multi-review column stored under
  // another show into its own row (rules: scripts/lib/multishow-section-copy.js;
  // refuses ambiguous sections; --expect-start/--expect-end use `_` for spaces).
  'copy-multishow-section.js',
  // BRO-5243: re-run the content verifier on named rows' stored text after a
  // byline/text fix left a stale verdict. Plans pass --file=<show>/<file>.json
  // (lib/reverify-file-mode.js: flagged rows and excluding verdicts are not written).
  'reverify-stale-cv-promoted.js',
  // BRO-5356: recompute contentTier on named invalid rows whose wrong-content
  // flag was cleared (plans pass --file=<show>/<file>.json --apply).
  'reclassify-invalid-reviews.js',
  // BRO-3139: refetch londontheatre.co.uk review pages once and store the critic's stars
  // (--limit chunks it inside the 5-minute run-script cap; it skips files already done).
  'backfill-london-theatre-stars.js',
  // BRO-4977: re-extract stored review texts that have other articles glued
  // on (refetch + same-article check in scripts/lib/page-bleed-repair.js;
  // queues a rescore for each trimmed file).
  'repair-page-bleed.js',
  'strip-variety-promo-bleed.js', // BRO-5254: strip Variety promo modules from stored texts
  'strip-leading-site-nav.js', // BRO-5859: cut site nav menus / Stage and Cinema footer from stored texts
  // BRO-5080: West End historical rows whose openingDate is a WhatsOnStage
  // first-performance date (221 rows, past the plan action cap). --apply
  // recomputes from live data and is idempotent; rules in
  // scripts/lib/we-historical-dates.js.
  'plan-we-historical-opening-repair.js',
  // BRO-3564: strip westendtheatre excerpts/stars an archived round-up about
  // another show planted (page judged by scripts/lib/aggregator-page-show-guard.js),
  // then delete that archive page. Idempotent.
  'clear-wrong-show-roundup-excerpts.js',
  // BRO-4490: refetch named tier-1.5-cleared rows and keep a star only when the
  // page structure shows it (plans pass --outlet=X --tier15-cleared --execute
  // --files=<show>/<file>.json,...; --limit keeps a chunk inside the 5-minute cap).
  'recollect-for-scores.js',
  // BRO-4490: stamp textFetchedAt on review texts that lack it (git history first,
  // then firstSeenAt/addedAt/collectedAt; plans pass --apply).
  'backfill-text-fetched-at.js',
];

/** Why the executor would refuse this run-script name, or null. */
function runScriptAllowProblem(script) {
  if (ALLOWED_SCRIPTS.includes(script)) return null;
  const hint = typeof script === 'string' && script.startsWith('scripts/') && ALLOWED_SCRIPTS.includes(script.slice(8))
    ? ` (name it "${script.slice(8)}", without the scripts/ prefix)` : '';
  return `Script "${script}" not in allowlist${hint}`;
}

module.exports = { ALLOWED_SCRIPTS, runScriptAllowProblem };
