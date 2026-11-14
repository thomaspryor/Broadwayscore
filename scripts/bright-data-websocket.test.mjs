import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// BRO-544: Bright Data's `mcp_browser` zone (deleted from the account
// 2026-04-27, confirmed via GET /zone?zone=mcp_browser -> plan.disable:
// "deleted") is a browser_api (Scraping Browser) zone. Those are reachable
// only over WebSocket/CDP (wss://brd.superproxy.io:9222) — POSTing to
// https://api.brightdata.com/request with { zone: 'mcp_browser', ... } (the
// pattern this repo used pre-2026-04, see commit 2969502d073) returns
// "use Scraping Browser zone as browser" and always fails. This is a
// regression guard, not a feature test: it fails CI if any script or
// workflow starts sending mcp_browser (or its pre-rename alias
// scraping_browser) through the plain HTTP /request path again.
const SCAN_DIRS = ['scripts', 'src', '.github/workflows', '.github/actions'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.yml', '.yaml']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

// Matches an actual zone assignment/array entry, e.g. `zone: 'mcp_browser'`,
// `zone: "scraping_browser"`, or `['web_unlocker2', 'mcp_browser']` — not
// prose comments that merely mention the zone name (e.g. "not mcp_browser").
const BROWSER_ZONE_AS_HTTP_ZONE = /zone['"]?\s*:?\s*\[?\s*(['"])(mcp_browser|scraping_browser)\1/g;

function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function findViolations() {
  const violations = [];
  const thisFile = path.resolve(__dirname, path.basename(import.meta.url));
  for (const dir of SCAN_DIRS) {
    for (const file of listFiles(path.join(repoRoot, dir))) {
      if (path.resolve(file) === thisFile) continue;
      const content = fs.readFileSync(file, 'utf8');
      const matches = content.match(BROWSER_ZONE_AS_HTTP_ZONE);
      if (matches) {
        violations.push({ file: path.relative(repoRoot, file), matches });
      }
    }
  }
  return violations;
}

test('no script or workflow sends the mcp_browser/scraping_browser zone through the HTTP /request API', () => {
  const violations = findViolations();
  assert.deepEqual(
    violations,
    [],
    `Found mcp_browser/scraping_browser used as an HTTP proxy zone (it is a WebSocket-only browser_api zone, deleted from the account 2026-04-27): ${JSON.stringify(violations)}`
  );
});

test('scraper.js and reddit-api.js default zone fallback is not the deleted browser_api zone', () => {
  const scraperSrc = fs.readFileSync(path.join(repoRoot, 'scripts/lib/scraper.js'), 'utf8');
  const redditSrc = fs.readFileSync(path.join(repoRoot, 'scripts/lib/reddit-api.js'), 'utf8');
  for (const [name, src] of [['scraper.js', scraperSrc], ['reddit-api.js', redditSrc]]) {
    assert.ok(
      !/BRIGHTDATA_ZONE\s*\|\|\s*['"](mcp_browser|scraping_browser)['"]/.test(src),
      `${name} must not default BRIGHTDATA_ZONE to the WebSocket-only mcp_browser/scraping_browser zone`
    );
  }
});
