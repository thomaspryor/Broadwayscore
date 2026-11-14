// BRO-5262: scripts/lib/get-route-dispatch.js flags API routes whose GET
// handler dispatches a workflow. Run: node --test scripts/lib/get-route-dispatch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { analyzeRoute, auditRoutes } = require('./get-route-dispatch.js');

const DISPATCH = "await fetch(`https://api.github.com/repos/${repo}/actions/workflows/x.yml/dispatches`, { method: 'POST' });";

test('GET that dispatches directly is flagged', () => {
  const r = analyzeRoute(`export async function GET(req) {\n  const css = 'body{margin:0}';\n  ${DISPATCH}\n}\n`);
  assert.deepEqual(r, { hasGet: true, dispatches: true, path: ['GET'] });
});

test('GET that dispatches through a same-file helper is flagged with the call chain', () => {
  const src = `async function gh(path) {\n  ${DISPATCH}\n}\nasync function handle(req, method) {\n  if (x) { return \`\${a ? '{' : '}'}\`; }\n  await gh('/p');\n}\nexport async function GET(req) {\n  return handle(req, 'GET');\n}\n`;
  assert.deepEqual(analyzeRoute(src).path, ['GET', 'handle', 'gh']);
});

test('confirm-page GET with dispatch only in POST passes', () => {
  const src = `function page() {\n  return '<form method="POST">';\n}\nexport async function GET(req) {\n  return page();\n}\nexport async function POST(req) {\n  ${DISPATCH}\n}\n`;
  assert.equal(analyzeRoute(src).dispatches, false);
});

test('workflow_dispatch mention and aliased GET export are caught', () => {
  const src = `const run = async (req) => {\n  await trigger({ event: 'workflow_dispatch' });\n};\nexport { run as GET };\n`;
  assert.equal(analyzeRoute(src).dispatches, true);
});

test('a route with no GET is never flagged', () => {
  assert.deepEqual(analyzeRoute(`export async function POST(req) {\n  ${DISPATCH}\n}\n`), { hasGet: false, dispatches: false, path: [] });
});

test('allowlist suppresses with a reason; a stale entry is reported', () => {
  const bad = { path: 'src/app/api/a/route.ts', src: `export async function GET() {\n  ${DISPATCH}\n}\n` };
  const ok = { path: 'src/app/api/b/route.ts', src: 'export async function GET() {\n  return 1;\n}\n' };
  assert.deepEqual(auditRoutes([bad, ok], {}).violations.map((v) => v.path), ['src/app/api/a/route.ts']);
  const r = auditRoutes([bad, ok], { 'src/app/api/a/route.ts': 'why', 'src/app/api/b/route.ts': 'stale' });
  assert.equal(r.violations.length, 0);
  assert.deepEqual(r.stale, ['src/app/api/b/route.ts']);
});

// No on-tree CLI assertion here: the live-tree check is the advisory test.yml
// step (CLAUDE.md §19). Asserting it in this blocking suite would arm it early.

test('wrapped export, function expression and HEAD handlers are followed', () => {
  const wrapped = `const go = async function (req) {\n  ${DISPATCH}\n};\nexport const GET = withAuth(go);\n`;
  assert.deepEqual(analyzeRoute(wrapped).path, ['GET', 'go']);
  const head = `export async function GET() {\n  return page();\n}\nexport async function HEAD() {\n  ${DISPATCH}\n}\n`;
  assert.deepEqual(analyzeRoute(head).path, ['HEAD']);
});
