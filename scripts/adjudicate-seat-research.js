#!/usr/bin/env node

/**
 * Adjudicate Seat Research
 *
 * Fact-checks seat-guidance research JSON against its cited evidence URLs.
 * For each section's rationale + hazards, fetches every evidenceUrl and asks
 * Claude whether the claims are actually supported by the source text.
 *
 * Purpose: catch fabrication or over-reach before populating theater-metadata.json.
 * Flags claims that look invented or that stretch what sources say.
 *
 * Usage:
 *   node scripts/adjudicate-seat-research.js /tmp/majestic-research.json
 *   node scripts/adjudicate-seat-research.js /tmp/majestic-research.json --output=/tmp/majestic-audit.json
 *
 * Exit codes:
 *   0  — all sections STRONG/MODERATE support
 *   2  — one or more sections UNSUPPORTED (review before merging)
 *   1  — script error
 */

import fs from 'fs';
import pathMod from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = pathMod.dirname(__filename);
const ROOT = pathMod.resolve(__dirname, '..');

// Load .env so ANTHROPIC_API_KEY is available.
// Check worktree root first, then main repo (worktrees don't copy .env).
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return true;
}
try {
  loadEnvFile(pathMod.join(ROOT, '.env'))
    || loadEnvFile('/Users/tompryor/Broadwayscore/.env');
} catch {}

const { fetchPage } = require('./lib/scraper');

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_EVIDENCE_CHARS = 2000;
const CACHE_DIR = '/tmp/seat-evidence-cache';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY missing. Source it from .env or set manually.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cachePath(url) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const safe = Buffer.from(url).toString('base64').replace(/[/+=]/g, '_').slice(0, 120);
  return pathMod.join(CACHE_DIR, safe + '.txt');
}

async function fetchEvidence(url) {
  const cp = cachePath(url);
  if (fs.existsSync(cp)) {
    const text = fs.readFileSync(cp, 'utf8');
    return { url, text, cached: true };
  }
  try {
    const result = await fetchPage(url, {});
    if (!result) return { url, error: 'no_response' };
    // fetchPage returns { content, format, source } — content is HTML or text depending on source
    const raw = result.content || result.html || result.text || '';
    const text = stripHtml(raw).slice(0, 20000);
    if (!text || text.length < 100) return { url, error: 'empty_content', rawBytes: raw.length };
    fs.writeFileSync(cp, text);
    return { url, text };
  } catch (e) {
    return { url, error: String(e?.message || e).slice(0, 200) };
  }
}

async function adjudicateSection(section, theaterName) {
  const sectionUrls = section.evidenceUrls || [];
  const hazardUrls = (section.hazards || []).flatMap(h => {
    // Support both h.evidenceUrl (single) and h.evidenceUrls (array)
    return h.evidenceUrl ? [h.evidenceUrl] : (h.evidenceUrls || []);
  });
  const allUrls = [...new Set([...sectionUrls, ...hazardUrls])];

  console.log(`\n─── ${section.name} [${section.verdict}] ───`);
  console.log(`   URLs to fetch: ${allUrls.length}`);

  const evidence = [];
  for (const url of allUrls) {
    const e = await fetchEvidence(url);
    evidence.push(e);
    if (e.cached) process.stdout.write('.');
    else if (e.error) process.stdout.write('✗');
    else process.stdout.write('+');
  }
  console.log('');

  const validEvidence = evidence.filter(e => e.text);
  const failed = evidence.filter(e => e.error);

  if (validEvidence.length === 0) {
    return {
      section: section.name,
      verdict: section.verdict,
      error: 'no_evidence_fetched',
      failed_urls: failed.map(e => ({ url: e.url, error: e.error })),
    };
  }

  const claims = [];
  if (section.rationale) claims.push({ kind: 'rationale', text: section.rationale });
  for (const h of (section.hazards || [])) {
    const desc = `${h.type}${h.note ? ': ' + h.note : ''}`;
    claims.push({ kind: 'hazard', text: desc });
  }
  // v2 structured fields — audit these as claims too
  if (section.bestRow) {
    claims.push({
      kind: 'bestRow',
      text: `The single sweetest row within ${section.rowRange || 'this section'} is ${section.bestRow}.`,
    });
  }
  if (section.rowRange) {
    claims.push({
      kind: 'rowRange',
      text: `The section spans rows ${section.rowRange}.`,
    });
  }
  if (section.bestFor && section.bestFor.length > 0) {
    claims.push({
      kind: 'bestFor',
      text: `This section is best suited for these show types: ${section.bestFor.join(', ')}.`,
    });
  }
  if (section.worstFor && section.worstFor.length > 0) {
    claims.push({
      kind: 'worstFor',
      text: `This section should be skipped for these show types: ${section.worstFor.join(', ')}.`,
    });
  }
  if (section.isValuePick) {
    claims.push({
      kind: 'valuePick',
      text: `This section is THE best-value pick for the theater (bang-for-buck beats other sections at this house).`,
    });
  }

  const evidenceBlock = validEvidence
    .map((e, i) => `[EVIDENCE ${i + 1}] ${e.url}\n${e.text.slice(0, MAX_EVIDENCE_CHARS)}`)
    .join('\n\n');

  const claimsBlock = claims.map((c, i) => `CLAIM ${i + 1} (${c.kind}): ${c.text}`).join('\n');

  const prompt = `You are auditing seat-guidance claims against aggregated audience reports and seat-review sites for broadwayscorecard.com.

THEATER: ${theaterName}
SECTION: ${section.name}${section.rowRange ? ' (rows ' + section.rowRange + ')' : ''}
VERDICT: ${section.verdict}

CLAIMS TO AUDIT:
${claimsBlock}

EVIDENCE (${validEvidence.length} sources fetched):

${evidenceBlock}

${failed.length > 0 ? `UNFETCHED URLs: ${failed.length} (source list incomplete)\n` : ''}

For each claim, rate how well the evidence supports it:
- STRONG: multiple evidence sources clearly support this exact claim
- MODERATE: at least one source supports, OR closely related context (not verbatim but consistent)
- WEAK: plausible but no direct support in the evidence
- UNSUPPORTED: no source mentions this, OR evidence contradicts it — likely fabricated

FIELD-SPECIFIC RULES (apply by claim kind):

- kind=rationale: standard STRONG/MODERATE/WEAK/UNSUPPORTED per above.

- kind=hazard: a hazard claim needs a source that mentions the specific issue
  (overhang, pillar, sound dead-spot, etc.). If the hazard has a note with a
  specific row/seat, that specificity must come from a source.

- kind=bestRow: STRICT. "Row X is the sweetest" is UNSUPPORTED unless a source
  explicitly says (verbatim or paraphrased): "Row X is best," "Row X is the
  sweet spot," "sit in Row X," or equivalent. Geometric inference (e.g., "Row
  X is the middle of the range") is UNSUPPORTED — not good enough. If a
  source says "Row H or I," the specific row claimed ("Row H") is MODERATE at
  most.

- kind=rowRange: STRONG if a source explicitly defines this range OR if
  multiple sources consistently locate the section at these rows. MODERATE if
  the range is close but slightly wider/narrower than evidence supports.
  UNSUPPORTED if evidence contradicts (e.g., evidence says A-B, claim says
  A-D).

- kind=bestFor: the "best for these show types" claim needs evidence tying
  the section to specific show characteristics (dance, scale, intimate drama,
  spectacle). A source talking about how the section is good for sound does
  NOT support "best for dance-heavy shows." MODERATE if the genre label is
  reasonable given the section's known strengths; UNSUPPORTED if no source
  discusses genre suitability at all and it's pattern-matched from general
  knowledge.

- kind=worstFor: same rule as bestFor.

- kind=valuePick: needs evidence that the section offers better
  price-per-experience than other sections at THIS theater. STRONG if a
  source explicitly calls it a steal / value pick / great for budget.
  MODERATE if evidence supports the section is good AND its priceTier is
  lower than the sweet-spot section. UNSUPPORTED if no source addresses the
  value proposition.

Also rate the overall VERDICT support (is ${section.verdict} the right verdict given the evidence?).

Flag concerning patterns in "warnings":
- "all evidence from one site" (weak diversity)
- "evidence contradicts verdict" (bigger problem)
- "bestRow is geometric inference, no source names that row"
- "bestFor/worstFor genre tags not supported by show-type discussion in evidence"
- "claim about specific seat/row that no source mentions" (fabrication risk)

Respond ONLY with compact JSON, no prose before or after:
{"claims":[{"i":1,"support":"STRONG|MODERATE|WEAK|UNSUPPORTED","note":"..."}],"verdict_support":"STRONG|MODERATE|WEAK|UNSUPPORTED","confidence":0.XX,"warnings":["..."]}`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const txt = msg.content.find(c => c.type === 'text')?.text || '';
  const jsonMatch = txt.match(/\{[\s\S]+\}/);
  if (!jsonMatch) {
    return {
      section: section.name,
      verdict: section.verdict,
      error: 'parse_fail',
      raw: txt.slice(0, 500),
    };
  }

  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) {
    return { section: section.name, verdict: section.verdict, error: 'json_invalid', raw: jsonMatch[0].slice(0, 500) };
  }

  return {
    section: section.name,
    verdict: section.verdict,
    rowRange: section.rowRange,
    claims_audited: claims.length,
    urls_fetched: validEvidence.length,
    urls_failed: failed.length,
    verdict_support: parsed.verdict_support,
    confidence: parsed.confidence,
    claim_results: parsed.claims,
    warnings: parsed.warnings || [],
    claims_full: claims.map((c, i) => ({
      ...c,
      support: parsed.claims?.find(x => x.i === i + 1)?.support,
      note: parsed.claims?.find(x => x.i === i + 1)?.note,
    })),
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: adjudicate-seat-research.js <research.json> [--output=path]');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Not found: ${inputPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const theaterName = data.theater || pathMod.basename(inputPath, '.json');
  const sections = data.sections || [];

  console.log(`\n═══ Adjudicating ${theaterName} (${sections.length} sections) ═══`);

  const results = [];
  for (const section of sections) {
    try {
      const r = await adjudicateSection(section, theaterName);
      results.push(r);
      if (r.error) {
        console.log(`   → ERROR: ${r.error}`);
      } else {
        console.log(`   → verdict=${r.verdict_support} confidence=${r.confidence}`);
        if (r.warnings?.length) {
          r.warnings.forEach(w => console.log(`      ⚠  ${w}`));
        }
        const unsupported = r.claim_results?.filter(c => c.support === 'UNSUPPORTED').length || 0;
        const weak = r.claim_results?.filter(c => c.support === 'WEAK').length || 0;
        if (unsupported > 0) console.log(`      ❌ ${unsupported} UNSUPPORTED claim(s)`);
        if (weak > 0) console.log(`      ⚠  ${weak} WEAK claim(s)`);
      }
    } catch (e) {
      console.error(`   → Exception: ${e.message}`);
      results.push({ section: section.name, error: 'exception', message: e.message });
    }
  }

  // Output
  const outArg = process.argv.find(a => a.startsWith('--output='));
  const outPath = outArg
    ? outArg.slice(9)
    : inputPath.replace(/\.json$/, '-audit.json');

  const report = {
    theater: theaterName,
    adjudicatedAt: new Date().toISOString(),
    model: MODEL,
    sections_total: sections.length,
    sections_audited: results.filter(r => !r.error).length,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n📝 Audit report: ${outPath}`);

  // Summary
  const byLevel = { STRONG: 0, MODERATE: 0, WEAK: 0, UNSUPPORTED: 0, ERROR: 0 };
  for (const r of results) {
    if (r.error) byLevel.ERROR++;
    else byLevel[r.verdict_support] = (byLevel[r.verdict_support] || 0) + 1;
  }
  const totalWarnings = results.reduce((sum, r) => sum + (r.warnings?.length || 0), 0);
  const unsupportedClaims = results.reduce((sum, r) =>
    sum + (r.claim_results?.filter(c => c.support === 'UNSUPPORTED').length || 0), 0);

  console.log('\n═══ SUMMARY ═══');
  for (const [lvl, n] of Object.entries(byLevel)) if (n > 0) console.log(`   ${lvl.padEnd(12)} ${n}/${results.length}`);
  console.log(`   warnings     ${totalWarnings}`);
  console.log(`   UNSUPPORTED claims: ${unsupportedClaims}`);

  if (byLevel.UNSUPPORTED > 0 || byLevel.ERROR > 0) {
    console.error('\n❌ Adjudication flagged issues — review before merging to theater-metadata.json');
    process.exit(2);
  }
  console.log('\n✅ Adjudication complete');
}

main().catch(e => { console.error(e); process.exit(1); });
