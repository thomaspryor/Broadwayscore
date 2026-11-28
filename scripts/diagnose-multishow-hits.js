#!/usr/bin/env node
/**
 * diagnose-multishow-hits.js — read-only (BRO-7053).
 * For stored review files of --show=ID, prints where each show-title match falls
 * (percent of text length) so a subject-name rule can be tuned. Titles and numbers
 * only, never review text.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { CURRENT_BROADWAY_SHOWS, detectMultiShowContent } = require('./lib/content-quality');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const show = (process.argv.find((a) => a.startsWith('--show=')) || '').slice(7);
const dir = path.join(__dirname, '..', 'data', 'review-texts', show);
const out = [];
for (const f of fs.readdirSync(dir)) {
  if (!isReviewTextFile(f)) continue;
  let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const text = typeof j.fullText === 'string' ? j.fullText : '';
  if (!text) continue;
  const det = detectMultiShowContent(text, show);
  const found = new Set(det.showsFound || []);
  const titles = {};
  for (const t of found) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    titles[t] = [...text.matchAll(new RegExp(`\\b${esc}\\b`, 'gi'))].map((m) => ({ pct: Math.round((m.index / text.length) * 100), at: m.index }));
  }
  out.push({ file: f, len: text.length, detected: det.detected, found: det.showsFound, titles });
}
console.log(JSON.stringify(out, null, 1));
