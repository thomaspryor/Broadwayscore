// BRO-7341: the review-scoring OpenAI pins must not name a model OpenAI has scheduled to shut down,
// and each must have a request profile. Requires the real modules (rule 15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MODELS = require('../../scripts/lib/models');
const { MODEL_SHUTDOWNS, ACCEPTED_SHUTDOWNS } = require('../../scripts/lib/research-cost');
const { openaiScoringModels } = require('../../scripts/lib/llm-batch.js');

const PINS = ['SCORING_OPENAI', 'COMPARATIVE_OPENAI', 'GPT4O', 'GPT4O_MINI'];

describe('scoring OpenAI pins (BRO-7341)', () => {
  for (const key of PINS) {
    it(`${key} is not a model with a listed shutdown date`, () => {
      const id = MODELS[key];
      assert.ok(id, `models.js has no ${key}`);
      assert.equal(MODEL_SHUTDOWNS[id], undefined, `${key}=${id} shuts down ${MODEL_SHUTDOWNS[id]}`);
      assert.equal(ACCEPTED_SHUTDOWNS[id], undefined, `${key}=${id} shuts down ${ACCEPTED_SHUTDOWNS[id]}; move the pin (rule 13 A/B first)`);
    });
    it(`${key} has an OPENAI_REQUEST_PROFILES entry`, () => {
      assert.ok(openaiScoringModels().includes(MODELS[key]), `${MODELS[key]} has no request profile in llm-batch.js`);
    });
  }
});
