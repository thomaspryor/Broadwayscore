// BRO-6968: the Mac backup trigger only fired at 9 PM ET, after the whole West End probe window, so a
// West End press night had no backup and its probe started 5h late on a delayed GitHub cron. Each
// backup plist's local (America/New_York) firing time must fall inside probeDue's dispatch window for
// every market it dispatches, on both sides of every DST change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { probeDue } = require('./press-night-record.js');
const { utcFromZoned } = require('./opening-night-windows.js');

const LAUNCHD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'launchd');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'opening-night-backup-trigger.sh');

function plist(name) {
  const xml = fs.readFileSync(path.join(LAUNCHD, `${name}.plist`), 'utf8');
  const hour = Number(xml.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/)[1]);
  const minute = Number(xml.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/)[1]);
  const args = [...xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const scriptAt = args.findIndex((a) => a.endsWith('opening-night-backup-trigger.sh'));
  const markets = args[scriptAt + 1] ? [args[scriptAt + 1]] : ['broadway', 'west-end'];
  return { hour, minute, markets };
}

// Ordinary dates plus the weeks when only one of the US/UK clocks has changed.
const DATES = ['2026-01-15', '2026-03-10', '2026-03-25', '2026-07-15', '2026-10-28', '2026-11-03', '2026-12-10'];
const CATS = { broadway: ['broadway', 'off-broadway'], 'west-end': ['west-end', 'off-west-end'] };

for (const name of ['com.bwsc.opening-night-backup-trigger', 'com.bwsc.opening-night-backup-trigger-we']) {
  test(`${name} fires inside the probe window for every market it dispatches`, () => {
    const p = plist(name);
    for (const market of p.markets) {
      for (const category of CATS[market]) {
        for (const d of DATES) {
          const firesAt = utcFromZoned(d, p.hour, p.minute, 'America/New_York').getTime();
          const due = probeDue({ id: 'x', category, openingDate: d }, firesAt);
          assert.ok(due, `${name} at ${p.hour}:${String(p.minute).padStart(2, '0')} ET on ${d} misses the ${category} probe window`);
        }
      }
    }
  });
}

test('every press-night market has a backup firing', () => {
  const covered = new Set(['com.bwsc.opening-night-backup-trigger', 'com.bwsc.opening-night-backup-trigger-we']
    .flatMap((n) => plist(n).markets));
  assert.deepEqual([...covered].sort(), ['broadway', 'west-end']);
});

test('the trigger script dispatches only the market it is given', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /MARKETS="\$\{1:-broadway west-end\}"/);
  assert.match(src, /for MARKET in \$MARKETS; do/);
});
