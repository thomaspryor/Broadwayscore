/** City tag for email signups (BRO-6912). Calls the real signupCity export. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { signupCity, buildSignupBody } from '../../src/lib/signup-city';

test('city hub pages tag the signup', () => {
  assert.equal(signupCity('/tours/chicago-il'), 'chicago-il');
  assert.equal(signupCity('/tours/washington-dc/'), 'washington-dc');
});
test('a local show page tags the signup through the show city', () => {
  assert.equal(signupCity('/show/some-chicago-show', 'chicago-il'), 'chicago-il');
});
test('everything else stays untagged', () => {
  assert.equal(signupCity('/'), undefined);
  assert.equal(signupCity('/west-end'), undefined);
  assert.equal(signupCity('/show/hamilton', undefined), undefined);
  assert.equal(signupCity(null, null), undefined);
});
test('only registry slugs pass, so page text never reaches the form', () => {
  assert.equal(signupCity('/tours/not-a-city'), undefined);
  assert.equal(signupCity('/tours/chicago-il', "<script>"), 'chicago-il');
  assert.equal(signupCity('/', 'constructor'), undefined);
});

const base = { email: ' A@Example.com ', source: 'footer', market: 'broadway', page: '/tours/chicago-il', pathname: '/tours/chicago-il', isSubscriber: true };
test('payload from a city hub carries city and keeps the old fields', () => {
  assert.deepEqual(buildSignupBody(base), { email: 'a@example.com', source: 'footer', market: 'broadway', page: '/tours/chicago-il', city: 'chicago-il' });
});
test('payload from a local show follow carries city, showId and showTitle', () => {
  const b = buildSignupBody({ ...base, pathname: '/show/x', page: '/show/x', isSubscriber: false, showId: 'x', showTitle: 'X', city: 'washington-dc', firstName: 'Ann' });
  assert.equal(b.city, 'washington-dc'); assert.equal(b.showId, 'x'); assert.equal(b.showTitle, 'X'); assert.equal(b.firstName, 'Ann');
});
test('payload from the homepage or a null-city show has no city key', () => {
  assert.equal('city' in buildSignupBody({ ...base, pathname: '/', page: '/' }), false);
  assert.equal('city' in buildSignupBody({ ...base, pathname: '/show/h', city: null }), false);
});

import fs from 'node:fs';
test('every email-list signup path builds its payload with buildSignupBody (a new path must join this list)', () => {
  for (const f of ['src/hooks/useFormspreeCapture.ts', 'src/components/EmailCaptureModal.tsx', 'src/lib/auto-subscribe.ts']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /buildSignupBody\(/, `${f} must use buildSignupBody so the city tag is not skipped`);
  }
});
