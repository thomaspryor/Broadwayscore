import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { recordGuardHit, planRecalibration, renderCalibration, openCalibrationPR, applyRecalibration } = require('./regex-pattern-recalibration');
const quality = require('./content-quality');
const prose = 'The theater production has actors on stage, a musical performance and a director. '.repeat(25);

function scan(family, texts) {
  const entry = { hits: texts.length };
  texts.forEach((text, i) => recordGuardHit(entry, {
    family, text, review: { outlet: `outlet-${i}` }, show: 'show', file: `${i}.json`,
  }));
  return { full: true, scanned: texts.length, date: '2026-10-20',
    violations: [{ family, index: 3, hits: texts.length, allow: 0 }], counts: { [family]: [null, null, null, entry] } };
}

test('newsletter leading/trailing mitigation uses the real runtime guard', () => {
  const inputs = [`subscribe to our newsletter\n${prose}`, `${prose}\nsubscribe to our newsletter`];
  for (const text of inputs) assert.equal(quality.isGarbageContent(text).isGarbage, false);
  const plan = planRecalibration(scan('NEWSLETTER_PATTERNS', inputs));
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].allow, 3);
  assert.equal(plan.updates[0].calibration.absorbed, 2);
  assert.deepEqual(plan.updates[0].calibration.sampleOutlets, ['outlet-0', 'outlet-1']);
});

test('one unprotected mid-text newsletter hit refuses the whole pattern', () => {
  const mid = prose.slice(0, 900) + ' subscribe to our newsletter ' + prose.slice(900);
  assert.equal(quality.isGarbageContent(mid).isGarbage, true);
  const plan = planRecalibration(scan('NEWSLETTER_PATTERNS', [`${prose} subscribe to our newsletter`, mid]));
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.refused[0].guardProof.absorbed, 1);
  assert.deepEqual(plan.refused[0].guardProof.failures, [{ show: 'show', file: '1.json' }]);
});

test('BRO-33: runtime pattern order can protect a mid-text index-3 match', () => {
  const text = prose.slice(0, 900) + ' subscribe to our newsletter ' + prose.slice(900) + ' enter your email';
  assert.equal(quality.isGarbageContent(text).isGarbage, false);
  assert.equal(planRecalibration(scan('NEWSLETTER_PATTERNS', [text])).updates.length, 1);
});

test('horror mitigation calls the real 3-keyword guard and fails closed on any rejection', () => {
  const safe = `${prose} The haunted house recalls a horror film.`;
  const unsafe = 'A terrifying haunted house in a horror film. '.repeat(30);
  assert.equal(quality.detectHorrorFilmContent(safe).detected, false);
  assert.equal(quality.detectHorrorFilmContent(unsafe).detected, true);
  assert.equal(planRecalibration(scan('HORROR_FILM_PATTERNS', [safe])).updates.length, 1);
  assert.equal(planRecalibration(scan('HORROR_FILM_PATTERNS', [safe, unsafe])).updates.length, 0);
});

test('unregistered families, missing evidence, partial scans and incomplete verification cannot bump', () => {
  for (const family of ['NAVIGATION_PATTERNS', 'NON_THEATER_PATTERNS', 'NON_OPERA_TITLE_PATTERNS', 'toString']) {
    assert.equal(planRecalibration(scan(family, [prose])).updates.length, 0);
  }
  const input = scan('HORROR_FILM_PATTERNS', [prose]);
  assert.throws(() => planRecalibration({ ...input, full: false }), /full corpus/);
  assert.throws(() => planRecalibration({ ...input, scanned: 0 }), /full corpus/);
  input.counts.HORROR_FILM_PATTERNS[3].guardProof.checked = 0;
  assert.equal(planRecalibration(input).updates.length, 0);
  delete input.counts.HORROR_FILM_PATTERNS[3].guardProof;
  assert.equal(planRecalibration(input).updates.length, 0);
});

const source = `const PATTERN_ALLOWLIST = {
  'NEWSLETTER_PATTERNS::3': 1, // old allowance
  'NAVIGATION_PATTERNS::0': 7,
};
const PATTERN_CALIBRATION = {
  'NEWSLETTER_PATTERNS::3': {
    note: 'old provenance',
  },
};
`;
const updates = planRecalibration(scan('NEWSLETTER_PATTERNS', [prose, prose])).updates;

test('writer replaces existing entries, adds missing ones, preserves unrelated families and is idempotent', () => {
  const extra = planRecalibration(scan('HORROR_FILM_PATTERNS', [prose])).updates;
  const all = [...updates, ...extra];
  const rendered = renderCalibration(source, all);
  assert.equal(renderCalibration(rendered, all), rendered);
  const result = vm.runInNewContext(rendered + '\n({allow: PATTERN_ALLOWLIST, cal: PATTERN_CALIBRATION})');
  assert.equal(result.allow['NEWSLETTER_PATTERNS::3'], 3);
  assert.equal(result.allow['HORROR_FILM_PATTERNS::3'], 2);
  assert.equal(result.allow['NAVIGATION_PATTERNS::0'], 7);
  assert.equal(result.cal['NEWSLETTER_PATTERNS::3'].date, '2026-10-20');
  assert.equal((rendered.match(/'NEWSLETTER_PATTERNS::3':/g) || []).length, 2);
  assert.throws(() => renderCalibration('unexpected source', updates), /Cannot find/);
  assert.throws(() => renderCalibration(source, [{ key: 'NON_THEATER_PATTERNS::0', allow: 999 }]), /Unregistered/);
});

function publisher(before = source) {
  const calls = [];
  const api = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint.includes('/pulls?')) return [];
    if (endpoint.includes('/git/matching-refs/')) return [];
    if (endpoint.endsWith('/branches/main')) return { commit: { sha: 'base', commit: { tree: { sha: 'base-tree' } } } };
    if (endpoint.includes('/contents/')) return { content: Buffer.from(before).toString('base64') };
    if (endpoint.endsWith('/git/trees')) return { sha: 'new-tree' };
    if (endpoint.endsWith('/git/commits')) return { sha: 'new-commit' };
    if (endpoint.endsWith('/git/refs')) return {};
    if (endpoint.endsWith('/pulls')) return { html_url: 'https://example.test/pr/1' };
    throw new Error(`unexpected ${method} ${endpoint}`);
  };
  return { calls, api };
}

test('PR publication includes exactly the calibrated file and deduplicates by source hash', () => {
  const after = renderCalibration(source, updates);
  const { calls, api } = publisher();
  assert.equal(openCalibrationPR({ before: source, after, updates, api }), 'https://example.test/pr/1');
  assert.equal(calls.length, 8);
  const tree = calls.find(c => c.endpoint.endsWith('/git/trees')).body;
  assert.equal(tree.tree.length, 1);
  assert.equal(tree.tree[0].mode, '100755', 'preserve the executable audit script');
  assert.equal(tree.tree[0].content, after);
  assert.equal(calls.find(c => c.endpoint.endsWith('/git/refs')).body.sha, 'new-commit');
  assert.match(calls.at(-1).body.head, /^codex\//);
  let reads = 0;
  assert.equal(openCalibrationPR({ before: source, after, updates, api: () => {
    reads++;
    return [{ html_url: 'existing-pr' }];
  } }), 'existing-pr');
  assert.equal(reads, 1);
});

test('PR publication refuses a stale/dirty checkout before any API write', () => {
  const { calls, api } = publisher('different main');
  assert.throws(() => openCalibrationPR({ before: source, after: renderCalibration(source, updates), updates, api }), /differs from main/);
  assert.equal(calls.some(c => c.method !== 'GET'), false);
});

test('PR publication retries a previously created branch without overwriting it', () => {
  const after = renderCalibration(source, updates);
  const { calls, api } = publisher();
  const retryApi = (method, endpoint, body) => {
    if (endpoint.includes('/git/matching-refs/')) return [{ ref: `refs/heads/${endpoint.split('/heads/')[1]}` }];
    if (endpoint.includes('/contents/') && !endpoint.endsWith('ref=base')) return { content: Buffer.from(after).toString('base64') };
    return api(method, endpoint, body);
  };
  assert.equal(openCalibrationPR({ before: source, after, updates, api: retryApi }), 'https://example.test/pr/1');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.ok(calls.at(-1).endpoint.endsWith('/pulls'));
});

test('apply writes allowances and provenance only after successful publication; no-op makes no API call', () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.regex-calibration-test-'));
  try {
    const filename = path.join(dir, 'audit.js');
    fs.writeFileSync(filename, source);
    assert.throws(() => applyRecalibration({ filename, updates, publish: () => { throw new Error('denied'); } }), /denied/);
    assert.equal(fs.readFileSync(filename, 'utf8'), source);
    assert.equal(applyRecalibration({ filename, updates, publish: () => 'pr-url' }), 'pr-url');
    assert.equal(fs.readFileSync(filename, 'utf8'), renderCalibration(source, updates));
    assert.equal(applyRecalibration({ filename, updates: [], publish: () => assert.fail('no API call') }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI auto-recalibration forces a full scan, dry-run makes no writes or API calls, malformed input fails closed', () => {
  const script = path.resolve('scripts/audit-regex-patterns.js');
  const before = fs.readFileSync(script, 'utf8');
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.regex-calibration-cli-'));
  try {
    const corpus = path.join(dir, 'data/review-texts/show');
    fs.mkdirSync(corpus, { recursive: true });
    for (let i = 0; i < 21; i++) {
      const fullText = i === 20 ? prose.slice(0, 900) + ' subscribe to our newsletter ' + prose.slice(900)
        : `${prose} subscribe to our newsletter`;
      fs.writeFileSync(path.join(corpus, `${String(i).padStart(2, '0')}.json`), JSON.stringify({ fullText, contentTier: 'complete', outlet: 'test outlet' }));
    }
    const run = (...args) => spawnSync(process.execPath, [script, ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: '', SCORING_DELTA_STAMP_DIR: path.join(dir, 'stamps') },
    });
    assert.match(run('--help').stdout, /--auto-recalibrate --dry-run/);
    const result = run('--auto-recalibrate', '--dry-run', '--json');
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scanned, 21, 'must not sample only 15 reviews per show');
    const refused = report.recalibration.refused.find(v => v.family === 'NEWSLETTER_PATTERNS' && v.index === 3);
    assert.equal(refused.guardProof.checked, 21);
    assert.equal(refused.guardProof.absorbed, 20);
    assert.equal(fs.readFileSync(script, 'utf8'), before);
    fs.writeFileSync(path.join(corpus, 'broken.json'), '{');
    const broken = run('--auto-recalibrate', '--dry-run');
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /unreadable\/malformed corpus record/);
    assert.equal(run('--dry-run').status, 2);
    assert.equal(run('--auto-recalibrate', '--max-hits', '100').status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
