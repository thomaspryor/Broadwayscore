#!/usr/bin/env node
'use strict';
// BRO-5724 diagnostic: print provenance metadata (never review text) for the four
// class-A files, to find which writer created them. Read-only.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'data', 'review-texts');
const FILES = [
  'into-the-woods-noel-coward-west-end-2026/i-paper--fiona-mountford.json',
  'into-the-woods-noel-coward-west-end-2026/independent--louis-chilton.json',
  'into-the-woods-noel-coward-west-end-2026/the-jewish-chronicle--john-nathan.json',
  'the-comedy-about-spies-west-end-2026/london-box-office--stuart-king.json',
];
const SKIP = /text|excerpt|quote|summary|body/i;
for (const f of FILES) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) { console.log(f, 'MISSING'); continue; }
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (SKIP.test(k)) { out[k] = `<${typeof v === 'string' ? v.length + ' chars' : typeof v}>`; continue; }
    out[k] = typeof v === 'string' && v.length > 140 ? v.slice(0, 140) + '...' : v;
  }
  console.log(f); console.log(JSON.stringify(out, null, 1));
}
