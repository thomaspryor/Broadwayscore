// Pins the per-channel video caption rules (BRO-6737). Requires the real module and the real reviewed plan files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const { channelCaption, videoLink, taggedUrl } = require('./video-proto/channel-captions.js');
const { lint } = require('./video-proto/copyreview.js');

const plansDir = path.join(HERE, 'video-proto', 'plans');
const plans = fs.readdirSync(plansDir).filter((f) => f.endsWith('.plan.json'))
  .map((f) => ({ file: f, plan: JSON.parse(fs.readFileSync(path.join(plansDir, f), 'utf8')) }));
// site entries as data/shows.json has them (real dates): the page slug differs from the id on purpose (year suffix dropped)
const SHOWS = {
  'the-curious-case-of-benjamin-button-off-broadway-2026': { slug: 'the-curious-case-of-benjamin-button-off-broadway', category: 'off-broadway', openingDate: '2026-10-21' },
  'the-curious-case-of-benjamin-button-west-end-2024': { slug: 'the-curious-case-of-benjamin-button-west-end-2024', category: 'west-end', openingDate: '2024-11-06' },
  'maybe-happy-ending-2024': { slug: 'maybe-happy-ending', category: 'broadway', openingDate: '2024-11-12' },
  'the-great-gatsby-2024': { slug: 'the-great-gatsby', category: 'broadway', openingDate: '2024-04-25' },
};
const lookup = (id) => SHOWS[id];
const TAIL = /See every review at [a-z0-9.-]+\.com/i;
const URL_RE = /https?:\/\/|www\./i;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
// the caption with the link line taken out, to prove nothing else moved
const withoutLink = (t) => norm(t.replace(/See every review( at [a-z0-9.-]+\.com( \(link in bio\))?|: https?:\/\/\S+)/i, ''));

test('there are reviewed plans to check', () => assert.ok(plans.length >= 4));

for (const { file, plan } of plans) {
  const link = videoLink(plan, lookup);
  const out = (n, o) => channelCaption(plan.caption, n, link, o);

  test(`${file}: facebook carries a live utm-tagged link`, () => {
    const t = out('facebook');
    assert.match(t, /See every review: https:\/\/[a-z]+scorecard\.com\/[^\s]*\?utm_source=facebook&utm_medium=social&utm_campaign=video&utm_content=[a-z0-9-]+/);
    assert.ok(!TAIL.test(t));
  });
  for (const n of ['tiktok', 'instagram']) {
    test(`${file}: ${n} says link in bio and has no URL`, () => {
      const t = out(n);
      assert.match(t, /See every review at [a-z]+scorecard\.com \(link in bio\)/);
      assert.ok(!URL_RE.test(t), 'a caption link is dead text here');
      assert.ok(!/utm_/.test(t));
    });
  }
  test(`${file}: youtube short leads with the plain domain and no dead URL`, () => {
    const t = out('youtube');
    assert.ok(t.startsWith(`See every review at ${link.domain}\n\n`), t.slice(0, 80));
    assert.ok(!URL_RE.test(t) && !/utm_/.test(t));
    assert.equal((t.match(/See every review/g) || []).length, 1);
  });
  test(`${file}: a youtube video that is not a Short leads with the tagged link`, () => {
    const t = out('youtube', { isShort: false });
    assert.ok(t.startsWith('See every review: https://'));
    assert.match(t.split('\n')[0], /utm_source=youtube&utm_medium=social&utm_campaign=video&utm_content=[a-z0-9-]+$/);
  });
  test(`${file}: only the link line differs, and the copy still passes the banned-wording lint`, () => {
    const base = withoutLink(plan.caption);
    for (const n of ['facebook', 'tiktok', 'instagram', 'youtube']) {
      const t = out(n);
      assert.equal(withoutLink(t), base, `${n} changed more than the link line`);
      assert.deepEqual(lint(t), [], `${n} caption trips the copy lint`);
      assert.ok(!/[—–]/.test(t));
    }
    // the hashtags are untouched (numbers and the question are covered by the withoutLink equality above)
    for (const n of ['facebook', 'tiktok', 'instagram', 'youtube']) {
      assert.deepEqual(out(n).match(/#\w+/g), plan.caption.match(/#\w+/g));
    }
  });
  test(`${file}: no whitespace damage from moving or replacing the link line`, () => {
    for (const n of ['facebook', 'tiktok', 'instagram', 'youtube']) {
      const t = out(n);
      assert.ok(!/ {2,}/.test(t) && !/\n{3,}/.test(t) && !/ \n/.test(t) && t === t.trim() && !/ \./.test(t), `${n}: ${JSON.stringify(t.slice(0, 120))}`);
    }
  });
  test(`${file}: fits every network's length limit`, () => {
    assert.ok(out('facebook').length < 5000);
    assert.ok(out('instagram').length < 2200);
    assert.ok(out('tiktok').length < 2200);
    assert.ok(out('youtube').length < 5000);
  });
}

test('a compare video links to the newest production, by its page slug, not its id', () => {
  const { plan } = plans.find((p) => p.plan.fmt === 'compare');
  const l = videoLink(plan, lookup);
  assert.equal(l.url, 'https://broadwayscorecard.com/show/the-curious-case-of-benjamin-button-off-broadway');
  assert.ok(!/-2026$/.test(l.url));
});

test('a West End show links to westendscorecard.com', () => {
  const l = videoLink({ key: 'x', fmt: 'compare', shows: [{ id: 'the-curious-case-of-benjamin-button-west-end-2024' }] }, lookup);
  assert.equal(l.domain, 'westendscorecard.com');
  assert.equal(l.url, 'https://westendscorecard.com/show/the-curious-case-of-benjamin-button-west-end-2024');
});

test('other video kinds link to the market home page', () => {
  const l = videoLink({ key: 'x', fmt: 'duo', shows: [{ id: 'maybe-happy-ending-2024' }] }, lookup);
  assert.equal(l.url, 'https://broadwayscorecard.com/');
});

test('fails loud instead of shipping a dead link', () => {
  assert.throws(() => videoLink({ key: 'x', fmt: 'compare', shows: [{ id: 'no-such-show' }] }, lookup), /no site entry/);
  assert.throws(() => videoLink({ key: 'x', shows: [] }, lookup), /no shows/);
  assert.throws(() => channelCaption('No link line here.', 'facebook', { domain: 'broadwayscorecard.com', url: 'https://broadwayscorecard.com/' }), /no "See every review/);
  assert.throws(() => channelCaption('See every review at broadwayscorecard.com', 'twitter', { domain: 'broadwayscorecard.com', url: 'https://broadwayscorecard.com/' }), /no video caption rule/);
});

test('taggedUrl uses the same utm shape as the image posts', () => {
  assert.equal(taggedUrl('https://broadwayscorecard.com/show/x', 'facebook', 'some-key'), 'https://broadwayscorecard.com/show/x?utm_source=facebook&utm_medium=social&utm_campaign=video&utm_content=some-key');
  assert.equal(taggedUrl('https://broadwayscorecard.com/show/x', 'facebook'), 'https://broadwayscorecard.com/show/x?utm_source=facebook&utm_medium=social&utm_campaign=video');
});

// The scheduler is run as a real subprocess, but with a fake `curl` first on PATH: any network call the script makes
// (reading a queue, creating a post) exits 99 and is logged, so a regression can never create a real Buffer post from a test.
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-curl-'));
const curlLog = path.join(fakeBin, 'calls.log');
fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh\necho "$@" >> "${curlLog}"\necho "fake curl: network blocked in tests" >&2\nexit 99\n`, { mode: 0o755 });
const SCHED = path.join(HERE, 'video-proto', 'schedule-compare-short.py');
const sched = (...args) => {
  fs.rmSync(curlLog, { force: true });
  const r = spawnSync('python3', [SCHED, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
  return { ...r, curlCalls: fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8') : '' };
};
const hasShowsData = fs.existsSync(path.join(HERE, '..', 'data', 'shows.json'));
const skipNoData = !hasShowsData && 'data/shows.json not present';

// the scheduler's dry run (posts nothing) must hand Buffer the per-channel text and the right channel metadata
for (const [net, expect] of [['facebook', /See every review: https:\/\/broadwayscorecard\.com\/show\/the-curious-case-of-benjamin-button-off-broadway\?utm_source=facebook/],
  ['tiktok', /\(link in bio\)/], ['instagram', /\(link in bio\)/], ['youtube', /^See every review at broadwayscorecard\.com\n\n/]]) {
  test(`scheduler dry run for ${net} uses its caption and makes no network call`, { skip: skipNoData }, () => {
    const r = sched(net, '2030-01-01T00:00:00Z', '1000');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.curlCalls, '', 'a dry run must not touch the network');
    const payload = JSON.parse(r.stdout);
    assert.match(payload.text, expect);
    assert.ok(payload.channelId);
    if (net === 'facebook') assert.deepEqual(payload.metadata, { facebook: { type: 'reel' } });
  });
}

test('scheduler: a past dueAt is fine in a dry run but refused before any network call when posting', { skip: skipNoData }, () => {
  assert.equal(sched('facebook', '2020-01-01T00:00:00Z', '1000').status, 0);
  const r = sched('facebook', '2020-01-01T00:00:00Z', '1000', 'post');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /in the past/);
  assert.equal(r.curlCalls, '');
});

test('scheduler: a bad 4th argument or bad dueAt dies instead of posting', { skip: skipNoData }, () => {
  const bad4 = sched('facebook', '2030-01-01T00:00:00Z', '1000', 'POST');
  assert.notEqual(bad4.status, 0);
  assert.match(bad4.stderr, /4th argument/);
  const badDue = sched('facebook', 'tomorrow', '1000', 'post');
  assert.notEqual(badDue.status, 0);
  assert.match(badDue.stderr, /not an ISO timestamp/);
  assert.equal(bad4.curlCalls + badDue.curlCalls, '');
});

test('scheduler: a live run reads the queue first and stops there when it cannot, so it never reaches createPost', { skip: skipNoData }, () => {
  const r = sched('facebook', '2030-01-01T00:00:00Z', '1000', 'post');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /curl failed/);
  assert.ok(r.curlCalls.includes('posts('), 'the first call must be the duplicate-guard queue read');
  assert.ok(!r.curlCalls.includes('createPost'), 'createPost must not be reached');
});

test('the "how we score" video links to its own subject (plan.key), not to the show it compares against', () => {
  const plan = { key: 'maybe-happy-ending-2024', fmt: 'how', compare: { id: 'the-curious-case-of-benjamin-button-west-end-2024' } };
  assert.equal(videoLink(plan, lookup).domain, 'broadwayscorecard.com');
  const west = { key: 'the-curious-case-of-benjamin-button-west-end-2024', fmt: 'how', compare: { id: 'maybe-happy-ending-2024' } };
  assert.equal(videoLink(west, lookup).domain, 'westendscorecard.com');
});

test('a compare video picks the newest production by opening date, whatever order the ids were typed in', () => {
  const ids = ['the-curious-case-of-benjamin-button-west-end-2024', 'the-curious-case-of-benjamin-button-off-broadway-2026'];
  for (const order of [ids, [...ids].reverse()]) {
    const l = videoLink({ key: 'x', fmt: 'compare', shows: order.map((id) => ({ id })) }, lookup);
    assert.equal(l.url, 'https://broadwayscorecard.com/show/the-curious-case-of-benjamin-button-off-broadway');
  }
  assert.throws(() => videoLink({ key: 'x', fmt: 'compare', shows: ids.map((id) => ({ id })) }, (id) => ({ ...SHOWS[id], openingDate: undefined })), /openingDate/);
});

test('a period after the link line does not leave a stray dot or end a URL with one', () => {
  const link = { domain: 'broadwayscorecard.com', url: 'https://broadwayscorecard.com/show/x', key: 'k' };
  const cap = 'Fact one. Why do you think so? See every review at broadwayscorecard.com.\n\n#One #Two';
  assert.ok(!/\.$/.test(channelCaption(cap, 'facebook', link).split('\n')[0].replace(/^.*(?=https)/, '')));
  assert.equal(channelCaption(cap, 'youtube', link), 'See every review at broadwayscorecard.com\n\nFact one. Why do you think so?\n\n#One #Two');
  assert.match(channelCaption(cap, 'tiktok', link), /so\? See every review at broadwayscorecard\.com \(link in bio\)\n\n#One/);
});

// behavior of the scheduler's duplicate guard, loaded as a module (its main() only runs as a script)
const py = (code) => spawnSync('python3', ['-c', `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('sched', ${JSON.stringify(path.join(HERE, 'video-proto', 'schedule-compare-short.py'))})\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n${code}`], { encoding: 'utf8' });

test('duplicate guard matches the old shared caption and every per-channel variant, despite curly quotes and spacing', () => {
  const plan = plans.find((p) => p.plan.fmt === 'compare').plan;
  const old = plan.caption;
  const variants = ['facebook', 'tiktok', 'instagram', 'youtube'].map((n) => channelCaption(plan.caption, n, videoLink(plan, lookup)));
  const r = py(`plan = json.loads(${JSON.stringify(JSON.stringify(plan))})\nmarker = m.body_marker_of(plan['caption'])\n` +
    `texts = json.loads(${JSON.stringify(JSON.stringify([old, ...variants, old.replace(/'/g, '\u2019').replace(/ /g, '  '), 'Some unrelated image post about The Pianist.']))})\n` +
    `print(json.dumps([bool(m.find_dupes([{'text': t}], marker)) for t in texts]))`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [true, true, true, true, true, true, false]);
});

test('duplicate guard reads every page of the channel and refuses to post when it cannot read them all', () => {
  const r = py(`pages = [{'edges': [{'node': {'id': 'a', 'text': 'x'}}], 'pageInfo': {'hasNextPage': True, 'endCursor': 'c1'}},\n` +
    `         {'edges': [{'node': {'id': 'b', 'text': 'y'}}], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}]\n` +
    `calls = []\ndef fake(q, v):\n    calls.append(v['a']); return {'posts': pages[len(calls) - 1]}\nm.gql = fake\n` +
    `print(json.dumps([[p['id'] for p in m.channel_posts('c')], calls]))\n` +
    `m.gql = lambda q, v: {'posts': {'edges': [], 'pageInfo': {'hasNextPage': True, 'endCursor': 'z'}}}\n` +
    `try:\n    m.channel_posts('c')\nexcept SystemExit as e:\n    print(str(e))`);
  assert.equal(r.status, 0, r.stderr);
  const [first, second] = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(first), [['a', 'b'], [null, 'c1']]);
  assert.match(second, /not posting/);
});
