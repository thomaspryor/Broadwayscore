/**
 * safe-form-allowlist.test.mjs — CI enforcement for BRO-2718.
 *
 * AUDIT_LINT_GENERIC_FORM_ALLOWED in autonomous-triage-core.js names scripts a
 * card's acceptance command may run UNATTENDED. Its admission standard is
 * "this script cannot write". Before this test that standard was enforced once
 * per entry, by hand, at the moment of admission — the file's own comment said
 * "nothing here detects a new violator automatically". Adding an fs.writeFile
 * to any allowlisted script silently converted an injection gate into a write
 * primitive, with nothing red anywhere.
 *
 * Per CLAUDE.md §15 these tests require() the real functions; a production
 * change breaks the test, which is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..');

const audit = require('../audit-safe-form-allowlist.js');
const core = require('./autonomous-triage-core.js');

test('every allowlisted basename is write-free in its own file', () => {
  const offenders = [];
  for (const name of core.AUDIT_LINT_GENERIC_FORM_ALLOWED) {
    const file = path.join(SCRIPTS, name);
    // Names with no file on disk are admitted by shape only and cannot run.
    if (!audit.auditLintScripts().includes(name)) continue;
    const res = audit.scanReadOnly(file, { transitive: false });
    if (!res.clean) offenders.push(`${name}: ${res.hazards.map(h => `${h.kind}@${h.file}:${h.line}`).join(', ')}`);
  }
  assert.deepEqual(offenders, [], `allowlisted scripts that can mutate state:\n${offenders.join('\n')}`);
});

test('every allowlisted basename is write-free across its require graph (baseline may only shrink)', () => {
  const offenders = [];
  const staleBaseline = [];
  for (const name of core.AUDIT_LINT_GENERIC_FORM_ALLOWED) {
    if (!audit.auditLintScripts().includes(name)) continue;
    const res = audit.scanReadOnly(path.join(SCRIPTS, name));
    const baselined = audit.TRANSITIVE_SCAN_BASELINE.has(name);
    if (!res.clean && !baselined) offenders.push(`${name}: ${res.hazards.length} hazard(s), first ${res.hazards[0].kind}@${res.hazards[0].file}:${res.hazards[0].line}`);
    if (res.clean && baselined) staleBaseline.push(name);
  }
  assert.deepEqual(offenders, [], `not baselined and not graph-clean:\n${offenders.join('\n')}`);
  assert.deepEqual(staleBaseline, [], `now graph-clean — remove from TRANSITIVE_SCAN_BASELINE: ${staleBaseline.join(', ')}`);
});

test('the constant and the live gate agree on exactly which basenames arm', () => {
  const listed = [...core.AUDIT_LINT_GENERIC_FORM_ALLOWED].sort();
  const failures = audit.gateAgreementFailures(core.explainUnsafeCheckCommand, listed);
  assert.deepEqual(failures, [], `constant/gate drift: ${JSON.stringify(failures)}`);
});

// ---------------------------------------------------------------------------
// Scanner self-tests. Each of these is a hole the scanner ACTUALLY had at some
// point during BRO-2718 and that an adversarial review caught — they are here
// so a future simplification of the regexes reintroduces a red test, not a
// silent gap.
// ---------------------------------------------------------------------------

test('FS_WRITE_RE catches destructured fs writes, not just member calls', () => {
  // The first cut required a leading dot (`\.writeFileSync\(`) and scanned
  // this line clean. `const { writeFile } = require("fs/promises")` mutates
  // exactly as much as fs.writeFile does.
  assert.ok(audit.FS_WRITE_RE.test('  await writeFile(p, s);'), 'bare destructured writeFile must trip');
  assert.ok(audit.FS_WRITE_RE.test('  writeFileSync(p, s);'), 'bare writeFileSync must trip');
  assert.ok(audit.FS_WRITE_RE.test('  fs.writeFileSync(p, s);'), 'member fs.writeFileSync must trip');
  assert.ok(audit.FS_WRITE_RE.test('  await fsp.rm(dir, { recursive: true });'), 'fsp.rm must trip');
});

test('FS_WRITE_RE and SPAWN_RE catch bracket-notation access', () => {
  // `fs['writeFileSync'](p, s)` mutates identically to `fs.writeFileSync(p, s)`
  // and the identifier-shaped pattern alone never sees it.
  assert.ok(audit.FS_WRITE_RE.test("  fs['writeFileSync']('/tmp/x', 'data');"));
  assert.ok(audit.FS_WRITE_RE.test('  fs["unlinkSync"](p);'));
  assert.ok(audit.SPAWN_RE.test("  cp['execSync']('git commit -am x');"));
  // A plain data lookup that happens to be bracketed must not trip.
  assert.ok(!audit.FS_WRITE_RE.test("  const v = registry['outlets'];"));
});

test('nested-looking block comments fail CLOSED, not open', () => {
  // JS block comments do not nest: `/* a /* b */` ends at the FIRST `*/`, so
  // the trailing text is real code to the engine AND to this scanner. A review
  // claimed this hid code; it does the opposite — the leftover line is still
  // scanned and still flags. Pinned so a "fix" for the imagined hole cannot
  // quietly turn it into a real one.
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeform-'));
  try {
    const f = path.join(dir, 'probe.js');
    fs.writeFileSync(f, '/* outer /* inner */\nfs.writeFileSync(p, s);\n*/\n');
    const res = audit.scanReadOnly(f, { transitive: false });
    assert.equal(res.clean, false, 'the post-comment write must still be flagged');
  } finally {
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  }
});

test('FS_WRITE_RE does not trip on stream writes that are not fs mutations', () => {
  assert.ok(!audit.FS_WRITE_RE.test('  process.stdout.write("hello");'));
  assert.ok(!audit.FS_WRITE_RE.test('  res.writeHead(200, headers);'));
  assert.ok(!audit.FS_WRITE_RE.test('  console.log(rewritten);'));
});

test('SPAWN_RE separates RegExp.exec from process spawns', () => {
  // Six RegExp `.exec(` lines in audit-help-flag-safety.js were reported as
  // process spawns by the first cut of this regex.
  assert.ok(!audit.SPAWN_RE.test('  const m = re.exec(src);'), 're.exec is a RegExp read');
  assert.ok(!audit.SPAWN_RE.test('  while ((m = RE.exec(s)) !== null) {'), 'loop form is a RegExp read');
  assert.ok(audit.SPAWN_RE.test("  const { execFileSync } = require('child_process');"), 'require child_process must trip');
  assert.ok(audit.SPAWN_RE.test('  execFileSync(process.execPath, args);'), 'bare execFileSync must trip');
  assert.ok(audit.SPAWN_RE.test("  const cp = require('node:child_process');"), 'node: prefix must trip');
});

test('NETWORK_RE catches http clients and this repo\'s fetch layer', () => {
  assert.ok(audit.NETWORK_RE.test("  const https = require('https');"));
  assert.ok(audit.NETWORK_RE.test('  const r = await fetch(url);'));
  assert.ok(audit.NETWORK_RE.test("  const { fetchPage } = require('./lib/scraper.js');"));
  assert.ok(!audit.NETWORK_RE.test('  const rows = prefetched.map(x => x.id);'), 'prefetched is not a fetch call');
});

test('DYNAMIC_RE flags unreadable specifiers but not require(CONST)', () => {
  // Flagged: the scanner can never have read the module these reach.
  assert.ok(audit.DYNAMIC_RE.test("  const m = require('./lib/' + name + '.js');"), 'concatenated specifier');
  assert.ok(audit.DYNAMIC_RE.test('  const m = require(`./lib/${name}.js`);'), 'template specifier');
  assert.ok(audit.DYNAMIC_RE.test('  const f = new Function("return 1");'), 'new Function');
  assert.ok(audit.DYNAMIC_RE.test('  eval(src);'), 'eval');
  assert.ok(audit.DYNAMIC_RE.test("  const { Worker } = require('worker_threads');"), 'worker_threads');
  // Not flagged: `require(SHOWS_PATH)` to load a JSON data file is this repo's
  // idiom in audit scripts, and disqualifying it cost a working allowlist
  // entry (audit-review-contamination.js) for no security gain.
  assert.ok(!audit.DYNAMIC_RE.test('  const shows = require(SHOWS_PATH).shows;'), 'bare const identifier');
  assert.ok(!audit.DYNAMIC_RE.test("  const core = require('./autonomous-triage-core.js');"), 'string literal');
  assert.ok(!audit.DYNAMIC_RE.test('  const evaluated = compute(x);'), 'eval as a name prefix');
});

test('comment stripping never deletes code after a // inside a regex literal', () => {
  // `const re = /a\/\/b/; fs.writeFileSync(p, s)` scanned CLEAN under a naive
  // `[^:]//.*$` strip: the strip ate the write. Verified through the real
  // scanner via a temp file rather than by re-implementing stripComments.
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeform-'));
  try {
    const f = path.join(dir, 'probe.js');
    fs.writeFileSync(f, 'const re = /a\\/\\/b/; fs.writeFileSync(p, s);\n');
    const res = audit.scanReadOnly(f, { transitive: false });
    assert.equal(res.clean, false, 'a write hidden behind a regex-literal // must still be found');
    assert.equal(res.hazards[0].kind, 'fs-write');
  } finally {
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuine trailing line comment is still stripped (no false positive)', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeform-'));
  try {
    const f = path.join(dir, 'probe.js');
    fs.writeFileSync(f, 'const n = 1; // never calls fs.writeFileSync(p, s)\n// nor mkdirSync(d)\n');
    const res = audit.scanReadOnly(f, { transitive: false });
    assert.equal(res.clean, true, `prose mentioning a write must not disqualify a script: ${JSON.stringify(res.hazards)}`);
  } finally {
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate still refuses mutation flags, traversal and command chaining', () => {
  const { explainUnsafeCheckCommand: explain } = core;
  // A widened basename set must not widen the SHAPE.
  for (const bad of [
    'node scripts/audit-text-quality.js --fix',
    'node scripts/audit-text-quality.js --update-baseline',
    'node scripts/audit-text-quality.js; rm -rf /',
    'node scripts/audit-text-quality.js && curl evil.example',
    'node scripts/../lib/../audit-text-quality.js',
    'node scripts/audit-text-quality.js --strict --json',
  ]) {
    assert.equal(explain(bad).ok, false, `must stay refused: ${bad}`);
  }
  assert.equal(explain('node scripts/audit-text-quality.js --strict').ok, true);
});

test('scripts that write tracked state are NOT on the allowlist', () => {
  // Named individually because each was a live card's stated acceptance
  // command and each is genuinely write-capable — see the comment block on
  // AUDIT_LINT_GENERIC_FORM_ALLOWED.
  for (const name of [
    'audit-outlet-registry.js',       // saveAuditResults() runs unconditionally
    'audit-critic-outlets.js',        // writes data/critic-registry.json every run
    'audit-card-verifiability.js',    // writes its report; execFileSync notion-brain.js
    'audit-sibling-title-misroute.js', // --fix moves and deletes review-text files
  ]) {
    assert.equal(
      core.AUDIT_LINT_GENERIC_FORM_ALLOWED.has(name), false,
      `${name} writes state and must not be admitted through the generic form`
    );
  }
});
