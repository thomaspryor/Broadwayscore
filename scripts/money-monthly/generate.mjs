// BRO-6773: generate the monthly Profitability Scorecard email PREVIEW.
// Writes <out>/money-monthly-<key>.html + .meta.json. Sends nothing.
// Flags: --data=DIR (default repo data/)  --today=YYYY-MM-DD  --month=YYYY-MM  --since=YYYY-MM-DD (catch-up)
//        --out=DIR  --write-snapshot (persist the estimate baseline for next month)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasHelpFlag } = require('../lib/cli-help.js');
const L = require('./lib.js');
const { renderHtml } = require('./render.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/money-monthly/generate.mjs [--today=D] [--month=YYYY-MM] [--since=D] [--out=DIR] [--write-snapshot]\nPreview only. Never sends.');
  process.exit(0);
}
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || undefined;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const today = arg('today') || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const outDir = arg('out') || path.join(repo, 'data/money-monthly/drafts');
const dataDir = arg('data') || path.join(repo, 'data');
const snapPath = path.join(repo, 'data/money-monthly/snapshot.json');

const commercial = JSON.parse(fs.readFileSync(path.join(dataDir, 'commercial.json'), 'utf8')).shows;
const shows = JSON.parse(fs.readFileSync(path.join(dataDir, 'shows.json'), 'utf8')).shows;
let snapshot = null;
try { snapshot = JSON.parse(fs.readFileSync(snapPath, 'utf8')).entries; } catch (e) { if (e.code !== 'ENOENT') throw e; }

const window = L.resolveWindow({ today, month: arg('month'), since: arg('since') });
const issue = L.buildIssue({ commercial, shows, snapshot, window });
const subject = L.buildSubject(issue);
const html = renderHtml(issue);
if (/—/.test(html) || /—/.test(subject)) throw new Error('em dash in email copy');

fs.mkdirSync(outDir, { recursive: true });
const slug = `money-monthly-${window.monthKey}`;
fs.writeFileSync(path.join(outDir, `${slug}.html`), html);
fs.writeFileSync(path.join(outDir, `${slug}.meta.json`), JSON.stringify({ subject, window, quiet: issue.quiet, hasBaseline: issue.hasBaseline, counts: Object.fromEntries(Object.entries(issue.sections).map(([k, v]) => [k, v.length])) }, null, 2));
if (process.argv.includes('--write-snapshot')) {
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  fs.writeFileSync(snapPath, JSON.stringify({ asOf: today, entries: L.snapshotOf(commercial) }));
}
console.log(`subject: ${subject}`);
console.log(`file: ${path.join(outDir, `${slug}.html`)}`);
console.log(`counts: ${JSON.stringify(Object.fromEntries(Object.entries(issue.sections).map(([k, v]) => [k, v.length])))} baseline=${issue.hasBaseline}`);
