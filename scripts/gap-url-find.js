#!/usr/bin/env node
'use strict';
/**
 * gap-url-find.js — READ-ONLY method-by-method yield test for finding the
 * original url of NO_URL reviews (BRO-7171 owner challenge, 2026-11-09).
 * Runs EVERY method on each sampled review, fetches each found url, and runs
 * the real acceptance gate in decide-only mode (plus the LLM identity check
 * when that is the only missing proof). Writes nothing to review files; the
 * driver's URL_FIND strategy does the real, locked, ledgered writes.
 *
 *   node scripts/gap-url-find.js --sample=30 --out=/tmp/x.json
 *   node scripts/gap-url-find.js --keys=show/file.json,... --methods=WAYBACK_CDX,AGG_LINK
 *   node scripts/gap-url-find.js --from-batch=<owner-batch.json> --group=PAYWALL_NO_ACCESS
 *
 * Options: --allow-paid (SERP + Bright Data fetch), --no-llm, --max-cands=3
 */
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const os = require('os');
const path = require('path');
const UF = require('./lib/gap-url-find');
const L = require('./lib/gap-recovery-ledger');
const LEDGER = L.ledgerPathDefault();
const RUN_ID = `probe-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${process.pid}`;

const argv = process.argv.slice(2);
// --out=PATH: the yield report (JSON), never a review file.
const REPORT_OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || null;
const arg = (n, d = null) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const ROOT = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Stratified sample: round-robin over outlets (largest first), spreading years. Pure. */
function stratifiedSample(rows, n) {
  const byOutlet = new Map();
  for (const r of rows) { if (!byOutlet.has(r.outletId)) byOutlet.set(r.outletId, []); byOutlet.get(r.outletId).push(r); }
  for (const l of byOutlet.values()) l.sort((a, b) => String(a.year).localeCompare(String(b.year)) || a.reviewKey.localeCompare(b.reviewKey));
  const outlets = [...byOutlet.keys()].sort((a, b) => byOutlet.get(b).length - byOutlet.get(a).length || a.localeCompare(b));
  const out = [];
  for (let round = 0; out.length < n && round < 50; round++) {
    for (const o of outlets) {
      const l = byOutlet.get(o);
      if (!l.length) continue;
      // Second and later picks of an outlet only for big outlets, from the other end of its year range.
      if (round > 0 && l.length < 10) continue;
      out.push(round % 2 ? l.pop() : l.shift());
      if (out.length >= n) break;
    }
  }
  return out;
}

async function main() {
  require('./lib/load-env').loadEnv(ROOT);
  const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
  const dir = process.env.REVIEW_TEXTS_DIR || resolveReviewTextsDir();
  const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'));
  const shows = new Map((showsRaw.shows || showsRaw).map((s) => [s.id, s]));
  const registryRaw = readJson(path.join(ROOT, 'data', 'outlet-registry.json'));
  const registry = registryRaw.outlets || registryRaw;
  const methods = (arg('methods') || UF.METHODS.join(',')).split(',');
  const allowPaid = flag('allow-paid');
  const useLlm = !flag('no-llm');
  const maxCands = parseInt(arg('max-cands', '3'), 10);

  let keys;
  if (arg('keys')) keys = arg('keys').split(',');
  else {
    const batch = readJson(arg('from-batch') || path.join(os.homedir(), '.broadwayscore-state', 'gap-recovery', 'owner-batch-2026-11-09.json'));
    const groups = (arg('group') || 'NOT_FINDABLE').split(',');
    keys = groups.flatMap((g) => (batch.items[g] || []).map((i) => i.reviewKey));
  }
  let rows = keys.map((k) => {
    const review = readJson(path.join(dir, k));
    return { reviewKey: k, review, outletId: review.outletId, year: (k.match(/-(\d{4})\//) || [])[1] || '0000' };
  });
  if (arg('sample')) rows = stratifiedSample(rows, parseInt(arg('sample'), 10));
  console.log(`${rows.length} review(s); methods ${methods.join(',')}; paid ${allowPaid ? 'ON' : 'off'}; LLM ${useLlm ? 'on' : 'off'}`);

  if (methods.includes('COMMON_CRAWL')) {
    try { UF.setCcCollections(JSON.parse(await UF.defaultDeps().fetchText('https://index.commoncrawl.org/collinfo.json', { timeoutMs: 60000 }))); } catch (e) { console.log(`  common crawl index list unavailable: ${e.message}`); }
  }
  console.log('building corpus index ...');
  const corpus = UF.buildCorpusIndex(dir, (id) => (shows.get(id) || {}).title);

  const { recoverReviewTextVerified, pageHeadline } = require('./lib/gap-acceptance');
  const serpKeys = { scrapingBeeKey: process.env.SCRAPINGBEE_API_KEY || '', brightDataKey: process.env.BRIGHTDATA_TOKEN || '' };
  const results = [];
  const fetched = new Map();
  for (const [i, row] of rows.entries()) {
    const { review } = row;
    const show = shows.get(review.showId || row.reviewKey.split('/')[0]) || null;
    const title = (show && show.title) || review.showTitle || row.reviewKey.split('/')[0];
    const ce = corpus.get(review.outletId) || { urls: [], samples: [] };
    const profile = UF.learnOutletProfile(ce.urls);
    const hosts = UF.outletHosts(review.outletId, profile, registry);
    if (!profile.hosts.length) profile.hosts = hosts.slice(0, 2);
    const ctx = { review: { ...review, showId: review.showId || row.reviewKey.split('/')[0] }, show, title, profile, hosts,
      archiveDir: path.join(ROOT, 'data', 'aggregator-archive'), templates: UF.learnSlugTemplates(ce.samples), titleDirs: UF.learnTitleStartDirs(ce.samples), serpKeys, allowPaid };
    console.log(`\n[${i + 1}/${rows.length}] ${row.reviewKey}  "${title}"  ${review.criticName || '?'}  pub ${review.publishDate || '-'}  hosts ${hosts.join(',')}  prefixes ${profile.prefixes.join(',') || '-'}`);
    const rec = { reviewKey: row.reviewKey, outletId: review.outletId, year: row.year, category: show && show.category, source: review.source, methods: {} };
    for (const m of methods) {
      const r = await UF.runMethod(m, ctx);
      const mr = { found: r.candidates.length, tried: r.tried.slice(0, 4), error: r.error, verified: null, candidates: [] };
      for (const c of r.candidates.slice(0, maxCands)) {
        let v = fetched.get(`${row.reviewKey}|${c.url}`);
        if (!v) {
          const got = await UF.fetchCandidateText(c.url, { allowBd: allowPaid });
          v = { url: c.url, fetch: got.tried, ok: false, code: got.ok ? null : 'fetch_failed' };
          if (got.ok) {
            const d = await recoverReviewTextVerified({
              filePath: path.join(dir, row.reviewKey), rawText: got.rawText, url: c.url, expectUrl: review.url || null,
              headline: pageHeadline(got.html), pageDate: require('./lib/gap-acceptance').pagePublishDate(got.html, c.url), pageByline: require('./lib/gap-acceptance').pageByline(got.html, review.outletId), labels: { fetchMethod: 'x', sourceMethod: 'x' }, dryRun: true, show, ctxOpts: { reviewTextsDir: dir },
            });
            v.code = d.code; v.reason = String(d.reason || '').slice(0, 160); v.ok = d.ok; v.len = got.rawText.length; v.via = got.via;
            if (d.code === 'dry_run_needs_llm' && useLlm) {
              const { verifyMovedReview, cleanCandidateText } = require('./lib/gap-acceptance');
              const cleaned = cleanCandidateText(got.rawText, { url: c.url, showId: ctx.review.showId });
              const ok = await verifyMovedReview({ filePath: path.join(dir, row.reviewKey), show, showId: ctx.review.showId, cleanedText: cleaned.text, newUrl: c.url, log: () => {} });
              v.llm = ok; v.ok = ok; v.code = ok ? 'accepted_after_llm' : 'llm_refused';
            }
          }
          fetched.set(`${row.reviewKey}|${c.url}`, v);
        }
        mr.candidates.push(v);
        if (v.ok && !mr.verified) mr.verified = c.url;
      }
      rec.methods[m] = mr;
      console.log(`  ${m.padEnd(15)} found ${String(mr.found).padStart(3)}  verified ${mr.verified ? 'YES ' + mr.verified : 'no'}${mr.error ? `  err ${mr.error}` : ''}${mr.candidates.length && !mr.verified ? `  [${mr.candidates.map((x) => x.code).join(',')}]` : ''}`);
    }
    results.push(rec);
    if (REPORT_OUT) fs.writeFileSync(REPORT_OUT, JSON.stringify(results, null, 1));
    // Every probe reaches the attempts ledger (non_evidence: never a cooldown).
    if (!flag('no-ledger')) L.appendRows([UF.probeLedgerRow(rec, { runId: RUN_ID })], LEDGER);
  }
  if (!flag('no-ledger') && L.manualRunShouldPublish({ dryRun: false, ledgerPath: LEDGER })) {
    try {
      require('./lib/gap-recovery-publish').publishLedgers({
        repoDir: ROOT,
        files: [{ rel: path.join('data', 'audit', 'gap-recovery-attempts.jsonl'), localPath: LEDGER }],
        message: `data: gap-recovery url-find probe ledger (${RUN_ID}) [skip ci]\n\nBRO-7171: read-only probe rows, published by plumbing.`,
        attempts: 3,
        log: (m) => console.log(`[ledger publish] ${m}`),
      });
    } catch (e) { console.error(`[ledger publish] FAILED: ${e.message} (rows stay in ${LEDGER}; the nightly publishes them)`); }
  }
  // Yield table.
  console.log('\nmethod           found  verified  yield');
  for (const m of methods) {
    const f = results.filter((r) => r.methods[m] && r.methods[m].found).length;
    const v = results.filter((r) => r.methods[m] && r.methods[m].verified).length;
    console.log(`${m.padEnd(16)} ${String(f).padStart(5)} ${String(v).padStart(9)}  ${Math.round((100 * v) / results.length)}%`);
  }
  const any = results.filter((r) => Object.values(r.methods).some((x) => x.verified)).length;
  console.log(`any method verified: ${any}/${results.length}`);
  return 0;
}

module.exports = { stratifiedSample };
if (require.main === module) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error('FATAL:', e.stack || e.message); process.exitCode = 1; })
    .finally(() => {
      let cleanup = null;
      try { if (require.cache[require.resolve('./lib/scraper')]) cleanup = require('./lib/scraper').cleanup; } catch { /* none */ }
      Promise.resolve(cleanup ? cleanup().catch(() => {}) : null).finally(() => process.exit(process.exitCode || 0));
    });
}
