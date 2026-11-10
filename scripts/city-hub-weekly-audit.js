#!/usr/bin/env node
'use strict';
/**
 * Weekly dual-model audit of every launched city hub (BRO-7291 class 8). Runs in audit-review-quality.yml (Tuesdays).
 *
 *   node scripts/city-hub-weekly-audit.js [--city=<hub>] [--max-usd=2] [--no-llm] [--dry-run] [--open] [--today=YYYY-MM-DD]
 *
 * --max-usd caps the WHOLE run (split evenly across the hubs audited, then a third per audit mode).
 * --open counts every current finding triage has not settled (ignores last week's "seen" list) and exits 1 when any
 *   remain: the check a weekly card's VERIFY line runs, so it cannot pass just because this week's run saw them.
 *
 * Per launched hub (data/city-hubs.json launched: true), or only --city:
 *   1. unless --no-llm: scripts/audit-city-hub-dual-model.js shows, reviews and coverage (--refresh-days=14), each
 *      capped at a third of --max-usd. Their caches are keyed on a hash of each record, so an unchanged show or review
 *      is never re-billed; a failed or capped call is not cached and is retried next week.
 *   2. the scorecard (all model + local checks) -> findings in classes 1-4 and 6 (scripts/lib/city-hub-weekly.js),
 *      plus class 5 (hand-entered reviews.json rows with no recorded reason, check-manual-entry-provenance.js).
 *   3. NEW findings (not reported last week, not settled in triage.json):
 *        deterministic ones with an exact fix -> a pending-fix plan (new-fix-plan.js --id=bro-7291-<city>-<week>);
 *        all of them -> ONE Linear card per city per week (deduped on the title).
 *   4. data/audit/city-hub-dual/<city>/weekly.json (this week's findings; next week's "seen" list), scorecard.json,
 *      ingest-plan.json (coverage gaps in dispatch-ingest-batch.js format).
 * --dry-run writes nothing outside a report on stdout and files nothing. Exit 0 unless the script itself breaks (or --open, above).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./lib/city-hub-weekly');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const DRY = flag('dry-run');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return d; } };

function runAuditMode(city, mode, maxUsd, extra = []) {
  const r = spawnSync('node', [path.join(__dirname, 'audit-city-hub-dual-model.js'), mode, `--city=${city}`, `--max-usd=${maxUsd}`, `--today=${TODAY}`, ...extra], { encoding: 'utf8', timeout: 25 * 60_000, cwd: ROOT });
  const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join(' | ');
  console.log(`  ${mode}: exit ${r.status} ${tail}`);
  if (r.status !== 0) console.log(`::warning::${city} ${mode} exited ${r.status}`);
}

/** Class 5 rows for this hub's shows. */
function provenanceFor(showIds) {
  const reviews = readJson('data/reviews.json', { reviews: [] });
  const { unprovenancedRows, BASELINE } = require('./check-manual-entry-provenance');
  const base = readJson(BASELINE, { keys: [] }); // read-only: the baseline is hand-maintained
  const { manualEntryKey } = require('./lib/manual-entry-merge');
  const live = unprovenancedRows(reviews.reviews || reviews, base.keys);
  // BRO-7319: rows displaced by a scored twin live in _meta.heldManualEntries; they still count as flagged, once per key.
  const held = ((reviews._meta || {}).heldManualEntries || []).map(manualEntryKey);
  const rows = [...new Set([...live, ...held])].filter((k) => showIds.has(k.split('|')[0]));
  return { unprovenanced: rows.length, rows };
}

function writePlan(city, week, actions) {
  if (!actions.length) return null;
  const id = `bro-7291-${city}-${week.toLowerCase()}`;
  const tmp = path.join(require('os').tmpdir(), `${id}-actions.json`);
  fs.writeFileSync(tmp, JSON.stringify(actions, null, 1));
  const r = spawnSync('node', [path.join(__dirname, 'new-fix-plan.js'), `--id=${id}`, '--force', `--summary=Weekly city-hub audit ${city} ${week}: deterministic findings (title typo, venue every outlet contradicts, later announced closing). Check each against its source before applying.`, `--actions=${tmp}`], { encoding: 'utf8', cwd: ROOT, timeout: 120_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) { console.log(`::warning::${city}: new-fix-plan exited ${r.status}: ${out.slice(-400)}`); return null; }
  const m = out.match(/plan_?id[^0-9a-f]*([0-9a-f]{8}-[0-9a-f-]{27})/i); // new-fix-plan prints "plan_id=<uuid>"
  return { id, planId: m ? m[1] : null };
}

function fileCard(card) {
  if (!process.env.LINEAR_API_KEY) { throw new Error('LINEAR_API_KEY not set: card not filed'); } // throws so the findings stay unseen and next run retries (BRO-7319)
  const brain = path.join(__dirname, 'linear-brain.js');
  const prefix = card.title.split(':')[0];
  const dedup = spawnSync('node', [brain, 'find', prefix], { encoding: 'utf8', timeout: 60_000, cwd: ROOT });
  if (dedup.status === 0 && dedup.stdout && dedup.stdout.trim() !== 'null') { console.log(`  card: "${prefix}" already open, not filed again`); return 'existing'; }
  const c = spawnSync('node', [brain, 'create', card.title, '--priority', '2', '--notes', card.body, '--dispatch'], { encoding: 'utf8', timeout: 400_000, cwd: ROOT });
  if (c.status !== 0) throw new Error(`linear-brain create failed (exit ${c.status}): ${(c.stderr || c.stdout || '').slice(0, 400)}`);
  const m = (c.stderr || '').match(/__BOARD_CARD_ID__=([A-Z]+-\d+)/);
  return m ? m[1] : 'filed';
}

async function auditCity(city, maxUsd) {
  console.log(`== ${city}`);
  if (!flag('no-llm')) {
    const per = (maxUsd / 3).toFixed(2);
    runAuditMode(city, 'shows', per);
    runAuditMode(city, 'reviews', per);
    runAuditMode(city, 'coverage', per, ['--refresh-days=14']);
  }
  // after the child runs: the audit module reads --today from argv, which this script shares
  const M = require('./audit-city-hub-dual-model');
  const L = M.loadCity(city);
  const dir = path.join(ROOT, 'data', 'audit', 'city-hub-dual', city);
  const triage = readJson(`data/audit/city-hub-dual/${city}/triage.json`, { items: {} });
  const sc = M.scorecard(L, triage);
  const findings = W.findingsFromFlags(sc.flags);
  const prev = readJson(`data/audit/city-hub-dual/${city}/weekly.json`, { findingKeys: [] });
  const fresh = W.newFindings(findings, flag('open') ? [] : prev.findingKeys, triage);
  const provenance = provenanceFor(new Set(L.shows.map((s) => s.id)));
  const week = W.isoWeek(TODAY);
  const byClass = Object.fromEntries([1, 2, 3, 4, 6].map((c) => [c, findings.filter((f) => f.cls === c).length]));
  const freshByClass = Object.fromEntries([1, 2, 3, 4, 6].map((c) => [c, fresh.filter((f) => f.cls === c).length]));
  console.log(`  findings ${findings.length} ${JSON.stringify(byClass)}; new ${fresh.length} ${JSON.stringify(freshByClass)}; class 5 unprovenanced ${provenance.unprovenanced}`);
  for (const f of fresh.slice(0, 40)) console.log(`   NEW c${f.cls} ${f.code} ${f.id} [${f.models.join('+')}] ${String(f.detail || '').slice(0, 160)}`);
  const summary = { city, week, today: TODAY, findings: findings.length, byClass, newFindings: fresh.length, newByClass: freshByClass, provenance: provenance.unprovenanced };
  if (DRY) return summary;
  const plan = writePlan(city, week, W.planActions(fresh));
  const card = W.cardFor(city, week, fresh, { planId: plan && (plan.planId ? `${plan.id} (issue_number=${plan.id} plan_id=${plan.planId})` : plan.id), provenance });
  summary.plan = plan;
  let cardFailed = false;
  summary.card = null;
  if (card) {
    const r = await W.fileWithRetry(() => fileCard(card), { attempts: 1 }) /* linear-brain retries 429s itself (5 x 60s); a 2nd attempt only risks a duplicate card and the 90-min job budget */;
    summary.card = r.card;
    if (r.error) { cardFailed = true; summary.cardError = r.error; console.log(`::warning::${city}: card not filed (${r.error.slice(0, 200)}); findings left unseen so next run retries`); }
  }
  fs.mkdirSync(dir, { recursive: true });
  require('./lib/city-hub-dual-audit').writeAuditJson(path.join(dir, 'scorecard.json'), sc);
  await M.writeIngestPlan(L);
  fs.writeFileSync(path.join(dir, 'weekly.json'), `${JSON.stringify({ ...summary, findingKeys: W.seenKeys(findings, fresh, cardFailed), fresh, provenanceRows: provenance.rows }, null, 1)}\n`);
  return summary;
}

async function main() {
  const hubs = readJson('data/city-hubs.json', { hubs: {} }).hubs;
  const launched = Object.entries(hubs).filter(([, h]) => h.launched === true).map(([k]) => k);
  const only = arg('city', null);
  const cities = only ? [only] : launched;
  const maxUsd = Number(arg('max-usd', 2)) / Math.max(1, cities.length); // --max-usd is the whole-run cap
  const out = [];
  for (const c of cities) {
    if (out.length && !DRY) await new Promise((r) => setTimeout(r, 5000)); // space Linear calls between hubs (429s, BRO-7319)
    try { out.push(await auditCity(c, maxUsd)); } catch (e) { console.log(`::warning::${c}: ${e.message}`); out.push({ city: c, error: e.message }); }
  }
  console.log(`[city-hub-weekly] ${out.map((s) => `${s.city}: ${s.error ? `ERROR ${s.error}` : `${s.newFindings} new`}`).join('; ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### City hub dual-model audit\n${out.map((s) => `- ${s.city}: ${s.error ? `error ${s.error}` : `${s.findings} findings, ${s.newFindings} new, class 5 ${s.provenance}${s.card ? `, card ${s.card}` : ''}${s.cardError ? `, CARD NOT FILED (${String(s.cardError).slice(0, 120)}), findings left unseen for next run` : ''}`}`).join('\n')}\n`);
  }
  if (out.some((s) => s.cardError)) process.exitCode = 1; // surface unfiled cards (job is continue-on-error, so this only marks the step)
  // --open is the weekly card's VERIFY: it fails while any finding is unsettled (or a hub could not be audited)
  if (flag('open') && out.some((s) => s.error || s.newFindings > 0 || s.provenance > 0)) process.exit(1);
}

module.exports = { auditCity };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
