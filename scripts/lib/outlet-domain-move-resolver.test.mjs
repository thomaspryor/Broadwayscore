// BRO-7822 class guard: "Quality: outlet domain moves" was filed as a digest card
// 4 times in 12 days (BRO-7335, BRO-7411, BRO-7761, BRO-8044), each fixed by a
// worker hand-adding one host. The unambiguous shapes are now decided by
// outlet-domain-move-resolver.js and written hourly by
// scripts/resolve-outlet-domain-moves.js --apply (audit-aggregator-gap.yml).
// These cases are the real hosts from those cards plus registry ground truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { decideDomainMove, buildOutletMarkets } = require('./outlet-domain-move-resolver.js');
const { findProbableDomainMoves } = require('./silent-exclusion-detectors.js');

const outlets = {
  hackneycitizen: { domain: 'hackneycitizen.co.uk', region: 'london' },
  theartsdispatch: { domain: 'theartsdispatch.substack.com', region: 'london' },
  'west-end-extra': { domain: 'westendextra.com', region: 'london' },
  'metro-uk': { domain: 'metro.co.uk', region: 'london' },
  rollingstone: { domain: 'rollingstone.com' },
  curtainup: { domain: 'curtainup.com' },
  'everything-theatre': { domain: 'everything-theatre.co.uk' },
  independent: { domain: 'independent.co.uk' },
  artshub: { domain: 'artshub.co.uk' },
  'gay-times': { domain: 'gaytimes.co.uk' },
  cnn: { domain: 'cnn.com', tier: 3 },
  stageandcinema: { domain: 'stageandcinema.com', tier: 3 },
  variety: { domain: 'variety.com', tier: 1 },
  thestage: { domain: 'thestage.co.uk', tier: 2, region: 'london' },
};
const showMarket = new Map([
  ['jack-and-the-beanstalk-off-west-end-2026', 'west-end'],
  ['ceilidh-the-musical-off-west-end-2026', 'west-end'],
  ['hamlet-hail-to-the-thief-off-west-end-2026', 'west-end'],
  ['its-a-wonderful-life-a-live-radio-play-2026', 'regional'],
  ['some-broadway-show', 'broadway'],
]);
const outletMarkets = new Map([['stageandcinema', new Set(['broadway', 'west-end'])], ['rollingstone', new Set(['broadway'])], ['curtainup', new Set(['broadway'])]]);
const decide = (host, outletId, shows = []) => decideDomainMove({ host, outletId, shows }, outlets, { outletMarkets, showMarket });

test('BRO-8044 hackneycitizen.ghost.io: blog-platform mirror of the same label is an alias', () => {
  const d = decide('hackneycitizen.ghost.io', 'hackneycitizen', ['jack-and-the-beanstalk-off-west-end-2026']);
  assert.equal(d.kind, 'domainAlias');
  assert.equal(d.rule, 'platform-mirror');
});

test('BRO-7335 theartsdispatch.com: custom domain of a substack outlet is an alias when seen on its own market', () => {
  assert.equal(decide('theartsdispatch.com', 'theartsdispatch', ['ceilidh-the-musical-off-west-end-2026']).kind, 'domainAlias');
  // seen on a Broadway show the London outlet never covered: left for judgment
  assert.equal(decide('theartsdispatch.com', 'theartsdispatch', ['some-broadway-show']).kind, null);
});

test('BRO-7335 westendextra.co.uk: home-country TLD swap on West End shows is an alias (0 reviews left on the old host)', () => {
  const d = decide('westendextra.co.uk', 'west-end-extra', ['ceilidh-the-musical-off-west-end-2026']);
  assert.equal(d.kind, 'domainAlias');
  assert.equal(d.rule, 'home-market-tld');
});

test('BRO-7335 metro.us vs metro.co.uk: two national ccTLDs is a different paper', () => {
  const d = decide('metro.us', 'metro-uk', ['some-broadway-show']);
  assert.equal(d.kind, 'notDomainMove');
  assert.equal(d.rule, 'foreign-cctld-twin');
  // without market evidence for the foreign host it stays undecided
  assert.equal(decide('independent.ie', 'independent').kind, null);
  assert.equal(decide('metro.eu', 'metro-uk', ['some-broadway-show']).kind, null, '.eu is not a country');
});

test('BRO-7411 rollingstone.co.uk on a West End show: an edition abroad stays for judgment', () => {
  assert.equal(decide('rollingstone.co.uk', 'rollingstone', ['hamlet-hail-to-the-thief-off-west-end-2026']).kind, null);
});

test('BRO-7761 curtain-up.com vs curtainup.com: punctuation twins stay for judgment (both answers exist in the registry)', () => {
  assert.equal(decide('curtain-up.com', 'curtainup', ['its-a-wonderful-life-a-live-radio-play-2026']).kind, null);
  assert.equal(decide('everythingtheatre.co.uk', 'everything-theatre').kind, null);
});

test('never guesses an alias without market evidence', () => {
  assert.equal(decide('gaytimes.com', 'gay-times', []).kind, null, 'no census shows');
  assert.equal(decide('gaytimes.com', 'gay-times', ['its-a-wonderful-life-a-live-radio-play-2026']).kind, null, 'regional: no known country');
  assert.equal(decide('gaytimes.com', 'gay-times', ['some-broadway-show']).kind, null, '.co.uk outlet, Broadway show');
});

test('never auto-aliases onto a tier 1/2 outlet (a same-named blog or mirror would inherit its weight)', () => {
  assert.equal(decide('variety.substack.com', 'variety').kind, null);
  assert.equal(decide('thestage.com', 'thestage', ['ceilidh-the-musical-off-west-end-2026']).kind, null);
  assert.equal(decide('cnn.substack.com', 'cnn', ['some-broadway-show']).kind, null, 'short famous label');
  assert.equal(decide('stageandcinema.co.uk', 'stageandcinema', ['ceilidh-the-musical-off-west-end-2026']).kind, null, 'US outlet that also covers London');
});

test('a host never vouches for its own market', () => {
  const reviews = [{ outletId: 'rollingstone', showId: 'hamlet-hail-to-the-thief-off-west-end-2026', url: 'https://www.rollingstone.co.uk/x' }];
  const m = buildOutletMarkets(reviews, showMarket, { excludeHosts: new Set(['rollingstone.co.uk']) });
  assert.equal(m.has('rollingstone'), false);
});

test('CLI --apply writes decided hosts so the detector row clears, and leaves the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7822-'));
  fs.mkdirSync(path.join(root, 'data', 'audit'), { recursive: true });
  const write = (f, o) => fs.writeFileSync(path.join(root, 'data', f), JSON.stringify(o));
  write('outlet-registry.json', { _meta: {}, outlets: JSON.parse(JSON.stringify(outlets)) });
  write('shows.json', { shows: [...showMarket].map(([id, market]) => ({ id, market })) });
  write('reviews.json', { reviews: [{ outletId: 'rollingstone', showId: 'some-broadway-show', url: 'https://www.rollingstone.com/a' }] });
  const census = [
    { host: 'hackneycitizen.ghost.io', shows: ['jack-and-the-beanstalk-off-west-end-2026'] },
    { host: 'metro.us', shows: ['some-broadway-show'] },
    { host: 'rollingstone.co.uk', shows: ['hamlet-hail-to-the-thief-off-west-end-2026'] },
  ];
  write('audit/unknown-aggregator-outlets.json', { generatedAt: new Date().toISOString(), outlets: census });
  const cli = fileURLToPath(new URL('../resolve-outlet-domain-moves.js', import.meta.url));
  const r = spawnSync(process.execPath, [cli, '--apply', '--json'], { env: { ...process.env, RESOLVE_DOMAIN_MOVES_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.written, 2);
  const reg = JSON.parse(fs.readFileSync(path.join(root, 'data', 'outlet-registry.json'), 'utf8'));
  assert.deepEqual(reg.outlets.hackneycitizen.domainAliases, ['hackneycitizen.ghost.io']);
  assert.deepEqual(reg.outlets['metro-uk'].notDomainMoves, ['metro.us']);
  assert.deepEqual(findProbableDomainMoves(reg.outlets, census).map((m) => m.host), ['rollingstone.co.uk']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the hourly census job runs the resolver before staging, and stages the registry (wiring guard)', () => {
  const yml = fs.readFileSync(fileURLToPath(new URL('../../.github/workflows/audit-aggregator-gap.yml', import.meta.url)), 'utf8');
  const run = yml.indexOf('node scripts/resolve-outlet-domain-moves.js --apply');
  const loop = yml.indexOf('for f in data/outlet-registry.json ');
  assert.ok(run > 0, 'audit-aggregator-gap.yml must run resolve-outlet-domain-moves.js --apply');
  assert.ok(loop > run, 'the commit loop must stage data/outlet-registry.json after the resolver ran');
});
