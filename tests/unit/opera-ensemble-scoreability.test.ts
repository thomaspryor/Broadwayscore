/**
 * Regression test for the 2026-05-01 Eugene Onegin Haiku-fallback bug.
 *
 * Background: opera shows live in shows.json with category='off-broadway' +
 * venue='Metropolitan Opera House' + type='opera'. The ensemble's wrong_show
 * scoreability gate was rejecting every opera review with reasoning like:
 *   "This is a review of opera at the Metropolitan Opera House, not a
 *    Broadway or West End theater show."
 * because the prompt told the LLM the show was Off-Broadway theater.
 *
 * Fix (2026-05-17, Notion 363637c5-416f-81cc-8240-c48df8b4cfd2): when
 * review.type === 'opera', input-builder frames the show as "Opera
 * (Metropolitan Opera)" and emits an explicit NOTE telling the model
 * NOT to reject opera reviews as wrong_show. This test guards that
 * framing — if it regresses, opera reviews will fall back to single-Haiku
 * scoring again, which over-weights closing lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScoringInput } from '../../scripts/llm-scoring/input-builder.ts';

test('opera shows are framed as opera, not off-broadway theater', () => {
  const built = buildScoringInput({
    showTitle: 'Eugene Onegin',
    outlet: 'Operawire',
    criticName: 'David Salazar',
    category: 'off-broadway',
    venue: 'Metropolitan Opera House',
    type: 'opera',
    fullText: 'Tchaikovsky\'s Eugene Onegin at the Met is one of the most intimate experiences. Tenor de Barbeyrac as Lensky gave the most compelling performance of the night. The orchestra balance was problematic throughout.',
  });

  // The context must mention opera/Metropolitan, not "Off-Broadway"
  assert.match(built.context, /Opera|Metropolitan/i, 'context should frame opera show as opera');
  assert.doesNotMatch(built.context, /\(Off-Broadway\)/, 'context must not say (Off-Broadway) for opera shows');

  // The explicit anti-wrong_show NOTE must be present
  assert.match(built.context, /do NOT flag.*wrong_show/i, 'must include explicit anti-wrong_show note for opera');
});

test('non-opera off-broadway shows still framed as Off-Broadway', () => {
  const built = buildScoringInput({
    showTitle: 'Oh, Mary!',
    outlet: 'The New York Times',
    category: 'off-broadway',
    venue: 'Lucille Lortel Theatre',
    type: 'play',
    fullText: 'A delicious comedy with sharp performances and inventive staging.',
  });

  assert.match(built.context, /\(Off-Broadway\)/, 'play at OB venue should be framed as Off-Broadway');
  assert.doesNotMatch(built.context, /Metropolitan Opera/i, 'should not mention Met for non-opera');
});

test('broadway shows unchanged by opera fix', () => {
  const built = buildScoringInput({
    showTitle: 'Hamilton',
    outlet: 'Variety',
    category: 'broadway',
    venue: 'Richard Rodgers Theatre',
    type: 'musical',
    fullText: 'Lin-Manuel Miranda\'s revolutionary hip-hop musical is a phenomenon.',
  });

  assert.match(built.context, /\(Broadway\)/, 'broadway musical should be framed as Broadway');
});

test('west-end shows unchanged by opera fix', () => {
  const built = buildScoringInput({
    showTitle: 'Six',
    outlet: 'The Guardian',
    category: 'west-end',
    venue: 'Vaudeville Theatre',
    type: 'musical',
    fullText: 'A pop-concert reimagining of the wives of Henry VIII.',
  });

  assert.match(built.context, /\(West End\)/, 'west end should be framed as West End');
});
