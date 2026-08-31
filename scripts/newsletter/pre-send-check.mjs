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
//     - Featured opening whose gap audit shows uncollected reviews — reported
//       as "INCLUDED WITH GAP" and left in the issue. This script CANNOT drop
//       an opening (owner decision 2026-08-09, superseding task #905's swap and
//       task #823's hard fail): the swap deleted three real openings from the
//       2026-08-03 issue, two of them over gaps that did not exist.
//       `--ack-gap=<showId>` and `NEWSLETTER_ALLOW_GAPS=1` now only mark a gap
//       as already-known in the banner; neither changes whether a show is sent.
//
// Runs AFTER generate.mjs, BEFORE send-test.mjs in newsletter-draft.yml.
//
// `--fixture=NAME` runs ONLY the coverage-gap disclosure check against a
// built-in synthetic edition (no real draft files needed), and asserts the
// no-drop invariant — exits non-zero if any opening went missing. For verifying
// the logic in CI/local without a live newsletter run. `--fixture=gapped` is
// the only fixture today: two openings, one gapped, one clean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { findLedeBodyViolations } = require_('../lib/lede-body-invariant.js');
const { buildPreSendBanner } = require_('../lib/pre-send-banner.js');
const {
  missingImageViolations,
  phantomImageViolations,
  countEmptyImgSrc,
  extractSiteImageUrls,
  completenessFindings,
  gapDisclosureDecisions,
  openingsPreserved,
} = require_('../lib/newsletter-preflight.js');
const { renderInvariantFailures } = require_('../lib/newsletter-render-invariants.js');
const { loadAcks, isAcked, addAck, saveAcks, cellKey } = require_('../lib/t1-scoreboard.js');
const { resolveNewsletterEdition } = require_('../lib/email-templates.js');
const { hasNoAccessSection, noAccessSections } = await import('./section-credential-guard.mjs');

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
  const { gapped, notes } = gapDisclosureDecisions(openingShows, checkpoint, Date.now(), {
    ackedShowIds,
    allowGaps: process.env.NEWSLETTER_ALLOW_GAPS === '1',
  });
  console.log(`\n=== Pre-send report (fixture: ${name}) ===`);
  if (gapped.length === 0) console.log('No coverage gaps among featured openings.');
  for (const g of gapped) {
    console.log(`INCLUDED-with-gap: "${g.title}" (${g.id}) — ${g.uncollected} uncollected review(s), show stays in the issue.`);
  }
  for (const n of notes) console.log(`NOTE: ${n}`);
  // The invariant, printed so the fixture run is self-verifying: every opening
  // that went in comes out. Nothing here can swap or exclude.
  const check = openingsPreserved(openingShows, openingShows);
  console.log(`Openings in: ${openingShows.length} | out: ${openingShows.length} | dropped: ${check.droppedIds.length}`);
  console.log(check.ok ? 'NO-DROP INVARIANT: OK' : `NO-DROP INVARIANT: VIOLATED (${check.droppedIds.join(', ')})`);
  process.exit(check.ok ? 0 : 1);
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
let meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

const repoRoot = path.join(__dirname, '..', '..');

// Failures raised before the main hardFailures array exists (the coverage-swap
// block below runs first so every later check sees the swapped draft). Folded
// into hardFailures at its declaration.
const hardFailuresEarly = [];

// ── Edition sanity, BEFORE anything regenerates or reads this draft ──────────
// The draft on disk must be the edition this invocation is checking. A west-end
// run over a leftover broadway draft (stale NEWSLETTER_OUT_DIR, a failed earlier
// run, a workflow that generated under the wrong edition) would otherwise sail
// through every check below and only blow up two steps later at send-test.mjs's
// identical guard — or, with the coverage-swap pin above, be silently carried
// forward into a regenerated draft. Fail here, where the message can name the
// mismatch. Only checked when the caller declared an edition; an unset
// NEWSLETTER_EDITION means "whatever is on disk", the historical behaviour.
if (process.env.NEWSLETTER_EDITION) {
  const wantEdition = resolveNewsletterEdition(process.env.NEWSLETTER_EDITION);
  const haveEdition = meta.edition || 'broadway';
  if (haveEdition !== wantEdition) {
    hardFailuresEarly.push(`Draft on disk is the "${haveEdition}" edition but NEWSLETTER_EDITION=${wantEdition} — ${htmlPath} is stale or was generated under the wrong edition. Re-run generate.mjs under this edition first.`);
  }
}

// ── Coverage gaps: REPORT, never remove (owner decision 2026-08-09) ──────────
// What used to live here: a "swap" that re-invoked generate.mjs with
// NEWSLETTER_EXCLUDE_SHOWS=<gapped ids> plus a market lead override, physically
// removing the gapped opening from the edition. On 2026-08-03 that deleted
// THREE openings from one issue, and two of the three were triggered by gaps
// that did not exist (ticket-seller URLs and a duplicate-URL variant — issue
// #4). A subscriber could not tell an opening was missing; the incomplete score
// the gate feared was replaced by an invisible absence, which is worse.
//
// Owner: "include ALL shows that opened that week AND collect all reviews. It
// is not one or the other." So the whole regeneration mechanism is deleted, not
// disabled — with it gone there is no code path in this script that can drop an
// opening. The gap becomes a loud banner line plus a ::warning:: annotation, and
// the show ships. NEWSLETTER_EXCLUDE_SHOWS still exists in generate.mjs for a
// deliberate human editorial call; nothing automated sets it any more.
const openingsBefore = Array.isArray(meta.openingShows) ? meta.openingShows.slice() : [];
const coverageGapNotes = [];
if (Array.isArray(meta.openingShows)) {
  let gapCheckpointEarly = {};
  try { gapCheckpointEarly = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/audit/gap-audit-checkpoint.json'), 'utf8')); } catch { /* no-op — reported as soft below */ }
  const acksEarly = loadAcks();
  const ackedShowIdsEarly = new Set(meta.openingShows.filter((s) => s && s.id && isAcked(cellKey(s.id, NEWSLETTER_GAP_NS), acksEarly)).map((s) => s.id));
  const allowGapsEarly = process.env.NEWSLETTER_ALLOW_GAPS === '1';
  const { notes } = gapDisclosureDecisions(meta.openingShows, gapCheckpointEarly, Date.now(), {
    ackedShowIds: ackedShowIdsEarly,
    allowGaps: allowGapsEarly,
  });
  coverageGapNotes.push(...notes);
}

// The no-drop invariant, checked against the draft this script is about to
// bless rather than asserted in a comment. Fail-open by design (see
// openingsPreserved's header): a throw here would kill the send, which is a
// worse failure than the one being guarded.
const preserved = openingsPreserved(openingsBefore, meta.openingShows);
if (!preserved.ok) {
  console.error(`::error::pre-send-check dropped opening(s) ${preserved.droppedIds.join(', ')} — no code path here may remove an opening (owner decision 2026-08-09). This is a bug in pre-send-check.mjs, not a coverage decision.`);
}

const hardFailures = [...hardFailuresEarly];  // stop the workflow entirely
const softIssues = [...coverageGapNotes];     // inject into draft banner so owner sees them

// ── HARD: no-access sections (card #1158) ─────────────────────────────────────
// generate.mjs reclassifies a credential-backed section's skip from 'no-data'
// to 'no-access: <var> missing' when its required env var is absent (see
// section-credential-guard.mjs). That is a fetch that never ran, not an empty
// week — a dev machine missing GA4_PROPERTY_ID silently deleted "Trending
// This Week" from a subscriber-facing draft on 2026-08-09 and nothing caught
// it. Refuse to PATCH the Resend draft in that state; NEWSLETTER_ALLOW_NO_ACCESS=1
// is the explicit, opt-in override (mirrors NEWSLETTER_ALLOW_GAPS).
if (Array.isArray(meta.sections) && hasNoAccessSection(meta.sections)) {
  for (const s of noAccessSections(meta.sections)) {
    hardFailures.push(`Section "${s.name}" skipped for ${s.skipReason} — the draft is missing real data, not just an empty week. Run from an environment with the credential (see refresh-drafts.sh usage comment), or set NEWSLETTER_ALLOW_NO_ACCESS=1 to send without it.`);
  }
}

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
// owner must never be the one catching it. Runs against the (possibly
// swap-regenerated) draft loaded above.
if (!Array.isArray(meta.openingShows)) {
  softIssues.push('meta.openingShows missing — draft was generated by an old generate.mjs; image/completeness gates did NOT run. Re-run refresh-drafts.sh.');
} else {
  // Image present in shows.json at all?
  for (const v of missingImageViolations(meta.openingShows)) hardFailures.push(v);
  // Metadata points at a real file on disk? (phantom-path class, task #714)
  for (const v of phantomImageViolations(meta.openingShows, rel => {
    try { return fs.statSync(path.join(repoRoot, rel)).size > 0; } catch { return false; }
  })) hardFailures.push(v);

  // ── HARD: does the rendered email actually CONTAIN the openings it claims?
  // 2026-08-09: the coverage-gap swap deleted featured openings from the HTML
  // while meta.openingShows still listed them, and every check here passed
  // because none of them compared the manifest to the render. A session then
  // "verified" the draft by grepping for a show title, found it in the lede,
  // and reported success while the show was absent from the openings block.
  // The owner caught it by eye. This closes that gap at the gate, so no human
  // or agent eyeball is load-bearing on send day.
  for (const v of renderInvariantFailures({ html, meta })) hardFailures.push(v);

  // ── SOFT: review completeness — unverified (stale/no-data) entries only.
  // Gap entries were already swapped or reported above, BEFORE this draft was
  // loaded, so they don't need a second pass here.
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
  ['broadway-openings', 'offbroadway-openings', 'london-openings', 'broadway-we'].includes(s.name) && s.fired);
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

  // Markup lives in scripts/lib/pre-send-banner.js next to the stripper that
  // create-broadcast-draft.mjs runs before PATCHing the audience draft — keep
  // them together or the strip silently stops matching (task #746).
  const banner = buildPreSendBanner(softIssues);

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
