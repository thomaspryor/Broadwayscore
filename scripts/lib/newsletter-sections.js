// Section runner + observability for the Weekly Round-up newsletter.
//
// Each section function in scripts/newsletter/generate.mjs can silently return
// null (no data this week, exception swallowed, etc.). When that happens the
// section just disappears from the email and we have no idea why. This module
// wraps every section call so failures + reasons surface in stdout AND a
// machine-readable meta.json sidecar that the send script + future regression
// test can read.
//
// Usage from generate.mjs:
//   const sections = createSectionRunner();
//   const tony = sections.run('tony-predictions', () => tonyWatchSection());
//   ...
//   sections.writeMeta(metaPath, { subject, preheader });
//   sections.printSummary();
//
// Why an OBJECT-based runner (closure-state) instead of free functions: each
// generator invocation is independent and we never want state leaking across
// runs in test/regression contexts.

'use strict';

function createSectionRunner() {
  const entries = [];

  function run(name, fn) {
    let html = null;
    let fired = false;
    let skipReason = null;
    try {
      const result = fn();
      if (result == null || result === '') {
        skipReason = 'no-data';
      } else {
        html = result;
        fired = true;
      }
    } catch (err) {
      skipReason = `error: ${err && err.message ? err.message : String(err)}`;
    }
    entries.push({ name, fired, skipReason, htmlLength: html ? html.length : 0 });
    return html;
  }

  function printSummary() {
    const fired = entries.filter((e) => e.fired);
    const skipped = entries.filter((e) => !e.fired);
    const skippedSummary = skipped.length
      ? skipped.map((e) => `${e.name} (${e.skipReason})`).join(', ')
      : '';
    const parts = [`${fired.length} sections fired`];
    if (skipped.length) parts.push(`${skipped.length} skipped: ${skippedSummary}`);
    // Single stderr line so existing stdout consumers (test scripts piping the
    // generator) aren't disturbed.
    process.stderr.write(`[newsletter] ${parts.join(' · ')}\n`);
  }

  function writeMeta(metaPath, extra) {
    const fs = require('node:fs');
    const meta = {
      generatedAt: new Date().toISOString(),
      sections: entries,
      ...(extra || {}),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }

  function entriesSnapshot() { return entries.slice(); }

  return { run, printSummary, writeMeta, entries: entriesSnapshot };
}

module.exports = { createSectionRunner };
