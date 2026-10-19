#!/usr/bin/env node
'use strict';
/**
 * audit-ownership-gate-losses.js: read-only. Find reviews the push action's
 * ownership gate dropped that exist nowhere in the corpus today (BRO-5373: the
 * gate dropped a moved review while the move's source delete went through, so
 * broadwayworld--kat-mokrynski.json was lost from both shows).
 *
 * For every review-texts commit in the window whose subject starts
 * "ownership-gate: drop", each deleted review file is read from the commit's
 * parent. It is a LOSS when no file in today's tree holds the same article
 * (canonicalArticleKey of the url) with text and without a duplicate pointer,
 * no file in the same show holds the same outlet + critic with text, and no
 * file anywhere holds a 120-char passage from the middle of its text.
 * Each loss prints the restore inputs: fromCommit (40-char sha of the parent),
 * sourcePath, url, critic, text length.
 *
 *   node scripts/audit-ownership-gate-losses.js [--days=60] [--json]
 * Cloud: node scripts/cloud-run-script.js --review-texts scripts/audit-ownership-gate-losses.js
 */
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);
const { canonicalArticleKey, normalizeCritic } = require('./lib/review-normalization');
const { NEAR_EMPTY_BODY_CHARS } = require('./lib/review-write-guard');

const ARGS = process.argv.slice(2);
const days = (() => { const a = ARGS.find((x) => x.startsWith('--days=')); const n = a ? parseInt(a.split('=')[1], 10) : 60; return Number.isFinite(n) && n > 0 ? n : 60; })();
const DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const git = (a) => execFileSync('git', ['-C', DIR, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const hasText = (d) => !!d && String(d.fullText || '').trim().length >= NEAR_EMPTY_BODY_CHARS;
// A passage from the middle of a text identifies the review across renames,
// outlet relabels (times-uk -> sunday-times, daily-mail -> mail-on-sunday) and
// moves between shows, where url and file name both change.
const { foldDiacritics } = require('./lib/title-match');
const norm = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function fingerprints(text) {
  const n = norm(text);
  if (n.length < 400) return [];
  const at = (f) => n.slice(Math.floor(n.length * f), Math.floor(n.length * f) + 120);
  return [at(0.3), at(0.6)];
}
const isReviewPath = (p) => /^[a-z0-9][^/]*\/[^/]+\.json$/.test(p) && !p.endsWith('failed-fetches.json') && !p.startsWith('_');

function currentIndex() {
  const byUrl = new Map();
  const byShowOutletCritic = new Set();
  const prints = new Set();
  const anyByUrl = new Map();
  for (const show of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!show.isDirectory() || show.name.startsWith('.') || show.name.startsWith('_')) continue;
    for (const f of fs.readdirSync(path.join(DIR, show.name))) {
      if (!isReviewTextFile(f)) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(DIR, show.name, f), 'utf8')); } catch { continue; }
      if (d.url) {
        const k0 = canonicalArticleKey(d.url);
        const st = [String(d.fullText || '').trim().length + 'ch', d.contentTier, d.wrongProduction && 'wrongProd', d.wrongShow && 'wrongShow', d.duplicateOf && 'dup', (d.isNotReview || d.isNonReview) && 'nonReview', d.rejectionReason && 'rejected'].filter(Boolean).join(',');
        if (k0) (anyByUrl.get(k0) || anyByUrl.set(k0, []).get(k0)).push(`${show.name}/${f} [${st}]`);
      }
      if (!hasText(d)) continue;
      if (d.url && !d.duplicateOf && !d.duplicateTextOf) {
        const k = canonicalArticleKey(d.url);
        if (k) (byUrl.get(k) || byUrl.set(k, []).get(k)).push(`${show.name}/${f}`);
      }
      byShowOutletCritic.add(`${show.name}|${d.outletId}|${normalizeCritic(d.criticName || '')}`);
      for (const fp of fingerprints(d.fullText)) prints.add(fp);
    }
  }
  return { byUrl, byShowOutletCritic, prints, anyByUrl };
}

function main() {
  if (!fs.existsSync(DIR)) { console.error('data/review-texts missing'); process.exit(3); }
  try { execFileSync('git', ['-C', DIR, 'fetch', '--quiet', `--shallow-since=${days + 2} days ago`, 'origin'], { stdio: 'ignore' }); } catch { /* full clone or offline */ }
  const commits = git(['log', `--since=${days} days ago`, '--format=%H %P %cI %s', '--grep=^ownership-gate: drop'])
    .split('\n').filter(Boolean).map((l) => { const [sha, parent, at] = l.split(' '); return { sha, parent, at }; });
  const idx = currentIndex();
  const drops = [];
  const losses = [];
  for (const c of commits) {
    if (!c.parent) continue;
    const deleted = git(['diff', '--no-renames', '--diff-filter=D', '--name-only', c.parent, c.sha]).split('\n').filter(isReviewPath);
    for (const rel of deleted) {
      let d;
      try { d = JSON.parse(git(['show', `${c.parent}:${rel}`])); } catch { continue; }
      const show = rel.split('/')[0];
      const entry = { commit: c.sha, fromCommit: c.parent, at: c.at, sourcePath: rel, url: d.url || null, critic: d.criticName || null, outletId: d.outletId || null, textChars: String(d.fullText || '').trim().length };
      drops.push(entry);
      if (!hasText(d)) continue; // a text-less drop loses nothing
      const k = d.url ? canonicalArticleKey(d.url) : null;
      const holders = k ? (idx.byUrl.get(k) || []) : [];
      const sameSlot = idx.byShowOutletCritic.has(`${show}|${d.outletId}|${normalizeCritic(d.criticName || '')}`);
      const textSurvives = fingerprints(d.fullText).some((fp) => idx.prints.has(fp));
      if (holders.length === 0 && !sameSlot && !textSurvives) {
        // Where the url lives today (any text level): the restore must go where
        // the article belongs, which these copies help decide.
        entry.urlHoldersToday = k ? (idx.anyByUrl.get(k) || []) : [];
        losses.push(entry);
      }
    }
  }
  const oldest = commits.length ? commits[commits.length - 1].at : null;
  if (ARGS.includes('--json')) { console.log(JSON.stringify({ days, commits: commits.length, oldestDropCommit: oldest, drops: drops.length, losses }, null, 2)); return; }
  console.log(`${commits.length} ownership-gate drop commits in ${days} days (oldest ${oldest}); ${drops.length} files dropped; ${losses.length} with text that exist nowhere today.`);
  for (const l of losses) console.log(`LOSS ${l.sourcePath} | ${l.outletId} | ${l.critic} | ${l.textChars} chars | dropped ${l.at} | fromCommit ${l.fromCommit} | ${l.url || '-'} | url today: ${(l.urlHoldersToday || []).join('; ') || 'nowhere'}`);
}

if (require.main === module) main();
