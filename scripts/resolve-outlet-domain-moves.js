#!/usr/bin/env node
/**
 * BRO-7822: resolve "Quality: outlet domain moves" rows without a card.
 *
 *   node scripts/resolve-outlet-domain-moves.js            # dry run: print decisions
 *   node scripts/resolve-outlet-domain-moves.js --apply    # write domainAliases to data/outlet-registry.json
 *   node scripts/resolve-outlet-domain-moves.js --json     # machine-readable decisions
 *
 * Reads the unknown-outlet census (data/audit/unknown-aggregator-outlets.json,
 * written hourly by audit-show-review-gap.js), runs the same detector the
 * health check uses, and applies only the moves scripts/lib/outlet-domain-move-resolver.js
 * decides from unambiguous evidence (blog-platform mirror of the same label, or
 * a home-country TLD swap seen only in markets the outlet already reviews).
 * Writes go through applyOutletRegistryAlias (BRO-6632 guards: detector must
 * pair the host with this outlet, no steal from another outlet, no
 * contradiction with notDomainMoves). Undecided moves are printed and left for
 * the daily digest row. Run hourly by audit-aggregator-gap.yml.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { exitFlushed } = require('./lib/exit-flushed');
const { findProbableDomainMoves } = require('./lib/silent-exclusion-detectors');
const { decideDomainMove, buildOutletMarkets } = require('./lib/outlet-domain-move-resolver');
const { applyOutletRegistryAlias } = require('./lib/outlet-registry-alias-action');

const ROOT = process.env.RESOLVE_DOMAIN_MOVES_ROOT || path.join(__dirname, '..');
const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) {
  console.log('Usage: node scripts/resolve-outlet-domain-moves.js [--apply] [--json]\nDry run by default; --apply writes decided domainAliases/notDomainMoves to data/outlet-registry.json.');
  process.exit(0);
}
const apply = argv.includes('--apply');
const asJson = argv.includes('--json');

const p = (...s) => path.join(ROOT, ...s);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function main() {
  const registryPath = p('data', 'outlet-registry.json');
  const censusPath = p('data', 'audit', 'unknown-aggregator-outlets.json');
  for (const f of [registryPath, censusPath, p('data', 'shows.json'), p('data', 'reviews.json')]) {
    if (!fs.existsSync(f)) {
      console.log(`skip: ${path.relative(ROOT, f)} not present`);
      return 0;
    }
  }
  if (process.env.OUTLET_DOMAIN_MOVE_AUTORESOLVE_DISABLED === '1' && apply) {
    console.log('skip: OUTLET_DOMAIN_MOVE_AUTORESOLVE_DISABLED=1');
    return 0;
  }
  const registry = readJson(registryPath);
  const census = readJson(censusPath);
  // Same freshness bar as the health-check row: never decide from a census the
  // audit failed to refresh.
  const ageH = (Date.now() - Date.parse(census.generatedAt || '')) / 3600000;
  if (apply && !(ageH <= 48)) {
    console.log(`skip: census generatedAt ${census.generatedAt || 'missing'} is older than 48h`);
    return 0;
  }
  const showMarket = new Map((readJson(p('data', 'shows.json')).shows || []).map((s) => [s.id, s.market]));
  const { registrableHost } = require('./lib/non-review-url-patterns');
  const excludeHosts = new Set((census.outlets || []).map((o) => o && o.host && registrableHost(String(o.host).toLowerCase())).filter(Boolean));
  const outletMarkets = buildOutletMarkets(readJson(p('data', 'reviews.json')).reviews || [], showMarket, { excludeHosts });

  const moves = findProbableDomainMoves(registry.outlets, census.outlets || []);
  const decided = [];
  const undecided = [];
  for (const move of moves) {
    const d = decideDomainMove(move, registry.outlets, { outletMarkets, showMarket });
    if (!d.kind) {
      undecided.push({ host: move.host, outletId: move.outletId, rule: d.rule, reason: d.reason });
      continue;
    }
    const row = { host: move.host, outletId: move.outletId, rule: d.rule, kind: d.kind };
    if (apply) {
      const r = applyOutletRegistryAlias(registry, { type: 'outlet-registry-alias', outletId: move.outletId, host: move.host, kind: d.kind, reason: d.reason });
      row.applied = r.ok ? (r.changed ? 'written' : 'already') : `refused: ${r.reason}`;
    }
    decided.push(row);
  }

  const written = decided.filter((r) => r.applied === 'written').length;
  if (apply && written > 0) {
    // Same shape the rebuild's AUTO-REGISTER writer uses (no trailing newline),
    // so merge-outlet-registry.js and the sync step see a minimal diff.
    const tmp = `${registryPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
    fs.renameSync(tmp, registryPath);
  }

  if (asJson) {
    console.log(JSON.stringify({ moves: moves.length, decided, undecided, written }, null, 2));
  } else {
    console.log(`${moves.length} probable domain move(s): ${decided.length} decided, ${undecided.length} left for the digest${apply ? `, ${written} written` : ' (dry run)'}`);
    for (const r of decided) console.log(`  ${r.kind === "domainAlias" ? "ALIAS   " : "DISTINCT"} ${r.host} -> ${r.outletId} [${r.rule}]${r.applied ? ` ${r.applied}` : ''}`);
    for (const r of undecided) console.log(`  LEFT  ${r.host} -> ${r.outletId} [${r.rule}] ${r.reason}`);
  }
  // A refusal is printed, never an exit code: the hourly workflow commits
  // whatever was written, and a nonzero exit would drop those writes.
  for (const r of decided.filter((x) => x.applied && x.applied.startsWith('refused'))) {
    console.error(`::warning::resolve-outlet-domain-moves: ${r.host} -> ${r.outletId} ${r.applied}`);
  }
  for (const r of decided.filter((x) => x.applied === 'written')) {
    console.error(`::notice::outlet domain move auto-resolved: ${r.host} -> ${r.outletId} ${r.kind} [${r.rule}]`);
  }
  return 0;
}

exitFlushed(main());
