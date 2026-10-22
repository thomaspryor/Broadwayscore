'use strict';

// Detects Promise.race timeout wrappers whose setTimeout is never cleared or
// unref()'d (BRO-2427). Pure: takes source text, returns findings.
//
// A race site is flagged when a setTimeout sits within a few lines of the
// Promise.race AND no clearTimeout / .unref() appears in the surrounding
// function-sized window. scripts/lib/with-timeout.js is the sanctioned fix.
const BEFORE = 30;
const AFTER = 12;
const CLEAR_BEFORE = 3;
const CLEAR_AFTER = 40;

function findUnclearedTimeoutRaces(source) {
  const lines = source.replace(/Promise\s*\n\s*\.race\s*\(/g, (m) => 'Promise.race(' + '\n'.repeat(m.split('\n').length - 1)).split('\n');
  const findings = [];
  lines.forEach((line, i) => {
    if (!/Promise\.race\s*\(/.test(line)) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const near = lines.slice(Math.max(0, i - BEFORE), i + AFTER + 1).join('\n');
    if (!/setTimeout\s*\(/.test(near)) return;
    const wide = lines.slice(Math.max(0, i - CLEAR_BEFORE), i + CLEAR_AFTER + 1).join('\n');
    if (/clearTimeout\s*\(|\.unref\s*\(/.test(wide)) return;
    findings.push({ line: i + 1, text: line.trim().slice(0, 120) });
  });
  return findings;
}

module.exports = { findUnclearedTimeoutRaces };
