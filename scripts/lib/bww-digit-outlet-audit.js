'use strict';

// BRO-4371: the parser is fixed, but fill-only/longer-only excerpt merges
// preserve old quotes that swallowed the next digit-leading outlet's entry.
// This audit deliberately reports private file paths and lengths, never text,
// and never writes review files. Repairs require review of the source archive.
const fs = require('fs');
const path = require('path');
const { parseArticleBodyReviews } = require('./bww-roundup-parser');
const { normalizeOutlet } = require('./review-normalization');
const { decodeHtmlEntities } = require('./text-cleaning');
const { isReviewTextFile } = require('./review-text-sidecars');

function normalizedText(text) {
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
}

function articleBodies(html) {
  const bodies = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.articleBody === 'string') bodies.push(node.articleBody);
    if (node['@graph']) visit(node['@graph']);
  }
  let invalidJsonLd = 0;
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1].replace(/[\x00-\x1F\x7F]/g, ' ')));
    } catch { invalidJsonLd++; }
  }
  return { bodies, invalidJsonLd };
}

/**
 * Find a swallowed boundary, including one truncated partway through a byline.
 * Exact clean-quote prefix plus the next archived byline is the evidence.
 * Outlet identity must match too, so a full roundup saved under BWW is ignored.
 * A missing/unknown stored critic is OK: the source text proves attribution.
 */
function auditDigitOutletFields(pairs, record) {
  const findings = [];
  const outlet = normalizeOutlet(record.outletId || record.outlet || '');
  for (let i = 1; i < pairs.length; i++) {
    const next = pairs[i];
    if (!/^\d/.test(next.outletRaw)) continue;
    const prior = pairs[i - 1];
    if (!outlet || outlet !== normalizeOutlet(prior.outletRaw)) continue;
    const clean = normalizedText(prior.quote);
    if (!clean) continue;
    const boundary = normalizedText(`${next.criticName}, ${next.outletRaw}:`);
    for (const field of ['bwwExcerpt', 'fullText']) {
      if (typeof record[field] !== 'string') continue;
      const stored = normalizedText(record[field]);
      if (!stored.startsWith(clean)) continue;
      const tail = stored.slice(clean.length).trim().replace(/(?:\.{3}|\u2026)$/, '').trim();
      const complete = tail.startsWith(boundary);
      // A short matching prefix could just be punctuation or a common word.
      const partial = tail.length >= next.criticName.length && boundary.startsWith(tail);
      if (!complete && !partial) continue;
      findings.push({
        field,
        outletId: outlet,
        reason: complete ? 'swallowed-digit-outlet' : 'truncated-digit-outlet-byline',
        storedLength: record[field].length,
        cleanLength: prior.quote.length,
      });
    }
  }
  return findings;
}

/** Read-only, offline sweep. Missing inputs fail instead of reporting a clean audit. */
function auditBwwDigitOutlets({ archiveDir, reviewDir, checkArchive = () => null }) {
  for (const dir of [archiveDir, reviewDir]) {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  }
  const report = {
    archivesScanned: 0, digitOutletEntries: 0, affectedShows: [], affectedFiles: 0,
    findings: [], manualReview: [],
  };
  const seen = new Set();
  for (const filename of fs.readdirSync(archiveDir).filter(f => f.endsWith('.html')).sort()) {
    report.archivesScanned++;
    // This is the archive's storage key, not metadata inferred from a URL.
    const showId = filename.slice(0, -5);
    const html = fs.readFileSync(path.join(archiveDir, filename), 'utf8');
    const { bodies, invalidJsonLd } = articleBodies(html);
    if (invalidJsonLd || !bodies.length) {
      report.manualReview.push({ showId, archive: filename, reason: 'unreadable-article-body' });
    }
    const parsed = bodies.map(parseArticleBodyReviews);
    const digitCount = parsed.reduce((n, pairs) => n + pairs.filter(p => /^\d/.test(p.outletRaw)).length, 0);
    report.digitOutletEntries += digitCount;
    // Compact spellings are intentionally outside the landed parser grammar.
    // Keep those archives visible for manual review instead of silently missing them.
    if (bodies.some(body => /\b1minutecritic\b/i.test(body))) {
      report.manualReview.push({ showId, archive: filename, reason: 'compact-digit-outlet-spelling' });
    }
    if (!digitCount) continue;
    const wrongShow = checkArchive(html, showId);
    if (wrongShow) {
      report.manualReview.push({ showId, archive: filename, reason: wrongShow.reason });
      continue;
    }
    const showDir = path.join(reviewDir, showId);
    if (!fs.existsSync(showDir)) {
      report.manualReview.push({ showId, archive: filename, reason: 'missing-review-directory' });
      continue;
    }
    for (const file of fs.readdirSync(showDir).filter(isReviewTextFile).sort()) {
      let record;
      try {
        record = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid review object');
      }
      catch {
        report.manualReview.push({ showId, file: `${showId}/${file}`, reason: 'unreadable-review' });
        continue;
      }
      for (const pairs of parsed) {
        for (const finding of auditDigitOutletFields(pairs, record)) {
          const key = `${showId}/${file}:${finding.field}`;
          if (seen.has(key)) continue;
          seen.add(key);
          report.findings.push({ showId, file: `${showId}/${file}`, archive: filename, ...finding });
        }
      }
    }
  }
  report.affectedShows = [...new Set(report.findings.map(f => f.showId))].sort();
  report.affectedFiles = new Set(report.findings.map(f => f.file)).size;
  return report;
}

module.exports = { auditDigitOutletFields, auditBwwDigitOutlets };
