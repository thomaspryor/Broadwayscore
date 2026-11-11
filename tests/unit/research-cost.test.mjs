// Unit tests for scripts/lib/research-cost.js (BRO-4990).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { researchCallCost, countSearchCalls, ratesFor, WEB_SEARCH_CALL_USD } = require('../../scripts/lib/research-cost');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe('researchCallCost', () => {
  it('bills web search calls on top of tokens (the old estimate dropped them)', () => {
    // Real o4-mini usage from the BRO-4990 smoke run on "six".
    const c = researchCallCost({ input_tokens: 69928, output_tokens: 8986 }, 'o4-mini', 22);
    close(c.tokens, (69928 * 1.10 + 8986 * 4.40) / 1e6);
    close(c.search, 22 * WEB_SEARCH_CALL_USD);
    close(c.total, c.tokens + c.search);
  });

  it('bills cached input at the cached rate', () => {
    const c = researchCallCost({ input_tokens: 1e6, output_tokens: 0, input_tokens_details: { cached_tokens: 4e5 } }, 'gpt-5.4-mini');
    close(c.total, 0.6 * 0.75 + 0.4 * 0.075);
  });

  it('prices dated snapshots like their alias and unknown models at the top rate', () => {
    assert.deepEqual(ratesFor('gpt-5.4-mini-2026-03-17'), ratesFor('gpt-5.4-mini'));
    assert.ok(ratesFor('some-new-model').input >= ratesFor('o3-deep-research').input);
  });
});

describe('countSearchCalls', () => {
  it('counts web_search_call items only', () => {
    assert.equal(countSearchCalls([{ type: 'web_search_call' }, { type: 'reasoning' }, { type: 'message' }, { type: 'web_search_call' }]), 2);
    assert.equal(countSearchCalls(undefined), 0);
  });
});

describe('modelShutdownStatus', () => {
  const { modelShutdownStatus } = require('../../scripts/lib/research-cost');
  it('warns inside 30 days, refuses on/after the date, passes unknown-shutdown models', () => {
    assert.equal(modelShutdownStatus('o4-mini', '2026-09-01').status, 'ok');
    assert.equal(modelShutdownStatus('o4-mini', '2026-10-10').status, 'warn');
    assert.equal(modelShutdownStatus('o4-mini-2025-04-16', '2026-10-10').status, 'warn');
    assert.equal(modelShutdownStatus('o4-mini', '2026-10-23').status, 'dead');
    assert.equal(modelShutdownStatus('o4-mini-deep-research', '2026-10-10').status, 'dead');
    assert.equal(modelShutdownStatus('gpt-5.4-mini', '2026-10-10').status, 'ok');
  });

  // Date-independent: a model with ANY announced shutdown must not be the
  // default or a dispatch choice, so the next retirement fails here when
  // MODEL_SHUTDOWNS is updated, not in a Saturday cron after the cutoff.
  it('the script default and workflow choices have no announced shutdown', async () => {
    const fs = await import('node:fs');
    const { MODEL_SHUTDOWNS } = require('../../scripts/lib/research-cost');
    const root = new URL('../../', import.meta.url);
    const script = fs.readFileSync(new URL('scripts/deep-research-commercial.js', root), 'utf8');
    const def = script.match(/const DEFAULT_MODEL = '([^']+)'/);
    assert.ok(def, 'DEFAULT_MODEL constant not found');
    const wf = fs.readFileSync(new URL('.github/workflows/deep-research-commercial.yml', root), 'utf8');
    const options = [...wf.matchAll(/^\s+- '([^']+)'$/gm)].map(m => m[1]);
    assert.ok(options.includes(def[1]), 'workflow choices must include the script default');
    for (const m of [def[1], ...options]) {
      assert.equal(modelShutdownStatus(m, '1970-01-01').shutdown, null, `${m} has a shutdown date in MODEL_SHUTDOWNS`);
    }
    assert.ok(Object.keys(MODEL_SHUTDOWNS).length > 0);
  });

  // BRO-4989: backfill-commercial-o4mini.js hardcoded model: 'o4-mini' outside
  // the guarded default above. Any API-call literal naming a model with an
  // announced shutdown fails here, in every script, before the cutoff.
  it('no script hardcodes a model with an announced shutdown in an API call', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { MODEL_SHUTDOWNS } = require('../../scripts/lib/research-cost');
    const scriptsDir = fileURLToPath(new URL('../../scripts/', import.meta.url));
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(c?js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
      }
    };
    walk(scriptsDir);
    const names = Object.keys(MODEL_SHUTDOWNS).map(m => m.replace(/[.]/g, '\\.'));
    const lit = `['"\`](?:${names.join('|')})(?:-\\d{4}-\\d{2}-\\d{2})?['"\`]`;
    // BRO-7339: the first version matched only a lowercase `\bmodel` key, so
    // `const OPENAI_MODEL = 'gpt-5-mini'` and `process.env.X || 'gpt-5-mini'`
    // sailed past it for months. Case-insensitive, any `*model` name, plus `|| 'id'` fallbacks.
    const re = new RegExp(`(?:\\b\\w*model\\s*[:=]\\s*|\\|\\|\\s*)${lit}`, 'i');
    const hits = files.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(scriptsDir, f));
    assert.deepEqual(hits, [], `hardcoded retiring model in: ${hits.join(', ')}`);
    assert.ok(files.length > 100, 'scan found too few scripts');
    // Workflows pass models too (dropdown options, --model=, shadow_model defaults).
    const wfDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
    const wfRe = new RegExp(`model.*${lit}|${lit}.*model`, 'i');
    const wfHits = fs.readdirSync(wfDir).filter(n => /\.ya?ml$/.test(n))
      .filter(n => fs.readFileSync(path.join(wfDir, n), 'utf8').split('\n').some(l => !/^\s*#/.test(l) && wfRe.test(l)));
    assert.deepEqual(wfHits, [], `retiring model in workflow: ${wfHits.join(', ')}`);
  });

  // BRO-7339: gpt-5-mini and o3 shut down 2026-12-11 and were not in the table, so
  // no guard could fire. Pin the 2026-06-11 notice, and the pins that replaced them.
  it('registry holds the 2026-12-11 shutdowns; the replacement pins are live and priced', () => {
    const { MODEL_SHUTDOWNS, RATES, ratesFor, perTokenUsd } = require('../../scripts/lib/research-cost');
    const models = require('../../scripts/lib/models');
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'o3', 'o3-pro']) {
      assert.equal(MODEL_SHUTDOWNS[m], '2026-12-11', `${m} missing from MODEL_SHUTDOWNS`);
    }
    for (const key of ['AUDIT_OPENAI', 'AEO_OPENAI', 'DEEP_RESEARCH_OPENAI_PRO']) {
      const id = models[key];
      assert.ok(id, `${key} missing from models.js`);
      assert.equal(modelShutdownStatus(id, '1970-01-01').shutdown, null, `${key}=${id} has a shutdown date`);
      assert.ok(RATES[id], `${key}=${id} has no RATES entry (would price at the fallback)`);
    }
    const t = perTokenUsd(models.AUDIT_OPENAI);
    assert.equal(t.in, ratesFor(models.AUDIT_OPENAI).input / 1e6);
    assert.equal(t.out, ratesFor(models.AUDIT_OPENAI).output / 1e6);
    assert.equal(t.search, 0.01);
  });

  it('the audit client and the deep-research dropdown follow the models.js pins', async () => {
    const fs = await import('node:fs');
    const models = require('../../scripts/lib/models');
    const { perTokenUsd } = require('../../scripts/lib/research-cost');
    delete process.env.AUDIT_OPENAI_MODEL;
    const client = require('../../scripts/lib/dual-model-client');
    assert.equal(client.OPENAI_MODEL, models.AUDIT_OPENAI);
    assert.deepEqual(perTokenUsd(client.OPENAI_MODEL), perTokenUsd(models.AUDIT_OPENAI));
    const wf = fs.readFileSync(new URL('../../.github/workflows/deep-research-commercial.yml', import.meta.url), 'utf8');
    const options = [...wf.matchAll(/^\s+- '([^']+)'$/gm)].map(m => m[1]);
    assert.ok(options.includes(models.DEEP_RESEARCH_OPENAI_PRO), 'workflow must offer the models.js pro pin');
  });
});
