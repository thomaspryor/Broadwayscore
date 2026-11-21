#!/usr/bin/env node
/**
 * diag-url-critic-slug-files.js — read-only per-file facts for BRO-2938.
 *
 * For every review-text file that audit-url-critic-slug-filenames.js flags
 * (critic part of the filename is a URL), print the metadata a human needs to
 * decide move vs delete: outlet, stored criticName, url, contentTier, text
 * length, exclusion flags, lock, the would-be destination
 * `<outlet>--<slug(criticName)>.json` and whether it exists (with the same
 * facts for it), plus any sibling file holding the same url.
 *
 * For Unknown/empty bylines it also prints a byline GUESS: a "By First Last"
 * match in the first 600 characters of the text, name only. No review text is
 * printed. Run via `node scripts/cloud-run-script.js --review-texts
 * scripts/diag-url-critic-slug-files.js` (output is sealed to the caller).
 *
 * Read-only: no writes, spawns or network.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasUrlCriticSlug } = require('./audit-url-critic-slug-filenames');
const { slugifyCritic } = require('./lib/critic-review-scan');
const { getLongestExcerpt } = require('./lib/excerpt-fields');

const ROOT = path.join(__dirname, '..', 'data', 'review-texts');

const urlKey = (u) => String(u || '').trim().toLowerCase()
  .replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

function facts(show, file) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(ROOT, show, file), 'utf8')); } catch (e) { return { file, unreadable: e.message }; }
  const text = String(d.fullText || '');
  return {
    file,
    outletId: d.outletId || null,
    outlet: d.outlet || null,
    criticName: d.criticName || null,
    url: d.url || null,
    publishDate: d.publishDate || null,
    contentTier: d.contentTier || null,
    textLen: text.length,
    excerptLen: getLongestExcerpt(d).length,
    flags: ['wrongProduction', 'wrongShow', 'isRoundupArticle', 'wrongPublication', 'isDuplicate'].filter((k) => d[k] === true),
    duplicateOf: d.duplicateOf || d.duplicateTextOf || null,
    locked: d._locked === true,
    score: d.assignedScore ?? d.llmScore?.score ?? null,
  };
}

function bylineGuess(show, file) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, show, file), 'utf8'));
    const head = String(d.fullText || '').slice(0, 600);
    const m = head.match(/\b[Bb]y\s+([A-Z][a-z'’.-]+(?:\s+[A-Z][a-z'’.-]+){1,2})/);
    return m ? m[1].replace(/[.]+$/, '') : null;
  } catch { return null; }
}

function main() {
  if (!fs.existsSync(ROOT)) { console.error('data/review-texts not found'); return 2; }
  const out = [];
  for (const show of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!show.isDirectory()) continue;
    const files = fs.readdirSync(path.join(ROOT, show.name)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      if (!hasUrlCriticSlug(f)) continue;
      const me = facts(show.name, f);
      const outletPart = f.slice(0, f.indexOf('--'));
      const unknown = !me.criticName || /^unknown$/i.test(me.criticName) || /^https?:|^www\.|[a-z0-9-]+\.(com|org|net|co\.uk)\b|\//i.test(me.criticName);
      const slug = unknown ? null : slugifyCritic(me.criticName);
      const dest = slug ? `${outletPart}--${slug}.json` : null;
      const destFacts = dest && files.includes(dest) ? facts(show.name, dest) : null;
      const k = urlKey(me.url);
      const sameUrl = k ? files.filter((g) => g !== f).map((g) => facts(show.name, g)).filter((g) => urlKey(g.url) === k) : [];
      const sameOutlet = files.filter((g) => g !== f && g.startsWith(`${outletPart}--`));
      out.push({
        path: `${show.name}/${f}`,
        self: me,
        bylineGuess: unknown ? bylineGuess(show.name, f) : undefined,
        proposedDest: dest,
        destExists: !!destFacts,
        dest: destFacts,
        sameUrlSiblings: sameUrl,
        sameOutletFiles: sameOutlet,
      });
    }
  }
  console.log(JSON.stringify({ count: out.length, files: out }, null, 2));
  return 0;
}

if (require.main === module) process.exit(main());
