// BRO-5080: "Studio 54" resolved to the Harold and Miriam Steinberg Center (an
// alias on a bogus Broadway entry), renaming 31 IBDB Studio 54 productions, and
// the Steinberg Center's partial match made Laura Pels shows validate as Broadway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateVenue, getCanonicalVenueName, isOfficialBroadwayTheater } = require('./broadway-theaters.js');

test('Studio 54 is its own Broadway house', () => {
  assert.equal(getCanonicalVenueName('Studio 54'), 'Studio 54');
  assert.equal(validateVenue('Studio 54').category, 'broadway');
});

test('the Steinberg Center (Laura Pels, Black Box) is not a Broadway house', () => {
  assert.equal(isOfficialBroadwayTheater('Harold and Miriam Steinberg Center for Theatre'), false);
  assert.equal(isOfficialBroadwayTheater('The Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre'), false);
  assert.notEqual(validateVenue('Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre').category, 'broadway');
});
