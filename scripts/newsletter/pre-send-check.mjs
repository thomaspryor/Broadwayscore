// Pre-send validation for the weekly newsletter.
// Catches the class of issues found during the 2026-06-07 newsletter session.
//
// Two tiers:
//   HARD (exit 1, workflow stops): would embarrass us if sent to all subscribers
//     - Missing unsubscribe link
//     - Zero BSC links have UTMs (total tracking blackout)
//     - Lede names a show that never appears in the body (lede ⊆ body)
//     - Featured opening with no show image / phantom image path / empty img src
//   SOFT (warning banner injected into draft HTML): owner sees issues in the
//     preview email and decides whether to fix before broadcasting
//     - Non-empty <title> tag
//     - Pill spans missing inline margin-right
//     - Subject too long / contains em dash / has banned prefix
//     - Lede contains em dash
//     - Too few sections fired / no opening section
//     - Missing preheader
//     - Featured opening whose gap audit shows uncollected reviews — SWAPPED
//       with the next eligible opening and named in the report (never hard-
//       blocks; Coverage Verdict S3, task #905, supersedes task #823's hard
//       fail). `--ack-gap=<showId>` persists a one-show waiver in the
//       t1-scoreboard ack store; `NEWSLETTER_ALLOW_GAPS=1` waives every gap
//       for this run only.
//
// Runs AFTER generate.mjs, BEFORE send-test.mjs in newsletter-draft.yml.
//
// `--fixture=NAME` runs ONLY the coverage-gap swap check against a built-in
// synthetic edition (no real draft files needed) — for verifying the swap
// logic in CI/local without a live newsletter run. `--fixture=gapped` is the
// only fixture today: two openings, one gapped, one clean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { findLedeBodyViolations } = require_('../lib/lede-body-invariant.js');
const {
  missingImageViolations,
  phantomImageViolations,
  countEmptyImgSrc,
  extractSiteImageUrls,
  completenessFindings,
  gapSwapDecisions,
} = require_('../lib/newsletter-preflight.js');
const { loadAcks, isAcked, addAck, saveAcks, cellKey } = require_('../lib/t1-scoreboard.js');

const NEWSLETTER_GAP_NS = 'newsletter-gap'; // namespaced "outletId" in the shared ack store — see t1-scoreboard.js

const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fixtureArg = process.argv.find((a) => a.startsWith('--fixture='));
const ackGapArg = process.argv.find((a) => a.startsWith('--ack-gap='));

if (ackGapArg) {
  const showId = ackGapArg.split('=')[1];
  const acks = addAck(loadAcks(), cellKey(showId, NEWSLETTER_GAP_NS), 'pre-send-check --ack-gap', new Date().toISOString());
  saveAcks(acks);
  console.log(`[pre-send-check] acked coverage gap for "${showId}" — future runs will send it as-is instead of swapping.`);
}

const FIXTURES = {
  gapped: () => ({
    openingShows: [
      { id: 'gapped-show', title: 'The Gapped Musical' },
      { id: 'eligible-show', title: 'The Eligible Play' },
    ],
    checkpoint: {
      'gapped-show': { at: new Date().toISOString(), gaps: 2, uncollected: 2 },
      'eligible-show': { at: new Date().toISOString(), gaps: 0, uncollected: 0 },
    },
  }),
};

if (fixtureArg) {
  const name = fixtureArg.split('=')[1];
  const build = FIXTURES[name];
  if (!build) {
    console.error(`pre-send-check: unknown fixture "${name}" — known: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(1);
  }
  const { openingShows, checkpoint } = build();
  const acks = loadAcks();
  const ackedShowIds = new Set(openingShows.filter((s) => isAcked(cellKey(s.id, NEWSLETTER_GAP_NS), acks)).map((s) => s.id));
  const { swaps, notes } = gapSwapDecisions(openingShows, checkpoint, Date.now(), {
    ackedShowIds,
    allowGaps: process.env.NEWSLETTER_ALLOW_GAPS === '1',
  });
  console.log(`\n=== Pre-send report (fixture: ${name}) ===`);
  if (swaps.length === 0 && notes.length === 0) console.log('No coverage gaps among featured openings.');
  for (const s of swaps) console.log(`SWAP: "${s.from.title}" (${s.from.id}) → "${s.to.title}" (${s.to.id}) — ${s.reason}`);
  for (const n of notes) console.log(`NOTE: ${n}`);
  process.exit(0);
}

const weekStart = positionalArgs[0] || (() => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();

const outDir = process.env.NEWSLETTER_OUT_DIR
  || path.join(process.env.HOME || '', 'Documents/claude-outputs/newsletter-mocks');
const htmlPath = path.join(outDir, `A-${weekStart}.html`);
const metaPath = path.join(outDir, `A-${weekStart}.meta.json`);

if (!fs.existsSync(htmlPath) || !fs.existsSync(metaPath)) {
  console.error(`pre-send-check: missing HTML or meta for week ${weekStart}`);
  process.exit(1);
}

let html = fs.readFileSync(htmlPath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

const hardFailures = [];  // stop the workflow entirely
const softIssues = [];    // inject into draft banner so owner sees them

// ── HARD: unsubscribe placeholder ────────────────────────────────────────────
if (!html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}')) {
  hardFailures.push('Unsubscribe placeholder {{{RESEND_UNSUBSCRIBE_URL}}} is missing — subscribers cannot opt out');
}

// ── HARD: UTM tracking ────────────────────────────────────────────────────────
const bscLinks = [...html.matchAll(/href="(https:\/\/broadwayscorecard\.com[^"]+)"/g)].map(m => m[1]);
const withUtm = bscLinks.filter(u => u.includes('utm_source'));
if (bscLinks.length > 0 && withUtm.length === 0) {
  hardFailures.push('No BSC links have UTM params — total tracking blackout');
} else {
  const missingUtm = bscLinks.filter(u => !u.includes('utm_source') && !u.includes('unsubscribe'));
  if (missingUtm.length > 0) {
    softIssues.push(`${missingUtm.length} BSC link(s) missing UTMs: ${missingUtm.slice(0, 2).map(u => u.replace('https://broadwayscorecard.com', '')).join(', ')}`);
  }
}

// ── SOFT: <title> tag ─────────────────────────────────────────────────────────
const titleMatch = html.match(/<title>([^<]*)<\/title>/);
if (titleMatch && titleMatch[1].trim()) {
  softIssues.push(`<title> is non-empty ("${titleMatch[1].trim()}") — Gmail renders it as visible text`);
}

// ── SOFT: pill inline styles ──────────────────────────────────────────────────
const pillSpans = html.match(/<span class="gp"[^>]*>/g) || [];
const pillsMissingMargin = pillSpans.filter(s => !s.includes('margin-right'));
if (pillsMissingMargin.length > 0) {
  softIssues.push(`${pillsMissingMargin.length} pill span(s) missing inline margin-right — PLAY+REVIVAL will squish`);
}

// ── SOFT: subject checks ──────────────────────────────────────────────────────
const subject = meta.subject || '';
if (!subject) {
  softIssues.push('Subject line is empty');
} else {
  if (subject.length > 80) softIssues.push(`Subject too long: ${subject.length} chars (max 80)`);
  if (subject.includes('—') || subject.includes('—')) softIssues.push('Subject contains em dash');
  if (/^scorecard weekly:/i.test(subject)) softIssues.push('Subject has banned "Scorecard Weekly:" prefix');
}

// ── SOFT: lede checks ─────────────────────────────────────────────────────────
// The lede is the first content block after the "Weekly Round-up · <dates>"
// row (the gold left-border was removed 2026-07-12). Match the lede paragraph
// by its distinctive font-size:14px;line-height:1.55 style instead.
const ledeRaw = html.match(/font-size:14px;line-height:1\.55;color:#d1d5db;">([\s\S]*?)<\/div>/)?.[1] || '';
const ledeText = ledeRaw.replace(/<[^>]+>/g, '').trim();
if (!ledeText) {
  softIssues.push('Lede appears empty');
} else if (ledeText.includes('—') || ledeText.includes('—')) {
  softIssues.push('Lede contains em dash — use comma, period, or parentheses');
}

// ── HARD: lede ⊆ body invariant ───────────────────────────────────────────────
// generate.mjs writes meta.ledeShows = [{id, slug, title}] for every show the
// lede paragraph names. Check each against the REAL body ONLY — everything
// from the `BODY_SECTIONS_START` marker onward (generate.mjs writes it right
// before `${sectionOrder.join('')}`). Earlier attempt stripped just the lede's
// own <div> and checked "the rest of html", but the subject line is echoed
// into a `<!-- SUBJECT: ... -->` HTML comment near the top AND the hidden
// preheader div repeats the first two lede sentences — both sit BEFORE the
// lede's own div and were never stripped, so any show named in the subject or
// first two lede sentences passed even with zero body mentions (caught in
// review 2026-07-26, before this ever shipped). Splitting on the marker
// excludes the subject comment, preheader, header row, AND the lede's own
// paragraph/secondary-paragraph/bullet-strip divs in one shot — only actual
// section-card HTML remains. Catches the class of bug behind two incidents:
// "The Fear of 13 plays final performance" (2026-07-12, closings window bug)
// and "Oh, Mary! recoups" in the West End edition with no recoupment section
// at all (2026-07-26).
const BODY_MARKER = 'BODY_SECTIONS_START';
if (meta.ledeShows?.length && !html.includes(BODY_MARKER)) {
  hardFailures.push(`Lede ⊆ body check cannot run — ${BODY_MARKER} marker missing from HTML (generate.mjs template changed?)`);
} else {
  const bodyOnly = html.includes(BODY_MARKER) ? html.slice(html.indexOf(BODY_MARKER)) : html;
  for (const v of findLedeBodyViolations(meta.ledeShows, bodyOnly)) hardFailures.push(v);
}

// ── HARD: featured-opening images (task #823/#714) ────────────────────────────
// Born 2026-08-02: the checker blessed a WE draft whose top hero card
// (Brainiac Live!) rendered the 🎭 no-image placeholder. Known locally; the
// owner must never be the one catching it.
const repoRoot = path.join(__dirname, '..', '..');
if (!Array.isArray(meta.openingShows)) {
  softIssues.push('meta.openingShows missing — draft was generated by an old generate.mjs; image/completeness gates did NOT run. Re-run refresh-drafts.sh.');
} else {
  // Image present in shows.json at all?
  for (const v of missingImageViolations(meta.openingShows)) hardFailures.push(v);
  // Metadata points at a real file on disk? (phantom-path class, task #714)
  for (const v of phantomImageViolations(meta.openingShows, rel => {
    try { return fs.statSync(path.join(repoRoot, rel)).size > 0; } catch { return false; }
  })) hardFailures.push(v);

  // ── SOFT: review completeness — swap, never block (Coverage Verdict S3,
  // task #905, supersedes task #823's hard fail). A fresh gap entry gets
  // swapped with the next eligible opening (named below); stale/absent
  // entries stay a plain "unverified" banner note.
  let gapCheckpoint = {};
  try { gapCheckpoint = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/audit/gap-audit-checkpoint.json'), 'utf8')); } catch { /* soft path below */ }
  let missingHostsById = {};
  try {
    const audit = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/audit/show-review-gap.json'), 'utf8'));
    for (const r of audit.results || []) {
      if (!r.showId || !Array.isArray(r.missing)) continue;
      // priorRun rows are prior-production URLs the audit keeps report-only
      // (TKAM class) — they're excluded from checkpoint.uncollected, so they
      // must not be named in the failure message either.
      const current = r.missing.filter(m => !m.priorRun);
      if (current.length) {
        missingHostsById[r.showId] = current.map(m => m.host || m.outletId || m.url || String(m)).filter(Boolean);
      }
    }
  } catch { /* hosts are enrichment only */ }
  const gapFindings = completenessFindings(meta.openingShows, gapCheckpoint, Date.now(), { missingHostsById });
  for (const v of gapFindings.soft) softIssues.push(v); // stale/no-data — unverified, not a gap

  const acks = loadAcks();
  const ackedShowIds = new Set(meta.openingShows.filter(s => s && s.id && isAcked(cellKey(s.id, NEWSLETTER_GAP_NS), acks)).map(s => s.id));
  const allowGaps = process.env.NEWSLETTER_ALLOW_GAPS === '1';
  const { swaps, notes } = gapSwapDecisions(meta.openingShows, gapCheckpoint, Date.now(), { ackedShowIds, allowGaps });
  for (const s of swaps) {
    softIssues.push(`COVERAGE SWAP: "${s.from.title}" (${s.from.id}) → "${s.to.title}" (${s.to.id}) — ${s.reason}. HTML still shows "${s.from.title}" as featured; re-run refresh-drafts.sh with the swap applied, or waive with --ack-gap=${s.from.id}.`);
  }
  for (const n of notes) softIssues.push(n);
}
// Any <img src=""> anywhere in the email (movers/closings rows use
// `getImage(...) || ''`) — renders as a broken image in mail clients.
const emptySrcCount = countEmptyImgSrc(html);
if (emptySrcCount > 0) {
  hardFailures.push(`${emptySrcCount} <img> tag(s) with empty src — a show row lost its image entirely.`);
}

// ── SOFT: do the referenced site images actually serve? (best-effort) ─────────
// Catches deploy lag / prod 404s the local file check can't see. Network
// observations are SOFT by design: Vercel bot-challenge or a flaky connection
// must not block the draft, but a 404 on send morning belongs in the banner.
// Skipped when a hard failure already exists — the run is stopping anyway, so
// don't spend up to 40×8s of network time first (ship-check finding).
if (process.env.NEWSLETTER_SKIP_IMAGE_FETCH !== '1' && hardFailures.length === 0) {
  const imgUrls = extractSiteImageUrls(html).slice(0, 40);
  const badImgs = [];
  for (const url of imgUrls) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) badImgs.push(`${url} → ${res.status} ${type || '(no content-type)'}`);
    } catch { /* network error/timeout: unverifiable, stay silent rather than cry wolf */ }
  }
  if (badImgs.length > 0) {
    softIssues.push(`${badImgs.length} image URL(s) not serving as images on prod (deploy lag or 404): ${badImgs.slice(0, 3).join('; ')}`);
  }
}

// ── SOFT: section sanity ──────────────────────────────────────────────────────
const fired = meta.sections.filter(s => s.fired);
if (fired.length < 6) softIssues.push(`Only ${fired.length} sections fired (expected ≥ 6)`);
const hasOpening = meta.sections.some(s =>
  ['broadway-openings', 'offbroadway-openings', 'london-openings'].includes(s.name) && s.fired);
if (!hasOpening) softIssues.push('No opening section fired — newsletter has no main story');

// ── SOFT: preheader ───────────────────────────────────────────────────────────
if (!html.includes('display:none !important') || !html.includes('max-height:0')) {
  softIssues.push('Preheader hidden div appears missing — inbox preview text will be wrong');
}

// ── Hard fail: stop the workflow ──────────────────────────────────────────────
if (hardFailures.length > 0) {
  console.error(`\n🛑 Pre-send HARD FAILURE — workflow stopped:\n`);
  for (const f of hardFailures) console.error(`   · ${f}`);
  if (softIssues.length > 0) {
    console.error(`\n   (also ${softIssues.length} soft issue(s) — fix alongside:)`);
    for (const i of softIssues) console.error(`   · ${i}`);
  }
  process.exit(1);
}

// ── Soft issues: inject warning banner into the draft HTML ────────────────────
if (softIssues.length > 0) {
  console.warn(`\n⚠️  Pre-send issues found (${softIssues.length}) — injecting banner into draft:`);
  for (const i of softIssues) console.warn(`   · ${i}`);
  console.warn('   Owner will see these in the preview email.\n');

  // Emit GitHub Actions annotations so they appear in the workflow summary
  for (const i of softIssues) console.warn(`::warning::Pre-send: ${i}`);

  const issueList = softIssues.map(i => `<li style="margin:2px 0;">${i}</li>`).join('');
  const banner = `
<div style="background:#7c2d12;color:#fef2f2;font-family:monospace;font-size:12px;padding:12px 16px;margin:0 0 0 0;border-bottom:2px solid #dc2626;">
  <strong>⚠️ PRE-SEND ISSUES — fix before broadcasting to subscribers:</strong>
  <ul style="margin:6px 0 0 0;padding-left:20px;">${issueList}</ul>
</div>`;

  // Insert banner right after <body ...>
  html = html.replace(/(<body[^>]*>)/, `$1${banner}`);
  fs.writeFileSync(htmlPath, html);
  console.warn('   Banner injected into draft HTML.\n');
}

// ── All clear ─────────────────────────────────────────────────────────────────
console.log(`\n✓ Pre-send check OK for week ${weekStart}`);
console.log(`  Subject (${subject.length} chars): ${subject}`);
console.log(`  ${fired.length} sections fired`);
if (softIssues.length > 0) console.log(`  ⚠️  ${softIssues.length} soft issue(s) flagged in draft banner`);
process.exit(0);
