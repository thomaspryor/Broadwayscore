#!/usr/bin/env node
/** Exit 1 when any scripts/*.js bumps a counter right after an unchecked safeWriteReview() (BRO-5995). */
'use strict';
const fs = require('fs');
const path = require('path');
const { findUncheckedWriteCounters } = require('./lib/unchecked-write-counters');

function scan(dir = __dirname) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    for (const h of findUncheckedWriteCounters(fs.readFileSync(path.join(dir, name), 'utf8'))) out.push({ file: `scripts/${name}`, ...h });
  }
  return out;
}

if (require.main === module) {
  const hits = scan();
  for (const h of hits) console.log(`${h.file}:${h.line}  ${h.call}  ->  ${h.counter}`);
  console.log(`${hits.length} counter-after-unchecked-write site(s)`);
  process.exit(hits.length ? 1 : 0);
}
module.exports = { scan };
