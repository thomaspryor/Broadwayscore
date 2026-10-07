#!/usr/bin/env node
/**
 * Sweep stale wrongProduction=true flags off review-text files that are
 * actually substantial individual critic reviews of THIS production.
 * Identified by `isLikelyStaleWrongProduction()` from
 * scripts/lib/review-guards.js, then verified by an LLM second-opinion
 * (Sonnet) before the flag is cleared. Bulk-override is UNSAFE for this
 * flag — most ~15k flagged files are CORRECTLY flagged (tour reviews,
 * regional tryouts, prior revivals, cross-Atlantic transfers).
 *
 * Background: Notion 34e637c5-416f-811d, Session 5 of multi-flag stale
 * audit. Predecessors: isRoundupArticle (817b), wrongShow (8121),
 * suspectedMisattribution (81b8), wrongAttribution (no stale cohort).
 *
 * Default mode runs an LLM second-opinion (Anthropic Claude Sonnet) per
 * candidate. Predicate alone has ~88% precision (manual sample 8/9);
 * LLM lifts to ~95%+. The sweep sets `wrongProduction = false` directly
 * (so the bare gate checks at is-scoreable.js:12, review-guards.js
 * isIncludableForRebuild, and llm-scoring/is-scoreable.ts:15 also pass without further refactor)
 * AND writes `wrongProductionManualClear = true` as a durable breadcrumb
 * so future audit/restore-protected-fields don't re-flag the file.
 *
 * Usage:
 *   node scripts/clear-stale-wrong-production-flags.js              # dry-run, predicate only
 *   node scripts/clear-stale-wrong-production-flags.js --llm        # dry-run + LLM second-opinion
 *   node scripts/clear-stale-wrong-production-flags.js --llm --apply  # write to disk
 *   node scripts/clear-stale-wrong-production-flags.js --show=ID    # filter to one show
 *   node scripts/clear-stale-wrong-production-flags.js --opened-within-days=21  # recent shows only (daily run)
 *   node scripts/clear-stale-wrong-production-flags.js --dir=PATH   # alt review-texts dir
 *
 * Without --llm the predicate is the only gate. NOT RECOMMENDED for
 * apply-mode — the flag's signal is weak and bulk-override is risky.
 *
 * Surge guard (card #1610, 2026-08-19): refuses to clear more than
 * FIX_SURGE_THRESHOLD files in one run without --force-bulk. This flag is
 * scheduled weekly (clear-stale-wrong-production-flags.yml, card #1917,
 * always --apply) and writes unattended to the private review-texts corpus —
 * a spike this size usually means the predicate or the LLM verification
 * regressed, not routine catch-up drift.
 */
const fs = require('fs');
const path = require('path');
const { isLikelyStaleWrongProduction, isReviewWithinOwnProductionWindow } = require('./lib/review-guards');
const { isGarbageContent, classifyContentTier } = require('./lib/content-quality');
const {
  isCollectorWrongProductionCandidate,
  classifyPriorRunWrongProduction,
  restoreQuarantinedText,
  resetWrongContentTier,
  stampCollectorWpRejection,
  priorRunVerdictHash,
} = require('./lib/collector-wp-release');
const { buildPriorRunHint } = require('./lib/content-verifier');
const { CLAUDE_SONNET } = require('./lib/models');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');

const FIX_SURGE_THRESHOLD = 50;
// Pre-LLM ceiling — catches a predicate regression BEFORE burning a paid,
// rate-limited (1/sec) Sonnet call per candidate. Set well above the observed
// 2026-08-19 baseline (150 candidates) since the predicate's own precision is
// only ~88% (most legitimate weekly runs will have candidates > FIX_SURGE_THRESHOLD
// but well under this).
const PREDICATE_SURGE_THRESHOLD = 400;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const USE_LLM = args.includes('--llm');
const FORCE_BULK = args.includes('--force-bulk');
const SHOW_FILTER = (args.find(a => a.startsWith('--show=')) || '').split('=')[1] || '';
const DIR_OVERRIDE = (args.find(a => a.startsWith('--dir=')) || '').split('=')[1] || '';
const SHOWS_OVERRIDE = (args.find(a => a.startsWith('--shows=')) || '').split('=')[1] || '';
// --opened-within-days=N: only shows whose earliest date (previews/opening)
// is within the last N days. The weekly Saturday sweep leaves a false flag set
// on opening weekend in place for up to 7 days — past the newsletter send and
// the opening-night broadcast (BRO-4185: Table 17 / First Night was flagged
// Saturday evening, hours after that week's sweep).
const OPENED_WITHIN_DAYS = parseInt((args.find(a => a.startsWith('--opened-within-days=')) || '').split('=')[1] || '', 10) || 0;

if (APPLY && !USE_LLM) {
  console.error('REFUSED: --apply requires --llm. Predicate alone is too weak for wrongProduction.');
  console.error('       Re-run with both flags, or use --apply on isLikelyStaleWrongShow / isLikelyStaleRoundupFlag instead.');
  process.exit(1);
}

const REVIEW_TEXTS_DIR = DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_JSON = SHOWS_OVERRIDE || path.join(__dirname, '..', 'data', 'shows.json');

const showsRaw = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = Object.create(null);
for (const s of showsArr) if (s && s.id) showById[s.id] = s;

function openedWithinDays(show, days) {
  const earliest = [show.previewsStartDate, show.openingDate].filter(Boolean).sort()[0];
  const t = Date.parse(earliest || '');
  if (Number.isNaN(t)) return false;
  const age = (Date.now() - t) / 86400000;
  return age >= -7 && age <= days;
}

const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
  .map(d => d.name)
  .sort();

let scanned = 0;
let flagged = 0;
let predicateMatches = 0;
let collectorMatches = 0;
let llmConfirmed = 0;
let llmRejected = 0;
let llmErrors = 0;
let cleared = 0;
const candidates = [];
// wrongProduction files dated inside a declared priorRuns/tourLegs window,
// by classifyPriorRunWrongProduction bucket (only 'candidate' is re-checked).
const priorRunBuckets = { candidate: [], ensemble: [], operator: [], settled: [], 'no-text': [], other: [] };

for (const showId of showDirs) {
  if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
  const show = showById[showId];
  if (!show) continue;
  if (OPENED_WITHIN_DAYS && !openedWithinDays(show, OPENED_WITHIN_DAYS)) continue;
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  let files;
  try {
    files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
  } catch { continue; }
  for (const f of files) {
    scanned++;
    const filePath = path.join(showDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (data.wrongProduction !== true) continue;
    flagged++;
    if (isLikelyStaleWrongProduction(data, show)) {
      predicateMatches++;
      candidates.push({ showId, file: f, filePath, data, show, kind: 'stale' });
      continue;
    }
    // BRO-4185 C: the collector's own LLM flag, text quarantined in
    // wrongFullText, dated inside this show's run. Same Sonnet check below,
    // on the quarantined text.
    if (isCollectorWrongProductionCandidate(data, show, {
      inOwnWindow: isReviewWithinOwnProductionWindow,
      isGarbage: (t) => isGarbageContent(t).isGarbage,
    })) {
      collectorMatches++;
      candidates.push({ showId, file: f, filePath, data, show, kind: 'collector-quarantined' });
      continue;
    }
    // Collector flags on reviews dated inside a DECLARED earlier run / tour
    // leg (show.priorRuns / show.tourLegs). The collector's verifier was not
    // told about those runs, so it called them a different production. Same
    // Sonnet check, with the declared runs in the prompt. Other flag sources
    // in those windows are reported, never cleared here: operator free-text
    // reasons stand, and an ensemble rejection needs a rescore, not an override.
    const pr = classifyPriorRunWrongProduction(data, show, {
      isGarbage: (t) => isGarbageContent(t).isGarbage,
    });
    if (!pr) continue;
    priorRunBuckets[pr.bucket].push(`${showId}/${f}`);
    if (pr.bucket === 'candidate') {
      candidates.push({ showId, file: f, filePath, data, show, kind: 'collector-prior-run', textField: pr.textField, text: pr.text });
    }
  }
}

// BRO-4185 C: at most this many collector candidates (quarantined or
// prior-run) per run, newest first. Keeps a backlog drain inside
// FIX_SURGE_THRESHOLD and the daily/weekly Sonnet budget; the rest wait for
// the next run.
const COLLECTOR_PER_RUN_CAP = 25;
const isCollectorKind = (c) => c.kind === 'collector-quarantined' || c.kind === 'collector-prior-run';
{
  const collector = candidates.filter(isCollectorKind);
  if (collector.length > COLLECTOR_PER_RUN_CAP) {
    // Prior-run candidates first: they are dated years before the current
    // run by definition, so newest-first alone would starve them forever.
    const priorRunFirst = (c) => (c.kind === 'collector-prior-run' ? 0 : 1);
    const keep = new Set(collector
      .sort((a, b) => priorRunFirst(a) - priorRunFirst(b)
        || (Date.parse(b.data.publishDate) || 0) - (Date.parse(a.data.publishDate) || 0))
      .slice(0, COLLECTOR_PER_RUN_CAP));
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (isCollectorKind(candidates[i]) && !keep.has(candidates[i])) candidates.splice(i, 1);
    }
    console.log(`Collector candidates capped at ${COLLECTOR_PER_RUN_CAP} of ${collector.length} this run (prior-run first, then newest).`);
  }
}

// The text the LLM judges: the quarantined copy for collector-quarantined,
// the classifier's pick for collector-prior-run, the live text otherwise.
function candidateText(c) {
  if (c.kind === 'collector-quarantined') return c.data.wrongFullText;
  if (c.kind === 'collector-prior-run') return c.text;
  return c.data.fullText;
}

async function llmVerify(c) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — re-run without --llm or export the key');
  }
  const { stripConsentLayerPrefix } = require('./lib/text-cleaning');
  const fullText = stripConsentLayerPrefix(String(candidateText(c) || ''));
  const excerpt = fullText.length > 4000 ? fullText.slice(0, 4000) + '\n[…truncated]' : fullText;
  // Declared earlier runs / tour legs of this production (empty when none).
  const priorRunHint = buildPriorRunHint(c.show.priorRuns, c.show.tourLegs);
  const prompt = `You are auditing whether a review-text file is a real review of a SPECIFIC theatrical PRODUCTION (not just the same play in a different production).

Show: "${c.show.title}"
Show ID: ${c.show.id}
Opening date: ${c.show.openingDate || '(unknown)'}
Closing date: ${c.show.closingDate || '(open run)'}
Show category: ${c.show.category || '(unknown)'}
Show venue: ${c.show.venue || '(unknown)'}
Review URL: ${c.data.url}
Review publish date: ${c.data.publishDate || '(unknown)'}
Critic: ${c.data.criticName || '(unknown)'}
Outlet: ${c.data.outlet || c.data.outletId || '(unknown)'}

Full text excerpt:
---
${excerpt}
---

Question: Is this review of THIS specific production — the one that opened ${c.show.openingDate}${c.show.venue ? ' at ' + c.show.venue : ''}${priorRunHint ? ', or one of its declared earlier runs / tour legs listed below' : ''}? Consider:
- Cross-Atlantic transfers (e.g., West End original vs Broadway transfer = DIFFERENT productions)
- Regional tryouts (e.g., Boston Huntington pre-Broadway tryout = DIFFERENT production)
- Revivals (e.g., 2003 Wicked Broadway opening vs 2024 national tour = DIFFERENT productions)
- Prior productions of same play (e.g., 2008 Lincoln Center Macbeth vs 2022 Daniel Craig Macbeth)
- Concert / staged-reading versions (City Center Encores, etc.) vs full production
- Preview/opening reviews of THIS run = SAME production${priorRunHint}

Also: is this an individual critic's review (an evaluation of the production), as opposed to a preview, interview, news item, feature or listing?

Reply with JSON only: {"isThisProduction": true|false, "isReview": true|false, "confidence": "high"|"medium"|"low", "reason": "<one sentence>"}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM call failed: ${res.status} ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json.content && json.content[0] && json.content[0].text) || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`LLM response not parseable: ${text.slice(0, 200)}`);
  const verdict = JSON.parse(m[0]);
  // A parseable but malformed verdict (e.g. `{}`) is a verification error, not a rejection (BRO-2432).
  if (!verdict || typeof verdict.isThisProduction !== 'boolean') {
    throw new Error(`LLM verdict missing boolean isThisProduction: ${m[0].slice(0, 200)}`);
  }
  return verdict;
}

(async () => {
  if (candidates.length > PREDICATE_SURGE_THRESHOLD && !FORCE_BULK) {
    console.error(`::error::Refusing to run LLM verification on ${candidates.length} predicate matches (> ${PREDICATE_SURGE_THRESHOLD}). This usually means isLikelyStaleWrongProduction regressed, not routine catch-up drift — burning a paid LLM call per candidate before checking would waste budget on a bad predicate. Investigate the predicate, then re-run with --force-bulk if the matches are legitimate.`);
    process.exit(1);
  }

  const decisions = [];
  if (USE_LLM) {
    console.log(`Running LLM second-opinion on ${candidates.length} candidates (rate-limited 1/sec)...`);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const v = await llmVerify(c);
        // STRICTER than wrongShow sweep — require HIGH confidence for wrongProduction
        // because the false-clear cost is leaking actual wrong-production reviews
        // back into scoring (wrong-production noise is much more common than wrong-show).
        // Collector-quarantined candidates also need a positive review verdict:
        // the collector quarantines previews/interviews too, and the release
        // restores their text into scoring (ship-check P0).
        const verdict = v.isThisProduction === true && v.confidence === 'high'
          && (!isCollectorKind(c) || v.isReview === true);
        decisions.push({ c, v, verdict });
        if (verdict) llmConfirmed++; else llmRejected++;
        console.log(`  ${i + 1}/${candidates.length} ${c.showId}/${c.file} → ${verdict ? 'CONFIRMED' : 'rejected'} (${v.confidence}: ${v.reason})`);
      } catch (e) {
        decisions.push({ c, v: null, verdict: false, error: e.message });
        llmRejected++;
        llmErrors++;
        console.log(`  ${i + 1}/${candidates.length} ${c.showId}/${c.file} → ERROR: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } else {
    for (const c of candidates) decisions.push({ c, v: null, verdict: true });
  }

  // Fail LOUD, not quiet, on a total LLM outage (task/ship-check finding,
  // card #1917): every candidate erroring (API down, key revoked, etc.) was
  // previously indistinguishable from a legitimate "nothing confirmed" run —
  // both print "Would clear: 0" and exit 0. That was tolerable when this
  // script only ever ran attended; scheduled unattended (clear-stale-wrong-
  // production-flags.yml, weekly) it would silently look like a clean no-op
  // week after week during an outage instead of tripping the workflow's
  // existing failure/notify path.
  if (USE_LLM && candidates.length > 0 && llmErrors === candidates.length) {
    console.error(`::error::All ${llmErrors} LLM verification call(s) errored (see ERROR lines above) — this looks like a total API outage or bad credential, not routine rejections. Refusing to report a false "nothing to clear" result. Investigate ANTHROPIC_API_KEY / API status, then re-run.`);
    process.exit(1);
  }

  const toClear = decisions.filter(d => d.verdict);

  console.log('');
  console.log(`Scanned: ${scanned} files`);
  console.log(`wrongProduction=true: ${flagged}`);
  console.log(`Predicate matches: ${predicateMatches}`);
  console.log(`Collector-quarantined candidates: ${collectorMatches}`);
  console.log(`Declared prior-run/tour-leg window flags: ${Object.entries(priorRunBuckets).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
  // Report-only buckets: never cleared by this sweep.
  for (const [bucket, label] of [
    ['ensemble', 'ensemble rejections inside a declared window (need a rescore with prior-run context, not an override)'],
    ['operator', 'operator/audit reasons inside a declared window (report only, owner review)'],
    ['no-text', 'collector flags inside a declared window with no usable text'],
  ]) {
    if (priorRunBuckets[bucket].length === 0) continue;
    console.log(`  ${label}:`);
    for (const k of priorRunBuckets[bucket]) console.log(`    ${k}`);
  }
  if (USE_LLM) {
    console.log(`LLM confirmed stale (high-conf only): ${llmConfirmed}`);
    console.log(`LLM rejected (genuine wrong-production OR low-conf): ${llmRejected}`);
  }
  console.log(`Would clear: ${toClear.length}`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write changes.\n');
    console.log('Files that would be cleared:');
    for (const d of toClear) console.log(`  ${d.c.showId}/${d.c.file}`);
    return;
  }

  if (toClear.length > FIX_SURGE_THRESHOLD && !FORCE_BULK) {
    console.error(`::error::Refusing to auto-clear ${toClear.length} stale wrongProduction flags (> ${FIX_SURGE_THRESHOLD}). A spike this large usually means the predicate or LLM verification regressed, not routine catch-up drift — auto-clearing would re-admit a flood of reviews to scoring. Investigate the cause, then re-run with --force-bulk if the clears are legitimate.`);
    process.exit(1);
  }

  // Collector-quarantined candidates the LLM did not confirm: stamp the text
  // hash so the next sweep does not re-ask about the same text. Errors are
  // not stamped (retry next run).
  const nowIso = new Date().toISOString();
  for (const d of decisions) {
    if (d.verdict || d.error || !isCollectorKind(d.c)) continue;
    // Re-read: the scan-time copy is minutes old after the LLM calls.
    const orig = fs.readFileSync(d.c.filePath, 'utf8');
    const fresh = JSON.parse(orig);
    // Stamp the hash of the text the LLM actually judged.
    if (d.c.kind === 'collector-prior-run') {
      stampCollectorWpRejection(fresh, nowIso, d.c.text, priorRunVerdictHash(d.c.text, d.c.show));
    } else {
      stampCollectorWpRejection(fresh, nowIso);
    }
    fs.writeFileSync(d.c.filePath, JSON.stringify(fresh, null, 2) + (orig.endsWith('\n') ? '\n' : ''));
  }

  for (const d of toClear) {
    const orig = fs.readFileSync(d.c.filePath, 'utf8');
    const hadTrailingNewline = orig.endsWith('\n');
    // A prior-run candidate judged on its quarantined text restores it, like
    // collector-quarantined; one judged on its live fullText keeps it.
    const restores = d.c.kind === 'collector-quarantined'
      || (d.c.kind === 'collector-prior-run' && d.c.textField === 'wrongFullText');
    const clearNote = d.c.kind === 'collector-prior-run'
      ? `[${nowIso.slice(0, 10)} cleared collector wrongProduction — review dated inside a declared earlier run/tour leg; Sonnet (high-conf, given the declared runs) confirmed it is a review of ${d.c.show.title}${restores ? '; text restored' : ''}]`
      : d.c.kind === 'collector-quarantined'
        ? `[${nowIso.slice(0, 10)} cleared collector wrongProduction — Sonnet (high-conf) confirmed the quarantined text is a review of ${d.c.show.title}; text restored — BRO-4185 C]`
        : `[${nowIso.slice(0, 10)} cleared stale wrongProduction — predicate + Sonnet (high-conf) confirmed real review of ${d.c.show.title} — Notion 34e637c5-416f-811d]`;
    // Apply to a fresh read: the scan-time copy is minutes old after the LLM calls.
    const data = JSON.parse(orig);
    if (data.wrongProduction !== true) continue; // cleared by someone else meanwhile
    // The judged text changed since the scan (re-fetch meanwhile): leave it
    // for the next run rather than clear on a verdict about other text.
    // Re-classify the fresh record too: an operator reason, ensemble rejection
    // or override added during the LLM calls must win over this verdict.
    if (d.c.kind === 'collector-prior-run') {
      const re = classifyPriorRunWrongProduction(data, d.c.show, { isGarbage: (t) => isGarbageContent(t).isGarbage });
      if (!re || re.bucket !== 'candidate' || re.textField !== d.c.textField || re.text !== d.c.text) continue;
    }
    clearWrongProductionFlags(data, { source: 'clear-stale-wrong-production-flags.js', reason: clearNote });
    data.wrongProductionManualClear = true;
    data.wrongProductionClearedNote = clearNote;
    // Tier AFTER the clear: classifyContentTier reads the flag, so a tier
    // computed while wrongProduction was still true came back
    // invalid/"Wrong production" and left that stale tierReason behind.
    if (restores) restoreQuarantinedText(data, classifyContentTier);
    else if (d.c.kind === 'collector-prior-run') resetWrongContentTier(data, classifyContentTier);
    fs.writeFileSync(d.c.filePath, JSON.stringify(data, null, 2) + (hadTrailingNewline ? '\n' : ''));
    cleared++;
  }
  console.log(`\nAPPLIED — cleared ${cleared} files.`);
})().catch(e => { console.error(e); process.exit(1); });
