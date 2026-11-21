#!/usr/bin/env node
/**
 * Audit data/critic-consensus.json for false-balance framing: generated
 * "Critics' Take" text that grammatically implies a real critical split
 * (hedge clauses, "divided"/"polarized" language) when the show's own
 * bucketBreakdown shows critics overwhelmingly agreed.
 *
 * Background (Linear BRO-164): scripts/generate-critic-consensus.js already
 * has two sentiment guards (Layer 5b) that block the extremes — 100%
 * positive text using hedge words, and >=50% negative+mixed text claiming
 * "universal acclaim". Neither guard fires in between: a show with a
 * dominant majority (e.g. 90% positive) and a small minority (e.g. 10%
 * mixed, 0% negative) can still get hedge language ("though some find...")
 * that reads as a real division. Example: the-comedy-about-spies-west-end-2026
 * — 37 positive / 4 mixed / 0 negative (90% majority) — generated text:
 * "...though some find the puns groanworthy and the formula wearing thin."
 * That clause gives a 10% minority (4 of 41 reviews) the same grammatical
 * weight as a genuine split, which is the false-balance framing BRO-164
 * flags. This audit surfaces every consensus record with the same pattern
 * so they can be queued for regeneration; it does not itself regenerate.
 *
 * Companion to scripts/audit-critic-consensus-contamination.js (which checks
 * staleness/orphans, not framing). See Notion 3b2637c5-416f-81ce-bafe-d8c9e5f60433.
 *
 * Usage:
 *   node scripts/audit-false-balance.js          # human report
 *   node scripts/audit-false-balance.js --json
 *   node scripts/audit-false-balance.js --strict # warn = fail
 *
 * Signals:
 *   STRONG_SPLIT_LANGUAGE_VS_MAJORITY (fail) — text uses "divided" /
 *     "polarized" / "split opinion" / "critics disagree" (language that
 *     implies a near-even split) while one bucket holds >= 65% of reviews.
 *   HEDGE_VS_NEAR_UNANIMOUS           (fail/warn) — text uses a softer hedge
 *     ("though/but some...", "a few critics...", "others found...") while
 *     the non-majority buckets combined are a small minority of reviews:
 *       <= 10% minority share -> fail
 *       <= 20% minority share -> warn
 *
 * Thresholds chosen against live data (2026-08-26, 1,092 consensus records
 * with a bucketBreakdown and reviewCount >= 5):
 *   - STRONG_SPLIT_LANGUAGE_VS_MAJORITY @ 65%: 59 hits — "divided"/"polarized"
 *     language paired with a two-thirds-plus majority is not a close call;
 *     lower majorities (real near-even splits, e.g. 25 positive/7 mixed/3
 *     negative) correctly do NOT fire.
 *   - HEDGE_VS_NEAR_UNANIMOUS fail @ <=10% minority: 123 hits, including the
 *     BRO-164 reference case (comedy-about-spies, 9.8% minority).
 *   - HEDGE_VS_NEAR_UNANIMOUS warn @ 10-20% minority: 113 hits.
 *   This is a systemic generator gap (documented in generate-critic-consensus.js
 *   Layer 5b), not a rare data-corruption bug like the contamination audit's
 *   signals — a high hit count here is expected and is the point: it scopes
 *   how many existing records need regeneration once the generator's
 *   proportional-hedge guard ships. Not wired to --gate (test.yml) for that
 *   reason; run manually or in a non-blocking digest workflow.
 *
 * NOT included: cross-checking bucketBreakdown itself against reviews.json
 * (staleness) — that's audit-critic-consensus-contamination.js's job. This
 * audit trusts bucketBreakdown as recorded and only checks the TEXT against it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONSENSUS_FILE = path.join(ROOT, 'data', 'critic-consensus.json');

const FAIL_SIGNALS = new Set([
  'STRONG_SPLIT_LANGUAGE_VS_MAJORITY',
  'HEDGE_VS_NEAR_UNANIMOUS_FAIL',
]);

const MIN_REVIEWS_FOR_AUDIT = 5;
const STRONG_SPLIT_MAJORITY_THRESHOLD = 0.65;
const HEDGE_FAIL_MINORITY_THRESHOLD = 0.10;
const HEDGE_WARN_MINORITY_THRESHOLD = 0.20;

const STRONG_SPLIT_RE = /\b(divided|polarized|split (?:opinion|reception|verdict)|decidedly mixed|critics disagree|split down the middle)\b/i;
const HEDGE_RE = /\b(though|but|however|while|yet)\s+(some|a few|others|a handful|certain critics)\b/i;
const OTHER_HEDGE_RE = /\b(some critics|a few critics|others (?:found|felt|criticized|panned|disliked|argued)|some find|some found|some feel|some felt)\b/i;

function loadCriticConsensus() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONSENSUS_FILE, 'utf-8'));
    return raw.shows || {};
  } catch {
    return null;
  }
}

function classify(consensus) {
  const bd = consensus.bucketBreakdown;
  if (!bd) return null;
  const positive = bd.positive || 0;
  const mixed = bd.mixed || 0;
  const negative = bd.negative || 0;
  const total = positive + mixed + negative;
  if (total < MIN_REVIEWS_FOR_AUDIT) return null;

  const majorityCount = Math.max(positive, mixed, negative);
  const majorityShare = majorityCount / total;
  const minorityShare = 1 - majorityShare;

  const text = consensus.text || '';
  const hasStrongSplit = STRONG_SPLIT_RE.test(text);
  const hasHedge = HEDGE_RE.test(text) || OTHER_HEDGE_RE.test(text);

  const flags = [];

  if (hasStrongSplit && majorityShare >= STRONG_SPLIT_MAJORITY_THRESHOLD) {
    flags.push(`STRONG_SPLIT_LANGUAGE_VS_MAJORITY:majorityShare=${majorityShare.toFixed(2)}`);
  }

  if (hasHedge) {
    if (minorityShare <= HEDGE_FAIL_MINORITY_THRESHOLD) {
      flags.push(`HEDGE_VS_NEAR_UNANIMOUS_FAIL:minorityShare=${minorityShare.toFixed(2)}`);
    } else if (minorityShare <= HEDGE_WARN_MINORITY_THRESHOLD) {
      flags.push(`HEDGE_VS_NEAR_UNANIMOUS_WARN:minorityShare=${minorityShare.toFixed(2)}`);
    }
  }

  return { flags, majorityShare, minorityShare, breakdown: { positive, mixed, negative } };
}

function audit() {
  const showsMap = loadCriticConsensus();
  if (showsMap === null) throw new Error(`Cannot read or parse ${CONSENSUS_FILE}`);

  const issues = [];

  for (const [id, c] of Object.entries(showsMap)) {
    if (!c || typeof c !== 'object' || !c.text) continue;

    const result = classify(c);
    if (!result || result.flags.length === 0) continue;

    const hasFail = result.flags.some(f => FAIL_SIGNALS.has(f.split(':')[0]));
    issues.push({
      id,
      text: c.text.length > 160 ? c.text.slice(0, 160) + '…' : c.text,
      breakdown: result.breakdown,
      severity: hasFail ? 'fail' : 'warn',
      flags: result.flags,
    });
  }

  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'fail' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function main() {
  const issues = audit();
  const json = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');

  if (json) {
    process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
  } else {
    const fails = issues.filter(i => i.severity === 'fail');
    const warns = issues.filter(i => i.severity === 'warn');
    console.log(`[audit-false-balance] ${fails.length} fail, ${warns.length} warn\n`);
    for (const i of issues) {
      console.log(`  [${i.severity}] ${i.id} (positive=${i.breakdown.positive}, mixed=${i.breakdown.mixed}, negative=${i.breakdown.negative})`);
      for (const f of i.flags) console.log(`     ${f}`);
      console.log(`     text: ${i.text}`);
    }
  }

  const fails = issues.filter(i => i.severity === 'fail').length;
  const warns = issues.filter(i => i.severity === 'warn').length;

  if (fails > 0 || (strict && warns > 0)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  audit,
  classify,
  FAIL_SIGNALS,
  MIN_REVIEWS_FOR_AUDIT,
  STRONG_SPLIT_MAJORITY_THRESHOLD,
  HEDGE_FAIL_MINORITY_THRESHOLD,
  HEDGE_WARN_MINORITY_THRESHOLD,
};
