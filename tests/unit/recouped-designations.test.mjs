// Breakout (owner 2026-10-27, BRO-6446): a new or untested work, with no
// star whose name sells the tickets, that recouped. Adding it meant finding
// six hand-written "recouped labels" lists across scripts/; one list
// (RECOUPED_DESIGNATIONS / isRecoupedDesignation in commercial-designations.js)
// now carries it, and a literal list elsewhere is refused here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const D = require('../../scripts/lib/commercial-designations');
const { proposeDesignation } = require('../../scripts/lib/designation-rule');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('recouped labels', () => {
  it('are valid designations and include Breakout', () => {
    for (const d of D.RECOUPED_DESIGNATIONS) assert.ok(D.VALID_DESIGNATIONS.includes(d), d);
    assert.ok(D.RECOUPED_DESIGNATIONS.includes('Breakout'));
    for (const d of [...D.REPORTED_WIN_DESIGNATIONS, ...D.MODEST_RETURN_DESIGNATIONS]) assert.ok(D.RECOUPED_DESIGNATIONS.includes(d), d);
    assert.ok(!D.REPORTED_WIN_DESIGNATIONS.includes('Trickle'), 'Trickle can be our estimate');
    for (const l of [D.RECOUPED_DESIGNATIONS, D.REPORTED_WIN_DESIGNATIONS, D.MODEST_RETURN_DESIGNATIONS]) assert.ok(Object.isFrozen(l));
  });
  it('never overlap the loss labels', () => {
    for (const d of D.RECOUPED_DESIGNATIONS) assert.ok(!D.isLossDesignation(d), d);
  });
  it('Breakout canonicalizes from LLM spellings', () => {
    assert.equal(D.canonicalDesignation('breakout'), 'Breakout');
    assert.equal(D.canonicalDesignation(' BREAKOUT '), 'Breakout');
  });
});

describe('the recoupment rule and Breakout', () => {
  const show = { openingDate: '2024-01-01', closingDate: '2024-06-01' };
  const p = (record) => proposeDesignation({ record: { designation: 'Breakout', recouped: true, ...record }, show, model: null, now: Date.parse('2026-10-27') });
  it('keeps it under 1.5x and with no reported return', () => {
    for (const r of [p({ investorMultiple: 1.0 }), p({ investorMultiple: 1.49 }), p({})]) {
      assert.equal(r.changed, false);
      assert.equal(r.designation, 'Breakout');
    }
  });
  it('proposes Windfall at a reported 1.5x or more', () => {
    for (const investorMultiple of [1.5, 2.0]) assert.equal(p({ investorMultiple }).designation, 'Windfall');
  });
});

describe('no literal recouped-label lists outside commercial-designations.js', () => {
  // A list naming Easy Winner with Trickle or Windfall is a recouped-labels list.
  const PATTERN = /\[[^\]]*['"]Easy Winner['"][^\]]*\]/;
  const ALLOW = new Set(['scripts/lib/commercial-designations.js']);
  // A list that means something else (the /biz headline chips) says so on the line.
  const OK_MARKER = /recouped-list-ok: \S/;
  const SKIP_DIR = /(^|\/)(node_modules|\.next|out|data|tests?|__tests__)(\/|$)/;
  function* walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(rel)) yield* walk(rel); continue; }
      if (/\.(c?m?js|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) yield rel;
    }
  }
  it('every recouped-label list comes from RECOUPED_DESIGNATIONS', () => {
    const hits = [];
    for (const dir of ['scripts', 'src']) {
      for (const rel of walk(dir)) {
        if (ALLOW.has(rel)) continue;
        fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line) || OK_MARKER.test(line)) return;
          if (PATTERN.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    assert.deepEqual(hits, [], 'use RECOUPED_DESIGNATIONS / isRecoupedDesignation from scripts/lib/commercial-designations.js');
  });
});
